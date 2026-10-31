package payments

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

func TestNOWCaptureWakeupNeedsDurableChangeAndFinishedOrRiskEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, signed, api string
		queued, want      bool
	}{
		{"new_finished", "finished", "finished", true, true},
		{"new_advanced_finished", "confirmed", "finished", true, true},
		{"duplicate_finished", "finished", "finished", false, false},
		{"enqueue_failure_or_unknown_order", "finished", "finished", false, false},
		{"new_waiting", "waiting", "waiting", true, false},
		{"new_confirming", "confirming", "confirmed", true, false},
		{"new_sending", "confirmed", "sending", true, false},
		{"new_refund", "refunded", "refunded", true, true},
		{"new_risk_snapshot", "failed", "waiting", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &Handler{}
			calls := 0
			h.SetNOWOperationalJobRunner(func(context.Context) (int, error) { calls++; return 0, nil })
			h.notifyNOWOperationalCapture(tc.queued, nowpayments.Payment{Status: tc.signed}, nowpayments.Payment{Status: tc.api})
			select {
			case <-h.NOWOperationalJobWakeups():
				if !tc.want {
					t.Fatal("unexpected worker pulse")
				}
			default:
				if tc.want {
					t.Fatal("durable finished/risk capture did not wake worker")
				}
			}
			if calls != 0 {
				t.Fatal("notification executed financial work inline")
			}
		})
	}
	// Inactive configuration has no channel and cannot start a financial worker.
	h := &Handler{}
	h.notifyNOWOperationalCapture(true, nowpayments.Payment{Status: "finished"}, nowpayments.Payment{Status: "finished"})
	if h.NOWOperationalJobWakeups() != nil {
		t.Fatal("disabled worker acquired a notification channel")
	}
}

func TestNOWCaptureWakeupCoalescesConcurrentBurstsWithoutBlocking(t *testing.T) {
	h := &Handler{}
	h.SetNOWOperationalJobRunner(func(context.Context) (int, error) { return 0, nil })
	var wg sync.WaitGroup
	for range 100 {
		wg.Go(func() {
			h.notifyNOWOperationalCapture(true, nowpayments.Payment{Status: "finished"}, nowpayments.Payment{Status: "finished"})
		})
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("notification burst blocked webhook senders")
	}
	if len(h.nowJobs.wake) != 1 || cap(h.nowJobs.wake) != 1 {
		t.Fatal("unbounded pending worker notifications")
	}
	<-h.NOWOperationalJobWakeups()
	h.notifyNOWOperationalCapture(true, nowpayments.Payment{Status: "finished"}, nowpayments.Payment{Status: "finished"})
	select {
	case <-h.NOWOperationalJobWakeups():
	default:
		t.Fatal("worker missed a new capture after draining previous pulse")
	}
}

func BenchmarkNOWCaptureWakeupCoalesced(b *testing.B) {
	h := &Handler{}
	h.SetNOWOperationalJobRunner(func(context.Context) (int, error) { return 0, nil })
	payment := nowpayments.Payment{Status: "finished"}
	b.ReportAllocs()
	for b.Loop() {
		h.notifyNOWOperationalCapture(true, payment, payment)
	}
}
