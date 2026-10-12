import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function released(pickup = false, path?: string) {
  const f = await cashFixture(pickup, path);
  try {
    const { code } = await f.route();
    assert.equal((await f.deliver(code)).statusCode, 200);
    for (const action of ['receive', 'return_request', 'return_release']) {
      const r = await f.receipt(await f.row(), action);
      assert.equal(r.statusCode, 200, r.body);
    }
    return f;
  } catch (e) {
    await f.close();
    throw e;
  }
}

test('shortage and overage reports never move cash or write off custody; full original collector receipt resolves the issue while preserving both reports', async () => {
  const f = await released();
  try {
    let row = await f.row();
    const total = row.totalMinor,
      before = (await f.view()).json(),
      journals = (await f.db.query('SELECT * FROM cash_journals')).rows.length;
    const key = crypto.randomUUID(),
      report = await f.receipt(row, 'return_difference', total - 100, 'courier-b', key);
    assert.equal(report.statusCode, 200, report.body);
    assert.deepEqual(
      (await f.receipt(row, 'return_difference', total - 100, 'courier-b', key)).json(),
      report.json(),
    );
    row = await f.row();
    assert.equal(row.remittanceReturn.issueOpen, true);
    assert.equal(row.remittanceReturn.lastReportedMinor, total - 100);
    assert.equal(row.issueOpen, false);
    let view = (await f.view()).json();
    assert.equal(view.returnIssueCount, 1);
    assert.equal(view.operationsBalanceMinor, before.operationsBalanceMinor);
    assert.equal(view.remittanceReturnTransitMinor, total);
    assert.equal(view.heldMinor, 0);
    assert.equal(view.goodsLiabilityMinor, before.goodsLiabilityMinor);
    assert.equal(view.deliveryClearingMinor, before.deliveryClearingMinor);
    assert.equal(view.consistent, true);
    assert.equal(
      (await f.receipt(row, 'return_confirm', total - 100, 'courier-b')).statusCode,
      422,
    );
    assert.equal((await f.receipt(row, 'return_cancel')).json().code, 'RETURN_CUSTODY');
    assert.equal(
      (await f.receipt(row, 'return_difference', total)).json().code,
      'NO_CASH_DIFFERENCE',
    );
    assert.equal((await f.receipt(row, 'return_difference', total + 200)).statusCode, 200);
    row = await f.row();
    assert.equal(row.remittanceReturn.lastReportedMinor, total + 200);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, journals);
    const receipt = await f.receipt(row, 'return_confirm', total, 'courier-b');
    assert.equal(receipt.statusCode, 200, receipt.body);
    view = (await f.view()).json();
    assert.equal(view.returnIssueCount, 0);
    assert.equal(view.remittanceReturnTransitMinor, 0);
    assert.equal(view.heldMinor, total);
    assert.equal(view.consistent, true);
    const history = view.history.filter(
      (e: { action: string }) => e.action === 'return_difference',
    );
    assert.equal(history.length, 2);
    const confirmed = view.history.find((e: { action: string }) => e.action === 'return_confirm');
    assert.equal(confirmed.details.resolvedDifferenceMinor, 200);
    const snapshot = (
      await f.db.query<{ issue_open: boolean; last_reported_minor: string }>(
        'SELECT issue_open,last_reported_minor::text FROM cash_remittance_returns',
      )
    ).rows[0];
    assert.equal(snapshot.issue_open, false);
    assert.equal(snapshot.last_reported_minor, String(total + 200));
    assert.equal(
      (await f.db.query("SELECT * FROM cash_journals WHERE kind='collection'")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('original pickup collector and operations can report while other roles, stale concurrent reports and invalid measured amounts cannot', async () => {
  const f = await cashFixture(true);
  try {
    const { code } = await f.route();
    await f.deliver(code);
    await f.receipt(await f.row());
    await f.receipt(await f.row(), 'return_request');
    const before = await f.row();
    assert.equal(
      (await f.receipt(before, 'return_difference', before.totalMinor - 1, 'pickup-a')).statusCode,
      409,
    );
    await f.receipt(before, 'return_release');
    let row = await f.row();
    const total = row.totalMinor;
    assert.equal(
      (await f.receipt(row, 'return_difference', total - 1, 'merchant-a')).statusCode,
      403,
    );
    assert.equal(
      (await f.receipt(row, 'return_difference', total - 1, 'courier-b')).statusCode,
      404,
    );
    assert.equal((await f.receipt(row, 'return_difference', -1, 'pickup-a')).statusCode, 422);
    const invalid = await f.post(
      `/api/cash/${row.shipmentId}/actions`,
      {
        action: 'return_difference',
        expectedVersion: row.version,
        amountMinor: total - 1,
        currency: 'USD',
        reference: 'محضر عد',
        reason: 'عملة خاطئة',
      },
      'pickup-a',
    );
    assert.equal(invalid.statusCode, 422);
    const reports = await Promise.all([
      f.receipt(row, 'return_difference', 0, 'pickup-a'),
      f.receipt(row, 'return_difference', total + 1, 'ops'),
    ]);
    assert.deepEqual(reports.map((r) => r.statusCode).sort(), [200, 409]);
    row = await f.row();
    assert.equal((await f.view('pickup-a')).json().returnIssueCount, 1);
    assert.equal((await f.view('merchant-b')).json().returnIssueCount, 0);
    assert.equal(
      (await f.receipt(row, 'return_difference', total - 1, 'pickup-a')).statusCode,
      200,
    );
    row = await f.row();
    assert.equal((await f.receipt(row, 'return_confirm', total, 'ops')).statusCode, 403);
    assert.equal((await f.receipt(row, 'return_confirm', total, 'pickup-a')).statusCode, 200);
    assert.equal(
      (await f.receipt(await f.row(), 'return_difference', total - 1, 'pickup-a')).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('audit failure rolls back measured difference or its resolution together with version, reversal journals and retry result', async () => {
  const f = await released();
  try {
    let row = await f.row();
    const total = row.totalMinor;
    await f.db.exec(
      "CREATE FUNCTION reject_return_difference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('return_difference','return_confirm') THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_return_difference BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION reject_return_difference();",
    );
    const key = crypto.randomUUID();
    assert.equal(
      (await f.receipt(row, 'return_difference', total - 1, 'courier-b', key)).statusCode,
      500,
    );
    assert.equal((await f.row()).version, row.version);
    assert.equal((await f.view()).json().returnIssueCount, 0);
    await f.db.exec('DROP TRIGGER reject_return_difference ON cash_events;');
    assert.equal(
      (await f.receipt(row, 'return_difference', total - 1, 'courier-b', key)).statusCode,
      200,
    );
    row = await f.row();
    await f.db.exec(
      'CREATE TRIGGER reject_return_difference BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION reject_return_difference();',
    );
    const confirmKey = crypto.randomUUID();
    assert.equal(
      (await f.receipt(row, 'return_confirm', total, 'courier-b', confirmKey)).statusCode,
      500,
    );
    assert.equal((await f.view()).json().returnIssueCount, 1);
    assert.equal((await f.row()).version, row.version);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 3);
    await f.db.exec(
      'DROP TRIGGER reject_return_difference ON cash_events; DROP FUNCTION reject_return_difference();',
    );
    assert.equal(
      (await f.receipt(row, 'return_confirm', total, 'courier-b', confirmKey)).statusCode,
      200,
    );
    await assert.rejects(
      f.db.query('UPDATE cash_remittance_returns SET issue_open=true WHERE shipment_id=$1', [
        row.shipmentId,
      ]),
    );
    await assert.rejects(
      f.db.query("UPDATE cash_events SET reason='rewritten' WHERE action='return_difference'"),
    );
  } finally {
    await f.close();
  }
});

test('schema 16 upgrade keeps existing cash return custody unflagged; discrepancy and later full resolution survive restart', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'return-difference-'));
  const f = await released(false, path);
  let closed = false;
  try {
    const row = await f.row(),
      total = row.totalMinor,
      id = row.shipmentId;
    await f.db.exec(
      'ALTER TABLE cash_remittance_returns DROP COLUMN issue_open CASCADE; ALTER TABLE cash_remittance_returns DROP COLUMN last_reported_minor CASCADE; DELETE FROM schema_migrations WHERE version=17;',
    );
    await f.close();
    closed = true;
    const body = {
      amountMinor: total - 100,
      currency: 'SYP',
      reference: 'محضر فرق ترقية',
      reason: 'نقص نقد الرجوع بعد الترقية',
    };
    const next = await fixture(path);
    try {
      let view = (await next.get('/api/cash')).json();
      assert.equal(view.returnIssueCount, 0);
      assert.equal(view.rows[0].remittanceReturn.issueOpen, false);
      assert.equal(view.remittanceReturnTransitMinor, total);
      const report = await next.post(
        `/api/cash/${id}/actions`,
        { ...body, action: 'return_difference', expectedVersion: view.rows[0].version },
        'courier-b',
      );
      assert.equal(report.statusCode, 200, report.body);
    } finally {
      await next.close();
    }
    const again = await fixture(path);
    try {
      const view = (await again.get('/api/cash')).json();
      assert.equal(view.returnIssueCount, 1);
      assert.equal(view.rows[0].remittanceReturn.lastReportedMinor, total - 100);
      assert.equal(view.remittanceReturnTransitMinor, total);
      const receipt = await again.post(
        `/api/cash/${id}/actions`,
        {
          ...body,
          amountMinor: total,
          action: 'return_confirm',
          expectedVersion: view.rows[0].version,
        },
        'courier-b',
      );
      assert.equal(receipt.statusCode, 200, receipt.body);
    } finally {
      await again.close();
    }
    const last = await fixture(path);
    try {
      const view = (await last.get('/api/cash')).json();
      assert.equal(view.returnIssueCount, 0);
      assert.equal(view.heldMinor, total);
      assert.equal(view.consistent, true);
      assert.equal(
        (await last.db.query("SELECT * FROM cash_events WHERE action='return_difference'")).rows
          .length,
        1,
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
