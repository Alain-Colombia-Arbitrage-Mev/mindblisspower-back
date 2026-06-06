/**
 * Drizzle representation of the mlm.* schema declared in _meta/schema_mlm.sql.
 * The DDL is the source of truth — these are typings only. `db:generate`
 * is run with `--breakpoints` disabled in CI so it never tries to ALTER
 * tables that the DDL already created. We diff drizzle migrations vs DDL
 * before applying anything.
 */
import {
  pgSchema, bigint, integer, smallint, text, boolean, timestamp, date,
  numeric, char, uuid, jsonb, pgEnum, customType, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';

export const mlmSchema = pgSchema('mlm');

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const personStatus    = mlmSchema.enum('person_status',    ['pending','active','suspended','banned','deleted']);
export const kycStatus       = mlmSchema.enum('kyc_status',       ['not_started','in_review','approved','rejected','expired']);
export const treePosition    = mlmSchema.enum('tree_position',    ['L','R']);
export const conceptKind     = mlmSchema.enum('concept_kind',     ['roi','binary_bonus','leadership_bonus','direct_bonus','package_purchase','withdrawal','platform_fee','inter_platform','manual_adjustment','reversal']);
export const txnStatus       = mlmSchema.enum('txn_status',       ['pending','posted','reversed']);
export const packageStatus   = mlmSchema.enum('package_status',   ['pending_payment','active','expired','refunded','cancelled']);
export const treeEventKind   = mlmSchema.enum('tree_event_kind',  ['enrollment','pv_credit','binary_payout','rank_advance','position_move','pv_reversal']);
export const withdrawalStatus = mlmSchema.enum('withdrawal_status', ['requested','approved','rejected','paid','cancelled']);

// ltree custom type — not built into drizzle yet
const ltree = customType<{ data: string; driverData: string }>({
  dataType: () => 'ltree',
});

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------
export const country = mlmSchema.table('country', {
  id: smallint('id').primaryKey(),
  iso2: char('iso2', { length: 2 }).notNull().unique(),
  nameEs: text('name_es').notNull(),
  nameEn: text('name_en').notNull(),
  phoneCode: text('phone_code'),
  phoneRegex: text('phone_regex'),
});

export const concept = mlmSchema.table('concept', {
  id: integer('id').primaryKey(),
  kind: conceptKind('kind').notNull(),
  nameEs: text('name_es').notNull(),
  nameEn: text('name_en').notNull(),
  factor: smallint('factor').notNull(),
  requiresPair: boolean('requires_pair').notNull().default(false),
  active: boolean('active').notNull().default(true),
});

export const rank = mlmSchema.table('rank', {
  id: smallint('id').primaryKey(),
  code: text('code').notNull().unique(),
  nameEs: text('name_es').notNull(),
  nameEn: text('name_en').notNull(),
  requiredPoints: integer('required_points').notNull(),
  bonusAmountUsd: numeric('bonus_amount_usd', { precision: 14, scale: 2 }).notNull().default('0'),
  previousRankId: smallint('previous_rank_id').references((): any => rank.id),
  displayOrder: smallint('display_order').notNull(),
});

export const pkg = mlmSchema.table('package', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
  pv: integer('pv').notNull(),
  type: text('type').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
export const person = mlmSchema.table('person', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text('user_id').references(() => user.id, { onDelete: 'restrict' }).unique(),
  legacyIdPerson: integer('legacy_id_person').unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  alias: text('alias'),
  email: text('email').notNull().unique(),
  phoneCountryId: smallint('phone_country_id').references(() => country.id),
  phoneNumber: text('phone_number').notNull(),
  birthday: date('birthday'),
  birthCountryId: smallint('birth_country_id').references(() => country.id),
  ssnEncrypted: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })('ssn_encrypted'),
  status: personStatus('status').notNull().default('pending'),
  kycStatus: kycStatus('kyc_status').notNull().default('not_started'),
  kycApprovedAt: timestamp('kyc_approved_at', { withTimezone: true }),
  isAdmin: boolean('is_admin').notNull().default(false),
  blacklisted: boolean('blacklisted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const affiliate = mlmSchema.table('affiliate', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  legacyIdVicionario: integer('legacy_id_vicionario').unique(),
  personId: bigint('person_id', { mode: 'bigint' }).notNull().unique().references(() => person.id, { onDelete: 'restrict' }),
  invitationLink: text('invitation_link').unique(),
  parentId: bigint('parent_id', { mode: 'bigint' }).references((): any => affiliate.id, { onDelete: 'restrict' }),
  position: treePosition('position'),
  sponsorId: bigint('sponsor_id', { mode: 'bigint' }).references((): any => affiliate.id, { onDelete: 'restrict' }),
  path: ltree('path').notNull(),
  depth: integer('depth').notNull(),
  leftCount: bigint('left_count', { mode: 'bigint' }).notNull().default(0n),
  rightCount: bigint('right_count', { mode: 'bigint' }).notNull().default(0n),
  leftPvLifetime: numeric('left_pv_lifetime', { precision: 20, scale: 2 }).notNull().default('0'),
  rightPvLifetime: numeric('right_pv_lifetime', { precision: 20, scale: 2 }).notNull().default('0'),
  leftPvCurrent: numeric('left_pv_current', { precision: 20, scale: 2 }).notNull().default('0'),
  rightPvCurrent: numeric('right_pv_current', { precision: 20, scale: 2 }).notNull().default('0'),
  leftCarry: numeric('left_carry', { precision: 20, scale: 2 }).notNull().default('0'),
  rightCarry: numeric('right_carry', { precision: 20, scale: 2 }).notNull().default('0'),
  currentRankId: smallint('current_rank_id').references(() => rank.id),
  status: personStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  parentPos: uniqueIndex('affiliate_parent_position_unique').on(t.parentId, t.position).where(sql`${t.parentId} IS NOT NULL`),
  pathBtree: index('affiliate_path_btree').on(t.path),
  sponsorIdx: index('affiliate_sponsor_idx').on(t.sponsorId),
  parentIdx:  index('affiliate_parent_idx').on(t.parentId),
}));

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------
export const wallet = mlmSchema.table('wallet', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  legacyIdWallet: integer('legacy_id_wallet').unique(),
  affiliateId: bigint('affiliate_id', { mode: 'bigint' }).notNull().references(() => affiliate.id, { onDelete: 'restrict' }),
  assetId: smallint('asset_id').notNull(),
  address: text('address').notNull(),
  balance: numeric('balance', { precision: 20, scale: 8 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex('wallet_affiliate_asset').on(t.affiliateId, t.assetId),
}));

export const transaction = mlmSchema.table('transaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalRef: text('external_ref').unique(),
  description: text('description').notNull(),
  status: txnStatus('status').notNull().default('pending'),
  initiatedByPersonId: bigint('initiated_by_person_id', { mode: 'bigint' }).references(() => person.id),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  reversedByTxnId: uuid('reversed_by_txn_id').references((): any => transaction.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// wallet_movement is partitioned in DDL; Drizzle typing works the same.
export const walletMovement = mlmSchema.table('wallet_movement', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
  legacyIdMovement: integer('legacy_id_movement'),
  transactionId: uuid('transaction_id').notNull().references(() => transaction.id, { onDelete: 'restrict' }),
  walletId: bigint('wallet_id', { mode: 'bigint' }).notNull().references(() => wallet.id),
  affiliateId: bigint('affiliate_id', { mode: 'bigint' }).notNull().references(() => affiliate.id),
  conceptId: integer('concept_id').notNull().references(() => concept.id),
  rankId: smallint('rank_id').references(() => rank.id),
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  reference: text('reference'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  availableAt: date('available_at'),
  isFrozen: boolean('is_frozen').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const treeEvent = mlmSchema.table('tree_event', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  externalRef: text('external_ref').notNull().unique(),
  kind: treeEventKind('kind').notNull(),
  affiliateId: bigint('affiliate_id', { mode: 'bigint' }).notNull().references(() => affiliate.id),
  pvDeltaLeft: numeric('pv_delta_left', { precision: 20, scale: 2 }).notNull().default('0'),
  pvDeltaRight: numeric('pv_delta_right', { precision: 20, scale: 2 }).notNull().default('0'),
  payload: jsonb('payload').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
});
