import { restoreCashSchema19 } from './helpers/cash-returns.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { cashFixture } from './helpers/cash.js';
import { fixture } from './helpers/inventory.js';

test('schema 18 approved return survives migration and restart without new stock or money', async () => {
  const root = resolve('artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, 'commercial-return-db-'));
  const f = await cashFixture(false, path);
  let closed = false;
  try {
    const { code } = await f.route();
    const delivered = await f.deliver(code);
    const request = await f.post(
      `/api/storefront/orders/${f.shipment().id}/returns`,
      {
        action: 'request',
        expectedShipmentVersion: delivered.json().version,
        reason: 'طلب إرجاع قديم قبل إضافة النقل',
      },
      'shop',
    );
    const r = request.json();
    const approve = await f.post(
      `/api/commercial-returns/${r.id}/actions`,
      {
        action: 'approve',
        expectedVersion: r.version,
        reference: 'قرار قديم 123',
        reason: 'موافقة المتجر قبل تطوير النقل العكسي',
      },
      'merchant-a',
    );
    assert.equal(approve.statusCode, 200, approve.body);
    const stock = await f.stock(),
      cash = (await f.view()).json();
    await restoreCashSchema19(f.db);
    await f.db.exec(`
      ALTER TABLE commercial_returns DROP CONSTRAINT commercial_return_status;
      ALTER TABLE commercial_returns DROP CONSTRAINT commercial_return_review;
      ALTER TABLE commercial_returns DROP CONSTRAINT commercial_return_transport;
      ALTER TABLE commercial_returns DROP COLUMN courier_id,DROP COLUMN collection_address,DROP COLUMN assignment_expires_at,DROP COLUMN accepted_at,DROP COLUMN released_at,DROP COLUMN picked_up_at,DROP COLUMN received_at,DROP COLUMN issue_open;
      ALTER TABLE commercial_returns ADD CONSTRAINT commercial_returns_status_check CHECK(status IN ('requested','approved','rejected','cancelled'));
      ALTER TABLE commercial_returns ADD CONSTRAINT commercial_returns_check CHECK((status='requested' AND reviewed_at IS NULL AND decision_reason IS NULL AND cancelled_at IS NULL) OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL AND cancelled_at IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL));
      CREATE OR REPLACE FUNCTION guard_commercial_return() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason'])<>(to_jsonb(NEW)-ARRAY['status','version','reviewed_at','cancelled_at','decision_reason']) OR NEW.version<>OLD.version+1 OR NOT ((OLD.status='requested' AND NEW.status IN ('approved','rejected','cancelled')) OR (OLD.status='approved' AND NEW.status='cancelled')) THEN RAISE EXCEPTION 'Commercial return history is protected' USING ERRCODE='23514'; END IF; RETURN NEW;
      END $f$;
      DELETE FROM schema_migrations WHERE version=19;
    `);
    await f.close();
    closed = true;
    const upgraded = await fixture(path);
    try {
      const row = (await upgraded.get('/api/commercial-returns')).json().rows[0];
      assert.equal(row.id, r.id);
      assert.equal(row.status, 'approved');
      assert.equal(row.courierId, null);
      assert.equal(row.version, approve.json().version);
      assert.deepEqual(await upgraded.stock(), stock);
      assert.deepEqual((await upgraded.get('/api/cash')).json(), cash);
      assert.equal(
        (await upgraded.db.query('SELECT * FROM commercial_return_events')).rows.length,
        2,
      );
      assert.equal(
        (await upgraded.db.query('SELECT * FROM schema_migrations WHERE version=19')).rows.length,
        1,
      );
    } finally {
      await upgraded.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + sep))
      throw new Error('Test cleanup escaped artifact root');
    await rm(path, { recursive: true, force: true });
  }
});
