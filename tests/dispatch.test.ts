import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/inventory.js';
import { courierCapacity, courierWorkloads } from '../server/domain.js';
import type { DispatchPreview } from '../shared/dispatch.js';
import { distanceKm } from '../shared/customer-locations.js';
import { mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function setup() {
  const f = await fixture();
  const now = Date.now();
  f.setNow(now);
  f.cookies['courier-a'] = (
    await f.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: 'courier-a' },
    })
  ).headers['set-cookie']!.toString().split(';')[0];
  await f.db.query("UPDATE sites SET latitude=33.51,longitude=36.29 WHERE id='site-a'");
  await f.db.query("UPDATE couriers SET capacity_kg=2 WHERE id='courier-a'");
  const share = (who = 'courier-a', extra = {}) =>
    f.post(
      '/api/dispatch/location',
      {
        action: 'share',
        consent: true,
        latitude: 33.511,
        longitude: 36.29,
        accuracy: 20,
        measuredAt: new Date(now).toISOString(),
        ...extra,
      },
      who,
    );
  assert.equal((await share()).statusCode, 200);
  assert.equal((await share('courier-b', { latitude: 33.53 })).statusCode, 200);
  async function shipment(priority?: string, quantity = 1) {
    const q = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity }],
        recipientName: 'عميل الأولوية',
        district: 'الروضة',
        address: 'عنوان اختبار واضح',
        ...(priority === undefined ? {} : { priority }),
      },
      'shop',
    );
    assert.equal(q.statusCode, 200, q.body);
    const r = await f.order(q.json().id);
    assert.equal(r.statusCode, 200, r.body);
    return { quote: q.json(), s: r.json().shipment };
  }
  const preview = async (id: string) => {
    const r = await f.get(`/api/shipments/${id}/dispatch`);
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as DispatchPreview;
  };
  const assign = (id: string, p: DispatchPreview, key = crypto.randomUUID()) =>
    f.post(
      `/api/shipments/${id}/dispatch`,
      {
        expectedVersion: p.shipmentVersion,
        token: p.token,
        courierId: p.candidates[0]?.id ?? 'courier-a',
      },
      'ops',
      key,
    );
  return { ...f, now, share, shipment, preview, assign };
}

test('priority defaults to normal, urgent survives quote/order/replay/list, invalid input rejected', async () => {
  const f = await setup();
  try {
    const a = await f.shipment(),
      b = await f.shipment('urgent');
    assert.equal(a.s.priority, 'normal');
    assert.equal(b.s.priority, 'urgent');
    assert.equal(b.quote.quote.priority, 'urgent');
    assert.equal(a.quote.quote.feeMinor, b.quote.quote.feeMinor);
    assert.equal((await f.order(b.quote.id)).json().shipment.priority, 'urgent');
    const list = await f.app.inject({ url: '/api/storefront/orders', headers: { cookie: f.shop } });
    assert.equal(
      list.json().orders.find((x: any) => x.shipment.id === b.s.id).shipment.priority,
      'urgent',
    );
    const bad = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        recipientName: 'عميل',
        district: 'الروضة',
        address: 'عنوان واضح',
        priority: 'immediate',
      },
      'shop',
    );
    assert.equal(bad.statusCode, 422);
    await assert.rejects(
      f.db.query("UPDATE shipments SET priority='invalid' WHERE id=$1", [a.s.id]),
    );
  } finally {
    await f.close();
  }
});

test('urgent chooses closest origin, normal chooses lower utilization; assignment audited and replay safe', async () => {
  const f = await setup();
  try {
    const a = await f.shipment('normal'),
      b = await f.shipment('urgent');
    assert.equal((await f.preview(a.s.id)).candidates[0].id, 'courier-b');
    const p = await f.preview(b.s.id);
    assert.equal(p.candidates[0].id, 'courier-a');
    assert.equal(p.method, 'straight-line');
    assert.ok(!JSON.stringify(p).includes('latitude'));
    const k = crypto.randomUUID(),
      r = await f.assign(b.s.id, p, k);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().courierId, 'courier-a');
    assert.equal(r.json().assignmentAccepted, false);
    assert.deepEqual((await f.assign(b.s.id, p, k)).json(), r.json());
    const history = (await f.get(`/api/shipments/${b.s.id}`)).json().timeline;
    assert.equal(history.filter((e: any) => e.type === 'shipment.assign').length, 1);
    assert.ok(history.some((e: any) => e.description.includes('local-v2')));
  } finally {
    await f.close();
  }
});

test('fresh consent is independent, scoped and revocable; rejects stale, inaccurate and out-of-order fixes', async () => {
  const f = await setup();
  try {
    assert.equal((await f.share('merchant-a')).statusCode, 403);
    assert.equal((await f.share('courier-a', { consent: false })).statusCode, 422);
    assert.equal((await f.share('courier-a', { accuracy: 201 })).statusCode, 422);
    assert.equal(
      (await f.share('courier-a', { measuredAt: new Date(f.now - 61_000).toISOString() }))
        .statusCode,
      422,
    );
    assert.equal((await f.share('courier-a')).statusCode, 409);
    assert.equal((await f.get('/api/dispatch/location', 'merchant-a')).statusCode, 403);
    const { s } = await f.shipment('urgent'),
      p = await f.preview(s.id);
    assert.equal((await f.get(`/api/shipments/${s.id}/dispatch`, 'courier-a')).statusCode, 403);
    assert.equal(
      (await f.post('/api/dispatch/location', { action: 'revoke' }, 'courier-a')).statusCode,
      200,
    );
    assert.equal((await f.assign(s.id, p)).statusCode, 409);
    assert.equal((await f.preview(s.id)).candidates[0].id, 'courier-b');
    assert.equal((await f.db.query('SELECT * FROM location_sharing')).rows.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM dispatch_locations WHERE courier_id='courier-a'")).rows
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('missing origin never fabricated, aged locations and remote couriers not ranked', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('urgent');
    await f.db.query("UPDATE sites SET latitude=NULL WHERE id='site-a'");
    assert.match((await f.preview(s.id)).blocked!, /موقع/);
    await f.db.query("UPDATE sites SET latitude=33.51 WHERE id='site-a'");
    await f.db.query("UPDATE dispatch_locations SET latitude=35 WHERE courier_id='courier-a'");
    assert.equal((await f.preview(s.id)).candidates.length, 1);
    f.advance(5 * 60_000);
    assert.equal((await f.preview(s.id)).candidates.length, 0);
    assert.equal((await f.get('/api/dispatch/location', 'courier-b')).json().active, false);
    assert.equal((await f.db.query('SELECT * FROM dispatch_locations')).rows.length, 0);
  } finally {
    await f.close();
  }
});

test('capacity and availability changes invalidate preview; archived courier rejected even for manual assignment', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('urgent'),
      p = await f.preview(s.id);
    await f.db.query("UPDATE couriers SET available=false WHERE id='courier-a'");
    assert.equal((await f.assign(s.id, p)).statusCode, 409);
    await f.db.query("UPDATE couriers SET available=true,archived_at=now() WHERE id='courier-a'");
    assert.equal((await f.action(s, 'assign', 'ops', { courierId: 'courier-a' })).statusCode, 422);
    assert.equal((await f.preview(s.id)).candidates.length, 1);
    const q = await f.preview(s.id);
    await f.db.query("UPDATE couriers SET capacity_kg=0.1 WHERE id='courier-b'");
    assert.equal((await f.assign(s.id, q)).statusCode, 409);
    assert.equal((await f.get(`/api/shipments/${s.id}`)).json().shipment.status, 'ready');
  } finally {
    await f.close();
  }
});

test('competing assignments recompute reserved capacity; one stale proposal wins and retry selects current eligible courier', async () => {
  const f = await setup();
  try {
    await f.db.query("UPDATE couriers SET available=false WHERE id='courier-a'");
    await f.db.query("UPDATE couriers SET capacity_kg=9 WHERE id='courier-b'");
    const a = await f.shipment('normal', 2),
      b = await f.shipment('normal', 2);
    const p = await f.preview(a.s.id),
      q = await f.preview(b.s.id);
    const results = await Promise.all([f.assign(a.s.id, p), f.assign(b.s.id, q)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const remaining = results[0].statusCode === 200 ? b.s : a.s;
    assert.equal((await f.preview(remaining.id)).candidates.length, 0);
    assert.ok((await courierCapacity(f.db, 'courier-b')) <= 9);
    const work = await courierWorkloads(f.db);
    assert.equal(work.get('courier-b')!.kg, await courierCapacity(f.db, 'courier-b'));
  } finally {
    await f.close();
  }
});

test('application API accepts urgent and old quotes remain normal without repricing', async () => {
  const f = await setup();
  try {
    const headers = { authorization: 'Bearer inventory-test', 'x-merchant-id': 'merchant-a' };
    const q = await f.app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers,
      payload: {
        externalReference: crypto.randomUUID(),
        originId: 'site-a',
        recipientName: 'عميل التطبيق',
        destination: 'الروضة دمشق',
        weightKg: 1,
        priority: 'urgent',
      },
    });
    assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().priority, 'urgent');
    await f.db.query("UPDATE quotes SET input=input-'priority' WHERE id=$1", [q.json().id]);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      payload: { quoteId: q.json().id },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().priority, 'normal');
  } finally {
    await f.close();
  }
});

test('selection compares entire eligible set deterministically against exhaustive distance reference', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('urgent');
    await f.db.query(
      `INSERT INTO couriers(id,name,vehicle,capacity_kg,available) SELECT 'bench-'||g,'اختبار '||g,'دراجة',10,true FROM generate_series(1,500) g`,
    );
    await f.db.query(
      `INSERT INTO dispatch_locations(courier_id,latitude,longitude,accuracy,measured_at,received_at) SELECT 'bench-'||g,33.51+g*0.00001,36.29,10,$1,$1 FROM generate_series(1,500) g`,
      [new Date(f.now).toISOString()],
    );
    const started = performance.now(),
      p = await f.preview(s.id);
    assert.equal(p.candidates.length, 502);
    const reference = Array.from({ length: 500 }, (_, i) => ({
      id: 'bench-' + (i + 1),
      km: distanceKm(
        { latitude: 33.51, longitude: 36.29 },
        { latitude: 33.51 + (i + 1) * 0.00001, longitude: 36.29 },
      ),
    })).sort((a, b) => a.km - b.km);
    assert.equal(p.candidates[0].id, reference[0].id);
    assert.deepEqual(
      (await f.preview(s.id)).candidates.map((c) => c.id),
      p.candidates.map((c) => c.id),
    );
    console.log(
      `Local exhaustive comparison: 502 eligible couriers, ${Math.round(performance.now() - started)} ms including two HTTP previews; no external routing calls`,
    );
  } finally {
    await f.close();
  }
});

test('failed assignment event rolls back reservation and idempotency result', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('urgent'),
      p = await f.preview(s.id),
      k = crypto.randomUUID();
    const used = await courierCapacity(f.db, 'courier-a');
    await f.db.exec(
      `CREATE FUNCTION reject_dispatch_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipment.assign' THEN RAISE EXCEPTION 'isolated failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_dispatch_event BEFORE INSERT ON timeline FOR EACH ROW EXECUTE FUNCTION reject_dispatch_event()`,
    );
    assert.equal((await f.assign(s.id, p, k)).statusCode, 500);
    assert.equal((await f.get('/api/shipments/' + s.id)).json().shipment.status, 'ready');
    assert.equal(await courierCapacity(f.db, 'courier-a'), used);
    await f.db.exec('DROP TRIGGER reject_dispatch_event ON timeline');
    assert.equal((await f.assign(s.id, p, k)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('migration 30 safely upgrades old priority values and survives reopen', async () => {
  const dir = await mkdtemp(resolve('artifacts/dispatch-db-'));
  const path = join(dir, 'data'),
    f = await fixture(path);
  const { s } = { s: (await f.order((await f.checkout()).id)).json().shipment };
  await f.db.exec(
    'ALTER TABLE shipments DROP COLUMN priority; DELETE FROM schema_migrations WHERE version=30',
  );
  await f.close();
  const next = await fixture(path);
  try {
    assert.equal((await next.get('/api/shipments/' + s.id)).json().shipment.priority, 'normal');
    assert.equal(
      (await next.db.query('SELECT * FROM schema_migrations WHERE version=30')).rows.length,
      1,
    );
  } finally {
    await next.close();
  }
});

test('transfer commitments consume shared capacity and invalidate dispatch proposal', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('normal');
    const p = await f.preview(s.id),
      before = p.candidates.find((c) => c.id === 'courier-b')!.freeKg;
    const site = await f.post('/api/inventory/sites', {
      merchantId: 'merchant-a',
      name: 'مستودع نقل اختبار',
      address: 'عنوان وجهة النقل في دمشق',
      products: ['bag'],
      reason: 'إعداد وجهة نقل',
    });
    assert.equal(site.statusCode, 200, site.body);
    const t = await f.post('/api/inventory/transfers', {
      merchantId: 'merchant-a',
      sourceId: 'site-a',
      destinationId: site.json().id,
      items: [{ productId: 'bag', quantity: 5, sourceVersion: (await f.stock()).version }],
      reason: 'نقل قطع فعلية بين موقعين',
    });
    assert.equal(t.statusCode, 200, t.body);
    const r = await f.post('/api/inventory/transfers/' + t.json().id + '/actions', {
      action: 'assign',
      expectedVersion: t.json().version,
      courierId: 'courier-b',
      reason: 'إسناد النقل للمندوب',
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await f.preview(s.id)).candidates.find((c) => c.id === 'courier-b')!.freeKg,
      before - 3,
    );
    assert.equal((await f.assign(s.id, p)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('pickup expiry return ranks distance to custody point instead of original merchant', async () => {
  const f = await setup();
  try {
    const { s } = await f.shipment('urgent');
    assert.equal((await f.preview(s.id)).candidates[0].id, 'courier-a');
    await f.db.query("UPDATE sites SET latitude=33.529,longitude=36.29 WHERE id='pickup-a'");
    await f.db.query(
      "UPDATE shipments SET status='pickup_expired',pickup_site_id='pickup-a',custody_site_id='pickup-a' WHERE id=$1",
      [s.id],
    );
    assert.equal((await f.preview(s.id)).candidates[0].id, 'courier-b');
  } finally {
    await f.close();
  }
});
