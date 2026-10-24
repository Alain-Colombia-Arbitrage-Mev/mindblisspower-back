import { readFileSync } from 'node:fs';
import type { GrpcTransportOptions } from '@connectrpc/connect-node';

type Environment = Record<string, string | undefined>;

export function engineTransportOptions(
  env: Environment,
  readFile: (path: string) => Buffer = readFileSync,
): GrpcTransportOptions {
  const baseUrl = env.VP_ENGINE_GRPC_URL ?? 'http://localhost:50051';
  const paths = [env.VP_ENGINE_TLS_CA, env.VP_ENGINE_TLS_CERT, env.VP_ENGINE_TLS_KEY];
  const configured = paths.some(Boolean);
  const required = env.ENGINE_MTLS_REQUIRED === 'true';
  if ((configured || required) && !paths.every(Boolean)) {
    throw new Error('Engine mTLS requires VP_ENGINE_TLS_CA, VP_ENGINE_TLS_CERT and VP_ENGINE_TLS_KEY');
  }
  if (!configured && !required) return { baseUrl };
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Engine mTLS requires an HTTPS URL');
  return {
    baseUrl,
    nodeOptions: {
      ca: readFile(paths[0]!),
      cert: readFile(paths[1]!),
      key: readFile(paths[2]!),
      rejectUnauthorized: true,
    },
  };
}
