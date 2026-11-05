package comms

import (
	"context"
	"errors"
	"net"
	"time"
)

const MaxAttempts = 3

// RetryDelay: espera antes del siguiente intento (1m, 5m, 25m). -1 = no reintentar.
func RetryDelay(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Minute
	case 2:
		return 5 * time.Minute
	case 3:
		return 25 * time.Minute
	}
	return -1
}

type apiErrCoder interface{ ErrorCode() string }
type apiErrStatus interface{ HTTPStatusCode() int }

// IsTransientSESError: throttling, 5xx, timeouts y errores de red se reintentan;
// 4xx (AccessDenied, MessageRejected, BadRequest) no.
func IsTransientSESError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || err.Error() == "context deadline exceeded" {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	var st apiErrStatus
	if errors.As(err, &st) {
		code := st.HTTPStatusCode()
		if code == 429 || code >= 500 {
			return true
		}
		if code >= 400 {
			return false
		}
	}
	var c apiErrCoder
	if errors.As(err, &c) {
		switch c.ErrorCode() {
		case "TooManyRequestsException", "Throttling", "ThrottlingException", "SendingPausedException", "LimitExceededException":
			return true
		}
	}
	return false
}
