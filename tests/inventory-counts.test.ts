import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/inventory.js';
import { openDatabase } from '../server/db.js';
import { reconcileInventory } from '../server/inventory-reconciliation.js';
import type { InventoryReconciliation } from '../shared/inventory-reconciliation.js';
const report = async (f: Awaited<ReturnType<typeof fixture>>, who = 'ops') =>
  (await f.get('/api/inventory/reconciliation', who)).json() as InventoryReconciliation;
const countBody = (counted: number, expectedVersion: number) => ({
  merchantId: 'merchant-a',
  siteId: 'site-a',
  productId: 'bag',
  counted,
  expectedVersion,
  reason: 'جرد فعلي موثق للرف',
});
test('reconciliation matches reservation, preparation, cancellation, mixed returns and count adjustments', async () => {
  const f = await fixture();
  try {
    assert.equal((await report(f)).matched, 6);
    let s = (await f.order((await f.checkout([{ productId: 'bag', quantity: 3 }])).id)).json()
      .shipment;
    assert.equal((await report(f)).exceptions, 0);
    s = await f.act(s, 'prepare', 'merchant-a');
    assert.equal((await report(f)).exceptions, 0);
    await f.act(s, 'cancel', 'merchant-a');
    assert.equal((await report(f)).exceptions, 0);
    s = await f.returned();
    assert.equal((await report(f)).exceptions, 0);
    assert.equal(
      (
        await f.post(
          `/api/inventory/returns/${s.id}/inspect`,
          {
            expectedVersion: s.version,
            reason: 'فحص قطع صالحة وتالفة',
            items: [{ productId: 'bag', restock: 1, discard: 1 }],
          },
          'merchant-a',
        )
      ).statusCode,
      200,
    );
    const row = (await report(f)).rows.find((r) => r.productId === 'bag')!;
    assert.equal(row.matched, true);
    assert.equal(row.onHand, 29);
    assert.equal(row.ledgerOnHand, 29);
    assert.equal(row.quarantineFromReturns, 1);
    assert.equal(row.ledgerQuarantine, 1);
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(28, row.version!), 'merchant-a')).statusCode,
      200,
    );
    assert.equal((await report(f)).exceptions, 0);
    assert.equal((await f.stock()).on_hand, 28);
    assert.equal((await f.stock()).quarantine, 1);
  } finally {
    await f.close();
  }
});
test('reconciliation detects balance drift, independent order drift, unknown movements and orphan keys without repairing them', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE inventory_stock SET on_hand=31 WHERE product_id='bag'");
    let row = (await report(f)).rows.find((r) => r.productId === 'bag')!;
    assert.equal(row.matched, false);
    assert.ok(row.differences.includes('الموجود لا يطابق الحركات'));
    const denied = await f.post('/api/inventory/counts', countBody(30, 1), 'merchant-a');
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().code, 'INVENTORY_INCONSISTENT');
    assert.equal((await f.stock()).on_hand, 31);
    await f.db.query("UPDATE inventory_stock SET on_hand=30 WHERE product_id='bag'");
    const s = (await f.order((await f.checkout()).id)).json().shipment;
    await f.db.query('UPDATE inventory_reservations SET quantity=2 WHERE shipment_id=$1', [s.id]);
    row = (await report(f)).rows.find((r) => r.productId === 'bag')!;
    assert.equal(row.ledgerReserved, 1);
    assert.equal(row.reservedFromOrders, 2);
    assert.equal(row.matched, false);
    await f.db.query(
      "INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) VALUES($1,'merchant-b','site-b','orphan','unexpected',1,'اختبار','حركة غير معروفة')",
      [randomUUID()],
    );
    const orphan = (await report(f)).rows.find((r) => r.productId === 'orphan')!;
    assert.equal(orphan.onHand, null);
    assert.equal(orphan.unknownMovements, 1);
    assert.equal(orphan.matched, false);
    assert.equal(
      (await report(f, 'merchant-a')).rows.some((r) => r.merchantId === 'merchant-b'),
      false,
    );
    assert.equal((await report(f, 'merchant-b')).rows.length, 1);
  } finally {
    await f.close();
  }
});
test('counting enforces permissions, replay, concurrent versions, zero counts and unchanged audit records', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/api/inventory/reconciliation', 'courier-b')).statusCode, 403);
    assert.equal((await f.get('/api/inventory/counts', 'pickup-a')).statusCode, 403);
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(33, 1), 'merchant-b')).statusCode,
      404,
    );
    assert.equal(
      (await f.post('/api/inventory/counts', { ...countBody(33, 1), delta: 3 }, 'ops')).statusCode,
      422,
    );
    const k = randomUUID();
    const saved = await f.post('/api/inventory/counts', countBody(33, 1), 'merchant-a', k);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().delta, 3);
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(33, 1), 'merchant-a', k)).json().id,
      saved.json().id,
    );
    assert.equal((await f.stock()).on_hand, 33);
    assert.equal((await f.get('/api/inventory/counts', 'merchant-a')).json().counts.length, 1);
    assert.equal((await f.get('/api/inventory/counts', 'merchant-b')).json().counts.length, 0);
    const results = await Promise.all([
      f.post('/api/inventory/counts', countBody(32, 2), 'merchant-a'),
      f.post('/api/inventory/counts', countBody(34, 2), 'ops'),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    let stock = await f.stock();
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(stock.on_hand, stock.version), 'ops')).json()
        .delta,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM inventory_movements WHERE kind IN ('adjustment_in','adjustment_out')",
        )
      ).rows.length,
      2,
      'unchanged count has no quantity movement',
    );
    stock = await f.stock();
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(0, stock.version), 'ops')).statusCode,
      200,
    );
    assert.equal((await f.stock()).on_hand, 0);
    assert.equal((await report(f)).exceptions, 0);
  } finally {
    await f.close();
  }
});
test('counts protect reserved and quarantined quantities and roll back on audit or movement failures', async () => {
  const f = await fixture();
  try {
    const held = (await f.order((await f.checkout([{ productId: 'bag', quantity: 2 }])).id)).json()
      .shipment;
    await f.returned([{ productId: 'bag', quantity: 3 }]);
    const before = await f.stock();
    assert.equal(before.reserved, 2);
    assert.equal(before.quarantine, 3);
    const rejected = await f.post(
      '/api/inventory/counts',
      countBody(4, before.version),
      'merchant-a',
    );
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().code, 'COUNT_BELOW_COMMITTED');
    assert.deepEqual(await f.stock(), before);
    await f.db.exec(
      "CREATE FUNCTION reject_count_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated count audit failure'; END $$; CREATE TRIGGER reject_count_audit BEFORE INSERT ON inventory_counts FOR EACH ROW EXECUTE FUNCTION reject_count_audit();",
    );
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(31, before.version), 'ops')).statusCode,
      500,
    );
    assert.deepEqual(await f.stock(), before);
    await f.db.exec('DROP TRIGGER reject_count_audit ON inventory_counts');
    await f.db.exec(
      "CREATE FUNCTION reject_count_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='adjustment_out' THEN RAISE EXCEPTION 'simulated count movement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_count_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION reject_count_movement();",
    );
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(29, before.version), 'ops')).statusCode,
      500,
    );
    assert.deepEqual(await f.stock(), before);
    assert.equal((await f.get('/api/inventory/counts')).json().counts.length, 0);
    assert.equal((await f.get('/api/shipments/' + held.id)).json().shipment.status, 'ready');
  } finally {
    await f.close();
  }
});
test('reconciliation totals include all scoped keys and prioritize discrepancies beyond the display limit', async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      for (let i = 0; i < 101; i++) {
        const product = 'test-' + String(i).padStart(3, '0');
        await tx.query(
          "INSERT INTO inventory_stock(merchant_id,site_id,product_id,on_hand) VALUES('merchant-a','site-a',$1,$2)",
          [product, i === 100 ? 2 : 1],
        );
        await tx.query(
          "INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) VALUES($1,'merchant-a','site-a',$2,'opening',1,'اختبار','رصيد اختبار')",
          [randomUUID(), product],
        );
      }
    });
    const checked = await report(f);
    assert.equal(checked.total, 107);
    assert.equal(checked.matched, 106);
    assert.equal(checked.exceptions, 1);
    assert.equal(checked.rows.length, 100);
    assert.equal(checked.rows[0].productId, 'test-100');
  } finally {
    await f.close();
  }
});
test('count audit and movement reconciliation survive database restart without repeating opening balances', async () => {
  const path = await mkdtemp(join(tmpdir(), 'logistics-count-'));
  const f = await fixture(path);
  let closed = false;
  try {
    assert.equal(
      (await f.post('/api/inventory/counts', countBody(27, 1), 'merchant-a')).statusCode,
      200,
    );
    await f.close();
    closed = true;
    const db = await openDatabase(path);
    try {
      const checked = await reconcileInventory(db, 'merchant-a');
      assert.equal(checked.exceptions, 0);
      assert.equal(checked.rows.find((r) => r.productId === 'bag')!.onHand, 27);
      assert.equal((await db.query('SELECT id FROM inventory_counts')).rows.length, 1);
      assert.equal(
        (await db.query("SELECT id FROM inventory_movements WHERE kind='opening'")).rows.length,
        6,
      );
    } finally {
      await db.close();
    }
  } finally {
    if (!closed) await f.close();
    await rm(path, { recursive: true, force: true });
  }
});
