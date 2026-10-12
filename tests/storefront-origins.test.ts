import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/inventory.js';
type F = Awaited<ReturnType<typeof fixture>>;
async function warehouse(f: F, merchantId = 'merchant-a') {
  const r = await f.post('/api/inventory/sites', {
    merchantId,
    name: 'مستودع السلة',
    address: 'عنوان مستقل في دمشق',
    products: ['bag', 'cup'],
    reason: 'اختبار منشأ تنفيذ الطلب',
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id as string;
  for (const productId of ['bag', 'cup']) {
    const receipt = await f.post('/api/inventory/receipts', {
      merchantId,
      siteId: id,
      productId,
      quantity: 4,
      expectedVersion: 1,
      reason: 'استلام فعلي للاختبار',
    });
    assert.equal(receipt.statusCode, 200, receipt.body);
  }
  return id;
}
async function count(f: F, productId: string, counted: number) {
  const s = await f.stock(productId);
  const r = await f.post('/api/inventory/counts', {
    merchantId: 'merchant-a',
    siteId: 'site-a',
    productId,
    counted,
    expectedVersion: s.version,
    reason: 'جرد متسق لاختبار التنفيذ',
  });
  assert.equal(r.statusCode, 200, r.body);
}
const basket = [
  { productId: 'bag', quantity: 2 },
  { productId: 'cup', quantity: 2 },
];
async function attempt(f: F, items = basket, extra = {}) {
  return f.post(
    '/api/storefront/checkouts',
    {
      items,
      recipientName: 'عميل تجربة',
      district: 'الروضة',
      address: 'عنوان تجربة واضح',
      ...extra,
    },
    'shop',
  );
}
test('whole basket selects an owned warehouse, pins origin, replays once and survives competing stock changes', async () => {
  const f = await fixture();
  try {
    const id = await warehouse(f);
    await count(f, 'bag', 0);
    const q = await f.checkout(basket);
    assert.equal(q.fulfillmentOrigin.id, id);
    await count(f, 'bag', 30);
    const [a, b] = await Promise.all([f.order(q.id), f.order(q.id)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().shipment.originId, id);
    assert.equal(a.json().shipment.id, b.json().shipment.id);
    assert.equal((await f.stock()).reserved, 0);
    const balances = (
      await f.db.query<{ reserved: number }>(
        'SELECT reserved FROM inventory_stock WHERE site_id=$1',
        [id],
      )
    ).rows;
    assert.ok(balances.every((s) => s.reserved === 2));
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    await count(f, 'bag', 0);
    const pending = await f.checkout(basket);
    const winner = await f.checkout(basket);
    assert.equal((await f.order(winner.id)).statusCode, 200);
    const lost = await f.order(pending.id);
    assert.equal(lost.statusCode, 409);
    assert.equal(lost.json().code, 'OUT_OF_STOCK');
    assert.equal(
      (
        await f.db.query(
          'SELECT shipment_id FROM inventory_reservations WHERE shipment_id=(SELECT shipment_id FROM storefront_checkouts WHERE id=$1)',
          [pending.id],
        )
      ).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});
test('individual availability is a maximum, never a sum; split baskets, foreign owners and outside coverage are excluded', async () => {
  const f = await fixture();
  try {
    const id = await warehouse(f);
    await warehouse(f, 'merchant-b');
    await count(f, 'bag', 0);
    await f.db.query("UPDATE sites SET city='حلب' WHERE id=$1", [id]);
    assert.equal((await attempt(f)).json().code, 'NO_FULFILLMENT_ORIGIN');
    await f.db.query("UPDATE sites SET city='دمشق' WHERE id=$1", [id]);
    const r = await f.post('/api/inventory/counts', {
      merchantId: 'merchant-a',
      siteId: id,
      productId: 'cup',
      counted: 0,
      expectedVersion: 2,
      reason: 'تجربة سلة موزعة بين موقعين',
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await attempt(f)).statusCode, 409);
    const available = (
      await f.app.inject({ url: '/api/storefront/availability', headers: { cookie: f.shop } })
    ).json().availability;
    assert.equal(available.find((s: { productId: string }) => s.productId === 'bag').available, 4);
    assert.equal(available.find((s: { productId: string }) => s.productId === 'cup').available, 30);
    assert.equal((await attempt(f, [{ productId: 'bag', quantity: 5 }])).statusCode, 409);
    assert.equal((await f.db.query('SELECT * FROM storefront_checkouts')).rows.length, 0);
  } finally {
    await f.close();
  }
});
test('damaged balances cannot execute and quote plus checkout roll back together on storage failure', async () => {
  const f = await fixture();
  try {
    const id = await warehouse(f);
    await f.db.query(
      "UPDATE inventory_stock SET on_hand=on_hand+1 WHERE site_id='site-a' AND product_id='bag'",
    );
    const q = await f.checkout(basket);
    assert.equal(q.fulfillmentOrigin.id, id);
    await f.db.query('UPDATE inventory_stock SET on_hand=on_hand+1 WHERE site_id=$1', [id]);
    assert.equal((await f.order(q.id)).json().code, 'INVENTORY_INCONSISTENT');
    assert.equal((await attempt(f)).statusCode, 409);
    await f.db.query(
      "UPDATE inventory_stock SET on_hand=on_hand-1 WHERE site_id='site-a' AND product_id='bag'",
    );
    await f.db.exec(
      "CREATE FUNCTION reject_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$; CREATE TRIGGER reject_checkout BEFORE INSERT ON storefront_checkouts FOR EACH ROW EXECUTE FUNCTION reject_checkout();",
    );
    const before = (await f.db.query('SELECT id FROM quotes')).rows.length;
    assert.equal((await attempt(f)).statusCode, 500);
    assert.equal((await f.db.query('SELECT id FROM quotes')).rows.length, before);
  } finally {
    await f.close();
  }
});
