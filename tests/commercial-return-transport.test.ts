import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { courierCapacity } from '../server/domain.js';

async function setup() {
  const f = await cashFixture();
  const { code } = await f.route();
  const delivery = await f.deliver(code);
  assert.equal(delivery.statusCode, 200, delivery.body);
  const path = `/api/storefront/orders/${f.shipment().id}/returns`;
  let r = (
    await f.post(
      path,
      {
        action: 'request',
        expectedShipmentVersion: delivery.json().version,
        reason: 'المنتج لا يناسب العميل ويريد إرجاعه',
      },
      'shop',
    )
  ).json();
  const action = async (
    name: string,
    who: string,
    extra: Record<string, unknown> = {},
    key = crypto.randomUUID(),
  ) => {
    const response = await f.post(
      `/api/commercial-returns/${r.id}/actions`,
      {
        action: name,
        expectedVersion: r.version,
        reference: 'محضر إرجاع 123',
        reason: 'تأكيد الإجراء الفعلي في تجربة الإرجاع',
        ...extra,
      },
      who,
      key,
    );
    if (response.statusCode === 200) r = response.json();
    return response;
  };
  assert.equal((await action('approve', 'merchant-a')).statusCode, 200);
  const handover = async () => {
    const response = await f.post(
      path,
      {
        action: 'handover',
        expectedReturnVersion: r.version,
        reason: 'سلمت جميع المنتجات فعليًا للمندوب المكلف',
      },
      'shop',
    );
    if (response.statusCode === 200) r = response.json();
    return response;
  };
  const assign = () =>
    action('assign', 'ops', {
      courierId: 'courier-b',
      collectionAddress: 'دمشق، الروضة، عنوان العميل المتفق عليه',
    });
  return {
    ...f,
    path,
    action,
    handover,
    assign,
    baseCapacity: await courierCapacity(f.db, 'courier-b'),
    current: () => r,
  };
}

test('commercial return has independent customer and courier custody, shared capacity, atomic quarantine and partial inspection without refunding cash', async () => {
  const f = await setup();
  try {
    const stock = await f.stock(),
      cash = (await f.view()).json();
    assert.equal((await f.assign()).statusCode, 200);
    assert.equal(await courierCapacity(f.db, 'courier-b'), f.baseCapacity + f.shipment().weightKg);
    assert.equal((await f.handover()).statusCode, 409);
    assert.equal((await f.action('receive', 'merchant-a')).statusCode, 409);
    assert.equal((await f.action('accept', 'courier-b')).statusCode, 200);
    assert.equal((await f.action('pickup', 'courier-b')).statusCode, 409);
    assert.equal((await f.handover()).statusCode, 200);
    assert.equal((await f.action('unassign', 'ops')).statusCode, 409);
    assert.equal(
      (
        await f.post(
          f.path,
          {
            action: 'cancel',
            expectedReturnVersion: f.current().version,
            reason: 'محاولة سحب بعد تسليم العهدة',
          },
          'shop',
        )
      ).statusCode,
      409,
    );
    assert.deepEqual(await f.stock(), stock);
    assert.equal((await f.action('pickup', 'courier-b')).statusCode, 200);
    assert.equal((await f.action('report', 'courier-b')).statusCode, 200);
    assert.equal(await courierCapacity(f.db, 'courier-b'), f.baseCapacity + f.shipment().weightKg);
    assert.equal((await f.action('receive', 'merchant-b')).statusCode, 404);
    const body = {
        action: 'receive',
        expectedVersion: f.current().version,
        reference: 'استلام كامل 123',
        reason: 'استلمت كامل المنتجات فعليًا في المنشأ',
      },
      key = crypto.randomUUID();
    const path = `/api/commercial-returns/${f.current().id}/actions`;
    const received = await f.post(path, body, 'merchant-a', key);
    assert.equal(received.statusCode, 200, received.body);
    assert.deepEqual((await f.post(path, body, 'merchant-a', key)).json(), received.json());
    assert.equal((await f.post(path, body, 'merchant-a')).statusCode, 409);
    assert.equal(await courierCapacity(f.db, 'courier-b'), f.baseCapacity);
    const returnedStock = await f.stock();
    assert.equal(returnedStock.on_hand, stock.on_hand + 2);
    assert.equal(returnedStock.quarantine, 2);
    assert.equal(returnedStock.on_hand - returnedStock.quarantine, stock.on_hand);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    const shipment = (await f.get(`/api/shipments/${f.shipment().id}`)).json().shipment;
    assert.equal(shipment.status, 'delivered');
    const inspection = await f.post(
      `/api/inventory/returns/${shipment.id}/inspect`,
      {
        expectedVersion: shipment.version,
        items: [{ productId: 'bag', restock: 1, discard: 1 }],
        reason: 'قطعة صالحة وقطعة تالفة بعد فحص فعلي',
      },
      'merchant-a',
    );
    assert.equal(inspection.statusCode, 200, inspection.body);
    assert.equal((await f.stock()).quarantine, 0);
    assert.equal((await f.get('/api/inventory/reconciliation')).json().exceptions, 0);
    assert.deepEqual((await f.view()).json(), cash);
  } finally {
    await f.close();
  }
});

test('return assignment expires without moving goods; concurrent capacity and customer cancellation are enforced', async () => {
  const f = await setup();
  try {
    await f.db.query('UPDATE couriers SET capacity_kg=$2 WHERE id=$1', ['courier-b', 0.1]);
    assert.equal((await f.assign()).statusCode, 409);
    await f.db.query('UPDATE couriers SET capacity_kg=30 WHERE id=$1', ['courier-b']);
    const competing = await Promise.all([f.assign(), f.assign()]);
    assert.deepEqual(competing.map((r) => r.statusCode).sort(), [200, 409]);
    f.advance(5 * 60_000 + 1);
    assert.equal((await f.action('accept', 'courier-b')).statusCode, 409);
    await f.system.sweepAssignments();
    assert.equal(await courierCapacity(f.db, 'courier-b'), f.baseCapacity);
    assert.equal((await f.get('/api/commercial-returns', 'courier-b')).json().total, 0);
    const row = (await f.get('/api/commercial-returns')).json().rows[0];
    const assigned = await f.post(
      `/api/commercial-returns/${row.id}/actions`,
      {
        action: 'assign',
        expectedVersion: row.version,
        courierId: 'courier-b',
        collectionAddress: 'دمشق، عنوان آخر متفق عليه مع العميل',
        reference: 'إسناد جديد 123',
        reason: 'إعادة الإسناد بعد انتهاء المهلة',
      },
      'ops',
    );
    assert.equal(assigned.statusCode, 200, assigned.body);
    const cancel = await f.post(
      f.path,
      {
        action: 'cancel',
        expectedReturnVersion: assigned.json().version,
        reason: 'قررت الاحتفاظ بالمنتجات قبل تسليمها',
      },
      'shop',
    );
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(await courierCapacity(f.db, 'courier-b'), f.baseCapacity);
    assert.equal((await f.stock()).quarantine, 0);
  } finally {
    await f.close();
  }
});

test('failed return receipt outbox rolls back custody, stock, audit and replay result together', async () => {
  const f = await setup();
  try {
    await f.assign();
    await f.action('accept', 'courier-b');
    await f.handover();
    await f.action('pickup', 'courier-b');
    const stock = await f.stock(),
      id = f.current().id;
    const before = (await f.db.query('SELECT * FROM commercial_return_events')).rows.length;
    await f.db.exec(
      "CREATE FUNCTION reject_return_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_return_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_return_outbox();",
    );
    const body = {
        action: 'receive',
        expectedVersion: f.current().version,
        reference: 'استلام كامل 123',
        reason: 'استلام جميع المنتجات فعليًا في المنشأ',
      },
      key = crypto.randomUUID();
    assert.equal(
      (await f.post(`/api/commercial-returns/${id}/actions`, body, 'merchant-a', key)).statusCode,
      500,
    );
    assert.deepEqual(await f.stock(), stock);
    assert.equal((await f.db.query('SELECT * FROM commercial_return_events')).rows.length, before);
    assert.equal((await f.get('/api/commercial-returns')).json().rows[0].status, 'in_transit');
    await f.db.exec(
      'DROP TRIGGER reject_return_outbox ON outbox; DROP FUNCTION reject_return_outbox();',
    );
    assert.equal(
      (await f.post(`/api/commercial-returns/${id}/actions`, body, 'merchant-a', key)).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
