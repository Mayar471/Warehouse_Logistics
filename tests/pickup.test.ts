import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

async function fixture() {
  const db = await openDatabase();
  let now = Date.now();
  const system = buildApp(db, {
    applicationKey: 'pickup-test',
    webhookKey: 'pickup-proof',
    demoMode: true,
    clock: () => now,
  });
  const app = system.app;
  const sessions: Record<string, string> = {};
  for (const accountId of [
    'ops',
    'courier-b',
    'courier-a',
    'pickup-a',
    'merchant-a',
    'merchant-b',
  ]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId },
    });
    sessions[accountId] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  const customer = (
    await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
  ).headers['set-cookie']!.toString().split(';')[0];
  async function create(pickupSiteId = 'pickup-a') {
    const q = await app.inject({
      method: 'POST',
      url: '/api/storefront/checkouts',
      headers: { cookie: customer },
      payload: {
        items: [{ productId: 'bag', quantity: 1 }],
        recipientName: 'عميل النقطة',
        district: 'الروضة',
        address: 'عنوان اصطناعي',
        pickupSiteId,
      },
    });
    if (q.statusCode !== 200) return q;
    return app.inject({
      method: 'POST',
      url: '/api/storefront/orders',
      headers: { cookie: customer },
      payload: { checkoutId: q.json().id },
    });
  }
  async function action(
    s: { id: string; version: number },
    action: string,
    who: string,
    extra: Record<string, unknown> = {},
    key = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/shipments/${s.id}/actions`,
      headers: { cookie: sessions[who], 'idempotency-key': key },
      payload: { action, expectedVersion: s.version, ...extra },
    });
  }
  async function ready() {
    const order = await create();
    assert.equal(order.statusCode, 200, order.body);
    let s = order.json().shipment;
    for (const [act, who] of [
      ['assign', 'ops'],
      ['accept', 'courier-b'],
      ['prepare', 'merchant-a'],
      ['handover_origin', 'merchant-a'],
      ['pickup', 'courier-b'],
      ['depart', 'courier-b'],
      ['arrive_pickup', 'courier-b'],
    ] as const) {
      const r = await action(
        s,
        act,
        who,
        ['assign', 'handover_origin'].includes(act) ? { courierId: 'courier-b' } : {},
      );
      assert.equal(r.statusCode, 200, r.body);
      s = r.json();
    }
    return s;
  }
  return {
    db,
    app,
    system,
    sessions,
    customer,
    create,
    action,
    ready,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

test('pickup enforces independent custody confirmation, scope, customer proof and atomic single delivery', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.create('site-a')).statusCode, 422);
    let s = await f.ready();
    assert.equal(s.status, 'awaiting_handover');
    assert.equal(s.custodySiteId, null);
    assert.equal((await f.action(s, 'receive_pickup', 'courier-b')).statusCode, 403);
    assert.equal((await f.action(s, 'receive_pickup', 'merchant-b')).statusCode, 404);
    assert.equal((await f.action(s, 'deliver', 'courier-b')).statusCode, 409);
    const issue = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/storefront/orders/${s.id}/delivery-code`,
        headers: { cookie: f.customer },
        payload: {},
      });
    assert.equal((await issue()).statusCode, 409);
    const before = (
      await f.app.inject({ url: '/api/bootstrap', headers: { cookie: f.sessions.ops } })
    )
      .json()
      .couriers.find((c: { id: string }) => c.id === 'courier-b').activeKg;
    const received = await f.action(s, 'receive_pickup', 'pickup-a');
    assert.equal(received.statusCode, 200, received.body);
    s = received.json();
    assert.equal(s.status, 'ready_for_pickup');
    assert.equal(s.courierId, null);
    assert.equal(s.custodySiteId, 'pickup-a');
    assert.ok(s.pickupExpiresAt);
    const after = (
      await f.app.inject({ url: '/api/bootstrap', headers: { cookie: f.sessions.ops } })
    )
      .json()
      .couriers.find((c: { id: string }) => c.id === 'courier-b').activeKg;
    assert.ok(Math.abs(before - after - s.weightKg) < 0.001);
    assert.equal(
      (
        await f.app.inject({
          url: `/api/shipments/${s.id}`,
          headers: { cookie: f.sessions['courier-b'] },
        })
      ).statusCode,
      404,
    );
    const code = (await issue()).json().code;
    assert.match(code, /^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal(
      (await f.action(s, 'release_pickup', 'pickup-a', { deliveryCode: wrong })).json().code,
      'PROOF_INVALID',
    );
    assert.equal(
      (
        await f.db.query<{ attempts: number }>(
          'SELECT attempts FROM delivery_proofs WHERE shipment_id=$1',
          [s.id],
        )
      ).rows[0].attempts,
      1,
    );
    await f.db.exec(
      "CREATE FUNCTION fail_pickup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.release_pickup' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_pickup BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_pickup()",
    );
    assert.equal(
      (await f.action(s, 'release_pickup', 'pickup-a', { deliveryCode: code })).statusCode,
      500,
    );
    assert.equal(
      (
        await f.db.query<{ consumed_at: string | null }>(
          'SELECT consumed_at FROM delivery_proofs WHERE shipment_id=$1',
          [s.id],
        )
      ).rows[0].consumed_at,
      null,
    );
    await f.db.exec('DROP TRIGGER fail_pickup ON outbox; DROP FUNCTION fail_pickup()');
    const key = randomUUID();
    const done = await f.action(s, 'release_pickup', 'pickup-a', { deliveryCode: code }, key);
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().status, 'delivered');
    assert.equal(done.json().custodySiteId, null);
    assert.equal(
      (await f.action(s, 'release_pickup', 'pickup-a', { deliveryCode: code }, key)).json().version,
      done.json().version,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM timeline WHERE shipment_id=$1 AND type='shipment.release_pickup'",
          [s.id],
        )
      ).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('expired pickup keeps point custody and requires accepted return assignment and point handover before origin receipt', async () => {
  const f = await fixture();
  try {
    let s = await f.ready();
    s = (await f.action(s, 'receive_pickup', 'pickup-a')).json();
    f.advance(72 * 60 * 60_000 + 1);
    assert.equal(
      (await f.action(s, 'release_pickup', 'pickup-a', { deliveryCode: '000000' })).json().code,
      'PICKUP_NOT_AVAILABLE',
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/storefront/orders/${s.id}/delivery-code`,
          headers: { cookie: f.customer },
          payload: {},
        })
      ).statusCode,
      409,
    );
    await f.system.sweepAssignments();
    s = (
      await f.app.inject({ url: `/api/shipments/${s.id}`, headers: { cookie: f.sessions.ops } })
    ).json().shipment;
    assert.equal(s.status, 'pickup_expired');
    assert.equal(s.custodySiteId, 'pickup-a');
    assert.equal(s.courierId, null);
    s = (await f.action(s, 'assign_return', 'ops', { courierId: 'courier-b' })).json();
    assert.equal((await f.action(s, 'receive_return', 'ops')).statusCode, 409);
    assert.equal((await f.action(s, 'handover_return', 'pickup-a')).statusCode, 409);
    f.advance(5 * 60_000 + 1);
    await f.system.sweepAssignments();
    s = (
      await f.app.inject({ url: `/api/shipments/${s.id}`, headers: { cookie: f.sessions.ops } })
    ).json().shipment;
    assert.equal(s.status, 'pickup_expired');
    assert.equal(s.custodySiteId, 'pickup-a');
    assert.equal(s.courierId, null);
    s = (await f.action(s, 'assign_return', 'ops', { courierId: 'courier-b' })).json();
    s = (await f.action(s, 'accept', 'courier-b')).json();
    assert.equal((await f.action(s, 'receive_return', 'ops')).statusCode, 409);
    assert.equal((await f.action(s, 'pickup', 'courier-b')).statusCode, 409);
    const handed = await f.action(s, 'handover_return', 'pickup-a');
    assert.equal(handed.statusCode, 200, handed.body);
    s = handed.json();
    assert.equal(s.custodySiteId, null);
    const done = await f.action(s, 'receive_return', 'ops');
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().status, 'returned');
    const before = done.json().version;
    await f.system.sweepAssignments();
    assert.equal(
      (
        await f.app.inject({ url: `/api/shipments/${s.id}`, headers: { cookie: f.sessions.ops } })
      ).json().shipment.version,
      before,
    );
  } finally {
    await f.close();
  }
});

test('pickup capacity is reserved atomically at order creation and revalidated after quotes', async () => {
  const f = await fixture();
  try {
    await f.db.query('UPDATE sites SET pickup_capacity_kg=1 WHERE id=$1', ['pickup-a']);
    const quote = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/storefront/checkouts',
        headers: { cookie: f.customer },
        payload: {
          items: [{ productId: 'bag', quantity: 1 }],
          recipientName: 'اختبار السعة',
          district: 'الروضة',
          address: 'عنوان تجريبي',
          pickupSiteId: 'pickup-a',
        },
      });
    const a = await quote();
    const b = await quote();
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    const outcomes = await Promise.all(
      [a, b].map((q) =>
        f.app.inject({
          method: 'POST',
          url: '/api/storefront/orders',
          headers: { cookie: f.customer },
          payload: { checkoutId: q.json().id },
        }),
      ),
    );
    assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(
      outcomes.find((r) => r.statusCode === 409)!.json().code,
      'PICKUP_CAPACITY_EXCEEDED',
    );
    const successful = outcomes.find((r) => r.statusCode === 200)!.json().shipment;
    assert.equal((await f.action(successful, 'cancel', 'ops')).statusCode, 200);
    assert.equal((await quote()).statusCode, 200);
    await f.db.query('UPDATE sites SET pickup_enabled=false WHERE id=$1', ['pickup-a']);
    assert.equal((await quote()).statusCode, 422);
    const sites = (
      await f.app.inject({
        method: 'POST',
        url: '/api/storefront/session',
        payload: {},
        headers: { cookie: f.customer },
      })
    ).json().pickupSites;
    assert.deepEqual(sites, []);
  } finally {
    await f.close();
  }
});
