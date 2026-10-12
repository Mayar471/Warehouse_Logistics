import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';

test('commercial return request and merchant review preserve delivery, stock and cash; ownership, replay and withdrawal are enforced', async () => {
  const f = await cashFixture();
  try {
    const path = `/api/storefront/orders/${f.shipment().id}/returns`;
    const request = {
      action: 'request',
      expectedShipmentVersion: f.shipment().version,
      reason: 'المنتج لا يناسب احتياج العميل',
    };
    assert.equal((await f.post(path, request, 'shop')).statusCode, 409);
    const { code } = await f.route();
    const delivered = await f.deliver(code);
    assert.equal(delivered.statusCode, 200, delivered.body);
    request.expectedShipmentVersion = delivered.json().version;
    const before = await f.stock(),
      cash = (await f.view()).json();
    assert.equal((await f.post(path, request, 'merchant-a')).statusCode, 401);
    const key = crypto.randomUUID();
    const response = await f.post(path, request, 'shop', key);
    assert.equal(response.statusCode, 200, response.body);
    const r = response.json();
    assert.deepEqual((await f.post(path, request, 'shop', key)).json(), r);
    assert.equal((await f.post(path, request, 'shop')).statusCode, 409);
    assert.equal((await f.get('/api/commercial-returns', 'merchant-b')).json().total, 0);
    const actionPath = `/api/commercial-returns/${r.id}/actions`;
    const review = {
      action: 'approve',
      expectedVersion: r.version,
      reference: 'مراجعة 123',
      reason: 'قبول الطلب لتنظيم استلام البضاعة',
    };
    assert.equal((await f.post(actionPath, review, 'merchant-b')).statusCode, 404);
    assert.equal((await f.post(actionPath, review, 'ops')).statusCode, 403);
    const reviewKey = crypto.randomUUID();
    const approved = await f.post(actionPath, review, 'merchant-a', reviewKey);
    assert.equal(approved.statusCode, 200, approved.body);
    assert.deepEqual(
      (await f.post(actionPath, review, 'merchant-a', reviewKey)).json(),
      approved.json(),
    );
    assert.equal((await f.post(actionPath, review, 'merchant-a')).statusCode, 409);
    const orders = await f.app.inject({
      url: '/api/storefront/orders',
      headers: { cookie: f.shop },
    });
    assert.equal(
      orders
        .json()
        .orders.find((o: { shipment: { id: string } }) => o.shipment.id === f.shipment().id)
        .commercialReturn.status,
      'approved',
    );
    const cancelled = await f.post(
      path,
      {
        action: 'cancel',
        expectedReturnVersion: approved.json().version,
        reason: 'العميل قرر الاحتفاظ بالمنتج',
      },
      'shop',
    );
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(await f.stock(), before);
    assert.deepEqual((await f.view()).json(), cash);
    assert.equal(
      (await f.get(`/api/shipments/${f.shipment().id}`)).json().shipment.status,
      'delivered',
    );
    assert.equal((await f.db.query('SELECT * FROM commercial_return_events')).rows.length, 3);
    await assert.rejects(f.db.exec("UPDATE commercial_return_events SET reason='عبث'"));
  } finally {
    await f.close();
  }
});

test('commercial return audit failure rolls back request and idempotency; snapshots cannot be changed', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route();
    const delivered = await f.deliver(code);
    const path = `/api/storefront/orders/${f.shipment().id}/returns`;
    const body = {
        action: 'request',
        expectedShipmentVersion: delivered.json().version,
        reason: 'طلب إرجاع بسبب مشكلة في المنتج',
      },
      key = crypto.randomUUID();
    await f.db.exec(
      "CREATE FUNCTION reject_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_return_audit BEFORE INSERT ON commercial_return_events FOR EACH ROW EXECUTE FUNCTION reject_return_audit();",
    );
    assert.equal((await f.post(path, body, 'shop', key)).statusCode, 500);
    assert.equal((await f.db.query('SELECT * FROM commercial_returns')).rows.length, 0);
    await f.db.exec(
      'DROP TRIGGER reject_return_audit ON commercial_return_events; DROP FUNCTION reject_return_audit();',
    );
    const response = await f.post(path, body, 'shop', key);
    assert.equal(response.statusCode, 200, response.body);
    await assert.rejects(
      f.db.exec('UPDATE commercial_returns SET goods_minor=goods_minor+1,version=version+1'),
    );
    await assert.rejects(f.db.exec('DELETE FROM commercial_returns'));
  } finally {
    await f.close();
  }
});
