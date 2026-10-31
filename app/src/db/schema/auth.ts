/**
 * Better Auth schema mirror — these tables are owned by Better Auth and live
 * in the `auth` Postgres schema. The DDL in `_meta/schema_mlm.sql` only
 * declares `auth.user` so `mlm.person.user_id` can FK to it; the rest
 * (session, account, verification) is created by `bun auth:migrate`.
 *
 * We mirror them here so Drizzle queries against sessions and OAuth accounts
 * are typed. Don't edit shapes manually — `better-auth migrate` will rewrite
 * any schema diff against the version of better-auth we're on. Plugin fields
 * below are mirrored by the reviewed additive identity migration 70. Optional
 * customer contact fields are managed by reviewed additive migration 76.
 */
import { pgSchema, text, timestamp, boolean, integer, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

export const user = authSchema.table('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  phoneNumber: text('phone_number').unique('auth_user_phone_unique'),
  phoneNumberVerified: boolean('phone_number_verified').notNull().default(false),
  // Migration 76. Self-declared customer contacts, not login identifiers.
  contactPhone: text('contact_phone_e164'),
  contactWhatsapp: text('contact_whatsapp_e164'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = authSchema.table('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('auth_session_user_idx').on(table.userId), index('auth_session_expiry_idx').on(table.expiresAt)]);

export const account = authSchema.table('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('auth_account_provider_subject_unique').on(table.providerId, table.accountId), index('auth_account_user_idx').on(table.userId)]);

export const verification = authSchema.table('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('auth_verification_identifier_idx').on(table.identifier), index('auth_verification_expiry_idx').on(table.expiresAt)]);

export const jwks = authSchema.table('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const rateLimit = authSchema.table('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// Additive migration 75. This separate relation is never queried by email
// login; explicit schema readiness gates only the optional SMS endpoints.
export const smsOptIn = authSchema.table('sms_opt_in', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  phoneNumber: text('phone_number').notNull(),
  consentVersion: text('consent_version').notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  challengeId: text('challenge_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
