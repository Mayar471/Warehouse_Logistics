import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Shipment } from '../shared/contracts.js';
import { fixture } from './helpers/inventory.js';
test('inventory confirmation is atomic under competing orders and retries do not reserve twice', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE inventory_stock SET on_hand=1 WHERE product_id='bag'");
    await f.db.query(
      "INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) VALUES(gen_random_uuid(),'merchant-a','site-a','bag','adjustment_out',29,'اختبار','تهيئة رصيد متسق للتنافس')",
    );
    const a = await f.checkout(),
      b = await f.checkout();
    assert.equal((await f.stock()).reserved, 0, 'quotes do not reserve');
    const results = await Promise.all([f.order(a.id), f.order(b.id)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(results.find((r) => r.statusCode === 409)!.json().code, 'OUT_OF_STOCK');
    assert.equal((await f.stock()).reserved, 1);
    const winner = results[0].statusCode === 200 ? a : b;
    const s = results.find((r) => r.statusCode === 200)!.json().shipment;
    assert.equal((await f.order(winner.id)).json().shipment.id, s.id);
    assert.equal((await f.stock()).reserved, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM inventory_movements WHERE shipment_id=$1 AND kind='reserve'",
          [s.id],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM shipments WHERE external_reference LIKE 'SHOP-%'")).rows
        .length,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ shipment_id: string | null }>(
          'SELECT shipment_id FROM storefront_checkouts WHERE id=$1',
          [winner.id],
        )
      ).rows[0].shipment_id,
      s.id,
    );
  } finally {
    await f.close();
  }
});
test('insufficient second product and failed outbox roll back stock, linkage, quote and creation together', async () => {
  const f = await fixture();
  try {
    const q = await f.checkout([
      { productId: 'bag', quantity: 2 },
      { productId: 'headphones', quantity: 1 },
    ]);
    await f.db.query("UPDATE inventory_stock SET on_hand=0 WHERE product_id='headphones'");
    assert.equal((await f.order(q.id)).statusCode, 409);
    assert.equal((await f.stock()).reserved, 0);
    assert.equal(
      (
        await f.db.query<{ consumed: boolean }>('SELECT consumed FROM quotes WHERE id=$1', [
          q.quote.id,
        ])
      ).rows[0].consumed,
      false,
    );
    assert.equal(
      (
        await f.db.query<{ shipment_id: string | null }>(
          'SELECT shipment_id FROM storefront_checkouts WHERE id=$1',
          [q.id],
        )
      ).rows[0].shipment_id,
      null,
    );
    await f.db.exec(
      "CREATE FUNCTION reject_inventory_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outbox failure'; END $$; CREATE TRIGGER reject_inventory_event BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_inventory_event();",
    );
    const next = await f.checkout();
    assert.equal((await f.order(next.id)).statusCode, 500);
    assert.equal((await f.stock()).reserved, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM inventory_movements WHERE kind='reserve'")).rows.length,
      0,
    );
    await f.db.exec('DROP TRIGGER reject_inventory_event ON outbox');
    assert.equal((await f.order(next.id)).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('preparation freezes expiry, dispatch removes physical stock, and cancellation releases prepared stock', async () => {
  const f = await fixture();
  try {
    let s = (await f.order((await f.checkout()).id)).json().shipment as Shipment;
    s = await f.act(s, 'prepare', 'merchant-a');
    assert.equal((await f.stock()).on_hand, 30);
    assert.equal((await f.stock()).reserved, 1);
    f.advance(25 * 60 * 60_000);
    await f.system.sweepAssignments();
    assert.equal((await f.get('/api/shipments/' + s.id)).json().shipment.status, 'ready');
    s = await f.act(s, 'cancel', 'merchant-a');
    assert.equal((await f.stock()).reserved, 0);
    assert.equal((await f.stock()).on_hand, 30);
    f.setNow(Date.now());
    s = (await f.order((await f.checkout()).id)).json().shipment;
    s = await f.act(s, 'prepare', 'merchant-a');
    s = await f.act(s, 'assign', 'ops', { courierId: 'courier-b' });
    s = await f.act(s, 'accept', 'courier-b');
    s = await f.act(s, 'handover_origin', 'merchant-a', { courierId: 'courier-b' });
    assert.equal((await f.stock()).on_hand, 29);
    assert.equal((await f.stock()).reserved, 0);
    assert.equal((await f.action(s, 'cancel', 'ops')).statusCode, 409);
    s = await f.act(s, 'pickup', 'courier-b');
    assert.equal((await f.stock()).on_hand, 29, 'courier receipt must not deduct twice');
  } finally {
    await f.close();
  }
});
test('expired inventory hold rejects preparation before sweep and sweep cancels accepted task once', async () => {
  const f = await fixture();
  try {
    let s = (await f.order((await f.checkout()).id)).json().shipment as Shipment;
    s = await f.act(s, 'assign', 'ops', { courierId: 'courier-b' });
    s = await f.act(s, 'accept', 'courier-b');
    f.advance(25 * 60 * 60_000);
    const r = await f.action(s, 'prepare', 'merchant-a');
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, 'RESERVATION_EXPIRED');
    await f.db.exec(
      "CREATE FUNCTION reject_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.reservation_expired' THEN RAISE EXCEPTION 'simulated expiry failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_expiry BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_expiry();",
    );
    await assert.rejects(f.system.sweepAssignments());
    assert.equal((await f.stock()).reserved, 1);
    assert.equal((await f.get('/api/shipments/' + s.id)).json().shipment.status, 'assigned');
    await f.db.exec('DROP TRIGGER reject_expiry ON outbox');
    await f.system.sweepAssignments();
    const after = (await f.get('/api/shipments/' + s.id)).json().shipment;
    assert.equal(after.status, 'cancelled');
    assert.equal(after.courierId, null);
    assert.equal(after.pickupOverdue, false);
    assert.equal((await f.stock()).reserved, 0);
    await f.system.sweepAssignments();
    assert.equal((await f.get('/api/shipments/' + s.id)).json().shipment.version, after.version);
  } finally {
    await f.close();
  }
});
test('inventory API enforces isolation, version, receipt replay and ledger rollback', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/api/inventory', 'courier-b')).statusCode, 403);
    assert.equal((await f.get('/api/inventory', 'pickup-a')).statusCode, 403);
    assert.equal((await f.get('/api/inventory', 'merchant-b')).json().stocks.length, 0);
    const body = {
      merchantId: 'merchant-a',
      siteId: 'site-a',
      productId: 'bag',
      quantity: 3,
      expectedVersion: 1,
      reason: 'استلام دفعة جديدة',
    };
    assert.equal((await f.post('/api/inventory/receipts', body, 'merchant-b')).statusCode, 404);
    const k = randomUUID();
    assert.equal((await f.post('/api/inventory/receipts', body, 'merchant-a', k)).statusCode, 200);
    assert.equal((await f.post('/api/inventory/receipts', body, 'merchant-a', k)).statusCode, 200);
    assert.equal((await f.stock()).on_hand, 33);
    assert.equal((await f.post('/api/inventory/receipts', body, 'merchant-a')).statusCode, 409);
    await f.db.exec(
      "CREATE FUNCTION reject_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated ledger failure'; END $$; CREATE TRIGGER reject_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION reject_movement();",
    );
    assert.equal(
      (await f.post('/api/inventory/receipts', { ...body, expectedVersion: 2 }, 'merchant-a'))
        .statusCode,
      500,
    );
    assert.equal((await f.stock()).on_hand, 33);
    assert.equal((await f.stock()).version, 2);
  } finally {
    await f.close();
  }
});
test('returned goods stay quarantined; inspection is atomic, scoped and cannot restock twice', async () => {
  const f = await fixture();
  try {
    for (const disposition of ['restock', 'discard']) {
      let s = (await f.order((await f.checkout()).id)).json().shipment as Shipment;
      for (const [a, who] of [
        ['prepare', 'merchant-a'],
        ['assign', 'ops'],
        ['accept', 'courier-b'],
        ['handover_origin', 'merchant-a'],
        ['pickup', 'courier-b'],
        ['return', 'ops'],
        ['receive_return', 'ops'],
      ])
        s = await f.act(s, a, who, {
          ...(['assign', 'handover_origin'].includes(a) ? { courierId: 'courier-b' } : {}),
          ...(a === 'return' ? { reason: 'تعذر التسليم للعميل' } : {}),
        });
      const before = await f.stock();
      assert.equal(before.quarantine, 1);
      assert.equal(before.on_hand - before.reserved - before.quarantine, 29);
      const url = `/api/inventory/returns/${s.id}/inspect`,
        body = { expectedVersion: s.version, disposition, reason: 'فحص مادي موثق لجميع القطع' };
      assert.equal((await f.post(url, body, 'merchant-b')).statusCode, 404);
      assert.equal((await f.post(url, body, 'courier-b')).statusCode, 403);
      if (disposition === 'restock') {
        await f.db.exec(
          "CREATE FUNCTION reject_inspection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.inventory_inspected' THEN RAISE EXCEPTION 'simulated inspection failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_inspection BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_inspection();",
        );
        assert.equal((await f.post(url, body, 'merchant-a')).statusCode, 500);
        assert.equal((await f.stock()).quarantine, 1);
        await f.db.exec('DROP TRIGGER reject_inspection ON outbox');
      }
      const k = randomUUID();
      assert.equal((await f.post(url, body, 'merchant-a', k)).statusCode, 200);
      assert.equal((await f.post(url, body, 'merchant-a', k)).statusCode, 200);
      assert.equal((await f.post(url, body, 'merchant-a')).statusCode, 409);
      const after = await f.stock();
      assert.equal(after.quarantine, 0);
      assert.equal(after.on_hand, disposition === 'restock' ? 30 : 29);
    }
  } finally {
    await f.close();
  }
});
test('legacy storefront orders are not assigned fabricated reservations', async () => {
  const f = await fixture();
  try {
    const q = await f.checkout();
    await f.db.query('UPDATE storefront_checkouts SET inventory_required=false WHERE id=$1', [
      q.id,
    ]);
    const s = (await f.order(q.id)).json().shipment;
    assert.equal((await f.get('/api/shipments/' + s.id)).json().inventory.length, 0);
    assert.equal((await f.stock()).reserved, 0);
  } finally {
    await f.close();
  }
});
