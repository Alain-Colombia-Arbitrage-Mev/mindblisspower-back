/**
 * gRPC client to vp-engine (Go service).
 *
 * vp-api MUST NOT write directly to mlm.wallet_movement / mlm.transaction.
 * All ledger writes go through this client → vp-engine LedgerService → DB.
 *
 * Transport: gRPC over HTTP/2 (h2c in dev, mTLS in prod — ADR-0002 §4 + ADR-0006).
 */
import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { LedgerService } from '@proto/ledger_pb.js';

const baseUrl = process.env.VP_ENGINE_GRPC_URL ?? 'http://localhost:50051';

const transport = createGrpcTransport({ baseUrl });

export const ledgerClient: Client<typeof LedgerService> = createClient(LedgerService, transport);
