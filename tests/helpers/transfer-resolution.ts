import assert from 'node:assert/strict';
import { fixture } from './inventory.js';
export async function transferFixture(path?: string) {
  const f = await fixture(path);
  const r = await f.post('/api/inventory/sites', {
    merchantId: 'merchant-a',
    name: 'مستودع الفحص',
    address: 'عنوان وجهة اختبار في دمشق',
    products: ['bag', 'cup'],
    reason: 'إعداد وجهة تسوية النقل',
  });
  assert.equal(r.statusCode, 200, r.body);
  const site = r.json().id as string;
  const created = await f.post('/api/inventory/transfers', {
    merchantId: 'merchant-a',
    sourceId: 'site-a',
    destinationId: site,
    items: [
      { productId: 'bag', quantity: 5, sourceVersion: (await f.stock()).version },
      { productId: 'cup', quantity: 4, sourceVersion: (await f.stock('cup')).version },
    ],
    reason: 'اختبار تسوية نقل متعدد المنتجات',
  });
  assert.equal(created.statusCode, 200, created.body);
  type Command = { id: string; version: number; status: string };
  let t = created.json() as Command;
  const action = (
    command: Command,
    action: string,
    extra: Record<string, unknown> = {},
    who = 'ops',
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/inventory/transfers/${command.id}/actions`,
      { action, expectedVersion: command.version, reason: 'إجراء موثق لاختبار العهدة', ...extra },
      who,
      key,
    );
  async function act(actionName: string, extra: Record<string, unknown> = {}, who = 'ops') {
    const r = await action(t, actionName, extra, who);
    assert.equal(r.statusCode, 200, r.body);
    t = r.json();
    return t;
  }
  const transit = async () => {
    await act('assign', { courierId: 'courier-b' });
    await act('accept', {}, 'courier-b');
    await act('release', {}, 'merchant-a');
    await act('pickup', {}, 'courier-b');
  };
  const stockAt = async (product = 'bag') =>
    (await f.get('/api/inventory?siteId=' + site))
      .json()
      .stocks.find((s: { productId: string }) => s.productId === product);
  const detail = async () => (await f.get('/api/inventory/transfers/' + t.id)).json();
  return { ...f, site, action, act, transit, stockAt, detail, current: () => t };
}
