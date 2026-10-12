import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
import { courierCapacity } from '../server/domain.js';
let db: Awaited<ReturnType<typeof openDatabase>>;
let system: ReturnType<typeof buildApp>;
let now = Date.now();
const cookies: Record<string, string> = {};
before(async () => {
  db = await openDatabase();
  system = buildApp(db, {
    applicationKey: 'test-key',
    webhookKey: 'test-signature',
    demoMode: true,
    clock: () => now,
  });
  for (const id of ['ops', 'courier-a', 'courier-b', 'merchant-a']) {
    const r = await system.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: id },
    });
    cookies[id] = r.headers['set-cookie']!.toString().split(';')[0];
  }
});
after(async () => {
  await system.app.close();
  await db.close();
});
async function createAssigned() {
  const headers = { authorization: 'Bearer test-key', 'x-merchant-id': 'merchant-a' };
  const q = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers,
    payload: {
      externalReference: randomUUID(),
      originId: 'site-a',
      recipientName: 'عميل اختبار',
      destination: 'الروضة، دمشق',
      weightKg: 1,
    },
  });
  const s = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { quoteId: q.json().id },
  });
  const a = await action(s.json().id, s.json().version, 'assign', 'ops', {
    courierId: 'courier-b',
  });
  assert.equal(a.statusCode, 200, a.body);
  return a.json();
}
function action(
  id: string,
  version: number,
  action: string,
  who: string,
  extra: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return system.app.inject({
    method: 'POST',
    url: `/api/shipments/${id}/actions`,
    headers: { cookie: cookies[who], 'idempotency-key': key },
    payload: { action, expectedVersion: version, ...extra },
  });
}
test('assignment deadline rejects late acceptance and sweep atomically releases capacity once', async () => {
  const s = await createAssigned();
  assert.equal(new Date(s.assignmentExpiresAt).getTime(), now + 300000);
  const capacity = await courierCapacity(db, 'courier-b');
  now += 300000;
  const late = await action(s.id, s.version, 'accept', 'courier-b');
  assert.equal(late.json().code, 'ASSIGNMENT_EXPIRED');
  await system.sweepAssignments();
  const row = (
    await system.app.inject({ url: `/api/shipments/${s.id}`, headers: { cookie: cookies.ops } })
  ).json();
  assert.equal(row.shipment.status, 'ready');
  assert.equal(row.shipment.courierId, null);
  assert.equal(row.shipment.assignmentExpiresAt, null);
  assert.equal(await courierCapacity(db, 'courier-b'), capacity - 1);
  await system.sweepAssignments();
  const events = await db.query('SELECT * FROM timeline WHERE shipment_id=$1 AND type=$2', [
    s.id,
    'shipment.assignment_expired',
  ]);
  assert.equal(events.rows.length, 1);
  assert.equal((await action(s.id, s.version, 'accept', 'courier-b')).statusCode, 404);
});
test('accepted tasks retain capacity after the deadline and cannot be declined', async () => {
  const s = await createAssigned();
  const accepted = await action(s.id, s.version, 'accept', 'courier-b');
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().assignmentExpiresAt, null);
  now += 300001;
  await system.sweepAssignments();
  const r = await action(s.id, accepted.json().version, 'decline', 'courier-b', {
    reason: 'لا أستطيع',
  });
  assert.equal(r.json().code, 'INVALID_TRANSITION');
  let current = (await action(s.id, accepted.json().version, 'prepare', 'merchant-a')).json();
  current = (
    await action(s.id, current.version, 'handover_origin', 'merchant-a', { courierId: 'courier-b' })
  ).json();
  const pickup = await action(s.id, current.version, 'pickup', 'courier-b');
  assert.equal(pickup.statusCode, 200);
  assert.equal(
    (await action(s.id, pickup.json().version, 'unassign', 'ops', { reason: 'تغيير المندوب' }))
      .statusCode,
    409,
  );
});
test('decline records reason, releases ownership and can replay after loss of scope', async () => {
  const s = await createAssigned();
  assert.equal(
    (await action(s.id, s.version, 'decline', 'courier-a', { reason: 'غير متاح' })).statusCode,
    404,
  );
  assert.equal((await action(s.id, s.version, 'decline', 'courier-b')).statusCode, 422);
  const k = randomUUID();
  const r = await action(
    s.id,
    s.version,
    'decline',
    'courier-b',
    { reason: 'انتهاء فترة عملي' },
    k,
  );
  assert.equal(r.statusCode, 200);
  const replay = await action(
    s.id,
    s.version,
    'decline',
    'courier-b',
    { reason: 'انتهاء فترة عملي' },
    k,
  );
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().version, r.json().version);
  assert.equal(
    (
      await system.app.inject({
        url: `/api/shipments/${s.id}`,
        headers: { cookie: cookies['courier-b'] },
      })
    ).statusCode,
    404,
  );
  const a = await action(s.id, r.json().version, 'assign', 'ops', { courierId: 'courier-a' });
  assert.equal(a.statusCode, 200);
});
test('operations can release before pickup while merchants cannot; expiry failure rolls back', async () => {
  const s = await createAssigned();
  assert.equal(
    (await action(s.id, s.version, 'unassign', 'merchant-a', { reason: 'تعديل الإسناد' }))
      .statusCode,
    403,
  );
  const r = await action(s.id, s.version, 'unassign', 'ops', { reason: 'إعادة توزيع المهام' });
  assert.equal(r.json().status, 'ready');
  const other = await createAssigned();
  now += 300001;
  await db.exec(
    "CREATE FUNCTION reject_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.assignment_expired' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_expiry BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_expiry()",
  );
  await assert.rejects(system.sweepAssignments());
  const row = await db.query<{ status: string; version: number }>(
    'SELECT status,version FROM shipments WHERE id=$1',
    [other.id],
  );
  assert.equal(row.rows[0].status, 'assigned');
  assert.equal(row.rows[0].version, other.version);
  await db.exec('DROP TRIGGER reject_expiry ON outbox; DROP FUNCTION reject_expiry()');
  await system.sweepAssignments();
});
