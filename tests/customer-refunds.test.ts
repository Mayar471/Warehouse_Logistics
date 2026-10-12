import test from 'node:test';
import assert from 'node:assert/strict';
import { refundFixture } from './helpers/customer-refunds.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
test('concurrent merchant payout and customer refund approval cannot reserve the same proceeds twice', async () => {
  const f = await refundFixture();
  try {
    await f.inspect();
    await f.fund();
    const row = await f.row();
    const results = await Promise.all([
      f.refund('request', f.returnCase.version, 'merchant-a'),
      f.post('/api/payouts', {
        shipmentId: f.shipment().id,
        expectedCollectionVersion: row.version,
        reference: 'صرف متزامن 123',
        reason: 'حجز مستحق متزامن مع رد العميل',
      }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const refunds = (await f.db.query("SELECT * FROM customer_refunds WHERE status<>'cancelled'"))
        .rows.length,
      payouts = (
        await f.db.query(
          "SELECT * FROM cash_payouts WHERE status NOT IN ('cancelled','returned','recovered')",
        )
      ).rows.length;
    assert.equal(refunds + payouts, 1);
    assert.equal((await f.view()).json().consistent, true);
  } finally {
    await f.close();
  }
});
test('refund requires inspection, funded unpaid goods, independent client receipt and exact amount; fees remain separate', async () => {
  const f = await refundFixture();
  try {
    assert.equal((await f.refund('request', f.returnCase.version, 'merchant-a')).statusCode, 409);
    assert.equal((await f.inspect()).statusCode, 200);
    assert.equal((await f.refund('request', f.returnCase.version, 'merchant-a')).statusCode, 409);
    assert.equal((await f.fund()).statusCode, 200);
    assert.equal((await f.refund('request', f.returnCase.version, 'merchant-b')).statusCode, 404);
    assert.equal((await f.refund('request', f.returnCase.version, 'ops')).statusCode, 403);
    const requested = await f.refund('request', f.returnCase.version, 'merchant-a');
    assert.equal(requested.statusCode, 200, requested.body);
    const row = await f.row();
    assert.equal(
      (
        await f.post(
          '/api/payouts',
          {
            shipmentId: f.shipment().id,
            expectedCollectionVersion: row.version,
            reference: 'صرف ممنوع 123',
            reason: 'محاولة صرف بوجود رد عميل',
          },
          'ops',
        )
      ).statusCode,
      409,
    );
    assert.equal((await f.receipt(row, 'return_request')).statusCode, 409);
    const reserved = await f.refund('reserve', requested.json().version);
    assert.equal(reserved.statusCode, 200, reserved.body);
    const key = crypto.randomUUID(),
      released = await f.refund('release', reserved.json().version, 'ops', key);
    assert.equal(released.statusCode, 200, released.body);
    assert.deepEqual(
      (await f.refund('release', reserved.json().version, 'ops', key)).json(),
      released.json(),
    );
    assert.equal((await f.refund('cancel', released.json().version)).statusCode, 409);
    assert.equal(
      (await f.client('confirm', released.json().version, f.shipment().collection.totalMinor))
        .statusCode,
      422,
    );
    const report = await f.client('report', released.json().version, 0);
    assert.equal(report.statusCode, 200, report.body);
    const cashBefore = (await f.view()).json();
    assert.equal(cashBefore.consistent, true);
    assert.ok(cashBefore.goodsLiabilityMinor > 0);
    const confirmed = await f.client('confirm', report.json().version);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const view = (await f.view()).json();
    assert.equal(view.consistent, true);
    assert.equal(view.goodsLiabilityMinor, 0);
    assert.equal(view.operationsBalanceMinor, f.shipment().collection.feeMinor);
    assert.equal(view.deliveryClearingMinor, f.shipment().collection.feeMinor);
    assert.equal((await f.client('confirm', report.json().version)).statusCode, 409);
    assert.equal(
      (await f.db.query('SELECT * FROM cash_journals WHERE refund_id IS NOT NULL')).rows.length,
      2,
    );
  } finally {
    await f.close();
  }
});

test('paid merchant proceeds must be recovered before refund approval; cancellation reopens payout eligibility', async () => {
  const f = await refundFixture();
  try {
    await f.inspect();
    await f.fund();
    const row = await f.row();
    const payout = await f.post('/api/payouts', {
      shipmentId: f.shipment().id,
      expectedCollectionVersion: row.version,
      reference: 'صرف 123',
      reason: 'صرف مستحق المتجر قبل طلب الرد',
    });
    assert.equal(payout.statusCode, 200, payout.body);
    let p = payout.json();
    for (const [action, who] of [
      ['release', 'ops'],
      ['confirm', 'merchant-a'],
    ] as const) {
      const result = await f.post(
        `/api/payouts/${p.id}/actions`,
        {
          action,
          expectedVersion: p.version,
          amountMinor: f.shipment().collection.goodsMinor,
          currency: 'SYP',
          reference: 'إيصال 123',
          reason: 'تسجيل انتقال عهدة نقد المتجر',
        },
        who,
      );
      assert.equal(result.statusCode, 200, result.body);
      p = result.json();
    }
    assert.equal((await f.refund('request', f.returnCase.version, 'merchant-a')).statusCode, 409);
    for (const [action, who] of [
      ['request_recovery', 'merchant-a'],
      ['receive_recovery', 'ops'],
    ] as const) {
      const result = await f.post(
        `/api/payouts/${p.id}/actions`,
        {
          action,
          expectedVersion: p.version,
          amountMinor: f.shipment().collection.goodsMinor,
          currency: 'SYP',
          reference: 'رد دفعة 123',
          reason: 'استعادة نقد المتجر لتمويل رد العميل',
        },
        who,
      );
      assert.equal(result.statusCode, 200, result.body);
      p = result.json();
    }
    const requested = await f.refund('request', f.returnCase.version, 'merchant-a');
    assert.equal(requested.statusCode, 200, requested.body);
    assert.equal((await f.get('/api/payouts')).json().eligible.length, 0);
    assert.equal(
      (await f.refund('cancel', requested.json().version, 'merchant-a')).statusCode,
      200,
    );
    assert.equal((await f.get('/api/payouts')).json().eligible.length, 1);
    assert.equal((await f.view()).json().consistent, true);
  } finally {
    await f.close();
  }
});

test('released refund and immutable journals survive restart; original customer can confirm once with scoped recovery status', async () => {
  const root = resolve('artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, 'refund-db-'));
  const f = await refundFixture(path);
  let closed = false;
  try {
    await f.inspect();
    await f.fund();
    const request = await f.refund('request', f.returnCase.version, 'merchant-a');
    const reserved = await f.refund('reserve', request.json().version);
    const key = crypto.randomUUID(),
      released = await f.refund('release', reserved.json().version, 'ops', key);
    assert.equal(released.statusCode, 200, released.body);
    const before = (await f.view()).json(),
      shop = f.shop,
      source = f.shipment().id,
      returnId = f.returnCase.id,
      body = f.refundBody('release', reserved.json().version);
    await f.close();
    closed = true;
    const next = await fixture(path);
    try {
      assert.deepEqual((await next.get('/api/cash')).json(), before);
      const status = await next.post('/api/financial-commands/status', {
        url: `/api/refunds/${returnId}/actions`,
        body: JSON.stringify(body),
        key,
      });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().state, 'committed');
      const unauthorized = await next.app.inject({
        method: 'POST',
        url: `/api/storefront/orders/${source}/refund`,
        headers: { cookie: next.shop, 'idempotency-key': crypto.randomUUID() },
        payload: { ...body, action: 'confirm', expectedVersion: released.json().version },
      });
      assert.equal(unauthorized.statusCode, 404);
      const confirmed = await next.app.inject({
        method: 'POST',
        url: `/api/storefront/orders/${source}/refund`,
        headers: { cookie: shop, 'idempotency-key': crypto.randomUUID() },
        payload: { ...body, action: 'confirm', expectedVersion: released.json().version },
      });
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      assert.equal(
        (await next.db.query('SELECT * FROM cash_journals WHERE refund_id IS NOT NULL')).rows
          .length,
        2,
      );
      assert.equal((await next.get('/api/cash')).json().consistent, true);
    } finally {
      await next.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + sep)) throw new Error('Test cleanup escaped root');
    await rm(path, { recursive: true, force: true });
  }
});
test('failed refund confirmation audit rolls back liability, transit and idempotency; retry records money once', async () => {
  const f = await refundFixture();
  try {
    await f.inspect();
    await f.fund();
    const req = await f.refund('request', f.returnCase.version, 'merchant-a');
    const reserve = await f.refund('reserve', req.json().version);
    const release = await f.refund('release', reserve.json().version);
    assert.equal(release.statusCode, 200, release.body);
    const before = (await f.view()).json(),
      key = crypto.randomUUID();
    await f.db.exec(
      "CREATE FUNCTION reject_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_refund_audit BEFORE INSERT ON customer_refund_events FOR EACH ROW EXECUTE FUNCTION reject_refund_audit();",
    );
    assert.equal(
      (await f.client('confirm', release.json().version, undefined, key)).statusCode,
      500,
    );
    assert.deepEqual((await f.view()).json(), before);
    await f.db.exec(
      'DROP TRIGGER reject_refund_audit ON customer_refund_events; DROP FUNCTION reject_refund_audit();',
    );
    assert.equal(
      (await f.client('confirm', release.json().version, undefined, key)).statusCode,
      200,
    );
    await assert.rejects(f.db.exec('DELETE FROM customer_refunds'));
    await assert.rejects(f.db.exec("UPDATE customer_refund_events SET reason='عبث'"));
  } finally {
    await f.close();
  }
});
