// Additive domain tables owned by _meta/migration/70_stable_identity_bindings.sql,
// not by Better Auth's migrator. No snapshots or raw provider payloads live here.
import { sql } from 'drizzle-orm';
import { pgSchema, text, bigint, boolean, timestamp, uuid, primaryKey, unique, index, check } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { person } from './mlm';

export const identitySchema = pgSchema('identity');

export const authBinding = identitySchema.table('auth_binding', {
  subject: text('subject').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  provider: text('provider').notNull().default('better_auth'),
  personId: bigint('person_id', { mode: 'bigint' }).notNull().unique('auth_binding_person_id_key').references(() => person.id, { onDelete: 'restrict' }),
  linkMethod: text('link_method').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('auth_binding_provider_check', sql`${table.provider} = 'better_auth'`),
  check('auth_binding_link_method_check', sql`${table.linkMethod} IN ('new_registration','legacy_user_id','approved_claim','single_use_invite','verified_email')`)]);

export const legacyClaimGrant = identitySchema.table('legacy_claim_grant', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: bigint('person_id', { mode: 'bigint' }).notNull().references(() => person.id, { onDelete: 'restrict' }),
  subject: text('subject').notNull().references(() => user.id, { onDelete: 'restrict' }),
  tokenHash: text('token_hash').notNull().unique('legacy_claim_grant_token_hash_key'),
  kind: text('kind').notNull(),
  approvedBySubject: text('approved_by_subject').notNull().references(() => user.id, { onDelete: 'restrict' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [index('legacy_claim_person_idx').on(table.personId), index('legacy_claim_subject_idx').on(table.subject),
  index('legacy_claim_approver_idx').on(table.approvedBySubject),
  index('legacy_claim_open_expiry_idx').on(table.expiresAt).where(sql`${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  check('legacy_claim_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check('legacy_claim_kind', sql`${table.kind} IN ('approved_claim','single_use_invite')`),
  check('legacy_claim_expiry', sql`${table.expiresAt} > ${table.approvedAt}`),
  check('legacy_claim_two_party', sql`${table.approvedBySubject} <> ${table.subject}`),
  check('legacy_claim_consumption_time', sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.approvedAt}`),
  check('legacy_claim_not_consumed_and_revoked', sql`${table.revokedAt} IS NULL OR ${table.consumedAt} IS NULL`)]);

export const linkConflict = identitySchema.table('link_conflict', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  subject: text('subject').notNull().references(() => user.id, { onDelete: 'restrict' }),
  candidatePersonId: bigint('candidate_person_id', { mode: 'bigint' }).references(() => person.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, table => [unique('link_conflict_subject_candidate_person_id_reason_key').on(table.subject, table.candidatePersonId, table.reason).nullsNotDistinct(),
  index('identity_conflict_person_idx').on(table.candidatePersonId),
  check('identity_link_conflict_reason', sql`${table.reason} IN ('legacy_claim_required','identity_collision','person_unavailable','invalid_claim','stripe_customer_collision')`)]);

export const stripeCustomer = identitySchema.table('stripe_customer', {
  accountId: text('account_id').notNull(),
  livemode: boolean('livemode').notNull(),
  customerId: text('customer_id').notNull(),
  personId: bigint('person_id', { mode: 'bigint' }).notNull().references(() => person.id, { onDelete: 'restrict' }),
  linkedBySubject: text('linked_by_subject').notNull().references(() => user.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.accountId, table.livemode, table.customerId] }),
  unique('stripe_customer_account_id_livemode_person_id_key').on(table.accountId, table.livemode, table.personId), index('stripe_customer_person_idx').on(table.personId),
  index('stripe_customer_actor_idx').on(table.linkedBySubject),
  check('stripe_account_id_format', sql`${table.accountId} ~ '^acct_[A-Za-z0-9]+$'`),
  check('stripe_customer_id_format', sql`${table.customerId} ~ '^cus_[A-Za-z0-9]+$'`)]);
