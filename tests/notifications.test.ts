import test from 'node:test';
import assert from 'node:assert/strict';
import { refundFixture } from './helpers/customer-refunds.js';
import type { NotificationFeed } from '../shared/notifications.js';

test('notifications respect roles and customer ownership, persist reads, and expose fresh versions after merchant reply', async () => {
  const f = await refundFixture();
  try {
    const read = async (who: string, customer = false) => {
      const r = await f.app.inject({
        url: customer ? '/api/storefront/notifications' : '/api/notifications',
        headers: { cookie: who === 'shop' ? f.shop : f.cookies[who] },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json<NotificationFeed>();
    };
    const merchant = await read('merchant-a');
    assert(
      merchant.items.some(
        (n) => n.kind === 'return' && n.targetId === f.returnCase.id && n.actionRequired,
      ),
    );
    const foreign = await read('merchant-b');
    assert(
      !foreign.items.some((n) => n.targetId === f.returnCase.id || n.targetId === f.shipment().id),
    );
    const courier = await read('courier-b');
    assert(courier.items.some((n) => n.kind === 'return' && n.targetId === f.returnCase.id));
    const point = await read('pickup-a');
    assert(
      !point.items.some((n) => n.kind === 'return' || n.kind === 'payout' || n.kind === 'transfer'),
    );
    const customer = await read('shop', true);
    assert(customer.items.some((n) => n.kind === 'return' && n.targetId === f.returnCase.id));
    assert(customer.items.every((n) => n.page === 'orders'));
    const id = customer.items.find((n) => n.kind === 'return')!.id;
    assert.equal(
      (await f.post('/api/storefront/notifications/read', { ids: [id] }, 'shop')).statusCode,
      200,
    );
    assert((await read('shop', true)).items.find((n) => n.id === id)!.read);
    assert(!(await read('ops')).items.find((n) => n.id === id)!.read);
    assert.equal(
      (await f.post('/api/notifications/read', { ids: [id] }, 'merchant-b')).statusCode,
      404,
    );
    assert.equal((await f.inspect()).statusCode, 200);
    const updated = await read('shop', true);
    const reply = updated.items.find((n) => n.kind === 'return')!;
    assert.notEqual(reply.id, id);
    assert.equal(reply.read, false);
    assert.equal(reply.title, 'وصل رد المتجر بعد الفحص');
    assert.equal(
      (await f.app.inject({ url: '/api/notifications', headers: { cookie: f.shop } })).statusCode,
      401,
    );
    const fresh = await f.app.inject({ method: 'POST', url: '/api/storefront/session' });
    const empty = await f.app.inject({
      url: '/api/storefront/notifications',
      headers: { cookie: fresh.headers['set-cookie']!.toString().split(';')[0] },
    });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().items, []);
  } finally {
    await f.app.close();
    await f.db.close();
  }
});
