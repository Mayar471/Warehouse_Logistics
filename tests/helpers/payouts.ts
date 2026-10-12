import assert from 'node:assert/strict';
import { cashFixture } from './cash.js';
export async function payoutFixture(path?: string) {
  const f = await cashFixture(false, path);
  async function fund() {
    const { code } = await f.route();
    assert.equal((await f.deliver(code)).statusCode, 200);
    const r = await f.row();
    assert.equal((await f.receipt(r)).statusCode, 200);
  }
  const view = (who = 'ops') => f.get('/api/payouts', who);
  const create = async (key = crypto.randomUUID(), who = 'ops') =>
    f.post(
      '/api/payouts',
      {
        shipmentId: f.shipment().id,
        expectedCollectionVersion: (await f.row()).version,
        reference: 'حجز صرف ١٠١',
        reason: 'إعداد صرف قيمة بضائع المتجر',
      },
      who,
      key,
    );
  const action = (
    p: { id: string; version: number },
    action: string,
    who = 'ops',
    extra: Record<string, unknown> = {},
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/payouts/${p.id}/actions`,
      {
        action,
        expectedVersion: p.version,
        reference: 'محضر صرف ١٠٢',
        reason: 'إقرار موثق في تجربة الصرف',
        ...(action === 'cancel'
          ? {}
          : { amountMinor: f.shipment().collection.goodsMinor, currency: 'SYP' }),
        ...extra,
      },
      who,
      key,
    );
  return { ...f, fund, view, create, action };
}
