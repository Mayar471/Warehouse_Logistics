import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
import { catalog } from '../shared/catalog.js';

test('customer commerce journey uses server prices, separates ownership, and replays fulfillment safely', async () => {
  const db = await openDatabase();
  const { app } = buildApp(db, {
    applicationKey: 'storefront-test-key',
    webhookKey: 'test-signature',
    demoMode: true,
  });
  try {
    const session = await app.inject({
      method: 'POST',
      url: '/api/storefront/session',
      payload: {},
    });
    const cookie = session.headers['set-cookie']!.toString().split(';')[0];
    const headers = { cookie };
    const payload = {
      items: [{ productId: 'bag', quantity: 2 }],
      recipientName: 'عميل المتجر',
      district: 'الروضة',
      address: 'شارع تجربة، بناء ١',
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/storefront/checkouts', payload })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/checkouts',
          headers,
          payload: { ...payload, subtotalMinor: 1 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/checkouts',
          headers,
          payload: { ...payload, items: [{ productId: 'unknown', quantity: 1 }] },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/checkouts',
          headers,
          payload: { ...payload, items: [...payload.items, ...payload.items] },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/checkouts',
          headers,
          payload: { ...payload, items: [{ productId: 'bag', quantity: 6 }] },
        })
      ).statusCode,
      422,
    );
    const quote = await app.inject({
      method: 'POST',
      url: '/api/storefront/checkouts',
      headers,
      payload,
    });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().subtotalMinor, catalog[0].priceMinor * 2);
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/storefront/session',
      payload: {},
    });
    const otherCookie = stranger.headers['set-cookie']!.toString().split(';')[0];
    const body = { checkoutId: quote.json().id };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/orders',
          headers: { cookie: otherCookie },
          payload: body,
        })
      ).statusCode,
      404,
    );
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/storefront/orders', headers, payload: body }),
      app.inject({ method: 'POST', url: '/api/storefront/orders', headers, payload: body }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().shipment.id, b.json().shipment.id);
    assert.equal(a.json().shipment.weightKg, 1.2);
    assert.equal(
      (await app.inject({ url: '/api/storefront/orders', headers })).json().orders.length,
      1,
    );
    assert.equal(
      (await app.inject({ url: '/api/storefront/orders', headers: { cookie: otherCookie } })).json()
        .orders.length,
      0,
    );
    assert.equal((await app.inject({ url: '/api/bootstrap', headers })).statusCode, 401);
    // Commerce linkage can recover after a lost update using the original checkout and key.
    await db.query('UPDATE storefront_checkouts SET shipment_id=NULL WHERE id=$1', [
      body.checkoutId,
    ]);
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/storefront/orders',
      headers,
      payload: body,
    });
    assert.equal(recovered.json().shipment.id, a.json().shipment.id);
    assert.equal(
      (await app.inject({ url: '/api/storefront/orders', headers })).json().orders.length,
      1,
    );
    const expired = await app.inject({
      method: 'POST',
      url: '/api/storefront/checkouts',
      headers,
      payload,
    });
    await db.query(
      "UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=(SELECT quote_id FROM storefront_checkouts WHERE id=$1)",
      [expired.json().id],
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/orders',
          headers,
          payload: { checkoutId: expired.json().id },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/storefront/session',
          headers: { host: 'evil.test' },
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
