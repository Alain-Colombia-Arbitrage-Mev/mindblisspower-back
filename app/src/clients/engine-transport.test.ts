import { describe, expect, test } from 'bun:test';
import { engineTransportOptions } from './engine-transport';

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
});
