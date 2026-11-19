import { expect, test } from 'bun:test';
import { recordWalletWidgetDiagnostic, walletWidgetDiagnostic } from './wallet-production-diagnostic';
test('only internally marked errors disclose the bounded diagnostic and preserve the original error identity', () => {
  const error = Error('wallet_production_forbidden'), cause = Error('private-cause'); (error as Error & { cause?: Error }).cause = cause;
  recordWalletWidgetDiagnostic(error, 'widget_finish', 403, { code: 'PROVIDER_REJECTED', serviceProviderDetails: { code: 'AUTH_REQUIRED', message: 'private' }, requestId: 'private' });
  expect(error.message).toBe('wallet_production_forbidden'); expect((error as Error & { cause?: Error }).cause).toBe(cause);
  expect(walletWidgetDiagnostic(error)).toEqual({ stage: 'widget_finish', upstreamStatus: 403, providerCode: 'PROVIDER_REJECTED', serviceProviderCode: 'AUTH_REQUIRED' });
  expect(Object.isFrozen(walletWidgetDiagnostic(error))).toBe(true);
  expect(walletWidgetDiagnostic({ diagnostic: { stage: 'widget_url', wallet: 'private' } })).toBeUndefined();
  expect(walletWidgetDiagnostic(Error('wallet_production_provider_unavailable'))).toBeUndefined();
});
test('hostile provider values, fake stages and invalid HTTP statuses cannot expose URLs, wallet addresses, identifiers or body fields', () => {
  for (const code of ['https://private.invalid/?token=secret', `0x${'a'.repeat(40)}`, `0X${'A'.repeat(40)}`, 'A'.repeat(64), 'private-code', 'X', 'X'.repeat(81)]) {
    const error = Error('wallet_production_provider_unavailable');
    recordWalletWidgetDiagnostic(error, 'widget_http', 700, { code, serviceProviderDetails: { code, walletAddress: 'private' }, customerId: 'private', message: 'private' });
    expect(walletWidgetDiagnostic(error)).toEqual({ stage: 'widget_http' });
  }
  const error = Error('wallet_production_provider_unavailable'); recordWalletWidgetDiagnostic(error, 'bad' as never, 200);
  expect(walletWidgetDiagnostic(error)).toBeUndefined();
});
