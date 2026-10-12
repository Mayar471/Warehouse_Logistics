import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { catalog } from '../shared/catalog.js';
import { parseCashAmount } from '../shared/cash.js';
test('server priced COD delivery creates balanced custody and goods liabilities atomically, and operations receipt remains independent and single', async () => {
  const f = await cashFixture();
  try {
    assert.equal(parseCashAmount('١٬٢٣٤٫٥٠'), 123450);
    assert.equal(parseCashAmount('1.01'), 101);
    assert.ok(Number.isNaN(parseCashAmount('1e3')));
    assert.ok(Number.isNaN(parseCashAmount('1,23')));
    const expected = catalog[0].priceMinor * 2 + f.checkout.quote.feeMinor;
    assert.equal(f.shipment().collection.totalMinor, expected);
    assert.equal((await f.view()).json().heldMinor, 0);
    const { code } = await f.route();
    const key = crypto.randomUUID();
    const body = { amountMinor: expected, currency: 'SYP', reference: 'تحصيل اختباري' };
    const [a, b] = await Promise.all([f.deliver(code, body, key), f.deliver(code, body, key)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().status, 'delivered');
    assert.equal(a.json().collection.status, 'collected');
    let view = (await f.view()).json();
    assert.equal(view.heldMinor, expected);
    assert.equal(view.receivedMinor, 0);
    assert.equal(view.goodsLiabilityMinor, catalog[0].priceMinor * 2);
    assert.equal(view.consistent, true);
    assert.equal((await f.view('merchant-b')).json().total, 0);
    assert.equal((await f.view('courier-b')).json().heldMinor, expected);
    const row = await f.row();
    assert.equal((await f.receipt(row, 'receive', expected, 'courier-b')).statusCode, 403);
    assert.equal((await f.receipt(row, 'receive', expected, 'merchant-a')).statusCode, 403);
    const results = await Promise.all([f.receipt(row), f.receipt(row)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    view = (await f.view()).json();
    assert.equal(view.heldMinor, 0);
    assert.equal(view.receivedMinor, expected);
    assert.equal(view.goodsLiabilityMinor, catalog[0].priceMinor * 2);
    assert.equal(view.consistent, true);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 2);
    const balance = (
      await f.db.query<{ sum: string }>('SELECT SUM(amount_minor)::text AS sum FROM cash_postings')
    ).rows[0];
    assert.equal(balance.sum, '0');
    const tracking = (await f.app.inject({ url: '/api/tracking/' + a.json().trackingToken })).body;
    assert.ok(!tracking.includes('goodsMinor'));
    assert.ok(!tracking.includes('تحصيل اختباري'));
  } finally {
    await f.close();
  }
});
test('missing, short, wrong currency or invalid reference cash cannot consume proof or deliver; cancellation creates no financial liability', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route();
    const total = f.shipment().collection.totalMinor;
    assert.equal(
      (
        await f.post(
          `/api/shipments/${f.shipment().id}/actions`,
          { action: 'deliver', expectedVersion: f.shipment().version, deliveryCode: code },
          'courier-b',
        )
      ).json().code,
      'CASH_REQUIRED',
    );
    assert.equal(
      (
        await f.deliver(code, { amountMinor: total - 1, currency: 'SYP', reference: 'تحصيل ناقص' })
      ).json().code,
      'CASH_AMOUNT_MISMATCH',
    );
    assert.equal(
      (await f.deliver(code, { amountMinor: total, currency: 'USD', reference: 'عملة غير صحيحة' }))
        .statusCode,
      422,
    );
    assert.equal(
      (await f.deliver(code, { amountMinor: total, currency: 'SYP', reference: 'x' })).statusCode,
      422,
    );
    assert.equal(
      (
        await f.deliver(code, {
          amountMinor: total + 0.5,
          currency: 'SYP',
          reference: 'كسر غير صحيح',
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await f.db.query<{ consumed_at: string | null }>(
          'SELECT consumed_at FROM delivery_proofs WHERE shipment_id=$1',
          [f.shipment().id],
        )
      ).rows[0].consumed_at,
      null,
    );
    assert.equal((await f.view()).json().heldMinor, 0);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 0);
    assert.equal((await f.deliver(code)).statusCode, 200);
    const q = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        paymentMode: 'cod',
        recipientName: 'عميل ملغى',
        district: 'الروضة',
        address: 'عنوان تجريبي للإلغاء',
      },
      'shop',
    );
    const s = (await f.order(q.json().id)).json().shipment;
    await f.act(s, 'cancel', 'merchant-a');
    assert.equal((await f.view()).json().pendingMinor, 0);
    const nextQ = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        paymentMode: 'cod',
        recipientName: 'عميل إرجاع',
        district: 'الروضة',
        address: 'عنوان اختبار إرجاع نقدي',
      },
      'shop',
    );
    let returned = (await f.order(nextQ.json().id)).json().shipment;
    for (const [action, who, extra] of [
      ['prepare', 'merchant-a', {}],
      ['assign', 'ops', { courierId: 'courier-b' }],
      ['accept', 'courier-b', {}],
      ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
      ['pickup', 'courier-b', {}],
      ['depart', 'courier-b', {}],
      ['return', 'ops', { reason: 'إرجاع دون تحصيل' }],
    ] as const)
      returned = await f.act(returned, action, who, extra);
    assert.equal((await f.view()).json().pendingMinor, 0);
    assert.equal(returned.collection.status, 'pending');
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 1);
  } finally {
    await f.close();
  }
});
test('cash differences remain in collector custody, are scoped and audited, and cannot automatically close or pay merchants', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route();
    await f.deliver(code);
    const r = await f.row(),
      total = r.totalMinor;
    assert.equal((await f.receipt(r, 'receive', total - 100)).json().code, 'REMITTANCE_MISMATCH');
    const key = crypto.randomUUID();
    const difference = await f.receipt(r, 'report_difference', total - 100, 'ops', key);
    assert.equal(difference.statusCode, 200, difference.body);
    assert.deepEqual(
      (await f.receipt(r, 'report_difference', total - 100, 'ops', key)).json(),
      difference.json(),
    );
    let view = (await f.view()).json();
    assert.equal(view.heldMinor, total);
    assert.equal(view.receivedMinor, 0);
    assert.equal(view.rows[0].issueOpen, true);
    assert.equal(
      view.history.filter((e: { action: string }) => e.action === 'report_difference').length,
      1,
    );
    assert.equal(view.consistent, true);
    assert.equal((await f.receipt(await f.row(), 'report_difference', total)).statusCode, 422);
    const saved = await f.row();
    const receiptKey = crypto.randomUUID();
    const receipt = await f.receipt(saved, 'receive', total, 'ops', receiptKey);
    assert.equal(receipt.statusCode, 200);
    assert.deepEqual(
      (await f.receipt(saved, 'receive', total, 'ops', receiptKey)).json(),
      receipt.json(),
    );
    view = (await f.view()).json();
    assert.equal(view.rows[0].issueOpen, false);
    assert.equal(view.goodsLiabilityMinor, r.goodsMinor);
    await assert.rejects(f.db.query('UPDATE cash_postings SET amount_minor=amount_minor+1'));
    await assert.rejects(f.db.query('DELETE FROM cash_journals'));
    await assert.rejects(f.db.query('DELETE FROM cash_events'));
    await assert.rejects(
      f.db.query("INSERT INTO cash_postings SELECT id,'extra',100 FROM cash_journals LIMIT 1"),
    );
    await f.db.query(
      "UPDATE cash_obligations SET status='collected',received_at=NULL WHERE shipment_id=$1",
      [f.shipment().id],
    );
    assert.equal((await f.view()).json().consistent, false);
    assert.equal((await f.receipt(await f.row())).json().code, 'CASH_INCONSISTENT');
  } finally {
    await f.close();
  }
});
