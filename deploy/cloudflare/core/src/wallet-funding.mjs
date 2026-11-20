export const WALLET_FUNDING_PREFIX = '/api/member/wallet-funding';
export const WALLET_FUNDING_MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ORIGIN = 'https://app.mindblisspower.com';
const PERSONAL_ORIGINS = new Set(['https://mindblisspower.com', APP_ORIGIN, 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const ADMINISTRATIVE_ORIGIN = 'https://wallet.mindblisspower.com';
const PERSONAL_COUNTRIES = new Set(['US', 'MX', 'CO']);
const PROHIBITED_PERSONAL_METHODS = new Set(['NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL']);
// Temporary integration gate, separate from the user's permanently prohibited methods.
const UNAVAILABLE_PERSONAL_METHODS = new Set(['ASTROPAY']);
const MELD_CHECKOUT_PATH = `${WALLET_FUNDING_PREFIX}/administrative/checkout`;
const APP_MELD_HEADER = 'x-mindbliss-funding-provider';
const PERSONAL_INTENT = `${WALLET_FUNDING_PREFIX}/personal/intent`;
const PERSONAL_OPTIONS = `${WALLET_FUNDING_PREFIX}/personal/options`;
const PERSONAL_STATUS = `${WALLET_FUNDING_PREFIX}/personal/status`;
const HISTORY = `${WALLET_FUNDING_PREFIX}/history`;
const APP_MELD_FIELDS = new Set(['requestId', 'walletAddress', 'country', 'amount', 'sourceCurrencyCode',
  'paymentMethodType', 'serviceProvider', 'destinationCurrencyCode']);
const APP_MELD_PROVIDERS = new Set(['MERCURYO', 'ONRAMPMONEY', 'RAMPNOW', 'ALCHEMYPAY']);
// Core checks request shape. Provider eligibility and exact route bounds live in the API.
const APP_MELD_MARKETS = new Map([
  ['US:USD', { asset: 'USDC_POLYGON', min: 50, max: 15_000,
    methods: ['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'ACH', 'LOCAL_BANK_TRANSFER'] }],
  ['MX:USD', { asset: 'USDT_POLYGON', min: 50, max: 15_000, methods: ['CREDIT_DEBIT_CARD'] }],
  ['MX:MXN', { asset: 'USDT_POLYGON', min: 931, max: 1_000_000_000, methods: ['CREDIT_DEBIT_CARD', 'SPEI'] }],
  ['CO:COP', { asset: 'USDC_POLYGON', min: 170_000, max: 4_000_000, methods: ['PSE', 'LOCAL_BANK_TRANSFER'] }],
  ['BR:BRL', { asset: 'USDC_ARBITRUM', min: 50, max: 93_387.41, methods: ['PIX', 'CREDIT_DEBIT_CARD'] }],
  // Keep the App gateway shape in sync with app-meld-additional-markets.ts.
  ['PE:PEN', { asset: 'USDT_POLYGON', min: 19, max: 4500000,
    provider: 'ONRAMPMONEY', methods: ['LOCAL_BANK_TRANSFER'] }],
  ['AR:ARS', { asset: 'USDT_POLYGON', min: 25000, max: 6600000,
    provider: 'ONRAMPMONEY', methods: ['LOCAL_BANK_TRANSFER'] }],
  ['DE:EUR', { asset: 'USDT_POLYGON', min: 10, max: 100000,
    provider: 'ONRAMPMONEY', methods: ['SEPA'] }],
  ['KE:KES', { asset: 'USDT_POLYGON', min: 1850, max: 700000,
    provider: 'ONRAMPMONEY', methods: ['MPESA'] }],
  ['VN:VND', { asset: 'USDT_POLYGON', min: 55000, max: 450000000,
    provider: 'ONRAMPMONEY', methods: ['VIETQR'] }],
]);

export function walletFundingNamespace(path) {
  return path === WALLET_FUNDING_PREFIX || path.startsWith(`${WALLET_FUNDING_PREFIX}/`);
}

/** This is a response-format capability, never an ownership or payment grant. */
export function walletFundingContractHeaders(headers, url, fundingValidated) {
  if (!fundingValidated || headers.get(APP_MELD_HEADER) !== 'meld') headers.delete(APP_MELD_HEADER);
  const name = 'x-mindbliss-sandbox-contract';
  const administrative = [`${WALLET_FUNDING_PREFIX}/administrative/session`, `${WALLET_FUNDING_PREFIX}/administrative/status`,
    `${WALLET_FUNDING_PREFIX}/administrative/options`].includes(url.pathname)
    || (url.pathname === `${WALLET_FUNDING_PREFIX}/history` && url.search === '?walletKind=administrative');
  if (!administrative || headers.get(name) !== 'v2') headers.delete(name);
}

function appMeldFundingPath(url) {
  return [PERSONAL_OPTIONS, PERSONAL_STATUS, PERSONAL_INTENT].includes(url.pathname)
    || (url.pathname === HISTORY && url.search === '?walletKind=personal');
}

function appMeldFundingRequest(request, url, body) {
  if (request.method === 'GET') {
    if (url.pathname === PERSONAL_OPTIONS) {
      const country = url.searchParams.get('country'), currency = url.searchParams.get('sourceCurrencyCode');
      return APP_MELD_MARKETS.has(`${country}:${currency}`) && url.search === `?country=${country}&sourceCurrencyCode=${currency}`;
    }
    if (url.pathname === PERSONAL_STATUS) {
      const reference = url.searchParams.get('checkoutReference');
      return UUID.test(reference || '') && url.search === `?checkoutReference=${reference}`;
    }
    return url.pathname === HISTORY && url.search === '?walletKind=personal';
  }
  if (request.method !== 'POST' || url.pathname !== PERSONAL_INTENT || url.search
    || request.headers.has('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !body?.length || body.length > WALLET_FUNDING_MAX_BODY) return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !APP_MELD_FIELDS.has(key))) return false;
    const { requestId, walletAddress, country, sourceCurrencyCode = 'USD', amount,
      paymentMethodType, serviceProvider, destinationCurrencyCode } = input;
    if (typeof country !== 'string' || typeof sourceCurrencyCode !== 'string') return false;
    const market = APP_MELD_MARKETS.get(`${country}:${sourceCurrencyCode}`);
    return Boolean(market && typeof requestId === 'string' && UUID.test(requestId)
      && typeof walletAddress === 'string' && /^0x[a-f0-9]{40}$/i.test(walletAddress)
      && market.methods.includes(paymentMethodType)
      && (serviceProvider === undefined || (market.provider ? serviceProvider === market.provider : country === 'BR'
        ? serviceProvider === (paymentMethodType === 'PIX' ? 'ALCHEMYPAY' : 'MERCURYO')
        : APP_MELD_PROVIDERS.has(serviceProvider) && serviceProvider !== 'ALCHEMYPAY'))
      && (destinationCurrencyCode === undefined || destinationCurrencyCode === market.asset)
      && Number.isFinite(amount) && amount >= market.min && amount <= market.max
      && (sourceCurrencyCode === 'COP' || sourceCurrencyCode === 'VND' ? Number.isInteger(amount)
        : Math.abs(amount * 100 - Math.round(amount * 100)) <= 0.000001));
  } catch { return false; }
}

/** A separate capability for recording requested funding, never financial settlement. */
export function walletFundingRequest(request, url, body, env, ready) {
  if (!ready || env.WALLET_FUNDING_ENABLED !== 'true' || url.protocol !== 'https:'
    || url.host !== 'auth.core.internal' || request.headers.has('x-vp-act-as')
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')) return false;
  const appMeld = env.CORE_ENV === 'production' && env.APP_MELD_PRODUCTION_ENABLED === 'true'
    && request.headers.get('origin') === APP_ORIGIN && appMeldFundingPath(url);
  if (appMeld || request.headers.has(APP_MELD_HEADER))
    return appMeld && request.headers.get(APP_MELD_HEADER) === 'meld' && appMeldFundingRequest(request, url, body);
  if (request.method === 'GET') {
    if (url.pathname === `${MELD_CHECKOUT_PATH}/capabilities`) return request.headers.get('origin') === ADMINISTRATIVE_ORIGIN && !url.search;
    if (url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/offramp/options`) {
      const country = url.searchParams.get('country'), fiat = url.searchParams.get('destinationCurrencyCode');
      return env.MELD_ADMIN_SANDBOX_ENABLED === 'true' && request.headers.get('origin') === ADMINISTRATIVE_ORIGIN
        && ['US', 'MX', 'CO'].includes(country) && (fiat === 'USD' || (country === 'MX' && fiat === 'MXN') || (country === 'CO' && fiat === 'COP'))
        && url.search === `?country=${country}&destinationCurrencyCode=${fiat}`;
    }
    if (url.pathname === `${MELD_CHECKOUT_PATH}/history`) return env.MELD_CHECKOUT_ENABLED === 'true'
      && env.MELD_ADMIN_SANDBOX_ENABLED === 'true' && request.headers.get('origin') === ADMINISTRATIVE_ORIGIN && !url.search;
    if (url.pathname === `${MELD_CHECKOUT_PATH}/status`) {
      const reference = url.searchParams.get('checkoutReference');
      return env.MELD_CHECKOUT_ENABLED === 'true' && env.MELD_ADMIN_SANDBOX_ENABLED === 'true'
        && request.headers.get('origin') === ADMINISTRATIVE_ORIGIN
        && UUID.test(reference || '') && url.search === `?checkoutReference=${reference}`;
    }
    if (url.pathname === HISTORY) return ['?walletKind=personal', '?walletKind=administrative'].includes(url.search);
    if ([PERSONAL_STATUS, `${WALLET_FUNDING_PREFIX}/administrative/status`].includes(url.pathname)) {
      const reference = url.searchParams.get('checkoutReference');
      return UUID.test(reference || '') && url.search === `?checkoutReference=${reference}`;
    }
    const country = url.searchParams.get('country');
    const sourceCurrencyCode = url.searchParams.get('sourceCurrencyCode');
    if (sourceCurrencyCode !== null && !/^[A-Z]{3}$/.test(sourceCurrencyCode)) return false;
    const currencyQuery = sourceCurrencyCode === null ? '' : `&sourceCurrencyCode=${sourceCurrencyCode}`;
    if (url.pathname === PERSONAL_OPTIONS) return PERSONAL_COUNTRIES.has(country)
      && (sourceCurrencyCode === null || sourceCurrencyCode === 'USD' || (country === 'MX' && sourceCurrencyCode === 'MXN'))
      && url.search === `?country=${country}${currencyQuery}`;
    const provider = url.searchParams.get('serviceProvider');
    return env.MELD_ADMIN_SANDBOX_ENABLED === 'true' && url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/options`
      && /^[A-Z]{2}$/.test(country || '') && ['TRANSAK', 'BANXA'].includes(provider)
      && (sourceCurrencyCode === null || sourceCurrencyCode === 'USD' || (country === 'MX' && sourceCurrencyCode === 'MXN'))
      && url.search === `?country=${country}${currencyQuery}&serviceProvider=${provider}`;
  }
  if (url.pathname === MELD_CHECKOUT_PATH) {
    if (env.MELD_CHECKOUT_ENABLED !== 'true' || env.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || request.method !== 'POST' || url.search
      || request.headers.has('content-encoding') || request.headers.get('origin') !== ADMINISTRATIVE_ORIGIN
      || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !body?.length || body.length > WALLET_FUNDING_MAX_BODY) return false;
    try {
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 4 || Object.keys(input).some(key => !['requestId', 'country', 'amount', 'sourceCurrencyCode'].includes(key))
        || !UUID.test(input.requestId || '') || !['US', 'MX', 'CO'].includes(input.country)
        || !['USD', 'MXN'].includes(input.sourceCurrencyCode) || (input.sourceCurrencyCode === 'MXN' && input.country !== 'MX')
        || typeof input.amount !== 'number' || !Number.isFinite(input.amount)
        || input.amount < (input.sourceCurrencyCode === 'USD' ? 50 : 1) || input.amount > (input.sourceCurrencyCode === 'USD' ? 25_000 : 10_000_000)
        || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001) return false;
      return true;
    } catch { return false; }
  }
  const personal = url.pathname === PERSONAL_INTENT;
  const administrative = url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/session`;
  if (request.method !== 'POST' || (!personal && !administrative) || url.search
    || request.headers.has('content-encoding')
    || (personal ? !PERSONAL_ORIGINS.has(request.headers.get('origin')) : request.headers.get('origin') !== ADMINISTRATIVE_ORIGIN)
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !body?.length || body.length > WALLET_FUNDING_MAX_BODY) return false;
  if (administrative && env.MELD_ADMIN_SANDBOX_ENABLED !== 'true') return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const allowed = ['requestId', 'walletAddress', 'country', 'amount', 'sourceCurrencyCode', 'paymentMethodType', ...(administrative ? ['serviceProvider'] : [])];
    const sourceCurrencyCode = input.sourceCurrencyCode === undefined ? 'USD' : input.sourceCurrencyCode;
    const localMxn = personal && input.country === 'MX' && sourceCurrencyCode === 'MXN'
      && ['SPEI', 'CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY'].includes(input.paymentMethodType);
    const administrativeMxn = administrative && input.country === 'MX' && sourceCurrencyCode === 'MXN'
      && (input.paymentMethodType === 'CREDIT_DEBIT_CARD' || (input.serviceProvider === 'TRANSAK' && ['APPLE_PAY', 'GOOGLE_PAY'].includes(input.paymentMethodType)));
    if (Object.keys(input).some(key => !allowed.includes(key)) || !UUID.test(input.requestId || '')
      || !/^0x[a-f0-9]{40}$/i.test(input.walletAddress || '') || !/^[A-Z]{2}$/.test(input.country || '')
      || (personal && (!PERSONAL_COUNTRIES.has(input.country) || PROHIBITED_PERSONAL_METHODS.has(input.paymentMethodType)
        || UNAVAILABLE_PERSONAL_METHODS.has(input.paymentMethodType)))
      || typeof sourceCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(sourceCurrencyCode)
      || (sourceCurrencyCode !== 'USD' && !localMxn && !administrativeMxn)
      || (personal && ['PSE', 'LOCAL_BANK_TRANSFER'].includes(input.paymentMethodType))
      || (personal && input.paymentMethodType === 'SPEI' && !localMxn)
      || (personal && ['VENMO', 'PAYPAL'].includes(input.paymentMethodType) && (input.country !== 'US' || sourceCurrencyCode !== 'USD'))
      || (personal && input.country === 'CO' && sourceCurrencyCode === 'USD' && !['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY'].includes(input.paymentMethodType))
      || typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < (sourceCurrencyCode === 'USD' ? (personal ? 30 : 50) : (personal ? 931 : 0.01))
      || input.amount > (sourceCurrencyCode === 'USD' ? (personal ? 15000 : 25000) : 1_000_000_000)
      || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001
      || typeof input.paymentMethodType !== 'string' || !/^[A-Z0-9_]{2,40}$/.test(input.paymentMethodType)) return false;
    return !administrative || ['TRANSAK', 'BANXA'].includes(input.serviceProvider);
  } catch { return false; }
}
