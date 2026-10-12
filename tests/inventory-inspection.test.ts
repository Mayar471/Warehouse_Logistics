import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { fixture } from './helpers/inventory.js';
test('partial inspection separates good, damaged and uninspected pieces across products without replay inflation', async () => {
  const f = await fixture();
  try {
    const s = await f.returned([
      { productId: 'bag', quantity: 3 },
      { productId: 'cup', quantity: 2 },
    ]);
    const url = `/api/inventory/returns/${s.id}/inspect`;
    const body = {
      expectedVersion: s.version,
      reason: 'فحص جزئي أول موثق',
      items: [{ productId: 'bag', restock: 1, discard: 1 }],
    };
    const k = randomUUID();
    assert.equal((await f.post(url, body, 'merchant-a', k)).statusCode, 200);
    assert.equal((await f.post(url, body, 'merchant-a', k)).statusCode, 200);
    assert.deepEqual(
      { onHand: (await f.stock()).on_hand, quarantine: (await f.stock()).quarantine },
      { onHand: 29, quarantine: 1 },
    );
    assert.equal((await f.stock('cup')).quarantine, 2);
    const task = (await f.get('/api/inventory'))
      .json()
      .returns.find((r: { id: string }) => r.id === s.id);
    assert.deepEqual(
      task.items.find((i: { productId: string }) => i.productId === 'bag'),
      { productId: 'bag', quantity: 1, originalQuantity: 3, restocked: 1, discarded: 1 },
    );
    assert.equal((await f.get('/api/inventory', 'merchant-b')).json().returns.length, 0);
    assert.equal((await f.post(url, body, 'merchant-a')).statusCode, 409);
    assert.equal(
      (
        await f.post(
          url,
          {
            expectedVersion: task.version,
            reason: 'إكمال فحص بقية القطع',
            items: [
              { productId: 'bag', restock: 1, discard: 0 },
              { productId: 'cup', restock: 0, discard: 2 },
            ],
          },
          'ops',
        )
      ).statusCode,
      200,
    );
    assert.equal((await f.stock()).quarantine, 0);
    assert.equal((await f.stock()).on_hand, 29);
    assert.equal((await f.stock('cup')).on_hand, 28);
    assert.equal((await f.stock('cup')).quarantine, 0);
    assert.equal((await f.get('/api/inventory')).json().returns.length, 0);
    const rows = await f.db.query<{
      product_id: string;
      state: string;
      restocked_quantity: number;
      discarded_quantity: number;
    }>('SELECT * FROM inventory_reservations WHERE shipment_id=$1 ORDER BY product_id', [s.id]);
    assert.equal(rows.rows[0].state, 'inspected');
    assert.equal(rows.rows[0].restocked_quantity, 2);
    assert.equal(rows.rows[0].discarded_quantity, 1);
    const totals = await f.db.query<{ kind: string; quantity: number }>(
      "SELECT kind,SUM(quantity)::integer AS quantity FROM inventory_movements WHERE shipment_id=$1 AND kind IN ('restock','discard') GROUP BY kind ORDER BY kind",
      [s.id],
    );
    assert.deepEqual(totals.rows, [
      { kind: 'discard', quantity: 3 },
      { kind: 'restock', quantity: 2 },
    ]);
  } finally {
    await f.close();
  }
});

test('partial inspection rejects invalid quantities and concurrent stale decisions without altering other lines', async () => {
  const f = await fixture();
  try {
    const s = await f.returned();
    const url = `/api/inventory/returns/${s.id}/inspect`;
    const common = { expectedVersion: s.version, reason: 'فحص كمية جزئية موثق' };
    for (const items of [
      [],
      [{ productId: 'bag', restock: 0, discard: 0 }],
      [{ productId: 'bag', restock: -1, discard: 0 }],
      [{ productId: 'bag', restock: 0.5, discard: 0 }],
      [
        { productId: 'bag', restock: 1, discard: 0 },
        { productId: 'bag', restock: 1, discard: 0 },
      ],
      [
        { productId: 'bag', restock: 1, discard: 0 },
        { productId: 'unknown', restock: 1, discard: 0 },
      ],
    ]) {
      assert.equal((await f.post(url, { ...common, items }, 'merchant-a')).statusCode, 422);
      assert.equal((await f.stock()).quarantine, 3);
      assert.equal((await f.stock()).on_hand, 30);
    }
    assert.equal(
      (
        await f.post(
          url,
          { ...common, items: [{ productId: 'bag', restock: 2, discard: 2 }] },
          'merchant-a',
        )
      ).statusCode,
      409,
    );
    const body = { ...common, items: [{ productId: 'bag', restock: 1, discard: 0 }] };
    const outcomes = await Promise.all([f.post(url, body, 'merchant-a'), f.post(url, body, 'ops')]);
    assert.deepEqual(outcomes.map((o) => o.statusCode).sort(), [200, 409]);
    assert.equal((await f.stock()).quarantine, 2);
    const version = (await f.get('/api/shipments/' + s.id)).json().shipment.version;
    assert.equal(
      (
        await f.post(
          url,
          { ...common, expectedVersion: version, disposition: 'discard' },
          'merchant-a',
        )
      ).statusCode,
      200,
      'legacy full decision applies only to the remaining pieces',
    );
    assert.equal((await f.stock()).on_hand, 28);
    assert.equal((await f.stock()).quarantine, 0);
  } finally {
    await f.close();
  }
});

test('partial inspection rolls back quantities, movements and versions when a later ledger entry or event fails', async () => {
  const f = await fixture();
  try {
    const s = await f.returned();
    const url = `/api/inventory/returns/${s.id}/inspect`;
    const body = {
      expectedVersion: s.version,
      reason: 'فحص صالح وتالف',
      items: [{ productId: 'bag', restock: 1, discard: 1 }],
    };
    const before = await f.stock();
    await f.db.exec(
      "CREATE FUNCTION reject_partial_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='discard' THEN RAISE EXCEPTION 'simulated partial ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_partial_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION reject_partial_movement();",
    );
    assert.equal((await f.post(url, body, 'merchant-a')).statusCode, 500);
    assert.deepEqual(await f.stock(), before);
    await f.db.exec('DROP TRIGGER reject_partial_movement ON inventory_movements');
    await f.db.exec(
      "CREATE FUNCTION reject_partial_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.inventory_inspected' THEN RAISE EXCEPTION 'simulated partial event failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_partial_event BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_partial_event();",
    );
    assert.equal((await f.post(url, body, 'merchant-a')).statusCode, 500);
    assert.deepEqual(await f.stock(), before);
    const reservation = (
      await f.db.query<{ restocked_quantity: number; discarded_quantity: number }>(
        'SELECT * FROM inventory_reservations WHERE shipment_id=$1',
        [s.id],
      )
    ).rows[0];
    assert.equal(reservation.restocked_quantity, 0);
    assert.equal(reservation.discarded_quantity, 0);
    assert.equal((await f.get('/api/shipments/' + s.id)).json().shipment.version, s.version);
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM inventory_movements WHERE shipment_id=$1 AND kind IN ('restock','discard')",
          [s.id],
        )
      ).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('inspection migration preserves prior full decisions and partially inspected quantities across restarts', async () => {
  const path = await mkdtemp(join(tmpdir(), 'logistics-inspection-'));
  const f = await fixture(path);
  let closed = false;
  try {
    const s = await f.returned();
    assert.equal(
      (
        await f.post(
          `/api/inventory/returns/${s.id}/inspect`,
          { expectedVersion: s.version, disposition: 'restock', reason: 'فحص كامل قبل الترحيل' },
          'merchant-a',
        )
      ).statusCode,
      200,
    );
    const before = await f.stock();
    await f.db.exec(
      'ALTER TABLE inventory_reservations DROP COLUMN restocked_quantity; ALTER TABLE inventory_reservations DROP COLUMN discarded_quantity; DELETE FROM schema_migrations WHERE version=6;',
    );
    await f.close();
    closed = true;
    const db = await openDatabase(path);
    try {
      const row = (
        await db.query<{ restocked_quantity: number; discarded_quantity: number }>(
          'SELECT * FROM inventory_reservations WHERE shipment_id=$1',
          [s.id],
        )
      ).rows[0];
      assert.equal(row.restocked_quantity, 3);
      assert.equal(row.discarded_quantity, 0);
      assert.deepEqual(
        (await db.query('SELECT * FROM inventory_stock WHERE product_id=$1', ['bag'])).rows[0],
        before,
      );
      await assert.rejects(
        db.query('UPDATE inventory_reservations SET discarded_quantity=1 WHERE shipment_id=$1', [
          s.id,
        ]),
      );
    } finally {
      await db.close();
    }
    const partialFixture = await fixture(path);
    let partialId: string;
    try {
      const partial = await partialFixture.returned();
      partialId = partial.id;
      assert.equal(
        (
          await partialFixture.post(
            `/api/inventory/returns/${partial.id}/inspect`,
            {
              expectedVersion: partial.version,
              reason: 'فحص جزئي قبل إعادة التشغيل',
              items: [{ productId: 'bag', restock: 1, discard: 1 }],
            },
            'merchant-a',
          )
        ).statusCode,
        200,
      );
    } finally {
      await partialFixture.close();
    }
    const restarted = await openDatabase(path);
    try {
      assert.equal(
        (
          await restarted.query<{ restocked_quantity: number }>(
            'SELECT restocked_quantity FROM inventory_reservations WHERE shipment_id=$1',
            [s.id],
          )
        ).rows[0].restocked_quantity,
        3,
      );
      const retained = (
        await restarted.query<{
          state: string;
          restocked_quantity: number;
          discarded_quantity: number;
        }>('SELECT * FROM inventory_reservations WHERE shipment_id=$1', [partialId])
      ).rows[0];
      assert.equal(retained.state, 'quarantined');
      assert.equal(retained.restocked_quantity, 1);
      assert.equal(retained.discarded_quantity, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    if (!closed) await f.close();
    await rm(path, { recursive: true, force: true });
  }
});
