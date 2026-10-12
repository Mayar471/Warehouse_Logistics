import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

test('customer proof enforces ownership, expiry, persisted attempts, replacement, single use and transactional delivery', async () => {
  const db = await openDatabase();
  let now = Date.now();
  const { app } = buildApp(db, {
    applicationKey: 'test-key',
    webhookKey: 'proof-secret',
    demoMode: true,
    clock: () => now,
  });
  try {
    const sessions: Record<string, string> = {};
    for (const id of ['ops', 'courier-b', 'merchant-a']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/demo/session',
        payload: { accountId: id },
      });
      sessions[id] = r.headers['set-cookie']!.toString().split(';')[0];
    }
    const shop = await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} });
    const customer = shop.headers['set-cookie']!.toString().split(';')[0];
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/storefront/session',
      payload: {},
    });
    const strangerCookie = stranger.headers['set-cookie']!.toString().split(';')[0];
    const q = await app.inject({
      method: 'POST',
      url: '/api/storefront/checkouts',
      headers: { cookie: customer },
      payload: {
        items: [{ productId: 'bag', quantity: 1 }],
        recipientName: 'عميل اختبار',
        district: 'الروضة',
        address: 'شارع اختبارات ١',
      },
    });
    const order = await app.inject({
      method: 'POST',
      url: '/api/storefront/orders',
      headers: { cookie: customer },
      payload: { checkoutId: q.json().id },
    });
    let s = order.json().shipment;
    assert.equal(s.deliveryProofRequired, true);
    const issue = (cookie = customer) =>
      app.inject({
        method: 'POST',
        url: `/api/storefront/orders/${s.id}/delivery-code`,
        headers: { cookie },
        payload: {},
      });
    assert.equal((await issue()).statusCode, 409);
    assert.equal((await issue(strangerCookie)).statusCode, 404);
    assert.equal((await issue(sessions.ops)).statusCode, 401);
    async function action(action: string, extra: Record<string, unknown> = {}, k = randomUUID()) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/shipments/${s.id}/actions`,
        headers: {
          cookie:
            sessions[
              action === 'assign'
                ? 'ops'
                : ['prepare', 'handover_origin'].includes(action)
                  ? 'merchant-a'
                  : 'courier-b'
            ],
          'idempotency-key': k,
        },
        payload: { action, expectedVersion: s.version, ...extra },
      });
      if (r.statusCode === 200) s = r.json();
      return r;
    }
    for (const act of ['assign', 'accept', 'prepare', 'handover_origin', 'pickup', 'depart'])
      assert.equal(
        (
          await action(
            act,
            ['assign', 'handover_origin'].includes(act) ? { courierId: 'courier-b' } : {},
          )
        ).statusCode,
        200,
      );
    const issued = await issue();
    assert.equal(issued.statusCode, 200);
    const code = issued.json().code;
    assert.match(code, /^\d{6}$/);
    assert.equal((await issue()).statusCode, 429);
    const stored = await db.query<{ code_hash: string }>(
      'SELECT code_hash FROM delivery_proofs WHERE shipment_id=$1',
      [s.id],
    );
    assert.notEqual(stored.rows[0].code_hash, code);
    const publicTrack = await app.inject(`/api/tracking/${s.trackingToken}`);
    assert.ok(!publicTrack.body.includes(code));
    assert.ok(!publicTrack.body.includes('code_hash'));
    assert.equal((await action('deliver')).statusCode, 422);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await action('deliver', { deliveryCode: '000000' })).json().code,
        'PROOF_INVALID',
      );
    assert.equal((await action('deliver', { deliveryCode: code })).json().code, 'PROOF_LOCKED');
    const attempts = await db.query<{ attempts: number }>(
      'SELECT attempts FROM delivery_proofs WHERE shipment_id=$1',
      [s.id],
    );
    assert.equal(attempts.rows[0].attempts, 5);
    now += 61000;
    const replacement = (await issue()).json();
    now += 600001;
    assert.equal(
      (await action('deliver', { deliveryCode: replacement.code })).json().code,
      'PROOF_EXPIRED',
    );
    const finalProof = (await issue()).json();
    const beforeVersion = s.version;
    await db.exec(
      "CREATE FUNCTION fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.deliver' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delivery BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_delivery()",
    );
    assert.equal((await action('deliver', { deliveryCode: finalProof.code })).statusCode, 500);
    const proofRow = await db.query<{ consumed_at: string | null }>(
      'SELECT consumed_at FROM delivery_proofs WHERE shipment_id=$1',
      [s.id],
    );
    assert.equal(proofRow.rows[0].consumed_at, null);
    await db.exec('DROP TRIGGER fail_delivery ON outbox; DROP FUNCTION fail_delivery()');
    const k = randomUUID();
    const body = {
      action: 'deliver',
      expectedVersion: beforeVersion,
      deliveryCode: finalProof.code,
    };
    const done = await action('deliver', { deliveryCode: finalProof.code }, k);
    assert.equal(done.statusCode, 200);
    assert.equal(s.status, 'delivered');
    const replay = await app.inject({
      method: 'POST',
      url: `/api/shipments/${s.id}/actions`,
      headers: { cookie: sessions['courier-b'], 'idempotency-key': k },
      payload: body,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().version, s.version);
    assert.equal((await issue()).statusCode, 409);
    const history = await db.query('SELECT * FROM timeline WHERE shipment_id=$1 AND type=$2', [
      s.id,
      'shipment.deliver',
    ]);
    assert.equal(history.rows.length, 1);
  } finally {
    await app.close();
    await db.close();
  }
});
