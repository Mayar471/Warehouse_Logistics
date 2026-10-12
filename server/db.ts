import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { catalog } from '../shared/catalog.js';
import type { Role, ShipmentStatus } from '../shared/contracts.js';

export type Transaction = Pick<PGlite, 'query'>;
export interface ShipmentRow {
  origin_handover_required: boolean;
  origin_prepared: boolean;
  origin_released: boolean;
  origin_received: boolean;
  pickup_due_at: string | null;
  pickup_overdue: boolean;
  pickup_site_id: string | null;
  custody_site_id: string | null;
  pickup_expires_at: string | null;
  application_id: string;
  id: string;
  reference: string;
  external_reference: string;
  merchant_id: string;
  recipient_name: string;
  destination: string;
  origin_id: string;
  weight_kg: number;
  status: ShipmentStatus;
  courier_id: string | null;
  assignment_accepted: boolean;
  assignment_expires_at: string | null;
  fee_minor: number;
  currency: string;
  version: number;
  tracking_token: string;
  created_at: string;
  updated_at: string;
}
export const demoAccounts: {
  id: string;
  name: string;
  role: Role;
  merchantId: string | null;
  pickupSiteId?: string | null;
  courierId: string | null;
}[] = [
  {
    id: 'pickup-a',
    name: 'موظف نقطة الروضة',
    role: 'pickup',
    pickupSiteId: 'pickup-a',
    merchantId: null,
    courierId: null,
  },
  { id: 'ops', name: 'مدير العمليات', role: 'operator', merchantId: null, courierId: null },
  {
    id: 'merchant-a',
    name: 'متجر بيت الشام',
    role: 'merchant',
    merchantId: 'merchant-a',
    courierId: null,
  },
  {
    id: 'merchant-b',
    name: 'متجر نواة',
    role: 'merchant',
    merchantId: 'merchant-b',
    courierId: null,
  },
  {
    id: 'courier-a',
    name: 'أحمد منصور',
    role: 'courier',
    merchantId: null,
    courierId: 'courier-a',
  },
  {
    id: 'courier-b',
    name: 'لينا الخطيب',
    role: 'courier',
    merchantId: null,
    courierId: 'courier-b',
  },
];
export async function openDatabase(path?: string) {
  const db = new PGlite(path);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS merchants (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE IF NOT EXISTS sites (id text PRIMARY KEY, name text NOT NULL, city text NOT NULL,
      address text NOT NULL, kind text NOT NULL, merchant_id text REFERENCES merchants(id));
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS pickup_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS pickup_capacity_kg real NOT NULL DEFAULT 100 CHECK(pickup_capacity_kg>0);
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS network_audit(id uuid PRIMARY KEY,site_id text NOT NULL REFERENCES sites(id),actor_name text NOT NULL,action text NOT NULL,reason text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS couriers (id text PRIMARY KEY, name text NOT NULL, vehicle text NOT NULL,
      capacity_kg real NOT NULL CHECK (capacity_kg > 0), available boolean NOT NULL DEFAULT true);
    CREATE TABLE IF NOT EXISTS quotes (id uuid PRIMARY KEY, application_id text NOT NULL, merchant_id text NOT NULL REFERENCES merchants(id),
      input jsonb NOT NULL, fee_minor integer NOT NULL CHECK (fee_minor >= 0), currency text NOT NULL,
      expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS shipments (id uuid PRIMARY KEY, reference text NOT NULL UNIQUE,
      application_id text NOT NULL, external_reference text NOT NULL, merchant_id text NOT NULL REFERENCES merchants(id),
      recipient_name text NOT NULL, destination text NOT NULL, origin_id text NOT NULL REFERENCES sites(id),
      weight_kg real NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 50), status text NOT NULL
      CHECK (status IN ('ready','assigned','picked_up','in_transit','delivered','failed','cancelled','returning','returned')),
      courier_id text REFERENCES couriers(id), assignment_accepted boolean NOT NULL DEFAULT false,
      fee_minor integer NOT NULL CHECK (fee_minor >= 0), currency text NOT NULL,
      version integer NOT NULL DEFAULT 1, tracking_token text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(application_id, merchant_id, external_reference));
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS assignment_expires_at timestamptz;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_handover_required boolean NOT NULL DEFAULT false;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_prepared boolean NOT NULL DEFAULT false;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_released boolean NOT NULL DEFAULT false;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_received boolean NOT NULL DEFAULT false;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS pickup_due_at timestamptz;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS pickup_overdue boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS origin_pickup_deadline ON shipments(pickup_due_at) WHERE status='assigned' AND assignment_accepted AND NOT pickup_overdue;
    CREATE INDEX IF NOT EXISTS origin_pickup_alerts ON shipments(pickup_due_at,id) WHERE pickup_overdue;
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS pickup_site_id text REFERENCES sites(id);
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS custody_site_id text REFERENCES sites(id);
    ALTER TABLE shipments ADD COLUMN IF NOT EXISTS pickup_expires_at timestamptz;
    ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check;
    ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK(status IN ('ready','assigned','picked_up','in_transit','delivered','failed','cancelled','returning','returned','awaiting_handover','ready_for_pickup','pickup_expired'));
    CREATE INDEX IF NOT EXISTS pickup_expiry ON shipments(pickup_expires_at) WHERE status='ready_for_pickup';
    CREATE INDEX IF NOT EXISTS pickup_scope ON shipments(pickup_site_id,status);
    INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
    CREATE INDEX IF NOT EXISTS assignment_expiry ON shipments(assignment_expires_at) WHERE status='assigned' AND NOT assignment_accepted;
    CREATE INDEX IF NOT EXISTS return_assignment_expiry ON shipments(assignment_expires_at) WHERE status='returning' AND custody_site_id IS NOT NULL AND NOT assignment_accepted;
    CREATE INDEX IF NOT EXISTS shipments_scope ON shipments(merchant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS shipments_courier ON shipments(courier_id, status);
    CREATE TABLE IF NOT EXISTS timeline (id uuid PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES shipments(id),
      type text NOT NULL, description text NOT NULL, actor_name text NOT NULL, created_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS timeline_shipment ON timeline(shipment_id, created_at);
    CREATE TABLE IF NOT EXISTS idempotency (scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
      response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key));
    CREATE TABLE IF NOT EXISTS outbox (id uuid PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES shipments(id),
      type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL, sent_at timestamptz);
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_attempt_at);
    ALTER TABLE outbox ADD COLUMN IF NOT EXISTS cycle_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
    ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text;
    ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_retried_at timestamptz;
    UPDATE outbox SET cycle_attempts=attempts WHERE retry_count=0 AND cycle_attempts=0 AND attempts>0;
    CREATE TABLE IF NOT EXISTS integration_audit(id uuid PRIMARY KEY,actor_id text NOT NULL,action text NOT NULL,entity_id uuid NOT NULL,reason text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS received_events (event_id uuid PRIMARY KEY, type text NOT NULL,
      shipment_id uuid NOT NULL, version integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), fingerprint text);
    ALTER TABLE received_events ADD COLUMN IF NOT EXISTS fingerprint text;
    CREATE TABLE IF NOT EXISTS commerce_projection (shipment_id uuid PRIMARY KEY, version integer NOT NULL,
      status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS storefront_checkouts (id uuid PRIMARY KEY, owner_hash text NOT NULL,
      quote_id uuid NOT NULL REFERENCES quotes(id), items jsonb NOT NULL, subtotal_minor integer NOT NULL CHECK(subtotal_minor>=0),
      shipment_id uuid REFERENCES shipments(id), created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS storefront_owner ON storefront_checkouts(owner_hash,created_at DESC);
    ALTER TABLE storefront_checkouts ADD COLUMN IF NOT EXISTS inventory_required boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS storefront_quote ON storefront_checkouts(quote_id);
    CREATE TABLE IF NOT EXISTS inventory_stock (
      merchant_id text NOT NULL REFERENCES merchants(id), site_id text NOT NULL REFERENCES sites(id), product_id text NOT NULL,
      on_hand integer NOT NULL DEFAULT 0 CHECK(on_hand>=0), reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),
      quarantine integer NOT NULL DEFAULT 0 CHECK(quarantine>=0), version integer NOT NULL DEFAULT 1,
      PRIMARY KEY(merchant_id,site_id,product_id), CHECK(on_hand>=reserved+quarantine));
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      shipment_id uuid NOT NULL REFERENCES shipments(id), merchant_id text NOT NULL, site_id text NOT NULL, product_id text NOT NULL,
      quantity integer NOT NULL CHECK(quantity>0), state text NOT NULL CHECK(state IN ('reserved','prepared','dispatched','fulfilled','released','quarantined','restocked','discarded')),
      expires_at timestamptz, PRIMARY KEY(shipment_id,product_id),
      FOREIGN KEY(merchant_id,site_id,product_id) REFERENCES inventory_stock(merchant_id,site_id,product_id));
    CREATE INDEX IF NOT EXISTS inventory_expiry ON inventory_reservations(expires_at,shipment_id) WHERE state='reserved';
    CREATE INDEX IF NOT EXISTS inventory_scope ON inventory_reservations(merchant_id,site_id,product_id,state);
    ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS restocked_quantity integer NOT NULL DEFAULT 0;
    ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS discarded_quantity integer NOT NULL DEFAULT 0;
    UPDATE inventory_reservations SET restocked_quantity=quantity WHERE state='restocked' AND restocked_quantity=0;
    UPDATE inventory_reservations SET discarded_quantity=quantity WHERE state='discarded' AND discarded_quantity=0;
    ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_state_check;
    ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_state_check CHECK(state IN ('reserved','prepared','dispatched','fulfilled','released','quarantined','restocked','discarded','inspected'));
    ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_inspection_quantities;
    ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_inspection_quantities CHECK(restocked_quantity>=0 AND discarded_quantity>=0 AND restocked_quantity+discarded_quantity<=quantity);
    INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id uuid PRIMARY KEY, merchant_id text NOT NULL, site_id text NOT NULL, product_id text NOT NULL,
      shipment_id uuid REFERENCES shipments(id), kind text NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
      actor_name text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS inventory_history ON inventory_movements(merchant_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS inventory_movement_key ON inventory_movements(merchant_id,site_id,product_id);
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id uuid PRIMARY KEY, merchant_id text NOT NULL, site_id text NOT NULL, product_id text NOT NULL,
      before_on_hand integer NOT NULL CHECK(before_on_hand>=0),counted_on_hand integer NOT NULL CHECK(counted_on_hand>=0),delta integer NOT NULL,
      reserved integer NOT NULL CHECK(reserved>=0),quarantine integer NOT NULL CHECK(quarantine>=0),
      actor_name text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(merchant_id,site_id,product_id) REFERENCES inventory_stock(merchant_id,site_id,product_id),
      CHECK(counted_on_hand=before_on_hand+delta),CHECK(counted_on_hand>=reserved+quarantine));
    CREATE INDEX IF NOT EXISTS inventory_count_history ON inventory_counts(merchant_id,created_at DESC);
    INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=8) THEN
        ALTER TABLE sites ADD CONSTRAINT site_inventory_owner UNIQUE(id,merchant_id);
        ALTER TABLE inventory_stock ADD CONSTRAINT inventory_site_owner FOREIGN KEY(site_id,merchant_id) REFERENCES sites(id,merchant_id);
        CREATE INDEX inventory_site_history ON inventory_movements(site_id,created_at DESC);
        INSERT INTO schema_migrations(version) VALUES(8);
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS inventory_transfers(
      id uuid PRIMARY KEY,merchant_id text NOT NULL REFERENCES merchants(id),source_id text NOT NULL,destination_id text NOT NULL,
      status text NOT NULL CHECK(status IN ('reserved','assigned','accepted','released','in_transit','received','cancelled')),
      version integer NOT NULL DEFAULT 1,issue_open boolean NOT NULL DEFAULT false,weight_kg real NOT NULL CHECK(weight_kg>0 AND weight_kg<=50),courier_id text REFERENCES couriers(id),
      hold_expires_at timestamptz NOT NULL,assignment_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(source_id,merchant_id) REFERENCES sites(id,merchant_id),FOREIGN KEY(destination_id,merchant_id) REFERENCES sites(id,merchant_id),CHECK(source_id<>destination_id),UNIQUE(id,merchant_id,source_id,destination_id));
    CREATE TABLE IF NOT EXISTS inventory_transfer_lines(
      transfer_id uuid NOT NULL REFERENCES inventory_transfers(id),merchant_id text NOT NULL,source_id text NOT NULL,destination_id text NOT NULL,product_id text NOT NULL,
      quantity integer NOT NULL CHECK(quantity>0),received integer NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity),PRIMARY KEY(transfer_id,product_id),
      FOREIGN KEY(merchant_id,source_id,product_id) REFERENCES inventory_stock(merchant_id,site_id,product_id),FOREIGN KEY(merchant_id,destination_id,product_id) REFERENCES inventory_stock(merchant_id,site_id,product_id),FOREIGN KEY(transfer_id,merchant_id,source_id,destination_id) REFERENCES inventory_transfers(id,merchant_id,source_id,destination_id));
    CREATE TABLE IF NOT EXISTS inventory_transfer_events(id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES inventory_transfers(id),action text NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,reason text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS transfer_scope ON inventory_transfers(merchant_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS transfer_courier ON inventory_transfers(courier_id,status);
    CREATE INDEX IF NOT EXISTS transfer_deadlines ON inventory_transfers(hold_expires_at,assignment_expires_at) WHERE status IN ('reserved','assigned','accepted');
    CREATE INDEX IF NOT EXISTS transfer_event_history ON inventory_transfer_events(transfer_id,created_at DESC);
    ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES inventory_transfers(id);
    CREATE INDEX IF NOT EXISTS transfer_movement_history ON inventory_movements(transfer_id,product_id) WHERE transfer_id IS NOT NULL;
    INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=10) THEN
        ALTER TABLE inventory_transfers DROP CONSTRAINT inventory_transfers_status_check;
        ALTER TABLE inventory_transfers ADD CONSTRAINT inventory_transfers_status_check CHECK(status IN ('reserved','assigned','accepted','released','in_transit','received','resolved','cancelled'));
        ALTER TABLE inventory_transfer_lines ADD COLUMN lost integer NOT NULL DEFAULT 0;
        ALTER TABLE inventory_transfer_lines ADD COLUMN damaged integer NOT NULL DEFAULT 0;
        ALTER TABLE inventory_transfer_lines ADD COLUMN restocked integer NOT NULL DEFAULT 0;
        ALTER TABLE inventory_transfer_lines ADD COLUMN discarded integer NOT NULL DEFAULT 0;
        ALTER TABLE inventory_transfer_lines ADD CONSTRAINT transfer_resolution_quantities CHECK(lost>=0 AND received+lost<=quantity AND damaged>=0 AND damaged<=received AND restocked>=0 AND discarded>=0 AND restocked+discarded<=damaged);
        CREATE INDEX transfer_damage_pending ON inventory_transfer_lines(merchant_id,destination_id,product_id) WHERE damaged>restocked+discarded;
        INSERT INTO schema_migrations(version) VALUES(10);
      END IF;
    END $$;
    INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS location_sharing(shipment_id uuid PRIMARY KEY REFERENCES shipments(id),session_id uuid NOT NULL,courier_id text NOT NULL REFERENCES couriers(id),active boolean NOT NULL,customer_allowed boolean NOT NULL,expires_at timestamptz NOT NULL,sequence integer NOT NULL DEFAULT 0,latitude double precision,longitude double precision,accuracy double precision,measured_at timestamptz,received_at timestamptz,fingerprint text,
      CHECK(sequence>=0),CHECK(latitude BETWEEN -85 AND 85),CHECK(longitude BETWEEN -180 AND 180),CHECK(accuracy BETWEEN 0 AND 5000),CHECK((latitude IS NULL AND longitude IS NULL AND accuracy IS NULL AND measured_at IS NULL AND received_at IS NULL AND fingerprint IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy IS NOT NULL AND measured_at IS NOT NULL AND received_at IS NOT NULL AND fingerprint IS NOT NULL)));
    CREATE INDEX IF NOT EXISTS location_expiry ON location_sharing(expires_at) WHERE active;
    CREATE TABLE IF NOT EXISTS location_audit(id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES shipments(id),actor_id text NOT NULL,action text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS cash_obligations(shipment_id uuid PRIMARY KEY REFERENCES shipments(id),goods_minor bigint NOT NULL CHECK(goods_minor>0 AND goods_minor<=1000000000000),fee_minor bigint NOT NULL CHECK(fee_minor>=0),total_minor bigint NOT NULL CHECK(total_minor=goods_minor+fee_minor),currency text NOT NULL CHECK(currency='SYP'),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','collected','received')),version integer NOT NULL DEFAULT 1,issue_open boolean NOT NULL DEFAULT false,collector_id text,collector_name text,collected_at timestamptz,received_at timestamptz,
      CHECK((status='pending' AND collector_id IS NULL AND collected_at IS NULL AND received_at IS NULL) OR (status='collected' AND collector_id IS NOT NULL AND collected_at IS NOT NULL AND received_at IS NULL) OR (status='received' AND collector_id IS NOT NULL AND collected_at IS NOT NULL AND received_at IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS cash_journals(id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES cash_obligations(shipment_id),kind text NOT NULL CHECK(kind IN ('collection','remittance')),currency text NOT NULL CHECK(currency='SYP'),amount_minor bigint NOT NULL CHECK(amount_minor>0),sealed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shipment_id,kind));
    CREATE TABLE IF NOT EXISTS cash_postings(journal_id uuid NOT NULL REFERENCES cash_journals(id),account_code text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor<>0),PRIMARY KEY(journal_id,account_code));
    CREATE TABLE IF NOT EXISTS cash_events(id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES cash_obligations(shipment_id),action text NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,reference text NOT NULL,reason text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS cash_pending_holder ON cash_obligations(collector_id,status);
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=12) THEN
      CREATE FUNCTION validate_cash_balance() RETURNS trigger LANGUAGE plpgsql AS $f$ DECLARE task_journal uuid; task_count integer; task_sum numeric; task_sealed boolean; BEGIN
        IF TG_TABLE_NAME='cash_journals' THEN task_journal:=NEW.id; ELSE task_journal:=NEW.journal_id; END IF;
        SELECT COUNT(*),COALESCE(SUM(amount_minor),0) INTO task_count,task_sum FROM cash_postings WHERE journal_id=task_journal;
        SELECT sealed INTO task_sealed FROM cash_journals WHERE id=task_journal;
        IF NOT task_sealed OR task_count<2 OR task_sum<>0 THEN RAISE EXCEPTION 'Unbalanced cash journal' USING ERRCODE='23514'; END IF; RETURN NULL;
      END $f$;
      CREATE CONSTRAINT TRIGGER cash_journal_balanced AFTER INSERT ON cash_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_cash_balance();
      CREATE CONSTRAINT TRIGGER cash_postings_balanced AFTER INSERT ON cash_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_cash_balance();
      CREATE FUNCTION immutable_cash_entry() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF TG_TABLE_NAME='cash_journals' AND TG_OP='UPDATE' THEN
          IF NOT OLD.sealed AND NEW.sealed AND (to_jsonb(OLD)-'sealed')=(to_jsonb(NEW)-'sealed') THEN RETURN NEW; END IF;
        END IF;
        RAISE EXCEPTION 'Cash entries are immutable' USING ERRCODE='23514'; END $f$;
      CREATE FUNCTION guard_cash_posting() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF (SELECT sealed FROM cash_journals WHERE id=NEW.journal_id) THEN RAISE EXCEPTION 'Cash entries are immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $f$;
      CREATE TRIGGER cash_posting_sealed BEFORE INSERT ON cash_postings FOR EACH ROW EXECUTE FUNCTION guard_cash_posting();
      CREATE TRIGGER cash_journal_immutable BEFORE UPDATE OR DELETE ON cash_journals FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      CREATE TRIGGER cash_posting_immutable BEFORE UPDATE OR DELETE ON cash_postings FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      CREATE TRIGGER cash_event_immutable BEFORE UPDATE OR DELETE ON cash_events FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      INSERT INTO schema_migrations(version) VALUES(12);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=13) THEN
      CREATE UNIQUE INDEX shipment_merchant_owner ON shipments(id,merchant_id);
      CREATE TABLE cash_payouts(id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES cash_obligations(shipment_id),merchant_id text NOT NULL REFERENCES merchants(id),amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),currency text NOT NULL CHECK(currency='SYP'),status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','released','received','cancelled')),version integer NOT NULL DEFAULT 1,issue_open boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,received_at timestamptz,
        UNIQUE(id,shipment_id),FOREIGN KEY(shipment_id,merchant_id) REFERENCES shipments(id,merchant_id),CHECK((status IN ('reserved','cancelled') AND released_at IS NULL AND received_at IS NULL) OR (status='released' AND released_at IS NOT NULL AND received_at IS NULL) OR (status='received' AND released_at IS NOT NULL AND received_at IS NOT NULL)));
      CREATE UNIQUE INDEX active_cash_payout ON cash_payouts(shipment_id) WHERE status<>'cancelled';
      CREATE INDEX cash_payout_scope ON cash_payouts(merchant_id,status,created_at);
      CREATE INDEX cash_payout_source ON cash_payouts(shipment_id,created_at);
      CREATE TABLE cash_payout_events(id uuid PRIMARY KEY,payout_id uuid NOT NULL REFERENCES cash_payouts(id),action text NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,reference text NOT NULL,reason text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TRIGGER payout_event_immutable BEFORE UPDATE OR DELETE ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      CREATE INDEX cash_payout_event_history ON cash_payout_events(payout_id,created_at DESC);
      CREATE INDEX cash_payout_event_recent ON cash_payout_events(created_at DESC);
      ALTER TABLE cash_journals ADD COLUMN payout_id uuid REFERENCES cash_payouts(id);
      ALTER TABLE cash_journals ADD CONSTRAINT cash_payout_shipment FOREIGN KEY(payout_id,shipment_id) REFERENCES cash_payouts(id,shipment_id);
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive'));
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_shipment_id_kind_key;
      CREATE UNIQUE INDEX cash_original_journal ON cash_journals(shipment_id,kind) WHERE payout_id IS NULL;
      CREATE UNIQUE INDEX cash_payout_journal ON cash_journals(payout_id,kind) WHERE payout_id IS NOT NULL;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive') AND payout_id IS NOT NULL));
      INSERT INTO schema_migrations(version) VALUES(13);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=14) THEN
      ALTER TABLE cash_payouts ADD COLUMN return_requested boolean NOT NULL DEFAULT false;
      ALTER TABLE cash_payouts ADD COLUMN returned_at timestamptz;
      ALTER TABLE cash_payouts DROP CONSTRAINT cash_payouts_status_check;
      ALTER TABLE cash_payouts DROP CONSTRAINT cash_payouts_check;
      ALTER TABLE cash_payouts ADD CONSTRAINT cash_payouts_status_check CHECK(status IN ('reserved','released','received','cancelled','returned'));
      ALTER TABLE cash_payouts ADD CONSTRAINT payout_dates CHECK((status IN ('reserved','cancelled') AND released_at IS NULL AND received_at IS NULL) OR (status IN ('released','returned') AND released_at IS NOT NULL AND received_at IS NULL) OR (status='received' AND released_at IS NOT NULL AND received_at IS NOT NULL));
      ALTER TABLE cash_payouts ADD CONSTRAINT payout_return_state CHECK((return_requested=false OR status IN ('released','returned')) AND ((status='returned' AND return_requested AND returned_at IS NOT NULL) OR (status<>'returned' AND returned_at IS NULL)));
      DROP INDEX active_cash_payout;
      CREATE UNIQUE INDEX active_cash_payout ON cash_payouts(shipment_id) WHERE status NOT IN ('cancelled','returned');
      ALTER TABLE cash_journals ADD COLUMN reverses_journal_id uuid UNIQUE REFERENCES cash_journals(id);
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return'));
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return') AND payout_id IS NOT NULL));
      ALTER TABLE cash_journals ADD CONSTRAINT reversal_required CHECK((kind='payout_return')=(reverses_journal_id IS NOT NULL));
      CREATE FUNCTION validate_cash_reversal() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF NEW.kind='payout_return' THEN
          IF NOT EXISTS(SELECT 1 FROM cash_journals j WHERE j.id=NEW.reverses_journal_id AND j.kind='payout_release' AND j.sealed AND j.payout_id=NEW.payout_id AND j.shipment_id=NEW.shipment_id AND j.currency=NEW.currency AND j.amount_minor=NEW.amount_minor) OR
          EXISTS((SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id EXCEPT SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id) UNION ALL (SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id EXCEPT SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id)) THEN
            RAISE EXCEPTION 'Invalid cash reversal' USING ERRCODE='23514';
          END IF;
        END IF; RETURN NULL;
      END $f$;
      CREATE CONSTRAINT TRIGGER cash_reversal_valid AFTER INSERT ON cash_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_cash_reversal();
      INSERT INTO schema_migrations(version) VALUES(14);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=15) THEN
      ALTER TABLE cash_payouts ADD COLUMN recovery_requested boolean NOT NULL DEFAULT false;
      ALTER TABLE cash_payouts ADD COLUMN recovered_at timestamptz;
      ALTER TABLE cash_payouts DROP CONSTRAINT cash_payouts_status_check;
      ALTER TABLE cash_payouts DROP CONSTRAINT payout_dates;
      ALTER TABLE cash_payouts ADD CONSTRAINT cash_payouts_status_check CHECK(status IN ('reserved','released','received','cancelled','returned','recovered'));
      ALTER TABLE cash_payouts ADD CONSTRAINT payout_dates CHECK((status IN ('reserved','cancelled') AND released_at IS NULL AND received_at IS NULL) OR (status IN ('released','returned') AND released_at IS NOT NULL AND received_at IS NULL) OR (status IN ('received','recovered') AND released_at IS NOT NULL AND received_at IS NOT NULL));
      ALTER TABLE cash_payouts ADD CONSTRAINT payout_recovery_state CHECK((NOT recovery_requested OR (status IN ('received','recovered') AND NOT return_requested)) AND ((status='recovered' AND recovery_requested AND recovered_at IS NOT NULL) OR (status<>'recovered' AND recovered_at IS NULL)));
      DROP INDEX active_cash_payout;
      CREATE UNIQUE INDEX active_cash_payout ON cash_payouts(shipment_id) WHERE status NOT IN ('cancelled','returned','recovered');
      CREATE INDEX cash_payout_recovery ON cash_payouts(merchant_id,created_at) WHERE recovery_requested AND status='received';
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose;
      ALTER TABLE cash_journals DROP CONSTRAINT reversal_required;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return','payout_receive_reverse'));
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return','payout_receive_reverse') AND payout_id IS NOT NULL));
      ALTER TABLE cash_journals ADD CONSTRAINT reversal_required CHECK((kind IN ('payout_return','payout_receive_reverse'))=(reverses_journal_id IS NOT NULL));
      CREATE OR REPLACE FUNCTION validate_cash_reversal() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF NEW.kind IN ('payout_return','payout_receive_reverse') THEN
          IF NOT EXISTS(SELECT 1 FROM cash_journals j WHERE j.id=NEW.reverses_journal_id AND j.kind=CASE WHEN NEW.kind='payout_return' THEN 'payout_release' ELSE 'payout_receive' END AND j.sealed AND j.payout_id=NEW.payout_id AND j.shipment_id=NEW.shipment_id AND j.currency=NEW.currency AND j.amount_minor=NEW.amount_minor) OR
          EXISTS((SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id EXCEPT SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id) UNION ALL (SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id EXCEPT SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id)) THEN
            RAISE EXCEPTION 'Invalid cash reversal' USING ERRCODE='23514';
          END IF;
        END IF; RETURN NULL;
      END $f$;
      INSERT INTO schema_migrations(version) VALUES(15);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=16) THEN
      ALTER TABLE cash_obligations ADD COLUMN remittance_count integer NOT NULL DEFAULT 0 CHECK(remittance_count>=0);
      UPDATE cash_obligations SET remittance_count=1 WHERE status='received';
      ALTER TABLE cash_journals ADD COLUMN remittance_round integer;
      ALTER TABLE cash_journals ADD CONSTRAINT journal_identity_shipment UNIQUE(id,shipment_id);
      ALTER TABLE cash_journals DISABLE TRIGGER cash_journal_immutable;
      UPDATE cash_journals SET remittance_round=1 WHERE kind='remittance';
      ALTER TABLE cash_journals ENABLE TRIGGER cash_journal_immutable;
      CREATE TABLE cash_remittance_returns(id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES cash_obligations(shipment_id),original_journal_id uuid NOT NULL,collector_id text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),currency text NOT NULL CHECK(currency='SYP'),status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','released','confirmed','cancelled')),created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,confirmed_at timestamptz,
        UNIQUE(id,shipment_id),FOREIGN KEY(original_journal_id,shipment_id) REFERENCES cash_journals(id,shipment_id),CHECK((status IN ('requested','cancelled') AND released_at IS NULL AND confirmed_at IS NULL) OR (status='released' AND released_at IS NOT NULL AND confirmed_at IS NULL) OR (status='confirmed' AND released_at IS NOT NULL AND confirmed_at IS NOT NULL)));
      CREATE UNIQUE INDEX active_remittance_return ON cash_remittance_returns(shipment_id) WHERE status IN ('requested','released');
      CREATE UNIQUE INDEX returned_remittance_source ON cash_remittance_returns(original_journal_id) WHERE status<>'cancelled';
      CREATE INDEX remittance_return_scope ON cash_remittance_returns(collector_id,status,created_at);
      ALTER TABLE cash_journals ADD COLUMN remittance_return_id uuid;
      ALTER TABLE cash_journals ADD CONSTRAINT journal_remittance_return FOREIGN KEY(remittance_return_id,shipment_id) REFERENCES cash_remittance_returns(id,shipment_id);
      DROP INDEX cash_original_journal;
      CREATE UNIQUE INDEX cash_original_journal ON cash_journals(shipment_id,kind) WHERE kind='collection';
      CREATE UNIQUE INDEX cash_remittance_journal ON cash_journals(shipment_id,remittance_round) WHERE kind='remittance';
      CREATE UNIQUE INDEX cash_remittance_return_journal ON cash_journals(remittance_return_id,kind) WHERE remittance_return_id IS NOT NULL;
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose;
      ALTER TABLE cash_journals DROP CONSTRAINT reversal_required;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return','payout_receive_reverse','remittance_return_release','remittance_reverse','remittance_return_restore'));
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL AND remittance_return_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return','payout_receive_reverse') AND payout_id IS NOT NULL AND remittance_return_id IS NULL) OR (kind IN ('remittance_return_release','remittance_reverse','remittance_return_restore') AND payout_id IS NULL AND remittance_return_id IS NOT NULL));
      ALTER TABLE cash_journals ADD CONSTRAINT remittance_round_required CHECK((kind='remittance' AND remittance_round IS NOT NULL AND remittance_round>0) OR (kind<>'remittance' AND remittance_round IS NULL));
      ALTER TABLE cash_journals ADD CONSTRAINT reversal_required CHECK((kind IN ('payout_return','payout_receive_reverse','remittance_reverse','remittance_return_restore'))=(reverses_journal_id IS NOT NULL));
      CREATE OR REPLACE FUNCTION validate_cash_reversal() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF NEW.reverses_journal_id IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM cash_journals j WHERE j.id=NEW.reverses_journal_id AND j.kind=CASE NEW.kind WHEN 'payout_return' THEN 'payout_release' WHEN 'payout_receive_reverse' THEN 'payout_receive' WHEN 'remittance_reverse' THEN 'remittance' ELSE 'remittance_return_release' END AND j.sealed AND j.shipment_id=NEW.shipment_id AND j.currency=NEW.currency AND j.amount_minor=NEW.amount_minor AND j.payout_id IS NOT DISTINCT FROM NEW.payout_id AND (NEW.kind NOT IN ('remittance_reverse','remittance_return_restore') OR (NEW.kind='remittance_return_restore' AND j.remittance_return_id=NEW.remittance_return_id) OR (NEW.kind='remittance_reverse' AND EXISTS(SELECT 1 FROM cash_remittance_returns r WHERE r.id=NEW.remittance_return_id AND r.original_journal_id=j.id)))) OR
          EXISTS((SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id EXCEPT SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id) UNION ALL (SELECT account_code,-amount_minor FROM cash_postings WHERE journal_id=NEW.reverses_journal_id EXCEPT SELECT account_code,amount_minor FROM cash_postings WHERE journal_id=NEW.id)) THEN
            RAISE EXCEPTION 'Invalid cash reversal' USING ERRCODE='23514';
          END IF;
        END IF; RETURN NULL;
      END $f$;
      INSERT INTO schema_migrations(version) VALUES(16);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=17) THEN
      ALTER TABLE cash_remittance_returns ADD COLUMN issue_open boolean NOT NULL DEFAULT false;
      ALTER TABLE cash_remittance_returns ADD COLUMN last_reported_minor bigint CHECK(last_reported_minor>=0 AND last_reported_minor<=1000000000000);
      ALTER TABLE cash_remittance_returns ADD CONSTRAINT return_difference_state CHECK(NOT issue_open OR (status='released' AND last_reported_minor IS NOT NULL));
      ALTER TABLE cash_remittance_returns ADD CONSTRAINT return_difference_amount CHECK(last_reported_minor IS NULL OR last_reported_minor<>amount_minor);
      CREATE INDEX remittance_return_issue ON cash_remittance_returns(collector_id,shipment_id) WHERE issue_open;
      INSERT INTO schema_migrations(version) VALUES(17);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=18) THEN
      CREATE UNIQUE INDEX checkout_shipment_pair ON storefront_checkouts(id,shipment_id);
      CREATE TABLE commercial_returns(id uuid PRIMARY KEY,checkout_id uuid NOT NULL,shipment_id uuid NOT NULL UNIQUE,merchant_id text NOT NULL,items jsonb NOT NULL,goods_minor bigint NOT NULL CHECK(goods_minor>0 AND goods_minor<=1000000000000),currency text NOT NULL CHECK(currency='SYP'),reason text NOT NULL,status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected','cancelled')),version integer NOT NULL DEFAULT 1 CHECK(version>0),decision_reason text,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,cancelled_at timestamptz,
        FOREIGN KEY(checkout_id,shipment_id) REFERENCES storefront_checkouts(id,shipment_id),FOREIGN KEY(shipment_id,merchant_id) REFERENCES shipments(id,merchant_id),CHECK((status='requested' AND reviewed_at IS NULL AND decision_reason IS NULL AND cancelled_at IS NULL) OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL AND cancelled_at IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL)));
      CREATE INDEX commercial_return_scope ON commercial_returns(merchant_id,status,created_at);
      CREATE TABLE commercial_return_events(id uuid PRIMARY KEY,return_id uuid NOT NULL REFERENCES commercial_returns(id),action text NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,reference text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX commercial_return_history ON commercial_return_events(return_id,created_at DESC);
      CREATE TRIGGER commercial_return_event_immutable BEFORE UPDATE OR DELETE ON commercial_return_events FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      CREATE FUNCTION guard_commercial_return() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason'])<>(to_jsonb(NEW)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason']) OR NEW.version<>OLD.version+1 OR NOT ((OLD.status='requested' AND NEW.status IN ('approved','rejected','cancelled')) OR (OLD.status='approved' AND NEW.status='cancelled')) THEN RAISE EXCEPTION 'Commercial return history is protected' USING ERRCODE='23514'; END IF; RETURN NEW;
      END $f$;
      CREATE TRIGGER commercial_return_guard BEFORE UPDATE OR DELETE ON commercial_returns FOR EACH ROW EXECUTE FUNCTION guard_commercial_return();
      INSERT INTO schema_migrations(version) VALUES(18);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=19) THEN
      ALTER TABLE commercial_returns ADD COLUMN courier_id text REFERENCES couriers(id);
      ALTER TABLE commercial_returns ADD COLUMN collection_address text;
      ALTER TABLE commercial_returns ADD COLUMN assignment_expires_at timestamptz;
      ALTER TABLE commercial_returns ADD COLUMN accepted_at timestamptz;
      ALTER TABLE commercial_returns ADD COLUMN released_at timestamptz;
      ALTER TABLE commercial_returns ADD COLUMN picked_up_at timestamptz;
      ALTER TABLE commercial_returns ADD COLUMN received_at timestamptz;
      ALTER TABLE commercial_returns ADD COLUMN issue_open boolean NOT NULL DEFAULT false;
      ALTER TABLE commercial_returns DROP CONSTRAINT commercial_returns_status_check;
      ALTER TABLE commercial_returns DROP CONSTRAINT commercial_returns_check;
      ALTER TABLE commercial_returns ADD CONSTRAINT commercial_return_status CHECK(status IN ('requested','approved','rejected','cancelled','assigned','accepted','released','in_transit','received'));
      ALTER TABLE commercial_returns ADD CONSTRAINT commercial_return_review CHECK((status='requested' AND reviewed_at IS NULL AND decision_reason IS NULL) OR (status NOT IN ('requested','cancelled') AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL) OR status='cancelled');
      ALTER TABLE commercial_returns ADD CONSTRAINT commercial_return_transport CHECK(
        (status IN ('requested','approved','rejected','cancelled') AND courier_id IS NULL AND accepted_at IS NULL AND released_at IS NULL AND picked_up_at IS NULL AND received_at IS NULL AND assignment_expires_at IS NULL AND NOT issue_open)
        OR (status IN ('assigned','accepted','released','in_transit','received') AND courier_id IS NOT NULL AND collection_address IS NOT NULL AND ((status='assigned' AND assignment_expires_at IS NOT NULL AND accepted_at IS NULL) OR (status<>'assigned' AND assignment_expires_at IS NULL AND accepted_at IS NOT NULL)) AND (released_at IS NOT NULL)=(status IN ('released','in_transit','received')) AND (picked_up_at IS NOT NULL)=(status IN ('in_transit','received')) AND (received_at IS NOT NULL)=(status='received') AND (NOT issue_open OR status IN ('accepted','released','in_transit'))));
      CREATE INDEX commercial_return_courier ON commercial_returns(courier_id,status);
      CREATE OR REPLACE FUNCTION guard_commercial_return() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason','courier_id','collection_address','assignment_expires_at','accepted_at','released_at','picked_up_at','received_at','issue_open'])<>(to_jsonb(NEW)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason','courier_id','collection_address','assignment_expires_at','accepted_at','released_at','picked_up_at','received_at','issue_open']) OR NEW.version<>OLD.version+1 OR NOT (
          (OLD.status='requested' AND NEW.status IN ('approved','rejected','cancelled')) OR
          (OLD.status='approved' AND NEW.status IN ('assigned','cancelled')) OR
          (OLD.status='assigned' AND NEW.status IN ('accepted','approved','cancelled')) OR
          (OLD.status='accepted' AND NEW.status IN ('released','approved','cancelled','accepted')) OR
          (OLD.status='released' AND NEW.status IN ('in_transit','released')) OR
          (OLD.status='in_transit' AND NEW.status IN ('received','in_transit'))
        ) THEN RAISE EXCEPTION 'Commercial return history is protected' USING ERRCODE='23514'; END IF;
        IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN RAISE EXCEPTION 'Return review is immutable' USING ERRCODE='23514'; END IF;
        IF OLD.released_at IS NOT NULL AND (NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.courier_id IS DISTINCT FROM OLD.courier_id OR NEW.collection_address IS DISTINCT FROM OLD.collection_address OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN RAISE EXCEPTION 'Return custody is protected' USING ERRCODE='23514'; END IF;
        IF OLD.picked_up_at IS NOT NULL AND NEW.picked_up_at IS DISTINCT FROM OLD.picked_up_at THEN RAISE EXCEPTION 'Return pickup is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $f$;
      INSERT INTO schema_migrations(version) VALUES(19);
    END IF; END $$;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=20) THEN
      CREATE UNIQUE INDEX commercial_refund_source_pair ON commercial_returns(id,shipment_id);
      CREATE TABLE customer_refunds(id uuid PRIMARY KEY REFERENCES commercial_returns(id),shipment_id uuid NOT NULL UNIQUE REFERENCES cash_obligations(shipment_id),amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),currency text NOT NULL CHECK(currency='SYP'),status text NOT NULL CHECK(status IN ('requested','reserved','released','confirmed','cancelled')),last_reported_minor bigint CHECK(last_reported_minor>=0 AND last_reported_minor<=1000000000000 AND last_reported_minor<>amount_minor),version integer NOT NULL DEFAULT 1 CHECK(version>0),issue_open boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,confirmed_at timestamptz,CHECK(NOT issue_open OR (status='released' AND last_reported_minor IS NOT NULL)),UNIQUE(id,shipment_id),FOREIGN KEY(id,shipment_id) REFERENCES commercial_returns(id,shipment_id),CHECK((status IN ('requested','reserved','cancelled') AND released_at IS NULL AND confirmed_at IS NULL AND NOT issue_open) OR (status='released' AND released_at IS NOT NULL AND confirmed_at IS NULL) OR (status='confirmed' AND released_at IS NOT NULL AND confirmed_at IS NOT NULL AND NOT issue_open)));
      CREATE TABLE customer_refund_events(id uuid PRIMARY KEY,refund_id uuid NOT NULL REFERENCES customer_refunds(id),action text NOT NULL,actor_id text NOT NULL,actor_name text NOT NULL,reference text NOT NULL,reason text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
      CREATE TRIGGER refund_event_immutable BEFORE UPDATE OR DELETE ON customer_refund_events FOR EACH ROW EXECUTE FUNCTION immutable_cash_entry();
      CREATE FUNCTION guard_customer_refund() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['status','version','issue_open','released_at','confirmed_at','last_reported_minor'])<>(to_jsonb(NEW)-ARRAY['status','version','issue_open','released_at','confirmed_at','last_reported_minor']) OR NEW.version<>OLD.version+1 OR NOT((OLD.status='requested' AND NEW.status IN ('reserved','cancelled')) OR (OLD.status='reserved' AND NEW.status IN ('released','cancelled')) OR (OLD.status='released' AND NEW.status IN ('released','confirmed'))) OR (OLD.released_at IS NOT NULL AND OLD.released_at IS DISTINCT FROM NEW.released_at) THEN RAISE EXCEPTION 'Customer refund history protected' USING ERRCODE='23514'; END IF;RETURN NEW;
      END $f$;
      CREATE TRIGGER refund_guard BEFORE UPDATE OR DELETE ON customer_refunds FOR EACH ROW EXECUTE FUNCTION guard_customer_refund();
      ALTER TABLE cash_journals ADD COLUMN refund_id uuid;
      ALTER TABLE cash_journals ADD CONSTRAINT journal_refund_shipment FOREIGN KEY(refund_id,shipment_id) REFERENCES customer_refunds(id,shipment_id);
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return','payout_receive_reverse','remittance_return_release','remittance_reverse','remittance_return_restore','refund_release','refund_confirm'));
      ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose;
      ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL AND remittance_return_id IS NULL AND refund_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return','payout_receive_reverse') AND payout_id IS NOT NULL AND remittance_return_id IS NULL AND refund_id IS NULL) OR (kind IN ('remittance_return_release','remittance_reverse','remittance_return_restore') AND payout_id IS NULL AND remittance_return_id IS NOT NULL AND refund_id IS NULL) OR (kind IN ('refund_release','refund_confirm') AND payout_id IS NULL AND remittance_return_id IS NULL AND refund_id IS NOT NULL));
      CREATE UNIQUE INDEX customer_refund_journal ON cash_journals(refund_id,kind) WHERE refund_id IS NOT NULL;
      INSERT INTO schema_migrations(version) VALUES(20);
    END IF; END $$;
    CREATE TABLE IF NOT EXISTS delivery_proofs (shipment_id uuid PRIMARY KEY REFERENCES shipments(id),code_hash text NOT NULL,expires_at timestamptz NOT NULL,issued_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0,consumed_at timestamptz);
    CREATE TABLE IF NOT EXISTS demo_settings (id integer PRIMARY KEY CHECK(id=1), webhook_paused boolean NOT NULL DEFAULT false);
    INSERT INTO demo_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
  `);
  await seed(db);
  await db.transaction(async (tx) => {
    for (const product of catalog) {
      const inserted = await tx.query(
        "INSERT INTO inventory_stock(merchant_id,site_id,product_id,on_hand) VALUES('merchant-a','site-a',$1,30) ON CONFLICT DO NOTHING RETURNING product_id",
        [product.id],
      );
      if (inserted.rows.length)
        await tx.query(
          "INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) VALUES($1,'merchant-a','site-a',$2,'opening',30,'بيانات العرض','رصيد افتتاحي اصطناعي؛ لا يمثل جردًا تاريخيًا')",
          [randomUUID(), product.id],
        );
    }
  });
  await db.query(
    "UPDATE shipments SET assignment_expires_at=now()+interval '5 minutes' WHERE status='assigned' AND NOT assignment_accepted AND assignment_expires_at IS NULL",
  );
  return db;
}

async function seed(db: PGlite) {
  const initialized = await db.query<{ id: string }>('SELECT id FROM merchants LIMIT 1');
  if (initialized.rows.length) return;
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO merchants VALUES ('merchant-a','بيت الشام'),('merchant-b','نواة')");
    await tx.query(`INSERT INTO sites(id,name,city,address,kind,merchant_id) VALUES
      ('site-a','متجر بيت الشام','دمشق','شارع العابد، دمشق','store','merchant-a'),
      ('site-b','متجر نواة','دمشق','المزة، دمشق','store','merchant-b'),
      ('hub-a','مركز التجميع الرئيسي','دمشق','كفرسوسة، دمشق','hub',NULL),
      ('pickup-a','نقطة استلام الروضة','دمشق','الروضة، دمشق','pickup',NULL)`);
    await tx.query(`INSERT INTO couriers VALUES
      ('courier-a','أحمد منصور','دراجة نارية',12,true),
      ('courier-b','لينا الخطيب','سيارة صغيرة',50,true),
      ('courier-c','سامر الحسن','سيارة نقل',100,false)`);
    const examples = [
      ['merchant-a', 'site-a', 'رامي الشامي', 'المالكي، دمشق', 2.5, 'ready', null],
      ['merchant-a', 'site-a', 'نور أحمد', 'أبو رمانة، دمشق', 1.2, 'in_transit', 'courier-a'],
      ['merchant-b', 'site-b', 'هالة محمد', 'المزة، دمشق', 3.0, 'assigned', 'courier-b'],
      ['merchant-a', 'site-a', 'يوسف علي', 'الروضة، دمشق', 0.8, 'delivered', 'courier-b'],
      ['merchant-b', 'site-b', 'سارة خالد', 'كفرسوسة، دمشق', 4.0, 'failed', 'courier-b'],
      ['merchant-a', 'site-a', 'عمر حسن', 'الصالحية، دمشق', 1.5, 'ready', null],
    ] as const;
    for (const [i, row] of examples.entries()) {
      const id = randomUUID();
      const created = new Date(Date.now() - (i + 1) * 45 * 60_000).toISOString();
      await tx.query(
        `INSERT INTO shipments(id,reference,application_id,external_reference,merchant_id,recipient_name,destination,origin_id,
        weight_kg,status,courier_id,assignment_accepted,fee_minor,currency,tracking_token,created_at,updated_at)
        VALUES($1,$2,'demo-commerce',$3,$4,$5,$6,$7,$8,$9,$10,$11,3500000,'SYP',$12,$13,$13)`,
        [
          id,
          `SHP-${String(1001 + i)}`,
          `DEMO-${i + 1}`,
          row[0],
          row[2],
          row[3],
          row[1],
          row[4],
          row[5],
          row[6],
          row[5] !== 'ready',
          randomUUID(),
          created,
        ],
      );
      await tx.query('INSERT INTO timeline VALUES($1,$2,$3,$4,$5,$6)', [
        randomUUID(),
        id,
        'seeded',
        'تحميل حالة ابتدائية للعرض؛ ليست سجل تنفيذ فعلي',
        'بيانات العرض',
        created,
      ]);
    }
  });
}
