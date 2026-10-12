import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
let db: Awaited<ReturnType<typeof openDatabase>>;
let system: ReturnType<typeof buildApp>;
let transportCode = 200;
const cookies: Record<string, string> = {};
before(async () => {
  db = await openDatabase();
  system = buildApp(db, {
    applicationKey: 'key',
    webhookKey: 'signature',
    demoMode: true,
    transport: async (raw, headers) =>
      transportCode === 200
        ? (
            await system.app.inject({
              method: 'POST',
              url: '/api/demo-commerce/webhook',
              headers,
              payload: raw,
            })
          ).statusCode
        : transportCode,
  });
  for (const id of ['ops', 'merchant-a', 'courier-b']) {
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
test('event listing pages through old records and filters terminal failures with ownership checks', async () => {
  for (let i = 0; i < 11; i++) await create();
  const headers = { cookie: cookies.ops };
  const first = await system.app.inject({
    url: '/api/integration/events?status=all&page=0',
    headers,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().events.length, 10);
  const second = await system.app.inject({
    url: '/api/integration/events?status=all&page=1',
    headers,
  });
  assert.ok(second.json().events.length > 0);
  assert.ok(
    !second
      .json()
      .events.some((e: { id: string }) =>
        first.json().events.some((p: { id: string }) => p.id === e.id),
      ),
  );
  const id = second.json().events[0].id;
  await db.query("UPDATE outbox SET status='failed' WHERE id=$1", [id]);
  const failed = await system.app.inject({
    url: '/api/integration/events?status=failed&page=0',
    headers,
  });
  assert.ok(failed.json().events.some((e: { id: string }) => e.id === id));
  assert.ok(failed.json().events.every((e: { status: string }) => e.status === 'failed'));
  assert.equal(
    (
      await system.app.inject({
        url: '/api/integration/events',
        headers: { cookie: cookies['merchant-a'] },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await system.app.inject({ url: '/api/integration/events?page=-1', headers })).statusCode,
    422,
  );
});
async function create() {
  const headers = { authorization: 'Bearer key', 'x-merchant-id': 'merchant-a' };
  const q = await system.app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers,
    payload: {
      externalReference: randomUUID(),
      originId: 'site-a',
      recipientName: 'اختبار التكامل',
      destination: 'الروضة، دمشق',
      weightKg: 1,
    },
  });
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/v1/fulfillments',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { quoteId: q.json().id },
  });
  return r.json();
}
function repair(id: string, version: number, who = 'ops', k = randomUUID()) {
  return system.app.inject({
    method: 'POST',
    url: `/api/integration/reconciliation/${id}/repair`,
    headers: { cookie: cookies[who], 'idempotency-key': k },
    payload: { reason: 'استعادة الحالة المفقودة', expectedVersion: version },
  });
}
function retry(id: string, count: number, k = randomUUID(), who = 'ops') {
  return system.app.inject({
    method: 'POST',
    url: `/api/integration/events/${id}/retry`,
    headers: { cookie: cookies[who], 'idempotency-key': k },
    payload: { reason: 'تصحيح سبب الفشل', expectedRetryCount: count },
  });
}
test('recovery endpoints enforce operator role and reason', async () => {
  const s = await create();
  assert.equal(
    (
      await system.app.inject({
        url: '/api/integration/reconciliation',
        headers: { cookie: cookies['merchant-a'] },
      })
    ).statusCode,
    403,
  );
  assert.equal((await repair(s.id, s.version, 'courier-b')).statusCode, 403);
  const event = (
    await db.query<{ id: string }>('SELECT id FROM outbox WHERE shipment_id=$1', [s.id])
  ).rows[0];
  assert.equal((await retry(event.id, 0, randomUUID(), 'merchant-a')).statusCode, 403);
  assert.equal(
    (
      await system.app.inject({
        method: 'POST',
        url: `/api/integration/events/${event.id}/retry`,
        headers: { cookie: cookies.ops, 'idempotency-key': randomUUID() },
        payload: { reason: '', expectedRetryCount: 0 },
      })
    ).statusCode,
    422,
  );
});
test('terminal event replay preserves identity and lifetime attempts, audits once and restores delivery', async () => {
  const s = await create();
  transportCode = 400;
  await system.flushOutbox(true);
  const event = (
    await db.query<{ id: string; attempts: number }>('SELECT * FROM outbox WHERE shipment_id=$1', [
      s.id,
    ])
  ).rows[0];
  const k = randomUUID();
  assert.equal((await retry(event.id, 0, k)).statusCode, 200);
  assert.equal((await retry(event.id, 0, k)).statusCode, 200);
  assert.equal((await retry(event.id, 0)).json().code, 'RETRY_CONFLICT');
  const audit = await db.query('SELECT * FROM integration_audit WHERE entity_id=$1', [event.id]);
  assert.equal(audit.rows.length, 1);
  transportCode = 200;
  await system.flushOutbox(true);
  const after = (
    await db.query<{
      status: string;
      attempts: number;
      retry_count: number;
      cycle_attempts: number;
    }>('SELECT * FROM outbox WHERE id=$1', [event.id])
  ).rows[0];
  assert.equal(after.status, 'sent');
  assert.equal(after.attempts, event.attempts + 1);
  assert.equal(after.retry_count, 1);
  assert.equal(after.cycle_attempts, 1);
  assert.equal((await retry(event.id, 1)).json().code, 'NOT_FAILED');
});
test('missing projection can be repaired idempotently and snapshot cannot roll back newer receiver state', async () => {
  const s = await create();
  const report = (
    await system.app.inject({
      url: '/api/integration/reconciliation',
      headers: { cookie: cookies.ops },
    })
  ).json();
  assert.equal(
    report.differences.find((d: { shipmentId: string }) => d.shipmentId === s.id).kind,
    'missing',
  );
  const k = randomUUID();
  const r = await repair(s.id, s.version, 'ops', k);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await repair(s.id, s.version, 'ops', k)).json().eventId, r.json().eventId);
  assert.equal((await repair(s.id, s.version)).json().code, 'REPAIR_PENDING');
  await system.flushOutbox(true);
  const p = await db.query<{ version: number; status: string }>(
    'SELECT * FROM commerce_projection WHERE shipment_id=$1',
    [s.id],
  );
  assert.equal(p.rows[0].version, s.version);
  assert.equal((await repair(s.id, s.version)).statusCode, 409);
  await db.query('UPDATE commerce_projection SET version=$2,status=$3 WHERE shipment_id=$1', [
    s.id,
    s.version + 10,
    'delivered',
  ]);
  assert.equal((await repair(s.id, s.version)).json().code, 'MANUAL_REVIEW_REQUIRED');
});
test('reconciliation detects conflicts, ahead and unknown records without silently overwriting them', async () => {
  const s = await create();
  await db.query('INSERT INTO commerce_projection(shipment_id,version,status) VALUES($1,$2,$3)', [
    s.id,
    s.version,
    'delivered',
  ]);
  const unknown = randomUUID();
  await db.query('INSERT INTO commerce_projection(shipment_id,version,status) VALUES($1,1,$2)', [
    unknown,
    'ready',
  ]);
  let r = (
    await system.app.inject({
      url: '/api/integration/reconciliation',
      headers: { cookie: cookies.ops },
    })
  ).json();
  assert.equal(
    r.differences.find((d: { shipmentId: string }) => d.shipmentId === s.id).kind,
    'conflict',
  );
  assert.ok(r.differences.some((d: { kind: string }) => d.kind === 'orphan'));
  assert.equal((await repair(s.id, s.version)).statusCode, 409);
  await db.query('UPDATE commerce_projection SET version=$2 WHERE shipment_id=$1', [
    s.id,
    s.version + 1,
  ]);
  r = (
    await system.app.inject({
      url: '/api/integration/reconciliation',
      headers: { cookie: cookies.ops },
    })
  ).json();
  assert.equal(
    r.differences.find((d: { shipmentId: string }) => d.shipmentId === s.id).kind,
    'ahead',
  );
});
test('audit failure rolls back repair; final retry limit and cooldown are enforced', async () => {
  const s = await create();
  await db.exec(
    "CREATE FUNCTION reject_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_recovery BEFORE INSERT ON integration_audit FOR EACH ROW EXECUTE FUNCTION reject_recovery()",
  );
  assert.equal((await repair(s.id, s.version)).statusCode, 500);
  const pending = await db.query(
    "SELECT * FROM outbox WHERE shipment_id=$1 AND type='shipment.snapshot'",
    [s.id],
  );
  assert.equal(pending.rows.length, 0);
  await db.exec(
    'DROP TRIGGER reject_recovery ON integration_audit; DROP FUNCTION reject_recovery()',
  );
  const e = (await db.query<{ id: string }>('SELECT id FROM outbox WHERE shipment_id=$1', [s.id]))
    .rows[0];
  await db.query("UPDATE outbox SET status='failed',retry_count=3 WHERE id=$1", [e.id]);
  assert.equal((await retry(e.id, 3)).json().code, 'RETRY_LIMIT');
  await db.query('UPDATE outbox SET retry_count=1,last_retried_at=now() WHERE id=$1', [e.id]);
  assert.equal((await retry(e.id, 1)).json().code, 'RETRY_COOLDOWN');
});
