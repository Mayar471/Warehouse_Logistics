import type { PGlite } from '@electric-sql/pglite';

// Restore the preceding schema only in an isolated upgrade fixture without returns.
export async function restoreCashSchema15(db: PGlite) {
  await restoreCashSchema19(db);
  await db.exec(`
    ALTER TABLE cash_journals DROP COLUMN remittance_return_id CASCADE;
    DROP TABLE cash_remittance_returns;
    ALTER TABLE cash_journals DROP COLUMN remittance_round CASCADE;
    ALTER TABLE cash_journals DROP CONSTRAINT journal_identity_shipment;
    ALTER TABLE cash_obligations DROP COLUMN remittance_count;
    DROP INDEX cash_original_journal;
    CREATE UNIQUE INDEX cash_original_journal ON cash_journals(shipment_id,kind) WHERE payout_id IS NULL;
    ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
    ALTER TABLE cash_journals DROP CONSTRAINT reversal_required;
    ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return','payout_receive_reverse'));
    ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return','payout_receive_reverse') AND payout_id IS NOT NULL));
    ALTER TABLE cash_journals ADD CONSTRAINT reversal_required CHECK((kind IN ('payout_return','payout_receive_reverse'))=(reverses_journal_id IS NOT NULL));
    DELETE FROM schema_migrations WHERE version IN (16,17);
  `);
}

export async function restoreCashSchema19(db: PGlite) {
  await db.exec(`
    ALTER TABLE cash_journals DROP COLUMN refund_id CASCADE;
    DROP TABLE customer_refund_events; DROP TABLE customer_refunds; DROP FUNCTION guard_customer_refund(); DROP INDEX commercial_refund_source_pair;
    ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
    ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return','payout_receive_reverse','remittance_return_release','remittance_reverse','remittance_return_restore'));
    ALTER TABLE cash_journals DROP CONSTRAINT IF EXISTS cash_journal_purpose;
    ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL AND remittance_return_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return','payout_receive_reverse') AND payout_id IS NOT NULL AND remittance_return_id IS NULL) OR (kind IN ('remittance_return_release','remittance_reverse','remittance_return_restore') AND payout_id IS NULL AND remittance_return_id IS NOT NULL));
    DELETE FROM schema_migrations WHERE version=20;
  `);
}
