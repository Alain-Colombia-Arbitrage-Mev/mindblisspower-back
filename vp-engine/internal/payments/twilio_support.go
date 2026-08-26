package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"hash/fnv"
	"html"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	defaultVoiceSayLanguage      = "es-MX"
	defaultVoiceGatherLanguage   = "es-CO"
	defaultVoiceGatherTimeoutSec = 5
	defaultVoiceAgentMaxTurns    = 6
	defaultVoiceAgentMode        = "gather"
	voiceAgentModePipecat        = "pipecat"
	pipecatStreamSignatureTTL    = 5 * time.Minute
	maxTwilioWebhookBody         = int64(1 << 16)
)

// CallSession guarda el estado de una llamada de soporte en curso.
type CallSession struct {
	CallSID         string `json:"call_sid"`
	TicketID        int64  `json:"ticket_id,omitempty"`
	FromNumber      string `json:"from_number"`
	ToNumber        string `json:"to_number"`
	Channel         string `json:"channel"`
	Status          string `json:"status"`
	Transcript      string `json:"transcript,omitempty"`
	LastUserMessage string `json:"last_user_message,omitempty"`
	LastAIAnswer    string `json:"last_ai_answer,omitempty"`
	Turns           int    `json:"turns"`
	StartedAt       string `json:"started_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
	EndedAt         string `json:"ended_at,omitempty"`
}

const callSessionSelectColumns = `
	call_sid, COALESCE(ticket_id, 0), COALESCE(from_number,''), COALESCE(to_number,''),
	COALESCE(channel,'voice'), COALESCE(status,'in_progress'), COALESCE(transcript,''),
	COALESCE(last_user_message,''), COALESCE(last_ai_answer,''), COALESCE(turns,0),
	COALESCE(to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
	COALESCE(to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
	COALESCE(to_char(ended_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),'')`

type callSessionScanner interface {
	Scan(dest ...any) error
}

func scanCallSession(row callSessionScanner) (CallSession, error) {
	var s CallSession
	if err := row.Scan(&s.CallSID, &s.TicketID, &s.FromNumber, &s.ToNumber, &s.Channel,
		&s.Status, &s.Transcript, &s.LastUserMessage, &s.LastAIAnswer, &s.Turns,
		&s.StartedAt, &s.UpdatedAt, &s.EndedAt); err != nil {
		return CallSession{}, err
	}
	return s, nil
}

// SetTwilioSupportChannels habilita los webhooks de Twilio para voz/WhatsApp.
// verifySignature debe quedar true en staging/prod.
func (h *Handler) SetTwilioSupportChannels(authToken, baseURL string, verifySignature bool, maxTurns int, sayLanguage, gatherLanguage string, gatherTimeoutSec int) {
	h.twilioAuthToken = strings.TrimSpace(authToken)
	h.twilioWebhookBaseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	h.twilioVerifySignature = verifySignature
	if maxTurns <= 0 || maxTurns > 20 {
		maxTurns = defaultVoiceAgentMaxTurns
	}
	h.voiceAgentMaxTurns = maxTurns
	h.voiceSayLanguage = cleanVoiceLanguage(sayLanguage, defaultVoiceSayLanguage)
	h.voiceGatherLanguage = cleanVoiceLanguage(gatherLanguage, defaultVoiceGatherLanguage)
	if gatherTimeoutSec <= 0 || gatherTimeoutSec > 20 {
		gatherTimeoutSec = defaultVoiceGatherTimeoutSec
	}
	h.voiceGatherTimeoutSec = gatherTimeoutSec
}

// SetPipecatVoiceAgent activa opcionalmente Twilio Media Streams hacia Pipecat.
// Sin URL wss o secreto HMAC, el handler conserva el flujo Gather como fallback.
func (h *Handler) SetPipecatVoiceAgent(mode, streamURL, streamSecret string) {
	h.voiceAgentMode = normalizeVoiceAgentMode(mode)
	h.pipecatStreamURL = cleanPipecatStreamURL(streamURL)
	h.pipecatStreamSecret = strings.TrimSpace(streamSecret)
}

func (h *Handler) handleTwilioVoice(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTwiML(w, h.voiceHangupResponse("Metodo no permitido."))
		return
	}
	form, ok := h.readTwilioForm(w, r)
	if !ok {
		return
	}
	callSID := cleanTicketField(form.Get("CallSid"), 80)
	if callSID == "" {
		writeTwiML(w, h.voiceHangupResponse("No pudimos identificar esta llamada."))
		return
	}
	from := cleanTicketField(form.Get("From"), 80)
	to := cleanTicketField(form.Get("To"), 80)
	channel := twilioCallChannel(from, to)
	if h.storeUsable() {
		if _, err := h.store.UpsertCallSession(r.Context(), callSID, from, to, channel, 0); err != nil {
			h.log.Error().Err(err).Str("call_sid", callSID).Msg("twilio call session start")
			writeTwiML(w, h.voiceHangupResponse("Soporte esta temporalmente no disponible. Intenta nuevamente en unos minutos."))
			return
		}
	}
	if h.voiceAgentMode == voiceAgentModePipecat {
		if h.pipecatStreamingEnabled() {
			writeTwiML(w, h.voicePipecatStreamResponse(callSID, channel))
			return
		}
		h.log.Warn().Str("call_sid", callSID).Msg("pipecat voice mode requested but ws url/secret missing; falling back to gather")
	}
	writeTwiML(w, h.voiceGatherResponse(r, "Hola, soy el agente de soporte de Mindbliss Power. Cuentame en una frase el problema de tu cuenta, pago, acceso, arbol o comisiones."))
}

func (h *Handler) handleTwilioVoiceProcess(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTwiML(w, h.voiceHangupResponse("Metodo no permitido."))
		return
	}
	form, ok := h.readTwilioForm(w, r)
	if !ok {
		return
	}
	callSID := cleanTicketField(form.Get("CallSid"), 80)
	if callSID == "" {
		writeTwiML(w, h.voiceHangupResponse("No pudimos identificar esta llamada."))
		return
	}
	from := cleanTicketField(form.Get("From"), 80)
	to := cleanTicketField(form.Get("To"), 80)
	channel := twilioCallChannel(from, to)
	userSpeech := cleanTicketText(form.Get("SpeechResult"), 1800)
	if userSpeech == "" {
		writeTwiML(w, h.voiceGatherResponse(r, "No alcance a escucharte. Describe el problema con tu cuenta, pago, acceso, arbol o comisiones."))
		return
	}
	if isVoiceDone(userSpeech) {
		if h.storeUsable() {
			if err := h.store.SetCallSessionStatus(r.Context(), callSID, "completed"); err != nil {
				h.log.Warn().Err(err).Str("call_sid", callSID).Msg("twilio call complete")
			}
		}
		writeTwiML(w, h.voiceHangupResponse("Gracias. Si ya abrimos un ticket, soporte continuara la revision."))
		return
	}
	triage := classifySupportTicket("Llamada de soporte", userSpeech)
	if !triage.SupportRequest {
		h.log.Info().Str("call_sid", callSID).Str("reason", triage.Reason).Msg("twilio voice ignored by deterministic support filter")
		writeTwiML(w, h.voiceGatherResponse(r, "Solo puedo atender solicitudes de soporte de Mindbliss Power. Si necesitas soporte, dime el problema de tu cuenta, pago, acceso, arbol o comisiones."))
		return
	}
	if !h.storeUsable() {
		writeTwiML(w, h.voiceHangupResponse("Soporte esta temporalmente no disponible. Intenta nuevamente en unos minutos."))
		return
	}

	ctx := r.Context()
	session, err := h.store.UpsertCallSession(ctx, callSID, from, to, channel, 0)
	if err != nil {
		h.log.Error().Err(err).Str("call_sid", callSID).Msg("twilio call session upsert")
		writeTwiML(w, h.voiceHangupResponse("Soporte esta temporalmente no disponible. Intenta nuevamente en unos minutos."))
		return
	}
	t, err := h.ensureCallTicket(ctx, session, callSID, from, to, channel, userSpeech)
	if err != nil {
		h.log.Error().Err(err).Str("call_sid", callSID).Msg("twilio call ticket")
		writeTwiML(w, h.voiceHangupResponse("No pude abrir tu ticket en este momento. Intenta nuevamente en unos minutos."))
		return
	}
	if session.TicketID > 0 {
		if updated, uerr := h.store.AppendTicketBody(ctx, t.ID, "Nuevo mensaje de llamada:\n"+userSpeech); uerr != nil {
			h.log.Warn().Err(uerr).Int64("ticket", t.ID).Msg("append voice ticket body")
		} else {
			t = updated
		}
	}

	answer := h.voiceFallbackAnswer(t.ID)
	if h.supportAIURL != "" && h.supportAIToken != "" {
		if res, aerr := h.callSupportAI(ctx, t); aerr != nil {
			h.log.Warn().Err(aerr).Int64("ticket", t.ID).Str("call_sid", callSID).Msg("twilio voice support ai")
			_, _ = h.store.SaveTicketAIDraft(ctx, t.ID, "error", "", aerr.Error(), nil)
		} else {
			answer = voiceAnswerText(res.Answer, t.ID, res.Escalate)
			status := "drafted"
			if res.Escalate {
				status = "escalate"
			}
			if _, serr := h.store.SaveTicketAIDraft(ctx, t.ID, status, res.Answer, "", res.Sources); serr != nil {
				h.log.Warn().Err(serr).Int64("ticket", t.ID).Msg("save voice ai draft")
			}
		}
	}

	nextStatus := "in_progress"
	if session.Turns+1 >= h.maxVoiceTurns() {
		nextStatus = "completed"
		answer += " Dejare este ticket abierto para que el equipo de soporte lo revise."
	}
	session, err = h.store.AppendCallTurn(ctx, callSID, userSpeech, answer, nextStatus)
	if err != nil {
		h.log.Warn().Err(err).Str("call_sid", callSID).Msg("append voice transcript")
	}
	if nextStatus == "completed" {
		writeTwiML(w, h.voiceHangupResponse(answer))
		return
	}
	writeTwiML(w, h.voiceGatherResponse(r, answer+" Puedes agregar otro detalle o decir finalizar."))
}

func (h *Handler) handleTwilioVoiceStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	form, ok := h.readTwilioForm(w, r)
	if !ok {
		return
	}
	callSID := cleanTicketField(form.Get("CallSid"), 80)
	if callSID == "" || !h.storeUsable() {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	status := normalizeTwilioCallStatus(form.Get("CallStatus"))
	if status == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.store.SetCallSessionStatus(r.Context(), callSID, status); err != nil {
		h.log.Warn().Err(err).Str("call_sid", callSID).Str("status", status).Msg("twilio status callback")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) handleTwilioWhatsApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTwiML(w, emptyMessagingResponse())
		return
	}
	form, ok := h.readTwilioForm(w, r)
	if !ok {
		return
	}
	body := cleanTicketText(form.Get("Body"), 4000)
	from := cleanTicketField(form.Get("From"), 80)
	to := cleanTicketField(form.Get("To"), 80)
	messageSID := cleanTicketField(form.Get("MessageSid"), 120)
	profileName := cleanTicketField(form.Get("ProfileName"), 120)
	if body == "" || messageSID == "" {
		writeTwiML(w, emptyMessagingResponse())
		return
	}
	triage := classifySupportTicket("Mensaje WhatsApp", body)
	if !triage.SupportRequest {
		h.log.Info().Str("message_sid", messageSID).Str("reason", triage.Reason).Msg("twilio whatsapp ignored by deterministic support filter")
		writeTwiML(w, emptyMessagingResponse())
		return
	}
	if !h.storeUsable() {
		writeTwiML(w, messagingResponse("Soporte esta temporalmente no disponible. Intenta nuevamente en unos minutos."))
		return
	}

	ticketBody := fmt.Sprintf("Canal: WhatsApp\nFrom: %s\nTo: %s\nNombre WhatsApp: %s\nMessageSid: %s\n\nMensaje:\n%s",
		from, to, profileName, messageSID, body)
	t, err := h.store.CreateTicketWithSource(r.Context(), pseudoSupportEmail("whatsapp", from, messageSID), supportSubject(body, "Mensaje WhatsApp"), ticketBody, "whatsapp", "twilio-wa:"+messageSID)
	if err != nil {
		h.log.Error().Err(err).Str("message_sid", messageSID).Msg("twilio whatsapp ticket")
		writeTwiML(w, messagingResponse("No pude abrir tu ticket en este momento. Intenta nuevamente en unos minutos."))
		return
	}
	if _, aerr := h.store.AutoAssignTicket(r.Context(), t.ID); aerr != nil && !errors.Is(aerr, ErrNoSupportAgent) {
		h.log.Warn().Err(aerr).Int64("ticket", t.ID).Msg("auto assign whatsapp ticket")
	}

	reply := fmt.Sprintf("Recibimos tu solicitud de soporte. Ticket #%d.", t.ID)
	if h.supportAIURL != "" && h.supportAIToken != "" {
		if drafted, derr := h.DraftTicketAI(r.Context(), t.ID); derr != nil {
			h.log.Warn().Err(derr).Int64("ticket", t.ID).Msg("whatsapp ai draft")
		} else if h.supportAIAutoReply && drafted.AIDraftStatus == "drafted" && strings.TrimSpace(drafted.AIDraftAnswer) != "" {
			reply = cleanTicketText(drafted.AIDraftAnswer, 1400)
		}
	}
	writeTwiML(w, messagingResponse(reply))
}

type internalVoiceTurnRequest struct {
	CallSID     string `json:"call_sid"`
	From        string `json:"from"`
	To          string `json:"to"`
	Channel     string `json:"channel"`
	UserMessage string `json:"user_message"`
	AIAnswer    string `json:"ai_answer"`
	Final       bool   `json:"final"`
}

func (h *Handler) handleInternalVoiceTurn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	if !h.storeUsable() {
		writeErr(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTwilioWebhookBody)
	var req internalVoiceTurnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	callSID := cleanTicketField(req.CallSID, 80)
	userMessage := cleanTicketText(req.UserMessage, 1800)
	if callSID == "" || userMessage == "" {
		writeErr(w, http.StatusBadRequest, "call_sid_and_user_message_required")
		return
	}
	from := cleanTicketField(req.From, 80)
	to := cleanTicketField(req.To, 80)
	channel := normalizeCallChannel(req.Channel)
	if channel == "voice" && (strings.HasPrefix(strings.ToLower(from), "whatsapp:") || strings.HasPrefix(strings.ToLower(to), "whatsapp:")) {
		channel = "whatsapp_call"
	}
	aiAnswer := cleanTicketText(req.AIAnswer, 1800)
	nextStatus := "in_progress"
	if req.Final {
		nextStatus = "completed"
	}

	ctx := r.Context()
	session, err := h.store.UpsertCallSession(ctx, callSID, from, to, channel, 0)
	if err != nil {
		h.log.Error().Err(err).Str("call_sid", callSID).Msg("pipecat call session upsert")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	triage := classifySupportTicket("Llamada de soporte Pipecat", userMessage)
	supportRequest := triage.SupportRequest || session.TicketID > 0
	var ticketID int64
	if supportRequest {
		t, terr := h.ensureCallTicket(ctx, session, callSID, from, to, channel, userMessage)
		if terr != nil {
			h.log.Error().Err(terr).Str("call_sid", callSID).Msg("pipecat call ticket")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		ticketID = t.ID
		if session.TicketID > 0 {
			if updated, uerr := h.store.AppendTicketBody(ctx, t.ID, "Nuevo mensaje de llamada Pipecat:\n"+userMessage); uerr != nil {
				h.log.Warn().Err(uerr).Int64("ticket", t.ID).Msg("append pipecat voice ticket body")
			} else {
				t = updated
			}
		}
		if aiAnswer != "" {
			status := "drafted"
			if containsAnyKeyword(normalizeSupportText(aiAnswer), []string{"agente", "soporte humano", "revision manual", "escalar"}) {
				status = "escalate"
			}
			if _, serr := h.store.SaveTicketAIDraft(ctx, t.ID, status, aiAnswer, "", nil); serr != nil {
				h.log.Warn().Err(serr).Int64("ticket", t.ID).Msg("save pipecat ai draft")
			}
		}
	} else {
		h.log.Info().Str("call_sid", callSID).Str("reason", triage.Reason).Msg("pipecat voice ignored by deterministic support filter")
	}
	if aiAnswer == "" {
		aiAnswer = "Turno registrado."
	}
	session, err = h.store.AppendCallTurn(ctx, callSID, userMessage, aiAnswer, nextStatus)
	if err != nil {
		h.log.Warn().Err(err).Str("call_sid", callSID).Msg("append pipecat voice transcript")
	}
	if ticketID == 0 {
		ticketID = session.TicketID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ticket_id":       ticketID,
		"support_request": supportRequest,
		"category":        triage.Category,
		"priority":        triage.Priority,
		"status":          session.Status,
	})
}

func (h *Handler) ensureCallTicket(ctx context.Context, session CallSession, callSID, from, to, channel, speech string) (Ticket, error) {
	if session.TicketID > 0 {
		return h.store.GetTicket(ctx, session.TicketID)
	}
	source := "voice"
	channelLabel := "Llamada telefonica"
	if channel == "whatsapp_call" {
		source = "whatsapp_call"
		channelLabel = "Llamada WhatsApp"
	}
	body := fmt.Sprintf("Canal: %s\nFrom: %s\nTo: %s\nCallSid: %s\n\nMensaje inicial:\n%s",
		channelLabel, from, to, callSID, speech)
	t, err := h.store.CreateTicketWithSource(ctx, pseudoSupportEmail(source, from, callSID), supportSubject(speech, channelLabel), body, source, "twilio-call:"+callSID)
	if err != nil {
		return Ticket{}, err
	}
	if _, aerr := h.store.AutoAssignTicket(ctx, t.ID); aerr != nil && !errors.Is(aerr, ErrNoSupportAgent) {
		h.log.Warn().Err(aerr).Int64("ticket", t.ID).Msg("auto assign voice ticket")
	}
	if _, err := h.store.UpsertCallSession(ctx, callSID, from, to, channel, t.ID); err != nil {
		return Ticket{}, err
	}
	return t, nil
}

func (h *Handler) readTwilioForm(w http.ResponseWriter, r *http.Request) (url.Values, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxTwilioWebhookBody)
	if err := r.ParseForm(); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_form")
		return nil, false
	}
	if !h.verifyTwilioWebhook(r, r.PostForm) {
		h.log.Warn().Str("path", r.URL.Path).Msg("twilio signature verification failed")
		writeErr(w, http.StatusForbidden, "invalid_signature")
		return nil, false
	}
	return r.PostForm, true
}

func (h *Handler) verifyTwilioWebhook(r *http.Request, params url.Values) bool {
	if !h.twilioVerifySignature {
		return true
	}
	if h.twilioAuthToken == "" {
		return false
	}
	return validateTwilioSignature(h.twilioAuthToken, h.twilioPublicURL(r), r.Header.Get("X-Twilio-Signature"), params)
}

func validateTwilioSignature(authToken, publicURL, signature string, params url.Values) bool {
	signature = strings.TrimSpace(signature)
	if authToken == "" || publicURL == "" || signature == "" {
		return false
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(publicURL)
	for _, k := range keys {
		vals := append([]string(nil), params[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			b.WriteString(k)
			b.WriteString(v)
		}
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	_, _ = mac.Write([]byte(b.String()))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

func (h *Handler) twilioPublicURL(r *http.Request) string {
	if h.twilioWebhookBaseURL != "" {
		return h.twilioWebhookBaseURL + r.URL.RequestURI()
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xfp := firstForwardedValue(r.Header.Get("X-Forwarded-Proto")); xfp != "" && fromTrustedProxy(r.RemoteAddr) {
		scheme = xfp
	}
	host := r.Host
	if xfh := firstForwardedValue(r.Header.Get("X-Forwarded-Host")); xfh != "" && fromTrustedProxy(r.RemoteAddr) {
		host = xfh
	}
	return scheme + "://" + host + r.URL.RequestURI()
}

func (h *Handler) twilioBaseURL(r *http.Request) string {
	u := h.twilioPublicURL(r)
	if reqURI := r.URL.RequestURI(); reqURI != "" && strings.HasSuffix(u, reqURI) {
		return strings.TrimRight(strings.TrimSuffix(u, reqURI), "/")
	}
	if parsed, err := url.Parse(u); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		return parsed.Scheme + "://" + parsed.Host
	}
	return strings.TrimRight(h.twilioWebhookBaseURL, "/")
}

func (h *Handler) voiceGatherResponse(r *http.Request, message string) string {
	action := h.twilioBaseURL(r) + "/api/support/voice/twilio/process"
	return `<Response>` +
		twimlSay(message, h.voiceSayLanguage) +
		`<Gather input="speech" method="POST" action="` + html.EscapeString(action) + `" language="` + html.EscapeString(h.voiceGatherLanguage) + `" speechTimeout="auto" timeout="` + strconv.Itoa(h.voiceGatherTimeout()) + `">` +
		`</Gather>` +
		twimlSay("No recibi respuesta. Intentalo de nuevo.", h.voiceSayLanguage) +
		`<Redirect method="POST">` + xmlText(action) + `</Redirect>` +
		`</Response>`
}

func (h *Handler) pipecatStreamingEnabled() bool {
	return h.voiceAgentMode == voiceAgentModePipecat && h.pipecatStreamURL != "" && h.pipecatStreamSecret != ""
}

func (h *Handler) voicePipecatStreamResponse(callSID, channel string) string {
	channel = normalizeCallChannel(channel)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signPipecatStream(h.pipecatStreamSecret, callSID, ts, channel)
	return `<Response><Connect><Stream url="` + html.EscapeString(h.pipecatStreamURL) + `">` +
		twimlParameter("mb_call_sid", callSID) +
		twimlParameter("mb_channel", channel) +
		twimlParameter("mb_ts", ts) +
		twimlParameter("mb_sig", sig) +
		`</Stream></Connect></Response>`
}

func twimlParameter(name, value string) string {
	return `<Parameter name="` + html.EscapeString(name) + `" value="` + html.EscapeString(value) + `"/>`
}

func signPipecatStream(secret, callSID, ts, channel string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(pipecatStreamSignaturePayload(callSID, ts, channel)))
	return hex.EncodeToString(mac.Sum(nil))
}

func pipecatStreamSignaturePayload(callSID, ts, channel string) string {
	return cleanTicketField(callSID, 80) + "|" + strings.TrimSpace(ts) + "|" + normalizeCallChannel(channel)
}

func (h *Handler) voiceHangupResponse(message string) string {
	return `<Response>` + twimlSay(message, h.voiceSayLanguage) + `<Hangup/></Response>`
}

func messagingResponse(message string) string {
	return `<Response><Message>` + xmlText(cleanTicketText(message, 1400)) + `</Message></Response>`
}

func emptyMessagingResponse() string {
	return `<Response></Response>`
}

func writeTwiML(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

func twimlSay(message, language string) string {
	return `<Say language="` + html.EscapeString(cleanVoiceLanguage(language, defaultVoiceSayLanguage)) + `">` + xmlText(cleanTicketText(message, 1400)) + `</Say>`
}

func xmlText(value string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(value))
	return b.String()
}

func firstForwardedValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if i := strings.IndexByte(value, ','); i >= 0 {
		value = value[:i]
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func cleanVoiceLanguage(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return fallback
	}
	return value
}

func normalizeVoiceAgentMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case voiceAgentModePipecat:
		return voiceAgentModePipecat
	default:
		return defaultVoiceAgentMode
	}
}

func cleanPipecatStreamURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "wss" || u.Host == "" {
		return ""
	}
	u.User = nil
	u.Fragment = ""
	return u.String()
}

func (h *Handler) voiceGatherTimeout() int {
	if h.voiceGatherTimeoutSec > 0 {
		return h.voiceGatherTimeoutSec
	}
	return defaultVoiceGatherTimeoutSec
}

func (h *Handler) maxVoiceTurns() int {
	if h.voiceAgentMaxTurns > 0 {
		return h.voiceAgentMaxTurns
	}
	return defaultVoiceAgentMaxTurns
}

func (h *Handler) storeUsable() bool {
	return h != nil && h.store != nil && h.store.db != nil
}

func twilioCallChannel(from, to string) string {
	if strings.HasPrefix(strings.ToLower(from), "whatsapp:") || strings.HasPrefix(strings.ToLower(to), "whatsapp:") {
		return "whatsapp_call"
	}
	return "voice"
}

func normalizeTwilioCallStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "completed":
		return "completed"
	case "failed":
		return "failed"
	case "busy":
		return "busy"
	case "no-answer", "no_answer":
		return "no_answer"
	case "canceled", "cancelled":
		return "canceled"
	default:
		return ""
	}
}

func isVoiceDone(speech string) bool {
	text := normalizeSupportText(speech)
	return containsAnyKeyword(text, []string{
		"finalizar", "terminar", "colgar", "gracias", "eso es todo", "nada mas", "no gracias",
	})
}

func supportSubject(message, fallback string) string {
	message = cleanTicketField(message, 120)
	if message == "" {
		return fallback
	}
	return fallback + ": " + message
}

func voiceAnswerText(answer string, ticketID int64, escalate bool) string {
	answer = cleanTicketText(answer, 1100)
	if answer == "" || escalate {
		return fmt.Sprintf("Recibi tu solicitud y abri el ticket numero %d. Un agente de soporte revisara el caso.", ticketID)
	}
	return fmt.Sprintf("%s Ticket numero %d.", answer, ticketID)
}

func (h *Handler) voiceFallbackAnswer(ticketID int64) string {
	return fmt.Sprintf("Recibi tu solicitud y abri el ticket numero %d. Un agente de soporte la revisara.", ticketID)
}

func pseudoSupportEmail(prefix, primary, fallback string) string {
	local := strings.ToLower(strings.TrimSpace(primary))
	local = strings.TrimPrefix(local, "whatsapp:")
	local = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}
		return '-'
	}, local)
	local = strings.Trim(local, "-")
	if local == "" {
		local = strings.ToLower(strings.TrimSpace(fallback))
		local = strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				return r
			}
			return '-'
		}, local)
		local = strings.Trim(local, "-")
	}
	if len(local) > 44 {
		h := fnv.New32a()
		_, _ = h.Write([]byte(primary + ":" + fallback))
		local = local[:32] + "-" + strconv.FormatUint(uint64(h.Sum32()), 36)
	}
	if local == "" {
		local = "unknown"
	}
	prefix = strings.Trim(strings.ToLower(prefix), "-")
	if prefix == "" {
		prefix = "support"
	}
	return prefix + "+" + local + "@support.mindblisspower.local"
}

func (s *Store) UpsertCallSession(ctx context.Context, callSID, from, to, channel string, ticketID int64) (CallSession, error) {
	callSID = cleanTicketField(callSID, 80)
	from = cleanTicketField(from, 80)
	to = cleanTicketField(to, 80)
	channel = normalizeCallChannel(channel)
	if callSID == "" {
		return CallSession{}, fmt.Errorf("call_sid required")
	}
	return scanCallSession(s.db.QueryRow(ctx, `
		INSERT INTO support.call_session (call_sid, from_number, to_number, channel, ticket_id)
		VALUES ($1, $2, $3, $4, NULLIF($5, 0))
		ON CONFLICT (call_sid) DO UPDATE SET
			from_number = COALESCE(NULLIF(EXCLUDED.from_number, ''), support.call_session.from_number),
			to_number = COALESCE(NULLIF(EXCLUDED.to_number, ''), support.call_session.to_number),
			channel = EXCLUDED.channel,
			ticket_id = COALESCE(EXCLUDED.ticket_id, support.call_session.ticket_id),
			status = CASE
				WHEN support.call_session.status IN ('completed','failed','busy','no_answer','canceled') THEN support.call_session.status
				ELSE 'in_progress'
			END
		RETURNING `+callSessionSelectColumns,
		callSID, from, to, channel, ticketID))
}

func (s *Store) AppendCallTurn(ctx context.Context, callSID, userMessage, aiAnswer, status string) (CallSession, error) {
	callSID = cleanTicketField(callSID, 80)
	userMessage = cleanTicketText(userMessage, 1800)
	aiAnswer = cleanTicketText(aiAnswer, 1800)
	status = normalizeCallSessionStatus(status)
	if callSID == "" {
		return CallSession{}, fmt.Errorf("call_sid required")
	}
	turn := cleanTicketText("Usuario: "+userMessage+"\nAgente IA: "+aiAnswer, 4200)
	return scanCallSession(s.db.QueryRow(ctx, `
		UPDATE support.call_session
		   SET transcript = CASE WHEN transcript = '' THEN $2 ELSE left(transcript || E'\n\n' || $2, 30000) END,
		       last_user_message = $3,
		       last_ai_answer = $4,
		       turns = turns + 1,
		       status = $5,
		       ended_at = CASE WHEN $5 <> 'in_progress' THEN COALESCE(ended_at, now()) ELSE ended_at END
		 WHERE call_sid = $1
		 RETURNING `+callSessionSelectColumns,
		callSID, turn, userMessage, aiAnswer, status))
}

func (s *Store) SetCallSessionStatus(ctx context.Context, callSID, status string) error {
	callSID = cleanTicketField(callSID, 80)
	status = normalizeCallSessionStatus(status)
	if callSID == "" || status == "" {
		return nil
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE support.call_session
		   SET status = $2,
		       ended_at = CASE WHEN $2 <> 'in_progress' THEN COALESCE(ended_at, now()) ELSE ended_at END
		 WHERE call_sid = $1`,
		callSID, status)
	if err != nil {
		return fmt.Errorf("set call session status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) AppendTicketBody(ctx context.Context, id int64, addition string) (Ticket, error) {
	addition = cleanTicketText(addition, 1800)
	if id <= 0 || addition == "" {
		return Ticket{}, fmt.Errorf("ticket/addition required")
	}
	t, err := scanTicket(s.db.QueryRow(ctx, `
		UPDATE support.ticket
		   SET body = right(body || E'\n\n' || $2, 5000)
		 WHERE id = $1
		 RETURNING `+ticketSelectColumns,
		id, addition))
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket %d no existe", id)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("append ticket body: %w", err)
	}
	return t, nil
}

func normalizeCallChannel(channel string) string {
	switch strings.ToLower(strings.TrimSpace(channel)) {
	case "whatsapp_call":
		return "whatsapp_call"
	default:
		return "voice"
	}
}

func normalizeCallSessionStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "failed", "busy", "no_answer", "canceled":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "in_progress"
	}
}
