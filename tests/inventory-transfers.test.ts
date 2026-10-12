import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/inventory.js';
type F = Awaited<ReturnType<typeof fixture>>;
type Command = { id: string; version: number; status: string };
async function setup(path?: string) {
  const f = await fixture(path);
  const site = (
    await f.post('/api/inventory/sites', {
      merchantId: 'merchant-a',
      name: 'مستودع نقل مستقل',
      address: 'عنوان وجهة النقل في دمشق',
      products: ['bag', 'cup'],
      reason: 'إعداد وجهة النقل',
    })
  ).json();
  const body = async (quantity = 5) => ({
    merchantId: 'merchant-a',
    sourceId: 'site-a',
    destinationId: site.id,
    items: [{ productId: 'bag', quantity, sourceVersion: (await f.stock()).version }],
    reason: 'نقل قطع فعلية بين موقعي المتجر',
  });
  const create = async (quantity = 5) => {
    const r = await f.post('/api/inventory/transfers', await body(quantity));
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as Command;
  };
  const action = (
    t: Command,
    action: string,
    who = 'ops',
    extra: Record<string, unknown> = {},
    key = randomUUID(),
  ) =>
    f.post(
      `/api/inventory/transfers/${t.id}/actions`,
      { action, expectedVersion: t.version, reason: 'إقرار نقل موثق من الحساب المختص', ...extra },
      who,
      key,
    );
  const act = async (t: Command, a: string, who = 'ops', extra: Record<string, unknown> = {}) => {
    const r = await action(t, a, who, extra);
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as Command;
  };
  const stock = async (id = site.id) =>
    (await f.get(`/api/inventory?siteId=${id}`))
      .json()
      .stocks.find((s: { productId: string }) => s.productId === 'bag');
  return { ...f, site, body, create, action, act, stockAt: stock };
}
test('transfer has separate source and courier custody and only received pieces appear at destination', async () => {
  const f = await setup();
  try {
    let t = await f.create();
    assert.equal((await f.stock()).on_hand, 30);
    assert.equal((await f.stock()).reserved, 5);
    assert.equal((await f.stockAt()).onHand, 0);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    assert.equal((await f.action(t, 'release', 'merchant-a')).statusCode, 409);
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    assert.equal((await f.action(t, 'accept', 'ops')).statusCode, 403);
    t = await f.act(t, 'accept', 'courier-b');
    assert.equal((await f.action(t, 'pickup', 'courier-b')).statusCode, 409);
    t = await f.act(t, 'release', 'merchant-a');
    assert.equal((await f.stock()).on_hand, 25);
    assert.equal((await f.stock()).reserved, 0);
    assert.equal((await f.stockAt('site-a')).inTransit, 5);
    assert.equal((await f.action(t, 'cancel')).statusCode, 409);
    assert.equal((await f.action(t, 'unassign')).statusCode, 409);
    assert.equal(
      (await f.action(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 5 }] }))
        .statusCode,
      409,
    );
    t = await f.act(t, 'pickup', 'courier-b');
    t = await f.act(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 3 }] });
    t = await f.act(t, 'report_issue', 'courier-b');
    assert.equal((await f.get(`/api/inventory/transfers/${t.id}`)).json().transfer.issueOpen, true);
    assert.equal(t.status, 'in_transit');
    assert.equal((await f.stockAt()).onHand, 3);
    assert.equal((await f.stockAt('site-a')).inTransit, 2);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    assert.equal(
      (
        await f.action(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 3 }] })
      ).json().code,
      'RECEIVE_EXCEEDS_REMAINING',
    );
    t = await f.act(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 2 }] });
    assert.equal(t.status, 'received');
    assert.equal((await f.stockAt()).onHand, 5);
    assert.equal((await f.stockAt('site-a')).inTransit, 0);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    const detail = (await f.get(`/api/inventory/transfers/${t.id}`)).json();
    assert.equal(detail.history.length, 8);
    assert.equal(detail.transfer.issueOpen, false);
    assert.equal(detail.transfer.lines[0].received, 5);
  } finally {
    await f.close();
  }
});
test('transfer creation competes with storefront reservations and protects quarantined pieces and destination ownership', async () => {
  const f = await setup();
  try {
    await f.returned();
    const pendingCheckout = await f.checkout();
    const source = await f.stock();
    const b = await f.body(27);
    const results = await Promise.all([
      f.post('/api/inventory/transfers', b),
      f.post('/api/inventory/transfers', b),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await f.stock()).quarantine, 3);
    assert.equal((await f.stock()).reserved, 27);
    const order = await f.order(pendingCheckout.id);
    assert.equal(order.statusCode, 409);
    const t = results.find((r) => r.statusCode === 200)!.json() as Command;
    await f.act(t, 'cancel', 'merchant-a');
    assert.equal((await f.stock()).reserved, 0);
    const countCup = await f.post('/api/inventory/counts', {
      merchantId: 'merchant-a',
      siteId: 'site-a',
      productId: 'cup',
      counted: 1,
      expectedVersion: 1,
      reason: 'جرد الكوب للتحقق من ذرية النقل',
    });
    assert.equal(countCup.statusCode, 200, countCup.body);
    const multi = await f.body(1);
    const before = await f.stock();
    const rejected = await f.post('/api/inventory/transfers', {
      ...multi,
      items: [...multi.items, { productId: 'cup', quantity: 2, sourceVersion: 2 }],
    });
    assert.equal(rejected.json().code, 'OUT_OF_STOCK');
    assert.deepEqual(await f.stock(), before);
    assert.equal(
      (
        await f.post('/api/inventory/transfers', {
          ...b,
          destinationId: 'site-b',
          items: [{ productId: 'bag', quantity: 1, sourceVersion: source.version }],
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await f.post('/api/inventory/transfers', { ...(await f.body(1)), destinationId: 'site-a' }))
        .statusCode,
      422,
    );
    assert.equal(
      (
        await f.post('/api/inventory/transfers', {
          ...(await f.body(1)),
          items: [{ productId: 'bag', quantity: 1, sourceVersion: 1 }],
        })
      ).json().code,
      'VERSION_CONFLICT',
    );
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
  } finally {
    await f.close();
  }
});
test('transfer scope, strict commands and idempotent replay do not reveal or duplicate stock and custody', async () => {
  const f = await setup();
  try {
    const body = await f.body();
    const key = randomUUID();
    const first = await f.post('/api/inventory/transfers', body, 'merchant-a', key);
    assert.equal(first.statusCode, 200, first.body);
    let t = first.json() as Command;
    assert.deepEqual((await f.post('/api/inventory/transfers', body, 'merchant-a', key)).json(), t);
    assert.equal(
      (
        await f.post(
          '/api/inventory/transfers',
          { ...body, reason: 'محتوى مختلف' },
          'merchant-a',
          key,
        )
      ).statusCode,
      409,
    );
    for (const who of ['merchant-b', 'courier-b'])
      assert.equal((await f.get(`/api/inventory/transfers/${t.id}`, who)).statusCode, 404);
    assert.equal((await f.get('/api/inventory/transfers', 'merchant-b')).json().total, 0);
    assert.equal((await f.get('/api/inventory/transfers', 'pickup-a')).statusCode, 403);
    assert.equal((await f.post('/api/inventory/transfers', body, 'courier-b')).statusCode, 403);
    assert.equal(
      (await f.post('/api/inventory/transfers', { ...body, weightKg: 1 })).statusCode,
      422,
    );
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    const declineKey = randomUUID();
    const declined = await f.action(t, 'decline', 'courier-b', {}, declineKey);
    assert.equal(declined.statusCode, 200, declined.body);
    assert.deepEqual(
      (await f.action(t, 'decline', 'courier-b', {}, declineKey)).json(),
      declined.json(),
    );
    t = declined.json();
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    t = await f.act(t, 'accept', 'courier-b');
    t = await f.act(t, 'release', 'merchant-a');
    t = await f.act(t, 'pickup', 'courier-b');
    const receiveKey = randomUUID();
    const received = await f.action(
      t,
      'receive',
      'merchant-a',
      { items: [{ productId: 'bag', quantity: 2 }] },
      receiveKey,
    );
    assert.equal(received.statusCode, 200, received.body);
    assert.deepEqual(
      (
        await f.action(
          t,
          'receive',
          'merchant-a',
          { items: [{ productId: 'bag', quantity: 2 }] },
          receiveKey,
        )
      ).json(),
      received.json(),
    );
    assert.equal((await f.stockAt()).onHand, 2);
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM inventory_movements WHERE transfer_id=$1 AND kind='transfer_receive'",
          [t.id],
        )
      ).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('shipment and transfer assignments share capacity and deadlines release only pre-custody resources', async () => {
  const f = await setup();
  try {
    await f.db.query("UPDATE shipments SET status='delivered' WHERE courier_id='courier-b'");
    await f.db.query("UPDATE couriers SET capacity_kg=3 WHERE id='courier-b'");
    let t = await f.create();
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    const second = await f.create(1);
    assert.equal(
      (await f.action(second, 'assign', 'ops', { courierId: 'courier-b' })).json().code,
      'CAPACITY_EXCEEDED',
    );
    const s = (await f.order((await f.checkout()).id)).json().shipment;
    assert.equal((await f.action(s, 'assign', 'ops', { courierId: 'courier-b' })).statusCode, 404);
    assert.equal(
      (
        await f.post(`/api/shipments/${s.id}/actions`, {
          action: 'assign',
          expectedVersion: s.version,
          courierId: 'courier-b',
        })
      ).json().code,
      'CAPACITY_EXCEEDED',
    );
    f.advance(5 * 60_000 + 1);
    assert.equal((await f.action(t, 'accept', 'courier-b')).json().code, 'ASSIGNMENT_EXPIRED');
    await f.system.sweepAssignments();
    t = (await f.get(`/api/inventory/transfers/${t.id}`)).json().transfer;
    assert.equal(t.status, 'reserved');
    assert.equal((await f.stock()).reserved, 7);
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    t = await f.act(t, 'accept', 'courier-b');
    t = await f.act(t, 'release', 'merchant-a');
    f.advance(48 * 60 * 60_000);
    await f.system.sweepAssignments();
    assert.equal(
      (await f.get(`/api/inventory/transfers/${t.id}`)).json().transfer.status,
      'released',
    );
    assert.equal(
      (await f.get(`/api/inventory/transfers/${second.id}`)).json().transfer.status,
      'cancelled',
    );
    assert.equal((await f.stock()).reserved, 0);
    t = await f.act(t, 'pickup', 'courier-b');
    t = await f.act(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 5 }] });
    assert.equal(t.status, 'received');
  } finally {
    await f.close();
  }
});
test('transfer history and receipt movement failures roll back quantity, reservation, version and command result', async () => {
  const f = await setup();
  try {
    await f.db.exec(
      "CREATE FUNCTION reject_transfer_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history test'; END $$; CREATE TRIGGER reject_transfer_event BEFORE INSERT ON inventory_transfer_events FOR EACH ROW EXECUTE FUNCTION reject_transfer_event();",
    );
    const body = await f.body();
    const key = randomUUID();
    assert.equal((await f.post('/api/inventory/transfers', body, 'ops', key)).statusCode, 500);
    assert.equal((await f.stock()).reserved, 0);
    assert.equal((await f.db.query('SELECT * FROM inventory_transfers')).rows.length, 0);
    await f.db.exec('DROP TRIGGER reject_transfer_event ON inventory_transfer_events');
    let t = (await f.post('/api/inventory/transfers', body, 'ops', key)).json() as Command;
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    t = await f.act(t, 'accept', 'courier-b');
    t = await f.act(t, 'release', 'merchant-a');
    t = await f.act(t, 'pickup', 'courier-b');
    await f.db.exec(
      "CREATE FUNCTION reject_transfer_receive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='transfer_receive' THEN RAISE EXCEPTION 'movement test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_transfer_receive BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION reject_transfer_receive();",
    );
    await f.db.query('UPDATE inventory_transfer_lines SET received=1 WHERE transfer_id=$1', [t.id]);
    assert.equal(
      (
        await f.action(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 1 }] })
      ).json().code,
      'INVENTORY_INCONSISTENT',
    );
    await f.db.query('UPDATE inventory_transfer_lines SET received=0 WHERE transfer_id=$1', [t.id]);
    assert.equal(
      (await f.action(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 2 }] }))
        .statusCode,
      500,
    );
    assert.equal((await f.stockAt()).onHand, 0);
    const detail = (await f.get(`/api/inventory/transfers/${t.id}`)).json();
    assert.equal(detail.transfer.version, t.version);
    assert.equal(detail.transfer.lines[0].received, 0);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
  } finally {
    await f.close();
  }
});
test('reserved and partially received transfers survive restart without replenishment or losing custody', async () => {
  const path = await mkdtemp(join(tmpdir(), 'inventory-transfers-'));
  const f = await setup(path);
  let initialClosed = false;
  try {
    let t = await f.create();
    t = await f.act(t, 'assign', 'ops', { courierId: 'courier-b' });
    t = await f.act(t, 'accept', 'courier-b');
    t = await f.act(t, 'release', 'merchant-a');
    t = await f.act(t, 'pickup', 'courier-b');
    t = await f.act(t, 'receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 2 }] });
    const held = await f.create(1);
    const destination = f.site.id;
    await f.close();
    initialClosed = true;
    const restarted = await fixture(path);
    // Keep the original helpers' app references out of the restart assertions.
    try {
      const detail = (await restarted.get(`/api/inventory/transfers/${t.id}`)).json();
      assert.equal(detail.transfer.status, 'in_transit');
      assert.equal(detail.transfer.lines[0].received, 2);
      assert.equal(
        (await restarted.get(`/api/inventory/transfers/${held.id}`)).json().transfer.status,
        'reserved',
      );
      assert.equal((await restarted.stock()).on_hand, 25);
      assert.equal((await restarted.stock()).reserved, 1);
      assert.equal(
        (await restarted.get(`/api/inventory?siteId=${destination}`))
          .json()
          .stocks.find((s: { productId: string }) => s.productId === 'bag').onHand,
        2,
      );
      assert.equal((await restarted.get('/api/inventory/reconciliation')).json().exceptions, 0);
    } finally {
      await restarted.close();
    }
  } finally {
    if (!initialClosed) await f.close();
    await rm(path, { recursive: true, force: true });
  }
});
