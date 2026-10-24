import { readFileSync } from 'node:fs';
import type { GrpcTransportOptions } from '@connectrpc/connect-node';

type Environment = Record<string, string | undefined>;

export function engineTransportOptions(
  env: Environment,
  readFile: (path: string) => Buffer = readFileSync,
): GrpcTransportOptions {
  const baseUrl = env.VP_ENGINE_GRPC_URL ?? 'http://localhost:50051';
  const paths = [env.VP_ENGINE_TLS_CA, env.VP_ENGINE_TLS_CERT, env.VP_ENGINE_TLS_KEY];
  const pems = [env.VP_ENGINE_TLS_CA_PEM, env.VP_ENGINE_TLS_CERT_PEM, env.VP_ENGINE_TLS_KEY_PEM];
  if (paths.some(Boolean) && pems.some(Boolean)) throw new Error('Choose file or inline engine mTLS credentials, not both');
  const inline = pems.some(Boolean);
  const configured = paths.some(Boolean) || inline;
  const required = env.ENGINE_MTLS_REQUIRED === 'true';
  if ((configured || required) && !(inline ? pems : paths).every(Boolean)) {
    throw new Error('Engine mTLS requires a complete CA, certificate and key (file paths or inline PEM)');
  }
  if (!configured && !required) return { baseUrl };
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Engine mTLS requires an HTTPS URL');
  return {
    baseUrl,
    nodeOptions: {
      ca: inline ? Buffer.from(pems[0]!) : readFile(paths[0]!),
      cert: inline ? Buffer.from(pems[1]!) : readFile(paths[1]!),
      key: inline ? Buffer.from(pems[2]!) : readFile(paths[2]!),
      rejectUnauthorized: true,
    },
  };
}
