import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationFixture } from './helpers/location.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
test('courier consent shares one shipment with authorized roles and customer only, never public tracking or another customer', async () => {
  const f = await locationFixture();
  try {
    assert.equal((await f.view()).json().state, 'off');
    assert.equal((await f.start(true, crypto.randomUUID(), 'ops')).statusCode, 403);
    assert.equal((await f.start(true, crypto.randomUUID(), 'merchant-a')).statusCode, 403);
    assert.equal((await f.start(true, crypto.randomUUID(), 'merchant-b')).statusCode, 404);
    assert.equal(
      (
        await f.post(
          f.base + '/sharing',
          {
            action: 'start',
            expectedVersion: f.shipment.version,
            consent: false,
            customerAllowed: true,
          },
          'courier-b',
        )
      ).statusCode,
      422,
    );
    const r = await f.start();
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().sessionId;
    assert.equal((await f.view()).json().state, 'waiting');
    assert.equal((await f.point(id)).statusCode, 200);
    for (const role of ['ops', 'merchant-a', 'courier-b'])
      assert.equal((await f.view(role)).json().point.latitude, 33.5138);
    assert.equal((await f.customer()).json().point.longitude, 36.2765);
    assert.equal((await f.view('merchant-b')).statusCode, 404);
    assert.equal((await f.view('pickup-a')).statusCode, 404);
    f.cookies['courier-a'] = (
      await f.app.inject({
        method: 'POST',
        url: '/api/demo/session',
        payload: { accountId: 'courier-a' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
    assert.equal((await f.view('courier-a')).statusCode, 404);
    assert.equal((await f.point(id, 2, {}, 'courier-a')).statusCode, 404);
    const other = (
      await f.app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
    ).headers['set-cookie']!.toString().split(';')[0];
    assert.equal(
      (
        await f.app.inject({
          url: `/api/storefront/orders/${f.shipment.id}/location`,
          headers: { cookie: other },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.post(
          f.base + '/points',
          {
            sessionId: id,
            sequence: 2,
            latitude: 1,
            longitude: 1,
            accuracy: 1,
            measuredAt: new Date(f.now()).toISOString(),
          },
          'ops',
        )
      ).statusCode,
      404,
    );
    const publicTracking = await f.app.inject({ url: '/api/tracking/' + f.shipment.trackingToken });
    assert.equal(publicTracking.statusCode, 200);
    assert.ok(!publicTracking.body.includes('33.5138'));
    assert.ok(!publicTracking.body.includes('latitude'));
    const audits = (await f.db.query('SELECT * FROM location_audit')).rows;
    assert.equal(audits.length, 1);
    assert.ok(!JSON.stringify(audits).includes('33.5138'));
  } finally {
    await f.close();
  }
});
test('point replay keeps original age; conflicting sequence, invalid coordinates, old time, out of order and rapid updates cannot refresh location', async () => {
  const f = await locationFixture();
  try {
    const id = (await f.start()).json().sessionId;
    const measuredAt = new Date(f.now()).toISOString();
    const first = await f.point(id, 1, { measuredAt });
    assert.equal(first.statusCode, 200, first.body);
    f.advance(6000);
    assert.deepEqual((await f.point(id, 1, { measuredAt })).json(), first.json());
    assert.equal(
      (await f.point(id, 1, { measuredAt, latitude: 34 })).json().code,
      'POINT_CONFLICT',
    );
    assert.equal((await f.point(id, 2, { latitude: 91 })).statusCode, 422);
    assert.equal((await f.point(id, 2, { accuracy: 6000 })).statusCode, 422);
    assert.equal(
      (await f.point(id, 2, { measuredAt: new Date(f.now() + 20000).toISOString() })).statusCode,
      422,
    );
    assert.equal(
      (await f.point(id, 2, { measuredAt: new Date(f.now() - 130000).toISOString() })).statusCode,
      422,
    );
    assert.equal((await f.point(id, 2, { measuredAt })).statusCode, 422);
    assert.equal((await f.point(id, 2)).statusCode, 200);
    assert.equal((await f.point(id, 1, { measuredAt })).json().code, 'POINT_OUT_OF_ORDER');
    f.advance(1000);
    assert.equal((await f.point(id, 3)).statusCode, 429);
    f.advance(121000);
    assert.equal((await f.customer()).json().state, 'stale');
    assert.equal((await f.customer()).json().point, null);
    assert.equal(
      (await f.point(id, 2, { measuredAt: new Date(f.now() - 122000).toISOString() })).statusCode,
      200,
      'exact replay may acknowledge old point but must not refresh age',
    );
    assert.equal((await f.customer()).json().point, null);
  } finally {
    await f.close();
  }
});
test('stops and expired grants hide immediately without workers; new generation rejects old point and customer opt-out is respected', async () => {
  const f = await locationFixture();
  try {
    const key = crypto.randomUUID();
    const first = await f.start(false, key);
    const id = first.json().sessionId;
    assert.deepEqual((await f.start(false, key)).json(), first.json());
    assert.equal((await f.point(id)).statusCode, 200);
    assert.equal((await f.customer()).json().point, null);
    assert.equal((await f.view()).json().state, 'live');
    assert.equal((await f.stop(id, crypto.randomUUID(), 'merchant-a')).statusCode, 403);
    const stopped = await f.stop(id);
    assert.equal(stopped.statusCode, 200);
    assert.equal((await f.view()).json().point, null);
    const stored = (
      await f.db.query<{ latitude: number | null }>(
        'SELECT latitude FROM location_sharing WHERE shipment_id=$1',
        [f.shipment.id],
      )
    ).rows[0];
    assert.equal(stored.latitude, null);
    const newId = (await f.start()).json().sessionId;
    assert.notEqual(newId, id);
    assert.equal((await f.point(id, 2)).json().code, 'SHARING_ENDED');
    assert.equal((await f.point(newId)).statusCode, 200);
    f.advance(30 * 60000);
    assert.equal((await f.view()).json().state, 'off');
    assert.equal((await f.customer()).json().point, null);
    assert.equal((await f.point(newId, 2)).statusCode, 409);
    await f.system.sweepAssignments();
    assert.equal(
      (
        await f.db.query<{ latitude: number | null }>(
          'SELECT latitude FROM location_sharing WHERE shipment_id=$1',
          [f.shipment.id],
        )
      ).rows[0].latitude,
      null,
    );
  } finally {
    await f.close();
  }
});
test('shipment transition revokes coordinates atomically and audit failures roll back start, stop and transition', async () => {
  const f = await locationFixture();
  try {
    await f.db.exec(
      "CREATE FUNCTION reject_location_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$; CREATE TRIGGER reject_location_audit BEFORE INSERT ON location_audit FOR EACH ROW EXECUTE FUNCTION reject_location_audit();",
    );
    const key = crypto.randomUUID();
    assert.equal((await f.start(true, key)).statusCode, 500);
    assert.equal((await f.view()).json().state, 'off');
    await f.db.exec('DROP TRIGGER reject_location_audit ON location_audit');
    const id = (await f.start(true, key)).json().sessionId;
    await f.point(id);
    await f.db.exec(
      'CREATE TRIGGER reject_location_audit BEFORE INSERT ON location_audit FOR EACH ROW EXECUTE FUNCTION reject_location_audit()',
    );
    assert.equal((await f.stop(id)).statusCode, 500);
    assert.equal((await f.view()).json().state, 'live');
    assert.equal(
      (await f.action(f.shipment, 'return', 'ops', { reason: 'اختبار إيقاف عند تغير الحالة' }))
        .statusCode,
      500,
    );
    assert.equal((await f.view()).json().state, 'live');
    await f.db.exec('DROP TRIGGER reject_location_audit ON location_audit');
    const proof = (
      await f.post(`/api/storefront/orders/${f.shipment.id}/delivery-code`, {}, 'shop')
    ).json();
    const delivered = await f.act(f.shipment, 'deliver', 'courier-b', { deliveryCode: proof.code });
    assert.equal(delivered.status, 'delivered');
    assert.equal((await f.view()).json().state, 'unavailable');
    assert.equal((await f.customer()).json().point, null);
    assert.equal((await f.point(id, 2)).statusCode, 409);
  } finally {
    await f.close();
  }
});
test('latest reading and consent survive restart but expired access is denied independently of cleanup', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'location-db-'));
  const f = await locationFixture(path);
  try {
    const id = (await f.start()).json().sessionId;
    await f.point(id);
    const shipmentId = f.shipment.id,
      now = f.now();
    await f.close();
    const next = await fixture(path);
    try {
      next.setNow(now);
      assert.equal((await next.get(`/api/shipments/${shipmentId}/location`)).json().state, 'live');
      next.setNow(now + 31 * 60000);
      assert.equal((await next.get(`/api/shipments/${shipmentId}/location`)).json().point, null);
      assert.equal((await next.db.query('SELECT * FROM location_sharing')).rows.length, 1);
    } finally {
      await next.close();
    }
  } finally {
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
