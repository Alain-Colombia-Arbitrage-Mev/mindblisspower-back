// These exact production routes returned matching quotes and hosted checkout
// prefills with a synthetic wallet. Onramp's numeric rail code depends on fiat.
export const additionalAppMeldMarkets = [
  { country: 'PE', currency: 'PEN', asset: 'USDT_POLYGON', minorUnits: 2,
    rails: [{ provider: 'ONRAMPMONEY', methods: ['LOCAL_BANK_TRANSFER'], minimum: 19, maximum: 4_500_000 }],
    widget: { fiatType: '8', paymentMethod: '2' } },
  { country: 'AR', currency: 'ARS', asset: 'USDT_POLYGON', minorUnits: 2,
    rails: [{ provider: 'ONRAMPMONEY', methods: ['LOCAL_BANK_TRANSFER'], minimum: 25_000, maximum: 6_600_000 }],
    widget: { fiatType: '29', paymentMethod: '1' } },
  { country: 'DE', currency: 'EUR', asset: 'USDT_POLYGON', minorUnits: 2,
    rails: [{ provider: 'ONRAMPMONEY', methods: ['SEPA'], minimum: 10, maximum: 100_000 }],
    widget: { fiatType: '12', paymentMethod: '2' } },
  { country: 'KE', currency: 'KES', asset: 'USDT_POLYGON', minorUnits: 2,
    rails: [{ provider: 'ONRAMPMONEY', methods: ['MPESA'], minimum: 1_850, maximum: 700_000 }],
    widget: { fiatType: '15', paymentMethod: '2' } },
  { country: 'VN', currency: 'VND', asset: 'USDT_POLYGON', minorUnits: 0,
    rails: [{ provider: 'ONRAMPMONEY', methods: ['VIETQR'], minimum: 55_000, maximum: 450_000_000 }],
    widget: { fiatType: '5', paymentMethod: '1' } },
] as const;

export function additionalAppMeldOnrampParameters(country: string, fiat: string, method: string) {
  return additionalAppMeldMarkets.find(market => market.country === country && market.currency === fiat
    && market.rails.some(rail => rail.methods.some(value => value === method)))?.widget;
}
