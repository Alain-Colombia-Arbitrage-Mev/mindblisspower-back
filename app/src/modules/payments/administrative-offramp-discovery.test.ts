import { expect, test } from 'bun:test';
import { administrativeOfframpRoutes, readAdministrativeOfframpOptions } from './administrative-offramp-discovery';

const environment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key' };
const route = (change = {}) => ({ partner: 'TRANSAK', source: 'USDT_POLYGON', destination: 'MXN',
  paymentMethods: [{ name: 'PAYOUT_TO_CARD', checkoutSupported: true, limits: { currencyCode: 'MXN', min: 187, max: 466480 } }], ...change });

test('offramp discovers crypto-to-fiat ordering and preserves provider fiat limit units', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), init }); return Response.json([route()]); }) as typeof fetch;
  const result = await readAdministrativeOfframpOptions({ country: 'MX', destinationCurrencyCode: 'MXN' }, { environment, fetchImpl });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_OFFRAMP/MX/USDT_POLYGON/MXN');
  expect(calls[0]?.init?.method).toBe('GET');
  expect(result.routes[0]?.paymentMethods[0]).toEqual({ method: 'PAYOUT_TO_CARD', currencyCode: 'MXN', minimumAmount: 187, maximumAmount: 466480 });
  expect(result.execution).toEqual({ canCreateSession: false, canTransfer: false, reason: 'discovery_only' });
  expect(JSON.stringify(result)).not.toContain(environment.MELD_API_SANDBOX);
});

test('all advertised providers and payout methods are retained without fabricating unavailable ones', () => {
  const value = [route(), route({ partner: 'BANXA', paymentMethods: [{ name: 'LOCAL_BANK_TRANSFER', limits: { currencyCode: 'USDT_POLYGON', min: 10, max: 1000 } }] })];
  expect(administrativeOfframpRoutes(value, 'MXN').map(row => row.serviceProvider)).toEqual(['TRANSAK', 'BANXA']);
  expect(administrativeOfframpRoutes([], 'COP')).toEqual([]);
  expect(administrativeOfframpRoutes([route({ checkoutSupported: false })], 'MXN')).toEqual([]);
});

test('wrong network, currency and ambiguous method limits fail closed', () => {
  expect(() => administrativeOfframpRoutes([route({ source: 'USDT' })], 'MXN')).toThrow();
  expect(() => administrativeOfframpRoutes([route({ destination: 'USD' })], 'MXN')).toThrow();
  expect(() => administrativeOfframpRoutes([route({ paymentMethods: [{ name: 'PAYOUT_TO_CARD', limits: { currencyCode: 'EUR', min: 1, max: 10 } }] })], 'MXN')).toThrow();
  expect(() => administrativeOfframpRoutes([route(), route({ paymentMethods: [{ name: 'PAYOUT_TO_CARD', limits: { currencyCode: 'MXN', min: 200, max: 466480 } }] })], 'MXN')).toThrow();
});

test('invalid country, fiat, extra address and disabled sandbox cannot call MELD', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw Error('not_expected'); }) as unknown as typeof fetch;
  for (const input of [{ country: 'ZZ', destinationCurrencyCode: 'USD' }, { country: 'CO', destinationCurrencyCode: 'MXN' },
    { country: 'US', destinationCurrencyCode: 'USD', walletAddress: `0x${'a'.repeat(40)}` }]) {
    await expect(readAdministrativeOfframpOptions(input, { environment, fetchImpl })).rejects.toThrow();
  }
  await expect(readAdministrativeOfframpOptions({ country: 'US', destinationCurrencyCode: 'USD' }, { environment: {}, fetchImpl })).rejects.toThrow('offramp_unconfigured');
  expect(calls).toBe(0);
});

test('provider rejection and cancellation cause no retries or writes', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({ code: 'UNAUTHORIZED', secret: 'never_expose' }, { status: 401 }); }) as unknown as typeof fetch;
  await expect(readAdministrativeOfframpOptions({ country: 'US', destinationCurrencyCode: 'USD' }, { environment, fetchImpl })).rejects.toThrow('offramp_provider_unavailable');
  const controller = new AbortController(); controller.abort();
  await expect(readAdministrativeOfframpOptions({ country: 'US', destinationCurrencyCode: 'USD' }, { environment, fetchImpl, signal: controller.signal })).rejects.toThrow('offramp_provider_unavailable');
  expect(calls).toBe(1);
});
