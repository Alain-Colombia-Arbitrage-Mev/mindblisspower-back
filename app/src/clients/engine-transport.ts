import { readFileSync } from 'node:fs';
import type { GrpcTransportOptions } from '@connectrpc/connect-node';
import { connect as connectTLS } from 'node:tls';

type Environment = Record<string, string | undefined>;

export function engineTransportOptions(
  env: Environment,
  readFile: (path: string) => Buffer = readFileSync,
  loopback?: { host: '127.0.0.1'; port: number },
): GrpcTransportOptions {
  const baseUrl = env.VP_ENGINE_GRPC_URL ?? 'http://localhost:50051';
  if (env.VP_ENGINE_TUNNEL_ENABLED !== undefined && !['true', 'false'].includes(env.VP_ENGINE_TUNNEL_ENABLED)) throw new Error('Engine private tunnel configuration is invalid');
  const paths = [env.VP_ENGINE_TLS_CA, env.VP_ENGINE_TLS_CERT, env.VP_ENGINE_TLS_KEY];
  const pems = [env.VP_ENGINE_TLS_CA_PEM, env.VP_ENGINE_TLS_CERT_PEM, env.VP_ENGINE_TLS_KEY_PEM];
  if (paths.some(Boolean) && pems.some(Boolean)) throw new Error('Choose file or inline engine mTLS credentials, not both');
  const inline = pems.some(Boolean);
  const configured = paths.some(Boolean) || inline;
  const required = env.ENGINE_MTLS_REQUIRED === 'true';
  if ((configured || required) && !(inline ? pems : paths).every(Boolean)) {
    throw new Error('Engine mTLS requires a complete CA, certificate and key (file paths or inline PEM)');
  }
  const tunnel = env.VP_ENGINE_TUNNEL_ENABLED === 'true';
  if (tunnel && (!required || !loopback || loopback.host !== '127.0.0.1' || !Number.isInteger(loopback.port) || loopback.port < 1 || loopback.port > 65535)) throw new Error('Engine private tunnel requires verified mTLS and loopback');
  if (!tunnel && loopback) throw new Error('Engine loopback requires an explicitly enabled private tunnel');
  if (!configured && !required) return { baseUrl };
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Engine mTLS requires an HTTPS URL');
  const origin = new URL(baseUrl);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Engine mTLS requires a bare HTTPS origin');
  const identity = {
    ca: inline ? Buffer.from(pems[0]!) : readFile(paths[0]!),
    cert: inline ? Buffer.from(pems[1]!) : readFile(paths[1]!),
    key: inline ? Buffer.from(pems[2]!) : readFile(paths[2]!),
    rejectUnauthorized: true,
  };
  return {
    baseUrl,
    nodeOptions: {
      ...identity,
      ...(tunnel ? { createConnection: () => connectTLS({ ...identity, host: loopback!.host, port: loopback!.port, servername: origin.hostname, ALPNProtocols: ['h2'], minVersion: 'TLSv1.3' }) } : {}),
    },
  };
}
