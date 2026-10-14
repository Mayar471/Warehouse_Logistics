import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
test('partner removal archives safely, revokes accounts, prevents stale quotes, and preserves history', async () => {
  const db = await openDatabase('memory://'),
    { app } = buildApp(db, {
      applicationKey: 'remove-test',
      webhookKey: 'remove-test',
      demoMode: true,
    });
  async function login(id: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: id },
    });
    return { response: r, cookie: r.headers['set-cookie']?.toString().split(';')[0] };
  }
  try {
    const ops = (await login('ops')).cookie!,
      merchant = (await login('merchant-a')).cookie!;
    const remove = (kind: string, id: string, version = 1, cookie = ops, key = randomUUID()) =>
      app.inject({
        method: 'DELETE',
        url: `/api/network/${kind}/${id}`,
        headers: { cookie, 'idempotency-key': key },
        payload: { expectedVersion: version },
      });
    assert.equal((await remove('sites', 'pickup-a', 1, merchant)).statusCode, 403);
    assert.equal((await remove('couriers', 'courier-a')).json().code, 'ACTIVE_PARTNER_WORK');
    assert.equal((await remove('sites', 'site-a')).statusCode, 409);
    await db.query(
      "INSERT INTO sites(id,name,city,address,kind,merchant_id) VALUES('empty-store','متجر خال','دمشق','موقع تجريبي، دمشق','store','merchant-a')",
    );
    const quote = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: { authorization: 'Bearer remove-test', 'x-merchant-id': 'merchant-a' },
      payload: {
        externalReference: 'ARCHIVE-TEST',
        originId: 'empty-store',
        recipientName: 'عميل',
        destination: 'الروضة، دمشق',
        weightKg: 1,
      },
    });
    assert.equal(quote.statusCode, 200);
    assert.equal((await remove('sites', 'empty-store', 2)).statusCode, 409);
    const archiveKey = randomUUID();
    assert.equal((await remove('sites', 'empty-store', 1, ops, archiveKey)).statusCode, 200);
    assert.equal((await remove('sites', 'empty-store', 1, ops, archiveKey)).json().archived, true);
    const oldQuote = await app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: {
        authorization: 'Bearer remove-test',
        'x-merchant-id': 'merchant-a',
        'idempotency-key': randomUUID(),
      },
      payload: { quoteId: quote.json().id },
    });
    assert.equal(oldQuote.statusCode, 409);
    assert.equal(oldQuote.json().code, 'ORIGIN_ARCHIVED');
    await db.query(
      "INSERT INTO couriers(id,name,vehicle,capacity_kg) VALUES('removable','مندوب للإزالة','دراجة نارية',12)",
    );
    const courierSession = (await login('removable')).cookie!;
    assert.equal((await remove('couriers', 'removable')).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: courierSession } })).statusCode,
      401,
    );
    assert.equal((await login('removable')).response.statusCode, 422);
    const pointSession = (await login('pickup-a')).cookie!;
    assert.equal((await remove('sites', 'pickup-a')).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: pointSession } })).statusCode,
      401,
    );
    const snapshot = (await app.inject({ url: '/api/bootstrap', headers: { cookie: ops } })).json();
    assert.equal(
      snapshot.sites.some((s: { id: string }) => ['pickup-a', 'empty-store'].includes(s.id)),
      false,
    );
    assert.equal(
      snapshot.couriers.some((c: { id: string }) => c.id === 'removable'),
      false,
    );
    const session = (await app.inject({ method: 'POST', url: '/api/storefront/session' })).json();
    assert.equal(
      session.pickupSites.some((s: { id: string }) => s.id === 'pickup-a'),
      false,
    );
    assert.equal((await db.query("SELECT id FROM sites WHERE id='pickup-a'")).rows.length, 1);
    assert.equal(
      (await db.query("SELECT id FROM shipments WHERE reference='SHP-1004'")).rows.length,
      1,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/network/pickup-sites/pickup-a',
          headers: { cookie: ops, 'idempotency-key': randomUUID() },
          payload: {
            expectedVersion: 2,
            name: 'نقطة مؤرشفة',
            address: 'الروضة، دمشق',
            enabled: true,
            capacityKg: 100,
            reason: 'اختبار منع إعادة التفعيل',
          },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
