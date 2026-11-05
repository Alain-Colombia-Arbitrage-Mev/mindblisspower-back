package comms

import (
	"bytes"
	"errors"
	"html/template"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/renderer/html"
)

type RenderInput struct {
	Subject      string
	BodyMarkdown string
	FirstName    string
	// UnsubscribeURL: enlace visible de baja del pie (obligatorio).
	UnsubscribeURL string
	// LegalName + PostalAddress: identidad legal del remitente en el pie.
	// Obligatorio por CAN-SPAM §7704(a)(5) y equivalentes; LegalName vacío es
	// un error de render (mejor no enviar que enviar sin identificación).
	// PostalAddress vacío es tolerado (se omite el separador).
	LegalName     string
	PostalAddress string
}

type Rendered struct{ Subject, HTML, Text string }

var (
	md = goldmark.New(goldmark.WithRendererOptions(html.WithHardWraps()))
	// Política: solo https/mailto en enlaces, sin imágenes remotas, sin estilos inline.
	policy = func() *bluemonday.Policy {
		p := bluemonday.NewPolicy()
		p.AllowElements("p", "br", "strong", "em", "b", "i", "u", "ul", "ol", "li", "h2", "h3", "blockquote", "hr")
		p.AllowAttrs("href").OnElements("a")
		p.AllowURLSchemes("https", "mailto")
		p.RequireNoFollowOnLinks(false)
		p.AddTargetBlankToFullyQualifiedLinks(true)
		return p
	}()
	// insecureLinkRe: destino de un enlace markdown con esquema prohibido.
	insecureLinkRe = regexp.MustCompile(`\]\(\s*(?i:http://|javascript:)[^)]*\)`)
	// insecureURLRe: cualquier otra aparición del esquema prohibido — autolink
	// (`<http://…>`) o URL desnuda en el texto. Importa porque el alternativo de
	// texto plano se construye del markdown crudo: sin este filtro, bluemonday
	// limpia el HTML pero el text/plain seguiría llevando el enlace (I9).
	insecureURLRe = regexp.MustCompile(`(?i:<\s*(?:http://|javascript:)[^>]*>|(?:http://|javascript:)[^\s<>)\]"']*)`)
)

const removedLinkMarker = "[enlace eliminado]"

// stripInsecureLinks deja el markdown sin ningún `http://` ni `javascript:`,
// en enlaces, autolinks o texto suelto.
func stripInsecureLinks(src string) string {
	src = insecureLinkRe.ReplaceAllString(src, "]()")
	return insecureURLRe.ReplaceAllString(src, removedLinkMarker)
}

const htmlTpl = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Subject}}</title></head>
<body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#e8e6e1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" style="max-width:600px;background:#141416;border:1px solid #2a2a2e;border-radius:12px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #2a2a2e"><span style="font-size:18px;font-weight:700;color:#D9B441;letter-spacing:.04em">MINDBLISS POWER</span></td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.55">
<p style="margin:0 0 16px">Hola{{if .FirstName}} {{.FirstName}}{{end}},</p>
{{.Body}}
</td></tr>
<tr><td style="padding:20px 28px;border-top:1px solid #2a2a2e;font-size:12px;line-height:1.5;color:#9a9891">
{{.LegalLine}}<br>
Recibes este correo porque eres miembro de Mindbliss Power. Si no lo ves en tu bandeja principal, revisa tu carpeta de spam y márcanos como remitente seguro.<br>
<a href="{{.UnsubscribeURL}}" style="color:#D9B441">Darse de baja</a> de los comunicados.
</td></tr></table></td></tr></table></body></html>`

var tpl = template.Must(template.New("mail").Parse(htmlTpl))

func Render(in RenderInput) (Rendered, error) {
	if strings.TrimSpace(in.UnsubscribeURL) == "" {
		return Rendered{}, errors.New("render: UnsubscribeURL requerido")
	}
	legal := strings.TrimSpace(in.LegalName)
	if legal == "" {
		return Rendered{}, errors.New("render: LegalName requerido (identificación legal del remitente en el pie)")
	}
	legalLine := legal
	if addr := strings.TrimSpace(in.PostalAddress); addr != "" {
		legalLine = legal + " · " + addr
	}
	src := stripInsecureLinks(in.BodyMarkdown)
	var buf bytes.Buffer
	if err := md.Convert([]byte(src), &buf); err != nil {
		return Rendered{}, err
	}
	safe := policy.SanitizeBytes(buf.Bytes())
	var out bytes.Buffer
	err := tpl.Execute(&out, map[string]any{
		"Subject":        in.Subject,
		"FirstName":      strings.TrimSpace(in.FirstName),
		"Body":           template.HTML(safe),
		"UnsubscribeURL": in.UnsubscribeURL,
		"LegalLine":      legalLine,
	})
	if err != nil {
		return Rendered{}, err
	}
	greeting := "Hola,"
	if n := strings.TrimSpace(in.FirstName); n != "" {
		greeting = "Hola " + n + ","
	}
	text := greeting + "\n\n" + strings.TrimSpace(src) + "\n\n--\n" +
		legalLine + "\n" +
		"Recibes este correo porque eres miembro de Mindbliss Power. Revisa tu carpeta de spam si no lo ves en tu bandeja principal.\n" +
		"Darse de baja: " + in.UnsubscribeURL + "\n"
	return Rendered{Subject: in.Subject, HTML: out.String(), Text: text}, nil
}
