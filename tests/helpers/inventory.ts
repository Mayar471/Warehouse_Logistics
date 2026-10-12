import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { openDatabase } from '../../server/db.js';
import { buildApp } from '../../server/app.js';
import type { Shipment } from '../../shared/contracts.js';
export async function fixture(path?: string) {
  const db = await openDatabase(path);
  let now = Date.now();
  const system = buildApp(db, {
    applicationKey: 'inventory-test',
    webhookKey: 'inventory-secret',
    demoMode: true,
    clock: () => now,
  });
  const app = system.app;
  const shop = (
    await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
  ).headers['set-cookie']!.toString().split(';')[0];
  const cookies: Record<string, string> = {};
  for (const accountId of ['ops', 'merchant-a', 'merchant-b', 'courier-b', 'pickup-a'])
    cookies[accountId] = (
      await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
    ).headers['set-cookie']!.toString().split(';')[0];
  const get = async (url: string, who = 'ops') =>
    app.inject({ url, headers: { cookie: cookies[who] } });
  const post = async (
    url: string,
    payload: Record<string, unknown>,
    who = 'ops',
    key = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: who === 'shop' ? shop : cookies[who], 'idempotency-key': key },
      payload,
    });
  async function checkout(items = [{ productId: 'bag', quantity: 1 }]) {
    const response = await post(
      '/api/storefront/checkouts',
      { items, recipientName: 'عميل المخزون', district: 'الروضة', address: 'عنوان اختبار واضح' },
      'shop',
    );
    assert.equal(response.statusCode, 200);
    return response.json();
  }
  const order = async (id: string) => post('/api/storefront/orders', { checkoutId: id }, 'shop');
  const stock = async (product = 'bag') =>
    (
      await db.query<{ on_hand: number; reserved: number; quarantine: number; version: number }>(
        "SELECT * FROM inventory_stock WHERE product_id=$1 AND merchant_id='merchant-a' AND site_id='site-a'",
        [product],
      )
    ).rows[0];
  const action = async (
    s: Shipment,
    action: string,
    who: string,
    extra: Record<string, unknown> = {},
  ) =>
    post(`/api/shipments/${s.id}/actions`, { action, expectedVersion: s.version, ...extra }, who);
  async function act(s: Shipment, a: string, who: string, extra: Record<string, unknown> = {}) {
    const r = await action(s, a, who, extra);
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as Shipment;
  }
  async function returned(items = [{ productId: 'bag', quantity: 3 }]) {
    let s = (await order((await checkout(items)).id)).json().shipment as Shipment;
    for (const [a, who] of [
      ['prepare', 'merchant-a'],
      ['assign', 'ops'],
      ['accept', 'courier-b'],
      ['handover_origin', 'merchant-a'],
      ['pickup', 'courier-b'],
      ['return', 'ops'],
      ['receive_return', 'ops'],
    ])
      s = await act(s, a, who, {
        ...(['assign', 'handover_origin'].includes(a) ? { courierId: 'courier-b' } : {}),
        ...(a === 'return' ? { reason: 'تعذر التسليم للعميل' } : {}),
      });
    return s;
  }
  const close = async () => {
    await app.close();
    await db.close();
  };
  return {
    db,
    app,
    system,
    cookies,
    shop,
    get,
    post,
    checkout,
    order,
    stock,
    action,
    act,
    returned,
    close,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
