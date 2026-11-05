package comms

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var (
	ErrUnsubscribeInvalid = errors.New("token de baja inválido")
	ErrUnsubscribeExpired = errors.New("token de baja expirado")
)

// Token: base64url("<personID>|<expUnix>") + "." + base64url(HMAC-SHA256(secret, payload)).
func SignUnsubscribe(secret []byte, personID int64, expires time.Time) string {
	payload := fmt.Sprintf("%d|%d", personID, expires.Unix())
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func VerifyUnsubscribe(secret []byte, token string, now time.Time) (int64, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return 0, ErrUnsubscribeInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return 0, ErrUnsubscribeInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, ErrUnsubscribeInvalid
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return 0, ErrUnsubscribeInvalid
	}
	fields := strings.SplitN(string(payload), "|", 2)
	if len(fields) != 2 {
		return 0, ErrUnsubscribeInvalid
	}
	id, err1 := strconv.ParseInt(fields[0], 10, 64)
	exp, err2 := strconv.ParseInt(fields[1], 10, 64)
	if err1 != nil || err2 != nil || id <= 0 {
		return 0, ErrUnsubscribeInvalid
	}
	if now.Unix() > exp {
		return 0, ErrUnsubscribeExpired
	}
	return id, nil
}

func UnsubscribeURL(baseURL, token string) string {
	sep := "?"
	if strings.Contains(baseURL, "?") {
		sep = "&"
	}
	return baseURL + sep + "t=" + token
}
