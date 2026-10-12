import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferFixture } from './helpers/transfer-resolution.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
test('loss and damaged arrivals resolve custody without creating sellable goods; partial inspection restores only actual good pieces', async () => {
  const f = await transferFixture();
  try {
    await f.transit();
    await f.act('receive', { items: [{ productId: 'bag', quantity: 2 }] }, 'merchant-a');
    const before = (await f.get('/api/bootstrap'))
      .json()
      .couriers.find((c: { id: string }) => c.id === 'courier-b').activeKg;
    const items = [
      { productId: 'bag', lost: 1, damaged: 2 },
      { productId: 'cup', lost: 0, damaged: 4 },
    ];
    const original = f.current(),
      key = crypto.randomUUID();
    const r = await f.action(
      original,
      'resolve_issue',
      { items, reference: 'محضر ١٠١' },
      'ops',
      key,
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'resolved');
    assert.deepEqual(
      (
        await f.action(original, 'resolve_issue', { items, reference: 'محضر ١٠١' }, 'ops', key)
      ).json(),
      r.json(),
    );
    assert.equal((await f.stockAt()).onHand, 4);
    assert.equal((await f.stockAt()).quarantine, 2);
    assert.equal((await f.stockAt()).available, 2);
    assert.equal((await f.stockAt('cup')).available, 0);
    const after = (await f.get('/api/bootstrap'))
      .json()
      .couriers.find((c: { id: string }) => c.id === 'courier-b').activeKg;
    assert.equal(before - after, 5);
    assert.equal((await f.get('/api/inventory/transfers')).json().active, 0);
    assert.equal((await f.get('/api/inventory/transfers')).json().pendingInspection, 1);
    const saved = (await f.detail()).transfer;
    const inspect = await f.action(
      saved,
      'inspect_damage',
      {
        items: [
          { productId: 'bag', restocked: 1, discarded: 0 },
          { productId: 'cup', restocked: 1, discarded: 2 },
        ],
      },
      'merchant-a',
    );
    assert.equal(inspect.statusCode, 200, inspect.body);
    assert.equal((await f.stockAt()).available, 3);
    assert.equal((await f.stockAt()).quarantine, 1);
    assert.equal((await f.stockAt('cup')).onHand, 2);
    assert.equal((await f.stockAt('cup')).quarantine, 1);
    const done = await f.action(inspect.json(), 'inspect_damage', {
      items: [
        { productId: 'bag', restocked: 0, discarded: 1 },
        { productId: 'cup', restocked: 1, discarded: 0 },
      ],
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((await f.get('/api/inventory/transfers')).json().pendingInspection, 0);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    assert.equal(
      (await f.detail()).history.filter((e: { action: string }) => e.action === 'resolve_issue')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('resolution requires operations, an open issue and courier custody; scope, quantities, stale versions and duplicate products are enforced', async () => {
  const f = await transferFixture();
  try {
    const payload = { items: [{ productId: 'bag', lost: 1, damaged: 0 }], reference: 'محضر تحقق' };
    assert.equal((await f.action(f.current(), 'resolve_issue', payload)).statusCode, 409);
    await f.transit();
    assert.equal((await f.action(f.current(), 'resolve_issue', payload)).statusCode, 409);
    await f.act('report_issue', {}, 'courier-b');
    assert.equal(
      (await f.action(f.current(), 'resolve_issue', payload, 'merchant-a')).statusCode,
      403,
    );
    assert.equal(
      (await f.action(f.current(), 'resolve_issue', payload, 'courier-b')).statusCode,
      403,
    );
    assert.equal(
      (await f.action(f.current(), 'resolve_issue', payload, 'merchant-b')).statusCode,
      404,
    );
    assert.equal(
      (
        await f.action(f.current(), 'resolve_issue', {
          ...payload,
          items: [...payload.items, ...payload.items],
        })
      ).statusCode,
      422,
    );
    for (const [lost, damaged] of [
      [0, 0],
      [5, 1],
      [-1, 0],
      [1.5, 0],
    ])
      assert.ok(
        (
          await f.action(f.current(), 'resolve_issue', {
            ...payload,
            items: [{ productId: 'bag', lost, damaged }],
          })
        ).statusCode >= 400,
      );
    const old = f.current();
    await f.act('resolve_issue', payload);
    assert.equal((await f.action(old, 'resolve_issue', payload)).json().code, 'VERSION_CONFLICT');
    assert.equal(
      (await f.action(f.current(), 'receive', { items: [{ productId: 'bag', quantity: 5 }] }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await f.action(f.current(), 'inspect_damage', {
          items: [{ productId: 'bag', restocked: 1, discarded: 0 }],
        })
      ).statusCode,
      409,
    );
    assert.equal((await f.stockAt()).onHand, 0);
    assert.equal((await f.get('/api/inventory/transfers')).json().active, 1);
    await f.act('receive', {
      items: [
        { productId: 'bag', quantity: 4 },
        { productId: 'cup', quantity: 4 },
      ],
    });
    assert.equal(f.current().status, 'resolved');
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
  } finally {
    await f.close();
  }
});
test('later product and audit failures roll back settlement and inspection including stock and idempotency result; drift rejects changes', async () => {
  const f = await transferFixture();
  try {
    await f.transit();
    await f.act('report_issue');
    const good = {
      items: [
        { productId: 'bag', lost: 1, damaged: 2 },
        { productId: 'cup', lost: 0, damaged: 4 },
      ],
      reference: 'محضر ذرية',
    };
    const before = await f.detail();
    const bad = await f.action(f.current(), 'resolve_issue', {
      ...good,
      items: [good.items[0], { productId: 'cup', lost: 0, damaged: 5 }],
    });
    assert.equal(bad.statusCode, 409);
    assert.deepEqual(await f.detail(), before);
    assert.equal((await f.stockAt()).onHand, 0);
    await f.db.exec(
      "CREATE FUNCTION reject_resolution_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('resolve_issue','inspect_damage') THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_resolution_event BEFORE INSERT ON inventory_transfer_events FOR EACH ROW EXECUTE FUNCTION reject_resolution_event();",
    );
    const key = crypto.randomUUID();
    assert.equal((await f.action(f.current(), 'resolve_issue', good, 'ops', key)).statusCode, 500);
    assert.deepEqual(await f.detail(), before);
    await f.db.exec('DROP TRIGGER reject_resolution_event ON inventory_transfer_events');
    const saved = await f.action(f.current(), 'resolve_issue', good, 'ops', key);
    assert.equal(saved.statusCode, 200, saved.body);
    const stock = await f.stockAt();
    await f.db.exec(
      'CREATE TRIGGER reject_resolution_event BEFORE INSERT ON inventory_transfer_events FOR EACH ROW EXECUTE FUNCTION reject_resolution_event()',
    );
    const inspectionKey = crypto.randomUUID();
    const inspection = { items: [{ productId: 'bag', restocked: 1, discarded: 0 }] };
    assert.equal(
      (await f.action(saved.json(), 'inspect_damage', inspection, 'merchant-a', inspectionKey))
        .statusCode,
      500,
    );
    assert.deepEqual(await f.stockAt(), stock);
    await f.db.exec('DROP TRIGGER reject_resolution_event ON inventory_transfer_events');
    assert.equal(
      (
        await f.action(saved.json(), 'inspect_damage', {
          items: [
            { productId: 'bag', restocked: 1, discarded: 0 },
            { productId: 'cup', restocked: 5, discarded: 0 },
          ],
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(await f.stockAt(), stock);
    const inspected = await f.action(
      saved.json(),
      'inspect_damage',
      inspection,
      'merchant-a',
      inspectionKey,
    );
    assert.equal(inspected.statusCode, 200, inspected.body);
    assert.deepEqual(
      (
        await f.action(saved.json(), 'inspect_damage', inspection, 'merchant-a', inspectionKey)
      ).json(),
      inspected.json(),
    );
    await f.db.query(
      'UPDATE inventory_transfer_lines SET lost=lost+1 WHERE transfer_id=$1 AND product_id=$2',
      [f.current().id, 'bag'],
    );
    assert.equal(
      (
        await f.action(inspected.json(), 'inspect_damage', {
          items: [{ productId: 'bag', restocked: 1, discarded: 0 }],
        })
      ).json().code,
      'INVENTORY_INCONSISTENT',
    );
  } finally {
    await f.close();
  }
});
test('migration and restart preserve settled losses and uninspected damage without replenishment', async () => {
  const root = resolve('artifacts');
  const path = await mkdtemp(join(root, 'resolution-db-'));
  let f = await transferFixture(path);
  try {
    await f.transit();
    await f.act('report_issue');
    await f.act('resolve_issue', {
      items: [
        { productId: 'bag', lost: 2, damaged: 3 },
        { productId: 'cup', lost: 4, damaged: 0 },
      ],
      reference: 'محضر استمرار',
    });
    const id = f.current().id,
      site = f.site;
    await f.close();
    const restarted = await fixture(path);
    try {
      const r = (await restarted.get('/api/inventory/transfers/' + id)).json().transfer;
      assert.equal(r.status, 'resolved');
      assert.equal(r.lines.find((l: { productId: string }) => l.productId === 'bag').lost, 2);
      const stock = (await restarted.get('/api/inventory?siteId=' + site))
        .json()
        .stocks.find((s: { productId: string }) => s.productId === 'bag');
      assert.equal(stock.onHand, 3);
      assert.equal(stock.quarantine, 3);
      assert.equal((await restarted.get('/api/inventory/reconciliation')).json().exceptions, 0);
      assert.equal(
        (await restarted.db.query('SELECT version FROM schema_migrations WHERE version=10')).rows
          .length,
        1,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
