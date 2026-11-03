import { describe, expect, test } from 'bun:test';
import { engineTransportOptions } from './engine-transport';
import type { SecureClientSessionOptions } from 'node:http2';

describe('portable engine transport', () => {
  test('keeps the existing local transport when mTLS is not enabled', () => {
    expect(engineTransportOptions({})).toEqual({ baseUrl: 'http://localhost:50051' });
  });
  test('fails closed when required certificates are absent', () => {
    expect(() => engineTransportOptions({ ENGINE_MTLS_REQUIRED: 'true' })).toThrow('mTLS requires');
  });
  test('rejects partial configuration even without the required flag', () => {
    expect(() => engineTransportOptions({ VP_ENGINE_TLS_CA: '/ca' })).toThrow('mTLS requires');
  });
  const env = { VP_ENGINE_TLS_CA: '/ca', VP_ENGINE_TLS_CERT: '/cert', VP_ENGINE_TLS_KEY: '/key' };
  test('never sends configured client certificates over HTTP', () => {
    expect(() => engineTransportOptions(env)).toThrow('HTTPS');
  });
  test('passes the complete identity and keeps server verification enabled', () => {
    const options = engineTransportOptions({ ...env, VP_ENGINE_GRPC_URL: 'https://engine:50051' }, p => Buffer.from(p));
    expect(options.nodeOptions).toEqual({
      ca: Buffer.from('/ca'), cert: Buffer.from('/cert'), key: Buffer.from('/key'), rejectUnauthorized: true,
    });
  });
  test('does not fall back to plaintext when a certificate cannot be read', () => {
    expect(() => engineTransportOptions({ ...env, VP_ENGINE_GRPC_URL: 'https://engine:50051' }, () => {
      throw new Error('missing certificate');
    })).toThrow('missing certificate');
  });
  test('App Platform accepts a complete inline identity without weakening verification', () => {
    const inline = { VP_ENGINE_TLS_CA_PEM: 'ca', VP_ENGINE_TLS_CERT_PEM: 'cert', VP_ENGINE_TLS_KEY_PEM: 'key', VP_ENGINE_GRPC_URL: 'https://engine:50051' };
    expect(engineTransportOptions(inline).nodeOptions).toEqual({ ca: Buffer.from('ca'), cert: Buffer.from('cert'), key: Buffer.from('key'), rejectUnauthorized: true });
    expect(() => engineTransportOptions({ ...inline, VP_ENGINE_TLS_CA: '/ca' })).toThrow('not both');
    expect(() => engineTransportOptions({ ...inline, VP_ENGINE_TLS_KEY_PEM: '' })).toThrow('mTLS requires');
  });
  test('private tunnel keeps the original TLS authority and requires a loopback socket', () => {
    const values = { ...env, ENGINE_MTLS_REQUIRED: 'true', VP_ENGINE_TUNNEL_ENABLED: 'true', VP_ENGINE_GRPC_URL: 'https://engine.original.invalid:50051' };
    expect(() => engineTransportOptions(values, p => Buffer.from(p))).toThrow('loopback');
    const options = engineTransportOptions(values, p => Buffer.from(p), { host: '127.0.0.1', port: 55555 });
    expect(options.baseUrl).toBe(values.VP_ENGINE_GRPC_URL);
    expect(options.nodeOptions?.createConnection).toBeFunction();
    expect((options.nodeOptions as SecureClientSessionOptions).rejectUnauthorized).toBe(true);
    expect(() => engineTransportOptions({ ...values, VP_ENGINE_GRPC_URL: 'http://engine.original.invalid:50051' }, p => Buffer.from(p), { host: '127.0.0.1', port: 55555 })).toThrow('HTTPS');
    expect(() => engineTransportOptions({ ...values, VP_ENGINE_GRPC_URL: 'https://engine.original.invalid/path' }, p => Buffer.from(p), { host: '127.0.0.1', port: 55555 })).toThrow('origin');
  });
});
