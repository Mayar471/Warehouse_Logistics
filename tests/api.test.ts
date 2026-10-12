import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

let db: Awaited<ReturnType<typeof openDatabase>>;
let system: ReturnType<typeof buildApp>;
const applicationKey = 'test-application-key';
const webhookKey = 'test-webhook-key';
const identities = new Map<string, string>();
before(async () => {
  db = await openDatabase();
  system = buildApp(db, {
    applicationKey,
    webhookKey,
    demoMode: true,
    transport: async (raw, headers) =>
      (
        await system.app.inject({
          method: 'POST',
          url: '/api/demo-commerce/webhook',
          headers,
          payload: raw,
        })
      ).statusCode,
  });
  await system.app.ready();
  for (const id of ['ops', 'merchant-a', 'merchant-b', 'courier-a', 'courier-b']) {
    const r = await system.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: id },
    });
    identities.set(id, r.headers['set-cookie']!.toString().split(';')[0]);
  }
});
after(async () => {
  await system.app.close();
  await db.close();
});
const cookie = (id: string) => ({ cookie: identities.get(id)! });
const identity = (merchantId = 'merchant-a') => ({
  authorization: 'Bearer ' + applicationKey,
  'x-merchant-id': merchantId,
});
async function create(weightKg = 1, merchantId = 'merchant-a') {
  const input = {
    externalReference: randomUUID(),
    originId: merchantId === 'merchant-a' ? 'site-a' : 'site-b',
    recipientName: 'عميل اختبار',
    destination: 'الروضة، دمشق',
    weightKg,
  };
  const q = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers: identity(merchantId),
    payload: input,
  });
  assert.equal(q.statusCode, 200, q.body);
  const quoteId = q.json().id;
  const requestKey = randomUUID();
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...identity(merchantId), 'idempotency-key': requestKey },
    payload: { quoteId },
  });
  assert.equal(r.statusCode, 200, r.body);
  return { shipment: r.json(), quoteId, requestKey };
}
async function action(
  id: string,
  version: number,
  act: string,
  who = 'ops',
  extra: Record<string, unknown> = {},
) {
  return system.app.inject({
    method: 'POST',
    url: `/api/shipments/${id}/actions`,
    headers: { ...cookie(who), 'idempotency-key': randomUUID() },
    payload: { action: act, expectedVersion: version, ...extra },
  });
}

test('authentication is enforced for operations and application API', async () => {
  assert.equal((await system.app.inject('/api/bootstrap')).statusCode, 401);
  assert.equal(
    (await system.app.inject({ method: 'POST', url: '/api/v1/quotes', payload: {} })).statusCode,
    401,
  );
});
test('merchant isolation includes lists and direct object access', async () => {
  const { shipment } = await create(1, 'merchant-b');
  const r = await system.app.inject({ url: '/api/bootstrap', headers: cookie('merchant-a') });
  assert.ok(r.json().shipments.every((s: { merchantId: string }) => s.merchantId === 'merchant-a'));
  assert.equal(
    (
      await system.app.inject({
        url: '/api/shipments/' + shipment.id,
        headers: cookie('merchant-a'),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await system.app.inject({
        url: '/api/v1/fulfillments/' + shipment.id,
        headers: identity('merchant-a'),
      })
    ).statusCode,
    404,
  );
});
test('commerce BFF cannot create quotes for another merchant', async () => {
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/demo-commerce/quotes',
    headers: cookie('merchant-a'),
    payload: {
      merchantId: 'merchant-b',
      input: {
        externalReference: 'TEST-X',
        originId: 'site-b',
        recipientName: 'عميل',
        destination: 'المزة، دمشق',
        weightKg: 1,
      },
    },
  });
  assert.equal(r.statusCode, 403);
});
test('quote validates origin, coverage, dimensions, and unknown fields', async () => {
  const base = {
    externalReference: 'TEST-VALIDATION',
    originId: 'site-a',
    recipientName: 'عميل',
    destination: 'دمشق، الروضة',
    weightKg: 1,
  };
  for (const changed of [
    { originId: 'site-b' },
    { destination: 'حلب' },
    { weightKg: 0 },
    { weightKg: 51 },
    { codAmount: 500 },
  ]) {
    const r = await system.app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: identity(),
      payload: { ...base, ...changed },
    });
    assert.equal(r.statusCode, 422);
  }
});
test('idempotency replays a create once, even after the quote is consumed', async () => {
  const c = await create();
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...identity(), 'idempotency-key': c.requestKey },
    payload: { quoteId: c.quoteId },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().id, c.shipment.id);
  const count = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int n FROM outbox WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(count.rows[0].n, 1);
});
test('same idempotency key with different content conflicts', async () => {
  const c = await create();
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...identity(), 'idempotency-key': c.requestKey },
    payload: { quoteId: randomUUID() },
  });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'IDEMPOTENCY_CONFLICT');
});
test('expired quotes cannot create a shipment', async () => {
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers: identity(),
    payload: {
      externalReference: randomUUID(),
      originId: 'site-a',
      recipientName: 'عميل',
      destination: 'دمشق الروضة',
      weightKg: 1,
    },
  });
  await system.write((tx) =>
    tx.query("UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=$1", [r.json().id]),
  );
  const created = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...identity(), 'idempotency-key': randomUUID() },
    payload: { quoteId: r.json().id },
  });
  assert.equal(created.statusCode, 409);
  assert.equal(created.json().code, 'QUOTE_EXPIRED');
});
test('concurrent assignments cannot overbook the remaining vehicle capacity', async () => {
  const first = await create(7);
  const second = await create(7);
  const results = await Promise.all([
    action(first.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-a' }),
    action(second.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-a' }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const success = results.find((r) => r.statusCode === 200)!.json();
  await action(success.id, success.version, 'cancel');
});
test('operators cannot impersonate courier actions; another courier cannot read the task', async () => {
  const c = await create();
  const assigned = await action(c.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-b' });
  assert.equal(assigned.statusCode, 200);
  assert.equal((await action(c.shipment.id, 2, 'accept', 'ops')).statusCode, 403);
  assert.equal((await action(c.shipment.id, 2, 'accept', 'courier-a')).statusCode, 404);
  await action(c.shipment.id, 2, 'cancel');
});
test('courier must accept before pickup and cannot skip custody transitions', async () => {
  const c = await create();
  let r = await action(c.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-b' });
  let s = r.json();
  assert.equal((await action(s.id, s.version, 'pickup', 'courier-b')).statusCode, 409);
  r = await action(s.id, s.version, 'accept', 'courier-b');
  s = r.json();
  assert.equal(r.statusCode, 200);
  assert.equal((await action(s.id, s.version, 'deliver', 'courier-b')).statusCode, 409);
  s = (await action(s.id, s.version, 'prepare', 'merchant-a')).json();
  s = (
    await action(s.id, s.version, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })
  ).json();
  for (const act of ['pickup', 'depart', 'deliver']) {
    r = await action(s.id, s.version, act, 'courier-b');
    assert.equal(r.statusCode, 200, r.body);
    s = r.json();
  }
  assert.equal(s.status, 'delivered');
  assert.equal(s.version, 8);
});
test('cancellation after custody transfer is rejected and the return path is explicit', async () => {
  const c = await create();
  let s = (await action(c.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-b' })).json();
  s = (await action(s.id, s.version, 'accept', 'courier-b')).json();
  s = (await action(s.id, s.version, 'prepare', 'merchant-a')).json();
  s = (
    await action(s.id, s.version, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })
  ).json();
  s = (await action(s.id, s.version, 'pickup', 'courier-b')).json();
  const cancel = await action(s.id, s.version, 'cancel', 'merchant-a');
  assert.equal(cancel.statusCode, 409);
  assert.equal(cancel.json().code, 'RETURN_REQUIRED');
  s = (await action(s.id, s.version, 'return', 'ops', { reason: 'تعذر الوصول للعميل' })).json();
  assert.equal(s.status, 'returning');
  s = (await action(s.id, s.version, 'receive_return')).json();
  assert.equal(s.status, 'returned');
});
test('optimistic version conflicts do not overwrite changes', async () => {
  const c = await create();
  await action(c.shipment.id, 1, 'assign', 'ops', { courierId: 'courier-b' });
  const r = await action(c.shipment.id, 1, 'cancel');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'VERSION_CONFLICT');
  await action(c.shipment.id, 2, 'cancel');
});
test('replayed action produces one event and no repeated transition', async () => {
  const c = await create();
  const k = randomUUID();
  const body = { action: 'cancel', expectedVersion: 1 };
  const request = {
    method: 'POST' as const,
    url: '/api/shipments/' + c.shipment.id + '/actions',
    headers: { ...cookie('merchant-a'), 'idempotency-key': k },
    payload: body,
  };
  const a = await system.app.inject(request);
  const b = await system.app.inject(request);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.json().version, b.json().version);
  const count = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int n FROM timeline WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(count.rows[0].n, 2);
});
test('public tracking omits recipient name, address, courier and private notes', async () => {
  const c = await create();
  const r = await system.app.inject('/api/tracking/' + c.shipment.trackingToken);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(r.json()).sort(), [
    'city',
    'reference',
    'status',
    'timeline',
    'updatedAt',
  ]);
  assert.ok(!r.body.includes('عميل اختبار'));
  assert.ok(!r.body.includes('الروضة'));
  await action(c.shipment.id, 1, 'cancel');
  assert.equal(
    (await system.app.inject('/api/tracking/' + c.shipment.trackingToken)).statusCode,
    404,
  );
});
test('webhooks persist on failure and recover with exactly one receiver record', async () => {
  await system.write((tx) =>
    tx.query('UPDATE outbox SET status=$1 WHERE status=$2', ['sent', 'pending']),
  );
  await system.app.inject({
    method: 'POST',
    url: '/api/integration/receiver',
    headers: cookie('ops'),
    payload: { paused: true },
  });
  const c = await create();
  await system.flushOutbox(true);
  let r = await db.query<{ status: string; attempts: number }>(
    'SELECT status,attempts FROM outbox WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(r.rows[0].status, 'pending');
  assert.equal(r.rows[0].attempts, 1);
  await system.app.inject({
    method: 'POST',
    url: '/api/integration/receiver',
    headers: cookie('ops'),
    payload: { paused: false },
  });
  await system.flushOutbox(true);
  r = await db.query('SELECT status,attempts FROM outbox WHERE shipment_id=$1', [c.shipment.id]);
  assert.equal(r.rows[0].status, 'sent');
  await system.write((tx) =>
    tx.query("UPDATE outbox SET status='pending' WHERE shipment_id=$1", [c.shipment.id]),
  );
  await system.flushOutbox(true);
  const count = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int n FROM received_events WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(count.rows[0].n, 1);
});
test('signed stale events cannot roll back the commerce projection', async () => {
  const c = await create();
  for (const version of [5, 2]) {
    const event = {
      id: randomUUID(),
      type: 'shipment.test',
      shipmentId: c.shipment.id,
      version,
      status: version === 5 ? 'delivered' : 'assigned',
      occurredAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(event);
    const ts = String(Date.now());
    const signature = createHmac('sha256', webhookKey)
      .update(ts + '.' + raw)
      .digest('hex');
    const r = await system.app.inject({
      method: 'POST',
      url: '/api/demo-commerce/webhook',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': ts,
        'x-webhook-signature': signature,
      },
      payload: raw,
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  const row = await db.query<{ version: number; status: string }>(
    'SELECT * FROM commerce_projection WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(row.rows[0].version, 5);
  assert.equal(row.rows[0].status, 'delivered');
});
test('bad webhook signatures, old timestamps, and foreign browser origins are rejected', async () => {
  assert.equal(
    (
      await system.app.inject({
        method: 'POST',
        url: '/api/demo-commerce/webhook',
        headers: { 'x-webhook-timestamp': String(Date.now()), 'x-webhook-signature': 'invalid' },
        payload: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await system.app.inject({
        method: 'POST',
        url: '/api/demo-commerce/webhook',
        headers: { 'x-webhook-timestamp': '1000000000000' },
        payload: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await system.app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: { origin: 'https://evil.example' },
        payload: { accountId: 'ops' },
      })
    ).statusCode,
    403,
  );
});
test('integration lab is not accessible to merchants or couriers', async () => {
  for (const id of ['merchant-a', 'courier-a'])
    assert.equal(
      (await system.app.inject({ url: '/api/integration', headers: cookie(id) })).statusCode,
      403,
    );
});

test('duplicate external sale reference with a new key does not create a second shipment', async () => {
  const c = await create();
  const q = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers: identity(),
    payload: {
      externalReference: c.shipment.externalReference,
      originId: 'site-a',
      recipientName: 'عميل',
      destination: 'الروضة، دمشق',
      weightKg: 1,
    },
  });
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...identity(), 'idempotency-key': randomUUID() },
    payload: { quoteId: q.json().id },
  });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'EXTERNAL_REFERENCE_EXISTS');
});
test('state, history, and command result roll back if outbox insertion fails', async () => {
  const c = await create();
  await db.exec(`CREATE FUNCTION test_fail_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_fail_outbox_trigger BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION test_fail_outbox();`);
  try {
    const r = await action(c.shipment.id, 1, 'cancel');
    assert.equal(r.statusCode, 500);
    const row = await db.query<{ status: string; version: number }>(
      'SELECT status,version FROM shipments WHERE id=$1',
      [c.shipment.id],
    );
    assert.equal(row.rows[0].status, 'ready');
    assert.equal(row.rows[0].version, 1);
    const history = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int n FROM timeline WHERE shipment_id=$1',
      [c.shipment.id],
    );
    assert.equal(history.rows[0].n, 1);
  } finally {
    await db.exec(
      'DROP TRIGGER test_fail_outbox_trigger ON outbox; DROP FUNCTION test_fail_outbox();',
    );
  }
});
test('same signed event ID with different content conflicts without modifying projection', async () => {
  const c = await create();
  const id = randomUUID();
  async function send(version: number) {
    const event = {
      id,
      type: 'shipment.test',
      shipmentId: c.shipment.id,
      version,
      status: 'assigned',
      occurredAt: '2026-10-08T12:00:00.000Z',
    };
    const raw = JSON.stringify(event);
    const ts = String(Date.now());
    return system.app.inject({
      method: 'POST',
      url: '/api/demo-commerce/webhook',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': ts,
        'x-webhook-signature': createHmac('sha256', webhookKey)
          .update(ts + '.' + raw)
          .digest('hex'),
      },
      payload: raw,
    });
  }
  assert.equal((await send(1)).statusCode, 200);
  assert.equal((await send(2)).statusCode, 409);
  const row = await db.query<{ version: number }>(
    'SELECT version FROM commerce_projection WHERE shipment_id=$1',
    [c.shipment.id],
  );
  assert.equal(row.rows[0].version, 1);
});
test('demo session rejects DNS rebinding hosts and demo accounts are unavailable outside demo mode', async () => {
  assert.equal(
    (
      await system.app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: { host: 'attacker.example' },
        payload: { accountId: 'ops' },
      })
    ).statusCode,
    403,
  );
  const isolated = buildApp(db, { applicationKey, webhookKey, demoMode: false });
  await isolated.app.ready();
  try {
    assert.equal((await isolated.app.inject('/api/demo/accounts')).statusCode, 404);
    assert.equal(
      (
        await isolated.app.inject({
          method: 'POST',
          url: '/api/demo/session',
          payload: { accountId: 'ops' },
        })
      ).statusCode,
      404,
    );
  } finally {
    await isolated.app.close();
  }
});
