import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { catalog } from '../shared/catalog.js';
import { dispatchCell } from './spatial-index.js';
import type { Role, ShipmentStatus } from '../shared/contracts.js';

const { Pool } = pg;

export type Transaction = Pick<PGlite, 'query'>;
export interface ShipmentRow {
  priority: 'normal' | 'urgent';
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

const schemaSQL = `
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
  DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=10) THEN
    ALTER TABLE inventory_transfers DROP CONSTRAINT inventory_transfers_status_check;
    ALTER TABLE inventory_transfers ADD CONSTRAINT inventory_transfers_status_check CHECK(status IN ('reserved','assigned','accepted','released','in_transit','received','resolved','cancelled'));
    ALTER TABLE inventory_transfer_lines ADD COLUMN lost integer NOT NULL DEFAULT 0;
    ALTER TABLE inventory_transfer_lines ADD COLUMN damaged integer NOT NULL DEFAULT 0;
    ALTER TABLE inventory_transfer_lines ADD COLUMN restocked integer NOT NULL DEFAULT 0;
    ALTER TABLE inventory_transfer_lines ADD COLUMN discarded integer NOT NULL DEFAULT 0;
    ALTER TABLE inventory_transfer_lines ADD CONSTRAINT transfer_resolution_quantities CHECK(lost>=0 AND received+lost<=quantity AND damaged>=0 AND damaged<=received AND restocked>=0 AND discarded>=0 AND restocked+discarded<=damaged);
    CREATE INDEX transfer_damage_pending ON inventory_transfer_lines(merchant_id,destination_id,product_id) WHERE damaged>restocked+discarded;
    INSERT INTO schema_migrations(version) VALUES(10);
  END IF; END $$;
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
    INSERT INTO schema_migrations(version) VALUES(14);
  END IF; END $$;
  DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=15) THEN
    CREATE TABLE customer_locations(id uuid PRIMARY KEY,shipment_id uuid REFERENCES shipments(id),owner_hash text NOT NULL,label text NOT NULL CHECK(label IN ('home','work','custom')),name text NOT NULL,address text NOT NULL,latitude double precision,longitude double precision,accuracy double precision,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS customer_location_owner ON customer_locations(owner_hash,created_at DESC);
    CREATE TABLE service_ratings(id uuid PRIMARY KEY,shipment_id uuid REFERENCES shipments(id),courier_id text REFERENCES couriers(id),pickup_site_id text REFERENCES sites(id),stars integer NOT NULL CHECK(stars>=1 AND stars<=5),comment text,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE delivery_service_subjects(id uuid PRIMARY KEY,shipment_id uuid REFERENCES shipments(id),role text NOT NULL CHECK(role IN ('courier','pickup')),subject_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX service_rating_shipment ON service_ratings(shipment_id);
    CREATE INDEX service_rating_courier ON service_ratings(courier_id);
    CREATE INDEX service_rating_pickup ON service_ratings(pickup_site_id);
    CREATE INDEX delivery_subject_shipment ON delivery_service_subjects(shipment_id);
    INSERT INTO schema_migrations(version) VALUES(15);
  END IF; END $$;
  DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=16) THEN
    CREATE TABLE pickup_hours(id uuid PRIMARY KEY,site_id text NOT NULL REFERENCES sites(id),day_of_week integer NOT NULL CHECK(day_of_week>=0 AND day_of_week<=6),opens_at time NOT NULL,closes_at time NOT NULL,UNIQUE(site_id,day_of_week));
    CREATE TABLE pickup_exceptions(id uuid PRIMARY KEY,site_id text NOT NULL REFERENCES sites(id),date date NOT NULL,opens_at time,closes_at time,closed boolean NOT NULL DEFAULT false,reason text,UNIQUE(site_id,date));
    CREATE INDEX IF NOT EXISTS pickup_hours_site ON pickup_hours(site_id);
    CREATE INDEX IF NOT EXISTS pickup_exceptions_site ON pickup_exceptions(site_id,date);
    INSERT INTO schema_migrations(version) VALUES(16);
  END IF; END $$;
  DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=17) THEN
    CREATE TABLE disputes(id uuid PRIMARY KEY,shipment_id uuid REFERENCES shipments(id),priority text NOT NULL CHECK(priority IN ('low','normal','high')),status text NOT NULL CHECK(status IN ('open','review','resolved','closed')),responsible_party text,responsible_audience text,deadline timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),decision text,decision_reason text,closed_at timestamptz,closed_by text);
    CREATE TABLE dispute_participants(id uuid PRIMARY KEY,dispute_id uuid NOT NULL REFERENCES disputes(id),audience text NOT NULL,name text NOT NULL,role text NOT NULL,UNIQUE(dispute_id,audience));
    CREATE INDEX IF NOT EXISTS dispute_participant_access ON dispute_participants(audience,dispute_id);
    CREATE TABLE IF NOT EXISTS dispute_events(id uuid PRIMARY KEY,sequence bigserial NOT NULL UNIQUE,dispute_id uuid NOT NULL REFERENCES disputes(id),actor_name text NOT NULL,actor_audience text NOT NULL,action text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('shared','internal')),text text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL);
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispute_events_immutable') THEN CREATE TRIGGER dispute_events_immutable BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION protect_service_rating(); END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispute_participants_immutable') THEN CREATE TRIGGER dispute_participants_immutable BEFORE UPDATE OR DELETE ON dispute_participants FOR EACH ROW EXECUTE FUNCTION protect_service_rating(); END IF;
    END $$;
    INSERT INTO schema_migrations(version) VALUES(29) ON CONFLICT DO NOTHING;
  END IF; END $$;
  INSERT INTO schema_migrations(version) VALUES(30) ON CONFLICT DO NOTHING;
  ALTER TABLE shipments ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent'));
  CREATE TABLE IF NOT EXISTS dispatch_locations(
    courier_id text PRIMARY KEY REFERENCES couriers(id),
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy double precision,
    updated_at timestamptz NOT NULL
  );
`;

// دالة الاتصال وفتح القاعدة وتنفيذ schemaSQL ككتلة واحدة صحيحة
export async function openDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  const client = await pool.connect();
  try {
    console.log("Opening database and executing schema...");
    // تنفيذ السكربت كاملاً كدفعة واحدة لتجنب أخطاء التقسيم مع الـ DO blocks
    await client.query(schemaSQL);
    console.log("Database schema initialized successfully.");
  } finally {
    client.release();
  }

  return pool;
}