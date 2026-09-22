package payments

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type QueueMessage struct{ ID, ReceiptHandle, Body string }

type QueueClient interface {
	Receive(ctx context.Context, max int, waitSec int) ([]QueueMessage, error)
	Delete(ctx context.Context, receiptHandle string) error
}

type sqsQueueClient struct {
	c   *sqs.Client
	url string
}

func NewSQSQueueClient(ctx context.Context, queueURL string) (QueueClient, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return &sqsQueueClient{c: sqs.NewFromConfig(cfg), url: queueURL}, nil
}

func (q *sqsQueueClient) Receive(ctx context.Context, max, waitSec int) ([]QueueMessage, error) {
	out, err := q.c.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: aws.String(q.url), MaxNumberOfMessages: int32(max), WaitTimeSeconds: int32(waitSec), VisibilityTimeout: 60,
	})
	if err != nil {
		return nil, err
	}
	msgs := make([]QueueMessage, 0, len(out.Messages))
	for _, m := range out.Messages {
		msgs = append(msgs, QueueMessage{ID: aws.ToString(m.MessageId), ReceiptHandle: aws.ToString(m.ReceiptHandle), Body: aws.ToString(m.Body)})
	}
	return msgs, nil
}

func (q *sqsQueueClient) Delete(ctx context.Context, rh string) error {
	_, err := q.c.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(q.url), ReceiptHandle: aws.String(rh)})
	return err
}

type CommsEventConsumer struct {
	store *Store
	q     QueueClient
	log   zerolog.Logger
}

func NewCommsEventConsumer(store *Store, q QueueClient, log zerolog.Logger) *CommsEventConsumer {
	return &CommsEventConsumer{store: store, q: q, log: log}
}

func (ec *CommsEventConsumer) Loop(ctx context.Context) {
	ec.log.Info().Msg("comms event consumer started")
	for {
		if _, err := ec.RunOnce(ctx); err != nil {
			ec.log.Error().Err(err).Msg("comms event consumer RunOnce failed (non-fatal)")
			select {
			case <-ctx.Done():
				return
			case <-time.After(10 * time.Second):
			}
		}
		if ctx.Err() != nil {
			ec.log.Info().Msg("comms event consumer stopped")
			return
		}
	}
}

// RunOnce: long-poll (20 s) de hasta 10 mensajes; cada mensaje se borra siempre
// (los no relacionados con campañas o corruptos se descartan sin reintento).
func (ec *CommsEventConsumer) RunOnce(ctx context.Context) (int, error) {
	msgs, err := ec.q.Receive(ctx, 10, 20)
	if err != nil {
		return 0, fmt.Errorf("sqs receive: %w", err)
	}
	for _, m := range msgs {
		if _, perr := ec.ProcessBody(ctx, []byte(m.Body)); perr != nil {
			ec.log.Warn().Err(perr).Str("msg", m.ID).Msg("comms event skipped")
		}
		if derr := ec.q.Delete(ctx, m.ReceiptHandle); derr != nil {
			ec.log.Warn().Err(derr).Str("msg", m.ID).Msg("sqs delete failed")
		}
	}
	return len(msgs), nil
}

func (ec *CommsEventConsumer) ProcessBody(ctx context.Context, body []byte) (bool, error) {
	ev, err := comms.ParseSESEvent(body)
	if err != nil {
		return false, err
	}
	cid, pid, email, found, err := ec.store.RecipientByMessageID(ctx, ev.MessageID)
	if err != nil || !found {
		return false, err
	}
	switch ev.Type {
	case "Delivery":
		err = ec.store.MarkRecipient(ctx, cid, pid, "delivered", "")
	case "Bounce":
		if ev.Permanent {
			if err = ec.store.MarkRecipient(ctx, cid, pid, "bounced", ev.Diagnostic); err == nil {
				err = ec.store.AddSuppressed(ctx, email, "bounce_permanent")
			}
		} else {
			err = ec.store.MarkRecipient(ctx, cid, pid, "sent", "bounce_transient: "+ev.Diagnostic)
		}
	case "Complaint":
		if err = ec.store.MarkRecipient(ctx, cid, pid, "complained", ev.Diagnostic); err == nil {
			err = ec.store.AddUnsubscribe(ctx, email, &pid, "complaint")
		}
	default:
		return true, nil
	}
	if err != nil {
		return true, err
	}
	if ev.Type == "Bounce" {
		if perr := ec.maybePauseForBounceRate(ctx, cid); perr != nil {
			return true, perr
		}
	}
	return true, ec.store.RefreshCampaignCounters(ctx, cid)
}

func (ec *CommsEventConsumer) maybePauseForBounceRate(ctx context.Context, cid int64) error {
	c, err := ec.store.GetCampaign(ctx, cid)
	if err != nil {
		return err
	}
	// +1 por el rebote que acabamos de aplicar (los contadores aún no se refrescan)
	bounced := c.BouncedCount + 1
	if c.Status == "sending" && c.SentCount >= 1000 && bounced*100 > c.SentCount*5 {
		if err := ec.store.SetCampaignStatus(ctx, cid, []string{"sending"}, "paused", "bounce_rate"); err != nil {
			return err
		}
		ec.store.cache.PublishEvent(ctx, "comms.campaign_paused", map[string]any{"campaign_id": cid, "reason": "bounce_rate"})
		ec.log.Warn().Int64("campaign", cid).Int("sent", c.SentCount).Int("bounced", bounced).Msg("comms: campaign paused by bounce rate")
	}
	return nil
}
