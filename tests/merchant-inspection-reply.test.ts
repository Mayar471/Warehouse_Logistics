import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';

test('client reason is written once; custody needs no repeated reason and final merchant reply requires full inspection, ownership and atomic audit', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route(),
      delivered = await f.deliver(code),
      source = f.shipment().id;
    const clientReason = 'أريد إرجاع المنتجات بسبب عدم ملاءمتها';
    let r = (
      await f.post(
        `/api/storefront/orders/${source}/returns`,
        {
          action: 'request',
          expectedShipmentVersion: delivered.json().version,
          reason: clientReason,
        },
        'shop',
      )
    ).json();
    const action = async (name: string, who: string, extra: Record<string, unknown> = {}) => {
      const result = await f.post(
        `/api/commercial-returns/${r.id}/actions`,
        { action: name, expectedVersion: r.version, reference: 'محضر 123', ...extra },
        who,
      );
      if (result.statusCode === 200) r = result.json();
      return result;
    };
    for (const [name, who, extra] of [
      ['approve', 'merchant-a', {}],
      [
        'assign',
        'ops',
        { courierId: 'courier-b', collectionAddress: 'دمشق، عنوان العميل المتفق عليه' },
      ],
      ['accept', 'courier-b', {}],
    ] as const) {
      const result = await action(name, who, extra);
      assert.equal(result.statusCode, 200, result.body);
    }
    const handover = await f.post(
      `/api/storefront/orders/${source}/returns`,
      { action: 'handover', expectedReturnVersion: r.version },
      'shop',
    );
    assert.equal(handover.statusCode, 200, handover.body);
    r = handover.json();
    assert.equal((await action('pickup', 'courier-b')).statusCode, 200);
    assert.equal((await action('report', 'courier-b')).statusCode, 422);
    assert.equal((await action('receive', 'merchant-a')).statusCode, 200);
    assert.equal(
      (await action('reply', 'merchant-a', { reply: 'بعد الفحص نقبل الإرجاع' })).statusCode,
      409,
    );
    const inspect = async (restock: number, discard: number) => {
      const shipment = (await f.get(`/api/shipments/${source}`)).json().shipment;
      const result = await f.post(
        `/api/inventory/returns/${source}/inspect`,
        {
          expectedVersion: shipment.version,
          items: [{ productId: 'bag', restock, discard }],
          reason: 'فحص حالة القطع المستلمة فعليًا',
        },
        'merchant-a',
      );
      assert.equal(result.statusCode, 200, result.body);
    };
    await inspect(1, 0);
    assert.equal(
      (await action('reply', 'merchant-a', { reply: 'نتيجة الفحص قبل اكتماله' })).statusCode,
      409,
    );
    await inspect(0, 1);
    assert.equal(
      (await action('reply', 'ops', { reply: 'محاولة رد من دور غير مخول' })).statusCode,
      403,
    );
    assert.equal(
      (await action('reply', 'merchant-b', { reply: 'محاولة رد من متجر آخر' })).statusCode,
      404,
    );
    const reply = 'بعد الفحص نقبل رد قيمة البضائع كاملة',
      body = { action: 'reply', expectedVersion: r.version, reference: 'رد بعد الفحص', reply },
      key = crypto.randomUUID(),
      url = `/api/commercial-returns/${r.id}/actions`;
    await f.db.exec(
      "CREATE FUNCTION reject_reply_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='reply' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reply_audit BEFORE INSERT ON commercial_return_events FOR EACH ROW EXECUTE FUNCTION reject_reply_audit();",
    );
    assert.equal((await f.post(url, body, 'merchant-a', key)).statusCode, 500);
    assert.equal(
      (await f.get(`/api/commercial-returns?returnId=${r.id}`)).json().rows[0].inspectionReply,
      null,
    );
    await f.db.exec(
      'DROP TRIGGER reject_reply_audit ON commercial_return_events; DROP FUNCTION reject_reply_audit();',
    );
    const result = await f.post(url, body, 'merchant-a', key);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual((await f.post(url, body, 'merchant-a', key)).json(), result.json());
    assert.equal(
      (
        await f.post(
          url,
          { ...body, expectedVersion: result.json().version, reply: 'محاولة تعديل الرد المحفوظ' },
          'merchant-a',
        )
      ).statusCode,
      409,
    );
    const order = (
      await f.app.inject({ url: '/api/storefront/orders', headers: { cookie: f.shop } })
    )
      .json()
      .orders.find((o: { shipment: { id: string } }) => o.shipment.id === source);
    assert.equal(order.commercialReturn.reason, clientReason);
    assert.equal(order.commercialReturn.inspectionReply, reply);
    assert.equal(
      (await f.db.query("SELECT * FROM commercial_return_events WHERE action='reply'")).rows.length,
      1,
    );
    await assert.rejects(
      f.db.exec("UPDATE commercial_returns SET reason='سبب مزيف',version=version+1"),
    );
  } finally {
    await f.close();
  }
});
