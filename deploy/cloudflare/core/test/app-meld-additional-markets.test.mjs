import test from 'node:test';
import assert from 'node:assert/strict';
import { walletFundingRequest } from '../src/wallet-funding.mjs';

const env = { CORE_ENV: 'production', WALLET_FUNDING_ENABLED: 'true', APP_MELD_PRODUCTION_ENABLED: 'true' };
const headers = { origin: 'https://app.mindblisspower.com', 'x-mindbliss-funding-provider': 'meld',
  cookie: 'better-auth.session_token=synthetic', 'content-type': 'application/json' };
const path = 'https://auth.core.internal/api/member/wallet-funding/personal';
const testAddress = '0x' + '2'.repeat(40);

test('Core only admits the five additional country, currency and rail pairs for App MELD', () => {
  for (const [country, sourceCurrencyCode, paymentMethodType, amount] of [
    ['PE', 'PEN', 'LOCAL_BANK_TRANSFER', 100], ['AR', 'ARS', 'LOCAL_BANK_TRANSFER', 50_000], ['DE', 'EUR', 'SEPA', 50],
    ['KE', 'KES', 'MPESA', 2_000], ['VN', 'VND', 'VIETQR', 500_000],
  ]) {
    const readUrl = new URL(path + '/options?country=' + country + '&sourceCurrencyCode=' + sourceCurrencyCode);
    assert.equal(walletFundingRequest(new Request(readUrl, { headers }), readUrl, undefined, env, true), true);
    const input = { requestId: '2084d1a5-98e0-4a9e-badc-b2ad56cc661a', country, sourceCurrencyCode, paymentMethodType, amount,
      walletAddress: testAddress, serviceProvider: 'ONRAMPMONEY', destinationCurrencyCode: 'USDT_POLYGON' };
    const url = new URL(path + '/intent');
    function accepts(body, override = {}) {
      return walletFundingRequest(new Request(url, { method: 'POST', headers: { ...headers, ...override } }), url,
        new TextEncoder().encode(JSON.stringify(body)), env, true);
    }
    assert.equal(accepts(input), true);
    for (const changes of [{ country: 'CR' }, { sourceCurrencyCode: 'USD' }, { paymentMethodType: 'PIX' },
      { serviceProvider: 'MERCURYO' }, { amount: 1 }, { destinationCurrencyCode: 'USDC_ARBITRUM' }]) {
      assert.equal(accepts({ ...input, ...changes }), false);
    }
    assert.equal(accepts(input, { origin: 'https://wallet.mindblisspower.com' }), false);
    if (country === 'VN') assert.equal(accepts({ ...input, amount: amount + 0.01 }), false);
  }
});
