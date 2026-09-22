package comms

import (
	"testing"
	"time"
)

func TestUnsubscribeRoundTrip(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	tok := SignUnsubscribe(secret, 4242, now.Add(180*24*time.Hour))
	id, err := VerifyUnsubscribe(secret, tok, now)
	if err != nil || id != 4242 {
		t.Fatalf("verify = %d, %v", id, err)
	}
}

func TestUnsubscribeExpired(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()
	tok := SignUnsubscribe(secret, 1, now.Add(-time.Minute))
	if _, err := VerifyUnsubscribe(secret, tok, now); err != ErrUnsubscribeExpired {
		t.Fatalf("err = %v, want expired", err)
	}
}

func TestUnsubscribeTamper(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()
	tok := SignUnsubscribe(secret, 1, now.Add(time.Hour))
	bad := "9" + tok[1:]
	if _, err := VerifyUnsubscribe(secret, bad, now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid", err)
	}
	if _, err := VerifyUnsubscribe([]byte("other"), tok, now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid (wrong secret)", err)
	}
	if _, err := VerifyUnsubscribe(secret, "garbage", now); err != ErrUnsubscribeInvalid {
		t.Fatalf("err = %v, want invalid (garbage)", err)
	}
}

func TestUnsubscribeURL(t *testing.T) {
	if got := UnsubscribeURL("https://app.mindblisspower.com/baja", "abc"); got != "https://app.mindblisspower.com/baja?t=abc" {
		t.Fatalf("url = %q", got)
	}
}
