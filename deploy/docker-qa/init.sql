\set ON_ERROR_STOP on
-- Synthetic QA database only. Never run against a recovered/production database.
CREATE ROLE engine_write NOLOGIN;
CREATE ROLE engine_read NOLOGIN;
CREATE ROLE vp_engine NOLOGIN;
\ir /qa-schema/schema_mlm.sql
\ir /qa-schema/auth.sql
\ir /qa-schema/schema_governance.sql
\ir /qa-schema/migration/05_timescaledb.sql
\ir /qa-schema/schema_payouts.sql
\ir /qa-schema/schema_payouts_v1.1.sql
\ir /qa-schema/schema_payouts_v1.2.sql
\ir /qa-schema/schema_ranks.sql
\ir /qa-schema/schema_payouts_v1.3.sql
\ir /qa-schema/migration/20_alert_event.sql
\ir /qa-schema/migration/32_plan_config_publish.sql
\ir /qa-schema/schema_support_kb.sql
\ir /qa-schema/migration/30_payments.sql
\ir /qa-schema/migration/41_kyc_documents.sql
\ir /qa-schema/migration/42_support_tickets.sql
\ir /qa-schema/migration/43_blacklist.sql
\ir /qa-schema/migration/56_ban_engine_name_match.sql
\ir /qa-schema/migration/44_receipt_and_verify.sql
\ir /qa-schema/migration/45_cart_reminders.sql
\ir /qa-schema/migration/46_kyc_ocr.sql
\ir /qa-schema/migration/48_person_profile_fields.sql
\ir /qa-schema/migration/49_withdrawal_bmp_and_fee.sql
\ir /qa-schema/migration/50_bmp_account_link.sql
\ir /qa-schema/migration/53_news.sql
\ir /qa-schema/migration/55_refund_accounting.sql
\ir /qa-schema/migration/57_operational_charge_adjustments.sql
\ir /qa-schema/migration/58_support_ticket_triage_ai.sql
\ir /qa-schema/migration/59_support_voice_channels.sql
\ir /qa-schema/migration/61_purchase_intent_referral_audit.sql
\ir /qa-schema/migration/62_registration_referral_attribution.sql
\ir /qa-schema/migration/63_admin_tree_relocation_grants.sql
\ir /qa-schema/migration/64_referral_preferred_side.sql
\ir /qa-schema/migration/65_member_onboarding.sql
\ir /qa-schema/migration/66_support_bmp_category.sql
\ir /qa-schema/migration/67_comms_campaigns.sql
\ir /qa-schema/migration/68_blacklist_normalization_schema.sql
\ir /qa-schema/member-read.sql

INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals)
VALUES (1, 'USD', 'US Dollar', true, 2);
INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, kyc_status, is_admin)
VALUES ('QA', 'Admin One', 'admin@example.invalid', '0', 'active', 'not_started', true),
       ('QA', 'Admin Two', 'reviewer@example.invalid', '0', 'active', 'not_started', true);
\ir /qa-schema/migration/33_seed_plan_config.sql
