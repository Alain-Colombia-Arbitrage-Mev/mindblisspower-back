export type RelayLimits = { frameBytes: number; idleMs: number; lifetimeMs: number };
export declare const DEFAULT_LIMITS: Readonly<RelayLimits>;
export declare const TUNNEL_PROTOCOL: 'mindbliss-opaque-tcp-v1';
export declare function relayWebSocketToSocket(
  ws: Pick<WebSocket, 'binaryType' | 'addEventListener' | 'send' | 'close'>,
  socket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): unknown; closed?: Promise<unknown> },
  limits?: Partial<RelayLimits>,
): { done: Promise<string>; close(): void };
