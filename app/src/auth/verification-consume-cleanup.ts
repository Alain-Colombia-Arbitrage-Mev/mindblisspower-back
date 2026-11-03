import type { DBAdapter } from '@better-auth/core/db/adapter';
import { defineRequestState } from '@better-auth/core/context';

const generations = defineRequestState(() => new Map<string, Date>());
const observedRows = defineRequestState(() => new Map<string, string>());
const emailOtpIdentifier = (value: unknown): value is string => typeof value === 'string'
  && /^(?:sign-in|email-verification|forget-password)-otp-/.test(value);

function identifierOnly(input: { model: string; where?: Parameters<DBAdapter['delete']>[0]['where'] }): string | null {
  const condition = input.where?.length === 1 ? input.where[0] : null;
  return input.model === 'verification' && condition?.field === 'identifier'
    && (!condition.operator || condition.operator === 'eq') && (!condition.connector || condition.connector === 'AND')
    && (!condition.mode || condition.mode === 'sensitive') && emailOtpIdentifier(condition.value) ? condition.value : null;
}

/** Native 1.6.22 cleans whole identifiers after consuming or reading an expired
 * row. Neither delayed cleanup may delete a subsequent resend. Bind expired-row
 * deletion to its observed ID, and consumed-row cleanup to its creation cutoff.
 * Request-local snapshots never verify, restore, retry or extend any OTP.
 */
export function guardVerificationCleanup(base: DBAdapter): DBAdapter {
  return { ...base,
    findMany: async <T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
      const rows = await base.findMany<T>(input);
      const identifier = identifierOnly(input);
      // This is findVerificationValue's latest-generation query, NOT the
      // unsorted deleteWithHooks pre-read that can already observe resend B.
      if (identifier && input.limit === 1 && input.sortBy?.field === 'createdAt' && input.sortBy.direction === 'desc') {
        const current = await observedRows.get();
        const row = rows[0] as { id?: unknown; identifier?: unknown } | undefined;
        if (!row) current.delete(identifier);
        else {
          if (row.identifier !== identifier || typeof row.id !== 'string' || !row.id) throw new Error('Invalid observed verification generation');
          current.set(identifier, row.id);
        }
      }
      return rows;
    },
    delete: async input => {
      const identifier = identifierOnly(input);
      if (identifier) {
        const current = await observedRows.get(), id = current.get(identifier);
        if (id) {
          current.delete(identifier);
          return base.delete({ ...input, where: [...input.where, { field: 'id', value: id }] });
        }
      }
      return base.delete(input);
    },
    consumeOne: async <T>(input: Parameters<DBAdapter['consumeOne']>[0]): Promise<T | null> => {
      const consumed = await base.consumeOne<T>(input);
      const row = consumed as { identifier?: unknown; createdAt?: unknown } | null;
      if (input.model === 'verification' && emailOtpIdentifier(row?.identifier)) {
        if (!(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime())) {
          throw new Error('Invalid consumed verification generation');
        }
        (await generations.get()).set(row.identifier, new Date(row.createdAt));
      }
      return consumed;
    },
    deleteMany: async input => {
      const identifier = identifierOnly(input);
      if (identifier) {
        const current = await generations.get();
        const cutoff = current.get(identifier);
        if (cutoff) {
          current.delete(identifier);
          return base.deleteMany({ ...input, where: [...input.where, { field: 'createdAt', operator: 'lte', value: cutoff }] });
        }
      }
      return base.deleteMany(input);
    },
  };
}
