import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
import { courierCapacity } from '../server/domain.js';
import type { Shipment } from '../shared/contracts.js';
let db: Awaited<ReturnType<typeof openDatabase>>;
let system: ReturnType<typeof buildApp>;
let now = Date.now();
const cookies: Record<string, string> = {};
before(async () => {
  db = await openDatabase();
  system = buildApp(db, {
    applicationKey: 'origin-test',
    webhookKey: 'origin-secret',
    demoMode: true,
    clock: () => now,
  });
  for (const accountId of ['ops', 'merchant-a', 'merchant-b', 'courier-b'])
    cookies[accountId] = (
      await system.app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
    ).headers['set-cookie']!.toString().split(';')[0];
});
after(async () => {
  await system.app.close();
  await db.close();
});
const action = (
  s: Shipment,
  action: string,
  who: string,
  extra: Record<string, unknown> = {},
  key = randomUUID(),
) =>
  system.app.inject({
    method: 'POST',
    url: `/api/shipments/${s.id}/actions`,
    headers: { cookie: cookies[who], 'idempotency-key': key },
    payload: { action, expectedVersion: s.version, ...extra },
  });
const load = async (s: Shipment) =>
  (
    await system.app.inject({ url: '/api/shipments/' + s.id, headers: { cookie: cookies.ops } })
  ).json().shipment as Shipment;
async function create() {
  const headers = { authorization: 'Bearer origin-test', 'x-merchant-id': 'merchant-a' };
  const q = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers,
    payload: {
      externalReference: randomUUID(),
      originId: 'site-a',
      recipientName: 'عميل المنشأ',
      destination: 'دمشق، الروضة',
      weightKg: 1,
    },
  });
  let s = (
    await system.app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { quoteId: q.json().id },
    })
  ).json() as Shipment;
  s = (await action(s, 'assign', 'ops', { courierId: 'courier-b' })).json();
  s = (await action(s, 'accept', 'courier-b')).json();
  return s;
}

test('origin handover requires merchant preparation, exact assigned courier and independent receipt', async () => {
  let s = await create();
  assert.equal(s.originHandoverRequired, true);
  assert.equal(s.originPrepared, false);
  assert.ok(s.pickupDueAt);
  assert.equal((await action(s, 'prepare', 'ops')).statusCode, 403);
  assert.equal((await action(s, 'prepare', 'courier-b')).statusCode, 403);
  assert.equal((await action(s, 'prepare', 'merchant-b')).statusCode, 404);
  assert.equal(
    (await action(s, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })).statusCode,
    409,
  );
  assert.equal(
    (await action(s, 'pickup', 'courier-b')).json().code,
    'ORIGIN_CONFIRMATION_REQUIRED',
  );
  s = (await action(s, 'prepare', 'merchant-a')).json();
  assert.equal(
    (await action(s, 'handover_origin', 'merchant-a', { courierId: 'courier-a' })).json().code,
    'COURIER_MISMATCH',
  );
  assert.equal((await action(s, 'pickup', 'courier-b')).statusCode, 409);
  const key = randomUUID();
  const before = s;
  const handover = await action(
    s,
    'handover_origin',
    'merchant-a',
    { courierId: 'courier-b' },
    key,
  );
  assert.equal(handover.statusCode, 200, handover.body);
  s = handover.json();
  assert.equal(
    (await action(before, 'handover_origin', 'merchant-a', { courierId: 'courier-b' }, key)).json()
      .version,
    s.version,
  );
  assert.equal(
    (await action(before, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })).json().code,
    'VERSION_CONFLICT',
  );
  assert.equal(s.status, 'assigned');
  assert.equal(s.originReleased, true);
  assert.equal(s.originReceived, false);
  assert.equal((await action(s, 'depart', 'courier-b')).statusCode, 409);
  assert.equal(
    (await action(s, 'unassign', 'ops', { reason: 'تغيير المندوب' })).json().code,
    'HANDOVER_PENDING',
  );
  assert.equal((await action(s, 'cancel', 'merchant-a')).json().code, 'RETURN_REQUIRED');
  s = (await action(s, 'pickup', 'courier-b')).json();
  assert.equal(s.originReceived, true);
  assert.equal(s.pickupDueAt, null);
  assert.equal((await action(s, 'depart', 'courier-b')).statusCode, 200);
  const events = await db.query(
    "SELECT * FROM timeline WHERE shipment_id=$1 AND type='shipment.handover_origin'",
    [s.id],
  );
  assert.equal(events.rows.length, 1);
});

test('late accepted pickup raises one durable exception without releasing capacity and can be reassigned before release', async () => {
  let s = await create();
  const kg = await courierCapacity(db, 'courier-b');
  now += 30 * 60_000 + 1;
  await system.sweepAssignments();
  s = await load(s);
  assert.equal(s.pickupOverdue, true);
  assert.equal(s.status, 'assigned');
  const alerts = await system.app.inject({
    url: '/api/shipments/pickup-alerts',
    headers: { cookie: cookies.ops },
  });
  assert.equal(alerts.statusCode, 200);
  assert.ok(alerts.json().alerts.some((item: { id: string }) => item.id === s.id));
  assert.ok(alerts.json().total >= 1);
  assert.equal(
    (
      await system.app.inject({
        url: '/api/shipments/pickup-alerts',
        headers: { cookie: cookies['courier-b'] },
      })
    ).statusCode,
    403,
  );
  assert.equal(s.courierId, 'courier-b');
  assert.equal(await courierCapacity(db, 'courier-b'), kg);
  const version = s.version;
  await system.sweepAssignments();
  s = await load(s);
  assert.equal(s.version, version);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM timeline WHERE shipment_id=$1 AND type='shipment.pickup_overdue'",
        [s.id],
      )
    ).rows.length,
    1,
  );
  s = (await action(s, 'unassign', 'ops', { reason: 'تأخر الوصول دون انتقال العهدة' })).json();
  assert.equal(s.status, 'ready');
  assert.equal(s.pickupDueAt, null);
  assert.equal(s.pickupOverdue, false);
  assert.equal(await courierCapacity(db, 'courier-b'), kg - 1);
  assert.ok(
    !(
      await system.app.inject({
        url: '/api/shipments/pickup-alerts',
        headers: { cookie: cookies.ops },
      })
    )
      .json()
      .alerts.some((item: { id: string }) => item.id === s.id),
  );
});

test('late pickup after merchant release retains custody barrier until courier receipt and clears the active exception', async () => {
  let s = await create();
  s = (await action(s, 'prepare', 'merchant-a')).json();
  s = (await action(s, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })).json();
  now += 30 * 60_000 + 1;
  await system.sweepAssignments();
  s = await load(s);
  assert.equal(s.pickupOverdue, true);
  assert.equal(
    (await action(s, 'unassign', 'ops', { reason: 'تأخر تأكيد الاستلام' })).statusCode,
    409,
  );
  const pickup = await action(s, 'pickup', 'courier-b');
  assert.equal(pickup.statusCode, 200, pickup.body);
  s = pickup.json();
  assert.equal(s.pickupOverdue, false);
  assert.equal(s.originReleased, true);
  assert.equal(s.originReceived, true);
  assert.equal(s.pickupDueAt, null);
});

test('outbox failure rolls back preparation, release, receipt and pickup deadline alert atomically', async () => {
  let s = await create();
  for (const [act, who] of [
    ['prepare', 'merchant-a'],
    ['handover_origin', 'merchant-a'],
    ['pickup', 'courier-b'],
  ] as const) {
    await db.exec(
      `CREATE FUNCTION fail_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.${act}' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_origin BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_origin()`,
    );
    const before = s;
    const extra = act === 'handover_origin' ? { courierId: 'courier-b' } : {};
    assert.equal((await action(s, act, who, extra)).statusCode, 500);
    s = await load(s);
    assert.deepEqual(s, before);
    await db.exec('DROP TRIGGER fail_origin ON outbox; DROP FUNCTION fail_origin()');
    const done = await action(s, act, who, extra);
    assert.equal(done.statusCode, 200, done.body);
    s = done.json();
  }
  let late = await create();
  now += 30 * 60_000 + 1;
  await db.exec(
    "CREATE FUNCTION fail_origin_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.pickup_overdue' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_origin_late BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_origin_late()",
  );
  await assert.rejects(system.sweepAssignments());
  assert.deepEqual(await load(late), late);
  await db.exec('DROP TRIGGER fail_origin_late ON outbox; DROP FUNCTION fail_origin_late()');
  await system.sweepAssignments();
  late = await load(late);
  assert.equal(late.pickupOverdue, true);
});

test('historical demo rows are explicitly marked without fabricated origin confirmations', async () => {
  const legacy = (
    await system.app.inject({ url: '/api/bootstrap', headers: { cookie: cookies.ops } })
  )
    .json()
    .shipments.find((s: Shipment) => s.externalReference === 'DEMO-2');
  assert.equal(legacy.originHandoverRequired, false);
  assert.equal(legacy.originPrepared, false);
  assert.equal(legacy.originReleased, false);
  assert.equal(legacy.originReceived, false);
  assert.equal(legacy.pickupDueAt, null);
});
