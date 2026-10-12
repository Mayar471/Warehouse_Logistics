import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFixture } from './helpers/payouts.js';
import { cashFixture } from './helpers/cash.js';
import { fixture } from './helpers/inventory.js';
import { restoreCashSchema15 } from './helpers/cash-returns.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('request, cash release and original collector receipt keep separate custody; corrected remittance can be received again without recollecting the customer', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let row = await f.row();
    const total = row.totalMinor,
      goods = row.goodsMinor,
      fee = row.feeMinor;
    const key = crypto.randomUUID(),
      request = await f.receipt(row, 'return_request', total, 'ops', key);
    assert.equal(request.statusCode, 200, request.body);
    assert.deepEqual(
      (await f.receipt(row, 'return_request', total, 'ops', key)).json(),
      request.json(),
    );
    row = await f.row();
    assert.equal(row.remittanceReturn.status, 'requested');
    assert.equal((await f.create()).json().code, 'REMITTANCE_RETURN_PENDING');
    assert.equal((await f.get('/api/payouts')).json().availableMinor, 0);
    assert.equal((await f.receipt(row, 'return_confirm', total, 'courier-b')).statusCode, 409);
    let cash = (await f.get('/api/cash')).json();
    assert.equal(cash.operationsBalanceMinor, total);
    assert.equal(cash.heldMinor, 0);
    const releaseKey = crypto.randomUUID(),
      release = await f.receipt(row, 'return_release', total, 'ops', releaseKey);
    assert.equal(release.statusCode, 200, release.body);
    assert.deepEqual(
      (await f.receipt(row, 'return_release', total, 'ops', releaseKey)).json(),
      release.json(),
    );
    row = await f.row();
    assert.equal((await f.receipt(row, 'return_cancel')).json().code, 'RETURN_CUSTODY');
    cash = (await f.get('/api/cash')).json();
    assert.equal(cash.operationsBalanceMinor, 0);
    assert.equal(cash.remittanceReturnTransitMinor, total);
    assert.equal(cash.heldMinor, 0);
    assert.equal(cash.consistent, true);
    const confirmKey = crypto.randomUUID(),
      receipt = await f.receipt(row, 'return_confirm', total, 'courier-b', confirmKey);
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.deepEqual(
      (await f.receipt(row, 'return_confirm', total, 'courier-b', confirmKey)).json(),
      receipt.json(),
    );
    row = await f.row();
    assert.equal(row.status, 'collected');
    assert.equal(row.remittanceReturn, null);
    assert.equal(row.remittanceCount, 1);
    cash = (await f.get('/api/cash')).json();
    assert.equal(cash.heldMinor, total);
    assert.equal(cash.netRemittedMinor, 0);
    assert.equal(cash.receivedMinor, total);
    assert.equal(cash.remittanceReturnTransitMinor, 0);
    assert.equal(cash.goodsLiabilityMinor, goods);
    assert.equal(cash.deliveryClearingMinor, fee);
    assert.equal(cash.consistent, true);
    assert.equal((await f.receipt(row)).statusCode, 200);
    row = await f.row();
    assert.equal(row.remittanceCount, 2);
    cash = (await f.get('/api/cash')).json();
    assert.equal(cash.receivedMinor, total * 2);
    assert.equal(cash.netRemittedMinor, total);
    assert.equal(cash.operationsBalanceMinor, total);
    assert.equal(cash.heldMinor, 0);
    assert.equal(cash.consistent, true);
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    assert.equal((await f.action(p, 'confirm', 'merchant-a')).statusCode, 200);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM cash_journals WHERE kind='collection'")).rows.length,
      1,
    );
    const links = (
      await f.db.query<{ kind: string; source: string }>(
        'SELECT j.kind,r.kind AS source FROM cash_journals j JOIN cash_journals r ON r.id=j.reverses_journal_id WHERE j.remittance_return_id IS NOT NULL ORDER BY j.kind',
      )
    ).rows;
    assert.deepEqual(links, [
      { kind: 'remittance_return_restore', source: 'remittance_return_release' },
      { kind: 'remittance_reverse', source: 'remittance' },
    ]);
  } finally {
    await f.close();
  }
});

test('merchant payout blocks cash return until actually recovered; amounts, roles, stale versions and cancelled requests are protected', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let row = await f.row(),
      p = (await f.create()).json();
    await f.db.query('UPDATE cash_obligations SET remittance_count=0 WHERE shipment_id=$1', [
      f.shipment().id,
    ]);
    assert.equal((await f.receipt(row, 'return_request')).json().code, 'CASH_INCONSISTENT');
    await f.db.query('UPDATE cash_obligations SET remittance_count=1 WHERE shipment_id=$1', [
      f.shipment().id,
    ]);
    assert.equal((await f.receipt(row, 'return_request')).json().code, 'PAYOUT_BLOCKS_RETURN');
    p = (await f.action(p, 'release')).json();
    assert.equal((await f.receipt(row, 'return_request')).json().code, 'PAYOUT_BLOCKS_RETURN');
    p = (await f.action(p, 'confirm', 'merchant-a')).json();
    assert.equal((await f.receipt(row, 'return_request')).json().code, 'PAYOUT_BLOCKS_RETURN');
    p = (await f.action(p, 'request_recovery', 'merchant-a')).json();
    assert.equal((await f.receipt(row, 'return_request')).json().code, 'PAYOUT_BLOCKS_RETURN');
    assert.equal((await f.action(p, 'receive_recovery')).statusCode, 200);
    assert.equal((await f.receipt(row, 'return_request', row.totalMinor - 1)).statusCode, 422);
    assert.equal(
      (await f.receipt(row, 'return_request', row.totalMinor, 'merchant-a')).statusCode,
      403,
    );
    const requested = await f.receipt(row, 'return_request');
    assert.equal(requested.statusCode, 200, requested.body);
    const old = row;
    row = await f.row();
    assert.equal((await f.receipt(old, 'return_release')).json().code, 'VERSION_CONFLICT');
    assert.equal((await f.receipt(row, 'return_confirm', row.totalMinor, 'ops')).statusCode, 403);
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'pickup-a')).statusCode,
      404,
    );
    assert.equal(
      (await f.receipt(row, 'return_release', row.totalMinor, 'courier-b')).statusCode,
      403,
    );
    assert.equal((await f.receipt(row, 'return_cancel')).statusCode, 200);
    row = await f.row();
    assert.equal((await f.get('/api/payouts')).json().availableMinor, row.goodsMinor);
    assert.equal((await f.receipt(row, 'return_request')).statusCode, 200);
    row = await f.row();
    assert.equal((await f.receipt(row, 'return_release')).statusCode, 200);
    row = await f.row();
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor - 1, 'courier-b')).statusCode,
      422,
    );
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'courier-b')).statusCode,
      200,
    );
    assert.equal((await f.receipt(await f.row())).statusCode, 200);
    assert.equal((await f.create()).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('pickup collector alone confirms cash arrival and later journal or audit failure rolls back the entire correction before exact retry', async () => {
  const f = await cashFixture(true);
  try {
    const { code } = await f.route();
    await f.deliver(code);
    await f.receipt(await f.row());
    let row = await f.row();
    await f.receipt(row, 'return_request');
    row = await f.row();
    await f.db.exec(
      "CREATE FUNCTION fail_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('return_release','return_confirm') THEN RAISE EXCEPTION 'test audit failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_return_audit BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION fail_return_audit();",
    );
    const releaseKey = crypto.randomUUID();
    assert.equal(
      (await f.receipt(row, 'return_release', row.totalMinor, 'ops', releaseKey)).statusCode,
      500,
    );
    assert.equal((await f.row()).version, row.version);
    assert.equal((await f.view()).json().operationsBalanceMinor, row.totalMinor);
    await f.db.exec('DROP TRIGGER fail_return_audit ON cash_events;');
    assert.equal(
      (await f.receipt(row, 'return_release', row.totalMinor, 'ops', releaseKey)).statusCode,
      200,
    );
    row = await f.row();
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'courier-b')).statusCode,
      404,
    );
    const confirmKey = crypto.randomUUID();
    await f.db.exec(
      "CREATE FUNCTION fail_return_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='remittance_return_restore' THEN RAISE EXCEPTION 'test restore failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_return_restore BEFORE INSERT ON cash_journals FOR EACH ROW EXECUTE FUNCTION fail_return_restore();",
    );
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'pickup-a', confirmKey)).statusCode,
      500,
    );
    await f.db.exec(
      'DROP TRIGGER fail_return_restore ON cash_journals; DROP FUNCTION fail_return_restore(); CREATE TRIGGER fail_return_audit BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION fail_return_audit();',
    );
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'pickup-a', confirmKey)).statusCode,
      500,
    );
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 3);
    assert.equal((await f.row()).version, row.version);
    await f.db.exec(
      'DROP TRIGGER fail_return_audit ON cash_events; DROP FUNCTION fail_return_audit();',
    );
    assert.equal(
      (await f.receipt(row, 'return_confirm', row.totalMinor, 'pickup-a', confirmKey)).statusCode,
      200,
    );
    assert.equal((await f.view('pickup-a')).json().heldMinor, row.totalMinor);
    await assert.rejects(f.db.query("DELETE FROM cash_journals WHERE kind='remittance_reverse'"));
  } finally {
    await f.close();
  }
});

test('schema 15 upgrade adds round metadata without changing sealed amounts; return custody and re-remittance survive restarts', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'cash-return-'));
  const f = await payoutFixture(path);
  let closed = false;
  try {
    await f.fund();
    const id = f.shipment().id,
      total = f.shipment().collection.totalMinor;
    const original = (
      await f.db.query<{ id: string; amount: string }>(
        'SELECT id,amount_minor::text AS amount FROM cash_journals ORDER BY kind',
      )
    ).rows;
    await restoreCashSchema15(f.db);
    await f.close();
    closed = true;
    const next = await fixture(path);
    const command = {
      amountMinor: total,
      currency: 'SYP',
      reference: 'رجوع بعد الترقية',
      reason: 'اختبار حفظ العهدة مع إعادة التشغيل',
    };
    let version: number;
    try {
      assert.deepEqual(
        (
          await next.db.query(
            'SELECT id,amount_minor::text AS amount FROM cash_journals ORDER BY kind',
          )
        ).rows,
        original,
      );
      let r = (await next.get('/api/cash')).json().rows[0];
      assert.equal(r.remittanceCount, 1);
      let request = await next.post(`/api/cash/${id}/actions`, {
        ...command,
        action: 'return_request',
        expectedVersion: r.version,
      });
      assert.equal(request.statusCode, 200, request.body);
      request = await next.post(`/api/cash/${id}/actions`, {
        ...command,
        action: 'return_release',
        expectedVersion: request.json().version,
      });
      assert.equal(request.statusCode, 200, request.body);
      version = request.json().version;
    } finally {
      await next.close();
    }
    const again = await fixture(path);
    try {
      assert.equal((await again.get('/api/cash')).json().remittanceReturnTransitMinor, total);
      const r = await again.post(
        `/api/cash/${id}/actions`,
        { ...command, action: 'return_confirm', expectedVersion: version! },
        'courier-b',
      );
      assert.equal(r.statusCode, 200, r.body);
      const receipt = await again.post(`/api/cash/${id}/actions`, {
        ...command,
        action: 'receive',
        expectedVersion: r.json().version,
      });
      assert.equal(receipt.statusCode, 200, receipt.body);
    } finally {
      await again.close();
    }
    const last = await fixture(path);
    try {
      const cash = (await last.get('/api/cash')).json();
      assert.equal(cash.consistent, true);
      assert.equal(cash.netRemittedMinor, total);
      assert.equal(cash.receivedMinor, total * 2);
      assert.equal(cash.rows[0].remittanceCount, 2);
      assert.equal(cash.remittanceReturnTransitMinor, 0);
      assert.equal(
        (await last.db.query("SELECT * FROM cash_journals WHERE kind='remittance'")).rows.length,
        2,
      );
    } finally {
      await last.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
