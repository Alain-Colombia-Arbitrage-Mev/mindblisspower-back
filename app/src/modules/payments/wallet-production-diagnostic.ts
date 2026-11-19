export type WalletWidgetStage = 'widget_transport' | 'widget_http' | 'widget_schema' | 'widget_url' | 'widget_finish';
export type WalletWidgetDiagnostic = { stage: WalletWidgetStage; upstreamStatus?: number; providerCode?: string; serviceProviderCode?: string };
const recorded = new WeakMap<object, Readonly<WalletWidgetDiagnostic>>();
const stages = new Set(['widget_transport', 'widget_http', 'widget_schema', 'widget_url', 'widget_finish']);
const code = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_]{2,80}$/.test(value)
  && !/^0X[0-9A-F]{40}$/i.test(value) && !/^[0-9A-F]{32,80}$/.test(value) ? value : undefined;
/** Keep the original error and its authorization mapping; retain no vendor body. */
export function recordWalletWidgetDiagnostic(error: unknown, stage: WalletWidgetStage, status?: unknown, body?: unknown) {
  if (!error || typeof error !== 'object' || !stages.has(stage)) return;
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const details = value.serviceProviderDetails && typeof value.serviceProviderDetails === 'object' && !Array.isArray(value.serviceProviderDetails)
    ? value.serviceProviderDetails as Record<string, unknown> : {};
  const providerCode = code(value.code), serviceProviderCode = code(details.code);
  recorded.set(error, Object.freeze({ stage,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {}),
    ...(providerCode ? { providerCode } : {}), ...(serviceProviderCode ? { serviceProviderCode } : {}) }));
}
/** An upstream/body lookalike cannot supply a diagnostic at the HTTP boundary. */
export function walletWidgetDiagnostic(error: unknown) {
  return error && typeof error === 'object' ? recorded.get(error) : undefined;
}
