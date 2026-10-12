import { fixture } from './inventory.js';
export async function locationFixture(path?: string) {
  const f = await fixture(path);
  const q = await f.checkout();
  let shipment = (await f.order(q.id)).json().shipment;
  for (const [action, who, extra] of [
    ['prepare', 'merchant-a', {}],
    ['assign', 'ops', { courierId: 'courier-b' }],
    ['accept', 'courier-b', {}],
    ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
    ['pickup', 'courier-b', {}],
    ['depart', 'courier-b', {}],
  ] as const)
    shipment = await f.act(shipment, action, who, extra);
  const base = `/api/shipments/${shipment.id}/location`;
  const start = (customerAllowed = true, key = crypto.randomUUID(), who = 'courier-b') =>
    f.post(
      base + '/sharing',
      { action: 'start', expectedVersion: shipment.version, consent: true, customerAllowed },
      who,
      key,
    );
  const point = (
    sessionId: string,
    sequence = 1,
    extra: Record<string, unknown> = {},
    who = 'courier-b',
  ) =>
    f.post(
      base + '/points',
      {
        sessionId,
        sequence,
        latitude: 33.5138,
        longitude: 36.2765,
        accuracy: 18,
        measuredAt: new Date(now()).toISOString(),
        ...extra,
      },
      who,
    );
  let clock = Date.now();
  f.setNow(clock);
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
    f.setNow(clock);
  };
  const view = (who = 'ops') => f.get(base, who);
  const customer = () =>
    f.app.inject({
      url: `/api/storefront/orders/${shipment.id}/location`,
      headers: { cookie: f.shop },
    });
  const stop = (sessionId: string, key = crypto.randomUUID(), who = 'courier-b') =>
    f.post(
      base + '/sharing',
      { action: 'stop', sessionId, reason: 'إيقاف المشاركة للاختبار' },
      who,
      key,
    );
  return { ...f, shipment, base, start, point, view, customer, stop, advance, now };
}
