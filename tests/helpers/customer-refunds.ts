import assert from 'node:assert/strict';
import { cashFixture } from './cash.js';
export async function refundFixture(path?: string) {
  const f = await cashFixture(false, path);
  const { code } = await f.route();
  const delivered = await f.deliver(code);
  const source = f.shipment().id;
  let r = (
    await f.post(
      `/api/storefront/orders/${source}/returns`,
      {
        action: 'request',
        expectedShipmentVersion: delivered.json().version,
        reason: 'العميل يريد إرجاع كامل المنتجات',
      },
      'shop',
    )
  ).json();
  for (const [action, who, extra] of [
    ['approve', 'merchant-a', {}],
    [
      'assign',
      'ops',
      { courierId: 'courier-b', collectionAddress: 'دمشق، عنوان العميل المتفق عليه' },
    ],
    ['accept', 'courier-b', {}],
  ] as const) {
    const response = await f.post(
      `/api/commercial-returns/${r.id}/actions`,
      {
        action,
        expectedVersion: r.version,
        reference: 'محضر إرجاع 123',
        reason: 'تنفيذ الإرجاع الفعلي لكامل المنتجات',
        ...extra,
      },
      who,
    );
    assert.equal(response.statusCode, 200, response.body);
    r = response.json();
  }
  r = (
    await f.post(
      `/api/storefront/orders/${source}/returns`,
      {
        action: 'handover',
        expectedReturnVersion: r.version,
        reason: 'سلمت كامل المنتجات للمندوب المكلف',
      },
      'shop',
    )
  ).json();
  for (const [action, who] of [
    ['pickup', 'courier-b'],
    ['receive', 'merchant-a'],
  ] as const) {
    const response = await f.post(
      `/api/commercial-returns/${r.id}/actions`,
      {
        action,
        expectedVersion: r.version,
        reference: 'محضر استلام 123',
        reason: 'استلمت المنتجات كاملة فعليًا',
      },
      who,
    );
    assert.equal(response.statusCode, 200, response.body);
    r = response.json();
  }
  const inspect = async () => {
    const shipment = (await f.get(`/api/shipments/${source}`)).json().shipment;
    const inspected = await f.post(
      `/api/inventory/returns/${source}/inspect`,
      {
        expectedVersion: shipment.version,
        items: [{ productId: 'bag', restock: 1, discard: 1 }],
        reason: 'فحص فعلي لقطعة صالحة وقطعة تالفة',
      },
      'merchant-a',
    );
    if (inspected.statusCode === 200) {
      const reply = await f.post(
        `/api/commercial-returns/${r.id}/actions`,
        {
          action: 'reply',
          expectedVersion: r.version,
          reference: 'رد بعد الفحص',
          reply: 'بعد الفحص نقبل رد قيمة البضائع كاملة للعميل',
        },
        'merchant-a',
      );
      assert.equal(reply.statusCode, 200, reply.body);
      Object.assign(r, reply.json());
    }
    return inspected;
  };
  const refundBody = (
    action: string,
    version: number,
    amount = f.shipment().collection.goodsMinor,
  ) => ({
    action,
    expectedVersion: version,
    amountMinor: amount,
    currency: 'SYP',
    reference: 'إيصال رد 123',
    reason: 'إقرار فعلي بمبلغ رد العميل كاملًا',
  });
  const refund = (action: string, version: number, who = 'ops', key = crypto.randomUUID()) =>
    f.post(`/api/refunds/${r.id}/actions`, refundBody(action, version), who, key);
  const client = (
    action: string,
    version: number,
    amount = f.shipment().collection.goodsMinor,
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/storefront/orders/${source}/refund`,
      refundBody(action, version, amount),
      'shop',
      key,
    );
  return {
    ...f,
    returnCase: r,
    inspect,
    fund: async () => f.receipt(await f.row()),
    refund,
    client,
    refundBody,
  };
}
