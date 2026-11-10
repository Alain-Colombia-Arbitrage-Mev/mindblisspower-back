import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { verifyMeldWebhook } from './meld-webhook';

const secret = 'synthetic-meld-webhook-secret-32-characters';
const publicUrl = 'https://app.mindblisspower.com/api/webhooks/meld';
const signatureTimestamp = '2026-11-10T15:00:00.000Z';
const now = Date.parse(signatureTimestamp);
const payload = JSON.stringify({
  eventType: 'TRANSACTION_CRYPTO_COMPLETE', eventId: 'event-1', timestamp: signatureTimestamp,
  accountId: 'account-1', profileId: 'profile-1', version: '2026-02-03',
  payload: { externalCustomerId: 'd8a4c010-cc33-44da-a297-8b3c6440f491', paymentTransactionId: 'payment-1',
    paymentTransactionStatus: 'SETTLED', transactionType: 'CRYPTO_PURCHASE' },
});
const signature = createHmac('sha256', secret).update(`${signatureTimestamp}.${publicUrl}.${payload}`).digest('base64url') + '=';

describe('Meld webhook proof', () => {
  test('authenticates the exact timestamp, public URL and raw body', () => {
    const result = verifyMeldWebhook({ rawBody: payload, signature, signatureTimestamp, secret, publicUrl,
      accountId: 'account-1', profileId: 'profile-1', now });
    expect(result.event.eventId).toBe('event-1');
    expect(result.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects replay, tampering and cross-profile events', () => {
    expect(() => verifyMeldWebhook({ rawBody: payload, signature, signatureTimestamp, secret, publicUrl,
      now: now + 301_000 })).toThrow('invalid_meld_signature');
    expect(() => verifyMeldWebhook({ rawBody: payload + ' ', signature, signatureTimestamp, secret, publicUrl, now }))
      .toThrow('invalid_meld_signature');
    expect(() => verifyMeldWebhook({ rawBody: payload, signature, signatureTimestamp, secret, publicUrl,
      profileId: 'different-profile', now })).toThrow('invalid_meld_profile');
  });
});
