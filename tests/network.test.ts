import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
let db: Awaited<ReturnType<typeof openDatabase>>;
let app: ReturnType<typeof buildApp>['app'];
const cookies: Record<string, string> = {};
let customer: string;
before(async () => {
  db = await openDatabase();
  app = buildApp(db, {
    applicationKey: 'network-test',
    webhookKey: 'network-secret',
    demoMode: true,
  }).app;
  for (const accountId of ['ops', 'courier-b', 'pickup-a', 'merchant-a'])
    cookies[accountId] = (
      await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
    ).headers['set-cookie']!.toString().split(';')[0];
  customer = (
    await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
  ).headers['set-cookie']!.toString().split(';')[0];
});
after(async () => {
  await app.close();
  await db.close();
});
const fields = {
  name: 'نقطة اختبار المزة',
  address: 'شارع اختبارات، المزة، دمشق',
  capacityKg: 20,
  enabled: true,
  reason: 'تهيئة نقطة عرض',
};
const create = (who = 'ops', key = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: '/api/network/pickup-sites',
    headers: { cookie: cookies[who], 'idempotency-key': key },
    payload: fields,
  });
const update = (
  id: string,
  version: number,
  extra: Record<string, unknown> = {},
  key = randomUUID(),
) =>
  app.inject({
    method: 'PATCH',
    url: '/api/network/pickup-sites/' + id,
    headers: { cookie: cookies.ops, 'idempotency-key': key },
    payload: { ...fields, expectedVersion: version, ...extra },
  });
const quote = (id: string) =>
  app.inject({
    method: 'POST',
    url: '/api/storefront/checkouts',
    headers: { cookie: customer },
    payload: {
      items: [{ productId: 'bag', quantity: 1 }],
      recipientName: 'عميل اختبار الشبكة',
      district: 'الروضة',
      address: 'عنوان تجريبي',
      pickupSiteId: id,
    },
  });
const order = (id: string) =>
  app.inject({
    method: 'POST',
    url: '/api/storefront/orders',
    headers: { cookie: customer },
    payload: { checkoutId: id },
  });

test('network creation is operator-only, audited, idempotent and exposes an isolated point account', async () => {
  for (const who of ['courier-b', 'pickup-a', 'merchant-a'])
    assert.equal((await create(who)).statusCode, 403);
  assert.equal(
    (await app.inject({ url: '/api/network/audit', headers: { cookie: cookies['pickup-a'] } }))
      .statusCode,
    403,
  );
  const key = randomUUID();
  const a = await create('ops', key);
  assert.equal(a.statusCode, 200, a.body);
  const id = a.json().id;
  assert.equal((await create('ops', key)).json().id, id);
  const records = await db.query('SELECT * FROM network_audit WHERE site_id=$1', [id]);
  assert.equal(records.rows.length, 1);
  const login = await app.inject({
    method: 'POST',
    url: '/api/demo/session',
    payload: { accountId: id },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookies[id] = login.headers['set-cookie']!.toString().split(';')[0];
  const bootstrap = (
    await app.inject({ url: '/api/bootstrap', headers: { cookie: cookies[id] } })
  ).json();
  assert.deepEqual(
    bootstrap.sites.map((s: { id: string }) => s.id),
    [id],
  );
  assert.deepEqual(bootstrap.shipments, []);
  const q = await quote(id);
  assert.equal(q.statusCode, 200, q.body);
  let s = (await order(q.json().id)).json().shipment;
  assert.equal(
    (await app.inject({ url: '/api/shipments/' + s.id, headers: { cookie: cookies['pickup-a'] } }))
      .statusCode,
    404,
  );
  // Closing new intake must preserve the handling of already-created parcels.
  assert.equal((await update(id, 1, { enabled: false })).statusCode, 200);
  for (const [action, who] of [
    ['assign', 'ops'],
    ['accept', 'courier-b'],
    ['prepare', 'merchant-a'],
    ['handover_origin', 'merchant-a'],
    ['pickup', 'courier-b'],
    ['depart', 'courier-b'],
    ['arrive_pickup', 'courier-b'],
    ['receive_pickup', id],
  ] as const) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/shipments/${s.id}/actions`,
      headers: { cookie: cookies[who], 'idempotency-key': randomUUID() },
      payload: {
        action,
        expectedVersion: s.version,
        ...(['assign', 'handover_origin'].includes(action) ? { courierId: 'courier-b' } : {}),
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    s = r.json();
  }
  const code = (
    await app.inject({
      method: 'POST',
      url: `/api/storefront/orders/${s.id}/delivery-code`,
      headers: { cookie: customer },
      payload: {},
    })
  ).json().code;
  const done = await app.inject({
    method: 'POST',
    url: `/api/shipments/${s.id}/actions`,
    headers: { cookie: cookies[id], 'idempotency-key': randomUUID() },
    payload: { action: 'release_pickup', expectedVersion: s.version, deliveryCode: code },
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().status, 'delivered');
  assert.equal((await quote(id)).statusCode, 422);
});

test('site versions invalidate stale quotes and reject concurrent edits without consuming the quote', async () => {
  const id = (await create()).json().id;
  const q = await quote(id);
  assert.equal(q.statusCode, 200, q.body);
  const key = randomUUID();
  const u = await update(id, 1, { address: 'عنوان جديد، دمشق' }, key);
  assert.equal(u.statusCode, 200, u.body);
  assert.equal((await update(id, 1, { address: 'عنوان جديد، دمشق' }, key)).json().version, 2);
  assert.equal((await update(id, 1)).json().code, 'VERSION_CONFLICT');
  const stale = await order(q.json().id);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'QUOTE_SITE_CHANGED');
  const consumed = (
    await db.query<{ consumed: boolean }>('SELECT consumed FROM quotes WHERE id=$1', [
      q.json().quote.id,
    ])
  ).rows[0].consumed;
  assert.equal(consumed, false);
  const fresh = await quote(id);
  const accepted = await order(fresh.json().id);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().shipment.destination, 'عنوان جديد، دمشق');
});

test('reserved capacity and active addresses are protected and audit failure rolls back settings', async () => {
  const id = (await create()).json().id;
  for (let i = 0; i < 2; i++) {
    const q = await quote(id);
    assert.equal((await order(q.json().id)).statusCode, 200);
  }
  assert.equal((await update(id, 1, { capacityKg: 1 })).json().code, 'CAPACITY_BELOW_RESERVED');
  assert.equal(
    (await update(id, 1, { address: 'عنوان متغير، دمشق' })).json().code,
    'ACTIVE_SITE_ADDRESS',
  );
  await db.exec(
    "CREATE FUNCTION fail_network_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER fail_network_audit BEFORE INSERT ON network_audit FOR EACH ROW EXECUTE FUNCTION fail_network_audit()",
  );
  assert.equal((await update(id, 1, { enabled: false })).statusCode, 500);
  const state = (
    await db.query<{ version: number; pickup_enabled: boolean }>(
      'SELECT version,pickup_enabled FROM sites WHERE id=$1',
      [id],
    )
  ).rows[0];
  assert.equal(state.version, 1);
  assert.equal(state.pickup_enabled, true);
  await db.exec(
    'DROP TRIGGER fail_network_audit ON network_audit; DROP FUNCTION fail_network_audit()',
  );
  const saved = await update(id, 1, { enabled: false });
  assert.equal(saved.statusCode, 200, saved.body);
  const sites = (
    await app.inject({
      method: 'POST',
      url: '/api/storefront/session',
      payload: {},
      headers: { cookie: customer },
    })
  ).json().pickupSites;
  assert.ok(!sites.some((s: { id: string }) => s.id === id));
});
