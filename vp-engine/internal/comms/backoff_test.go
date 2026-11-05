package comms

import (
	"errors"
	"testing"
	"time"
)

func TestRetryDelay(t *testing.T) {
	cases := map[int]time.Duration{1: time.Minute, 2: 5 * time.Minute, 3: 25 * time.Minute, 4: -1}
	for attempt, want := range cases {
		if got := RetryDelay(attempt); got != want {
			t.Fatalf("RetryDelay(%d) = %v, want %v", attempt, got, want)
		}
	}
}

type fakeAPIErr struct {
	code   string
	status int
}

func (e fakeAPIErr) Error() string       { return e.code }
func (e fakeAPIErr) ErrorCode() string   { return e.code }
func (e fakeAPIErr) HTTPStatusCode() int { return e.status }

func TestIsTransientSESError(t *testing.T) {
	if !IsTransientSESError(fakeAPIErr{"TooManyRequestsException", 429}) {
		t.Fatal("throttle should be transient")
	}
	if !IsTransientSESError(fakeAPIErr{"InternalFailure", 500}) {
		t.Fatal("5xx should be transient")
	}
	if IsTransientSESError(fakeAPIErr{"AccessDeniedException", 403}) {
		t.Fatal("403 should be permanent")
	}
	if IsTransientSESError(fakeAPIErr{"BadRequestException", 400}) {
		t.Fatal("400 should be permanent")
	}
	if !IsTransientSESError(errors.New("context deadline exceeded")) {
		t.Fatal("timeout should be transient")
	}
	if IsTransientSESError(nil) {
		t.Fatal("nil is not an error")
	}
}
