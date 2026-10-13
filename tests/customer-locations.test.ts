import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { distanceKm } from '../shared/customer-locations.js';
test('saved locations are scoped and versioned; nearest ranking returns five located enabled points with verified ratings only', async () => {
  const f = await cashFixture();
  try {
    const payload = {
      label: 'home',
      name: 'البيت',
      district: 'الروضة',
      details: 'البناء الأول الطابق الثاني',
      latitude: 33.514,
      longitude: 36.28,
    };
    const k = crypto.randomUUID(),
      saved = await f.post('/api/storefront/addresses', payload, 'shop', k);
    assert.equal(saved.statusCode, 200, saved.body);
    const a = saved.json();
    assert.equal((await f.post('/api/storefront/addresses', payload, 'shop', k)).json().id, a.id);
    assert.equal((await f.post('/api/storefront/addresses', payload, 'shop')).statusCode, 409);
    const listed = await f.app.inject({
      url: '/api/storefront/addresses',
      headers: { cookie: f.shop },
    });
    assert.equal(listed.json().addresses.length, 1);
    const fresh = (await f.app.inject({ method: 'POST', url: '/api/storefront/session' })).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
    const foreign = await f.app.inject({
      method: 'POST',
      url: '/api/storefront/pickup-sites/nearest',
      headers: { cookie: fresh },
      payload: { addressId: a.id },
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(
      (
        await f.post(
          '/api/storefront/addresses',
          { ...payload, id: a.id, expectedVersion: 999 },
          'shop',
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.post(
          '/api/storefront/addresses',
          { ...payload, id: a.id, expectedVersion: 1, latitude: 33.515 },
          'shop',
        )
      ).statusCode,
      200,
    );
    const quote = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        recipientName: 'عميل المواقع',
        district: 'الروضة',
        address: 'عنوان محفوظ واضح',
        location: { latitude: 33.514, longitude: 36.28 },
      },
      'shop',
    );
    assert.equal(quote.statusCode, 200, quote.body);
    const snapshot = (
      await f.db.query<{ delivery_location: { latitude: number } }>(
        'SELECT delivery_location FROM storefront_checkouts WHERE id=$1',
        [quote.json().id],
      )
    ).rows[0];
    assert.equal(snapshot.delivery_location.latitude, 33.514);
    const created = await f.order(quote.json().id);
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(created.json().shipment.deliveryLocation, {
      latitude: 33.514,
      longitude: 36.28,
    });
    const publicView = await f.app.inject({
      url: '/api/tracking/' + created.json().shipment.trackingToken,
    });
    assert.equal(publicView.statusCode, 200);
    assert.equal('deliveryLocation' in publicView.json(), false);
    for (let i = 0; i < 7; i++) {
      const r = await f.post(
        '/api/network/pickup-sites',
        {
          name: `نقطة اختبار ${i}`,
          address: 'عنوان نقطة داخل دمشق',
          capacityKg: 100,
          enabled: i !== 6,
          reason: 'تجهيز بيانات مراجعة معزولة',
          location: { latitude: 33.514 + i * 0.001, longitude: 36.28 },
        },
        'ops',
      );
      assert.equal(r.statusCode, 200, r.body);
    }
    const nearest = await f.post(
      '/api/storefront/pickup-sites/nearest',
      { latitude: 33.514, longitude: 36.28 },
      'shop',
    );
    assert.equal(nearest.statusCode, 200, nearest.body);
    const points = nearest.json().sites;
    assert.equal(points.length, 5);
    assert(
      points.every(
        (p: { ratingCount: number; rating: null }) => p.ratingCount === 0 && p.rating === null,
      ),
    );
    assert(
      points.every(
        (p: { distanceKm: number }, i: number) => !i || p.distanceKm >= points[i - 1].distanceKm,
      ),
    );
    assert.equal(points[0].distanceKm, 0);
    assert.equal(
      (
        await f.post(
          '/api/storefront/pickup-sites/nearest',
          { latitude: NaN, longitude: 36.28 },
          'shop',
        )
      ).statusCode,
      422,
    );
    assert.equal(
      distanceKm({ latitude: 33.5, longitude: 36.2 }, { latitude: 33.5, longitude: 36.2 }),
      0,
    );
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: '/api/storefront/addresses/' + a.id,
      headers: { cookie: f.shop },
      payload: { expectedVersion: 2 },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(
      (await f.db.query('SELECT * FROM storefront_checkouts WHERE id=$1', [quote.json().id])).rows
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('courier and pickup ratings require the owning delivered order; retry cannot double count and public pickup averages come from ratings', async () => {
  const f = await cashFixture(true);
  try {
    const id = f.shipment().id,
      route = `/api/storefront/orders/${id}/ratings`;
    assert.equal((await f.post(route, { kind: 'courier', score: 5 }, 'shop')).statusCode, 409);
    const { code } = await f.route();
    assert.equal((await f.deliver(code)).statusCode, 200);
    const k = crypto.randomUUID(),
      body = { kind: 'courier', score: 4 };
    assert.equal((await f.post(route, body, 'shop', k)).statusCode, 200);
    assert.equal((await f.post(route, body, 'shop', k)).statusCode, 200);
    assert.equal((await f.post(route, { kind: 'courier', score: 1 }, 'shop')).statusCode, 409);
    assert.equal((await f.post(route, { kind: 'pickup', score: 5 }, 'shop')).statusCode, 200);
    await assert.rejects(
      f.db.query('UPDATE service_ratings SET score=1 WHERE shipment_id=$1', [id]),
      /immutable/,
    );
    await assert.rejects(
      f.db.query('DELETE FROM delivery_service_subjects WHERE shipment_id=$1', [id]),
      /immutable/,
    );
    const fresh = (await f.app.inject({ method: 'POST', url: '/api/storefront/session' })).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: route,
          payload: { kind: 'courier', score: 2 },
          headers: { cookie: fresh, 'idempotency-key': crypto.randomUUID() },
        })
      ).statusCode,
      404,
    );
    const view = (await f.get('/api/bootstrap')).json();
    assert.equal(view.couriers.find((c: { id: string }) => c.id === 'courier-b').rating, 4);
    const session = (
      await f.app.inject({
        method: 'POST',
        url: '/api/storefront/session',
        headers: { cookie: f.shop },
      })
    ).json();
    assert.equal(session.pickupSites.find((p: { id: string }) => p.id === 'pickup-a').rating, 5);
    const orders = (
      await f.app.inject({ url: '/api/storefront/orders', headers: { cookie: f.shop } })
    ).json();
    assert.equal(
      orders.orders.find((o: { shipment: { id: string } }) => o.shipment.id === id).ratings.length,
      2,
    );
  } finally {
    await f.close();
  }
});
