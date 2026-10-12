import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/inventory.js';
const siteBody = (name = 'مستودع التجربة', merchantId = 'merchant-a') => ({
  merchantId,
  name,
  address: 'عنوان المستودع التجريبي في دمشق',
  products: ['bag'],
  reason: 'إضافة موقع تخزين فعلي للتجربة',
});
async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  name = 'مستودع التجربة',
  merchantId = 'merchant-a',
) {
  const r = await f.post('/api/inventory/sites', siteBody(name, merchantId));
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { id: string; version: number };
}
test('sites start at zero, enforce owners and strict products, and replay creation without duplicate balances', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const body = siteBody();
    const r = await f.post('/api/inventory/sites', body, 'merchant-a', key);
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    assert.deepEqual(
      (await f.post('/api/inventory/sites', body, 'merchant-a', key)).json(),
      r.json(),
    );
    assert.equal((await f.get(`/api/inventory?siteId=${id}`)).json().stocks[0].onHand, 0);
    assert.equal((await f.get(`/api/inventory/reconciliation?siteId=${id}`)).json().exceptions, 0);
    assert.equal(
      (await f.db.query('SELECT * FROM inventory_movements WHERE site_id=$1', [id])).rows.length,
      0,
    );
    assert.equal((await f.post('/api/inventory/sites', body)).statusCode, 409);
    assert.equal(
      (
        await f.post(
          '/api/inventory/sites',
          { ...body, name: 'آخر', merchantId: 'merchant-b' },
          'merchant-a',
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await f.post('/api/inventory/sites', { ...body, name: 'آخر', products: ['bag', 'bag'] }))
        .statusCode,
      422,
    );
    assert.equal(
      (await f.post('/api/inventory/sites', { ...body, name: 'آخر', products: ['unknown'] }))
        .statusCode,
      422,
    );
    assert.equal(
      (await f.post('/api/inventory/sites', { ...body, name: 'آخر', onHand: 50 })).statusCode,
      422,
    );
    for (const who of ['courier-b', 'pickup-a']) {
      assert.equal((await f.get('/api/inventory/sites', who)).statusCode, 403);
      assert.equal((await f.post('/api/inventory/sites', body, who)).statusCode, 403);
    }
    await assert.rejects(
      f.db.query(
        "INSERT INTO inventory_stock(merchant_id,site_id,product_id) VALUES('merchant-a','site-b','bag')",
      ),
      (e: unknown) => (e as { code: string }).code === '23503',
    );
    assert.equal(
      (
        await f.post('/api/inventory/sites/pickup-a/products', {
          products: ['bag'],
          expectedVersion: 1,
          reason: 'ربط منتج بالخطأ',
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.post(
          '/api/inventory/sites/site-b/products',
          { products: ['bag'], expectedVersion: 1, reason: 'ربط منتج بالخطأ' },
          'merchant-a',
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
test('registering products is versioned and atomic and never changes a previously received balance', async () => {
  const f = await fixture();
  try {
    const site = await create(f);
    const body = { products: ['cup'], expectedVersion: 1, reason: 'ربط منتج جديد دون كمية' };
    const results = await Promise.all([
      f.post(`/api/inventory/sites/${site.id}/products`, body),
      f.post(`/api/inventory/sites/${site.id}/products`, { ...body, products: ['wallet'] }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const saved = results.find((r) => r.statusCode === 200)!.json();
    assert.equal(saved.version, 2);
    const received = await f.post('/api/inventory/receipts', {
      merchantId: 'merchant-a',
      siteId: site.id,
      productId: 'bag',
      expectedVersion: 1,
      quantity: 7,
      reason: 'استلام فعلي في المستودع',
    });
    assert.equal(received.statusCode, 200, received.body);
    const duplicate = await f.post(`/api/inventory/sites/${site.id}/products`, {
      products: ['lamp', 'bag'],
      expectedVersion: 2,
      reason: 'طلب يتضمن منتجًا مرتبطًا',
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const view = (await f.get(`/api/inventory?siteId=${site.id}`)).json();
    assert.equal(view.stocks.length, 2);
    assert.equal(
      view.stocks.some((s: { productId: string }) => s.productId === 'lamp'),
      false,
    );
    assert.equal(view.stocks.find((s: { productId: string }) => s.productId === 'bag').onHand, 7);
    assert.equal(
      (await f.get(`/api/inventory/reconciliation?siteId=${site.id}`)).json().exceptions,
      0,
    );
    const key = randomUUID();
    const register = {
      products: ['headphones'],
      expectedVersion: 2,
      reason: 'ربط منتج بعد الاستلام',
    };
    const first = await f.post(`/api/inventory/sites/${site.id}/products`, register, 'ops', key);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(
      (await f.post(`/api/inventory/sites/${site.id}/products`, register, 'ops', key)).json(),
      first.json(),
    );
  } finally {
    await f.close();
  }
});
test('site scopes isolate receipts, counts and returns while storefront reservations stay at the actual fulfillment origin', async () => {
  const f = await fixture();
  try {
    const site = await create(f);
    await f.post('/api/inventory/receipts', {
      merchantId: 'merchant-a',
      siteId: site.id,
      productId: 'bag',
      quantity: 12,
      expectedVersion: 1,
      reason: 'استلام فعلي موثق',
    });
    const held = await f.order((await f.checkout([{ productId: 'bag', quantity: 2 }])).id);
    assert.equal(held.statusCode, 200, held.body);
    await f.returned();
    const scoped = (await f.get(`/api/inventory?siteId=${site.id}`)).json();
    assert.equal(scoped.totals.available, 12);
    assert.equal(scoped.totals.reserved, 0);
    assert.equal(scoped.returns.length, 0);
    assert.equal(scoped.movements.length, 1);
    assert.equal(scoped.movements[0].siteId, site.id);
    assert.equal((await f.stock()).reserved, 2);
    const count = await f.post('/api/inventory/counts', {
      merchantId: 'merchant-a',
      siteId: site.id,
      productId: 'bag',
      counted: 11,
      expectedVersion: 2,
      reason: 'جرد الموقع المستقل',
    });
    assert.equal(count.statusCode, 200, count.body);
    assert.equal((await f.get('/api/inventory/counts?siteId=site-a')).json().counts.length, 0);
    assert.equal((await f.get(`/api/inventory/counts?siteId=${site.id}`)).json().counts.length, 1);
    for (const endpoint of ['inventory', 'inventory/reconciliation', 'inventory/counts']) {
      assert.equal(
        (await f.get(`/api/${endpoint}?siteId=${site.id}`, 'merchant-b')).statusCode,
        404,
      );
      assert.equal((await f.get(`/api/${endpoint}?siteId=missing`)).statusCode, 404);
      assert.equal(
        (await f.get(`/api/${endpoint}?merchantId=merchant-b`, 'merchant-a')).statusCode,
        422,
      );
    }
    const other = await create(f, 'مستودع نواة', 'merchant-b');
    const merchants = (await f.get('/api/inventory/sites', 'merchant-b')).json();
    assert.equal(
      merchants.sites.every((s: { merchantId: string }) => s.merchantId === 'merchant-b'),
      true,
    );
    assert.equal(
      merchants.audit.every((a: { siteId: string }) => a.siteId === other.id),
      true,
    );
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    assert.equal((await f.app.inject({ url: '/api/storefront/availability' })).statusCode, 401);
    const available = await f.app.inject({
      url: '/api/storefront/availability',
      headers: { cookie: f.shop },
    });
    assert.equal(
      available.json().availability.find((p: { productId: string }) => p.productId === 'bag')
        .available,
      25,
    );
  } finally {
    await f.close();
  }
});
test('creation and product registration roll back on audit failure and enforce the local site limit', async () => {
  const f = await fixture();
  try {
    await f.db.exec(
      "CREATE FUNCTION fail_site_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit test'; END $$; CREATE TRIGGER fail_site_audit BEFORE INSERT ON network_audit FOR EACH ROW EXECUTE FUNCTION fail_site_audit();",
    );
    const key = randomUUID();
    assert.equal((await f.post('/api/inventory/sites', siteBody(), 'ops', key)).statusCode, 500);
    assert.equal((await f.db.query("SELECT id FROM sites WHERE kind='warehouse'")).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM inventory_stock')).rows.length, 6);
    assert.equal(
      (
        await f.post('/api/inventory/sites/site-b/products', {
          products: ['cup'],
          expectedVersion: 1,
          reason: 'فشل التدقيق للمنتجات',
        })
      ).statusCode,
      500,
    );
    assert.equal((await f.get('/api/inventory?siteId=site-b')).json().stocks.length, 0);
    await f.db.exec('DROP TRIGGER fail_site_audit ON network_audit');
    assert.equal((await f.post('/api/inventory/sites', siteBody(), 'ops', key)).statusCode, 200);
    await f.db.exec(
      "INSERT INTO sites(id,name,city,address,kind,merchant_id) SELECT 'limit-'||n,'موقع '||n,'دمشق','عنوان اختبار الحد','warehouse','merchant-a' FROM generate_series(1,48) n",
    );
    assert.equal(
      (await f.post('/api/inventory/sites', siteBody('فوق الحد'))).json().code,
      'SITE_LIMIT',
    );
  } finally {
    await f.close();
  }
});
test('stock totals cover every site beyond the display limit and selected sites remain fully visible', async () => {
  const f = await fixture();
  try {
    let last = '';
    for (let i = 0; i < 18; i++) {
      const r = await f.post('/api/inventory/sites', {
        ...siteBody(`مستودع ${i}`),
        products: ['bag', 'cup', 'wallet', 'lamp', 'headphones', 'watch'],
      });
      assert.equal(r.statusCode, 200, r.body);
      last = r.json().id;
    }
    await f.db.exec(
      "UPDATE inventory_stock SET on_hand=on_hand+1; INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) SELECT gen_random_uuid(),merchant_id,site_id,product_id,'receipt',1,'اختبار الإجماليات','استلام قطعة في كل رصيد' FROM inventory_stock;",
    );
    const all = (await f.get('/api/inventory')).json();
    assert.equal(all.stocks.length, 100);
    assert.equal(all.totals.stockTotal, 114);
    assert.equal(all.totals.available, 294);
    assert.equal((await f.get(`/api/inventory?siteId=${last}`)).json().stocks.length, 6);
    assert.equal(
      (await f.get(`/api/inventory/reconciliation?siteId=${last}`)).json().exceptions,
      0,
    );
  } finally {
    await f.close();
  }
});
test('site ownership, zero balances and registration audit survive restart without synthetic replenishment', async () => {
  const path = await mkdtemp(join(tmpdir(), 'inventory-sites-'));
  let f = await fixture(path);
  try {
    const site = await create(f);
    await f.post(`/api/inventory/sites/${site.id}/products`, {
      products: ['cup'],
      expectedVersion: 1,
      reason: 'ربط منتج قبل إعادة التشغيل',
    });
    await f.post('/api/inventory/receipts', {
      merchantId: 'merchant-a',
      siteId: site.id,
      productId: 'bag',
      quantity: 4,
      expectedVersion: 1,
      reason: 'استلام قبل إعادة التشغيل',
    });
    await f.close();
    f = await fixture(path);
    const view = (await f.get(`/api/inventory?siteId=${site.id}`)).json();
    assert.equal(view.stocks.find((s: { productId: string }) => s.productId === 'bag').onHand, 4);
    assert.equal(view.stocks.find((s: { productId: string }) => s.productId === 'cup').onHand, 0);
    assert.equal((await f.get('/api/inventory/sites')).json().audit.length, 2);
    assert.equal(
      (await f.db.query("SELECT id FROM inventory_movements WHERE kind='opening'")).rows.length,
      6,
    );
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
  } finally {
    await f.close();
    await rm(path, { recursive: true, force: true });
  }
});
