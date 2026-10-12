import assert from 'node:assert/strict';
import { fixture } from './inventory.js';
export async function cashFixture(pickup = false, path?: string) {
  const f = await fixture(path);
  const r = await f.post(
    '/api/storefront/checkouts',
    {
      items: [{ productId: 'bag', quantity: 2 }],
      paymentMode: 'cod',
      recipientName: 'عميل النقد التجريبي',
      district: 'الروضة',
      address: 'عنوان اختبار نقدي في دمشق',
      ...(pickup ? { pickupSiteId: 'pickup-a' } : {}),
    },
    'shop',
  );
  assert.equal(r.statusCode, 200, r.body);
  const checkout = r.json();
  let shipment = (await f.order(checkout.id)).json().shipment;
  const route = async () => {
    for (const [action, who, extra] of [
      ['prepare', 'merchant-a', {}],
      ['assign', 'ops', { courierId: 'courier-b' }],
      ['accept', 'courier-b', {}],
      ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
      ['pickup', 'courier-b', {}],
      ['depart', 'courier-b', {}],
      ...(pickup
        ? [
            ['arrive_pickup', 'courier-b', {}],
            ['receive_pickup', 'pickup-a', {}],
          ]
        : []),
    ] as [string, string, Record<string, unknown>][])
      shipment = await f.act(shipment, action, who, extra);
    const code = (
      await f.post(`/api/storefront/orders/${shipment.id}/delivery-code`, {}, 'shop')
    ).json().code;
    return { code, shipment };
  };
  const receipt = (
    row: { version: number },
    action = 'receive',
    amountMinor = shipment.collection.totalMinor,
    who = 'ops',
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/cash/${shipment.id}/actions`,
      {
        action,
        expectedVersion: row.version,
        amountMinor,
        currency: 'SYP',
        reference: 'محضر نقد ١٠١',
        reason: 'عد فعلي موثق في تجربة التحصيل',
      },
      who,
      key,
    );
  const view = (who = 'ops') => f.get('/api/cash', who);
  const row = async () =>
    (await view()).json().rows.find((r: { shipmentId: string }) => r.shipmentId === shipment.id);
  const deliver = async (
    code: string,
    cash: Record<string, unknown> | undefined = {
      amountMinor: shipment.collection.totalMinor,
      currency: 'SYP',
      reference: 'إقرار تحصيل ١٠١',
    },
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/shipments/${shipment.id}/actions`,
      {
        action: pickup ? 'release_pickup' : 'deliver',
        expectedVersion: shipment.version,
        deliveryCode: code,
        ...(cash ? { cash } : {}),
      },
      pickup ? 'pickup-a' : 'courier-b',
      key,
    );
  return { ...f, checkout, route, receipt, view, row, deliver, shipment: () => shipment };
}
