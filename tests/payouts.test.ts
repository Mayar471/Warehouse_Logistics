import { restoreCashSchema15 } from './helpers/cash-returns.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFixture } from './helpers/payouts.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
test('reservation, physical release and merchant receipt remain independent, balanced and exactly once without paying delivery fees', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    const goods = f.shipment().collection.goodsMinor,
      fee = f.shipment().collection.feeMinor;
    assert.equal((await f.view()).json().availableMinor, goods);
    const key = crypto.randomUUID(),
      r = await f.create(key);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual((await f.create(key)).json(), r.json());
    let p = r.json();
    assert.equal((await f.view()).json().reservedMinor, goods);
    assert.equal((await f.view()).json().availableMinor, 0);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, goods);
    assert.equal((await f.action(p, 'confirm', 'merchant-a')).statusCode, 409);
    const releaseKey = crypto.randomUUID(),
      release = await f.action(p, 'release', 'ops', {}, releaseKey);
    assert.equal(release.statusCode, 200, release.body);
    assert.deepEqual((await f.action(p, 'release', 'ops', {}, releaseKey)).json(), release.json());
    p = release.json();
    let cash = (await f.get('/api/cash')).json();
    assert.equal(cash.operationsBalanceMinor, fee);
    assert.equal(cash.payoutInTransitMinor, goods);
    assert.equal(cash.goodsLiabilityMinor, goods);
    assert.equal(cash.receivedMinor, goods + fee);
    assert.equal(cash.consistent, true);
    assert.equal((await f.action(p, 'confirm', 'ops')).statusCode, 403);
    const merchantKey = crypto.randomUUID(),
      paid = await f.action(p, 'confirm', 'merchant-a', {}, merchantKey);
    assert.equal(paid.statusCode, 200, paid.body);
    assert.deepEqual(
      (await f.action(p, 'confirm', 'merchant-a', {}, merchantKey)).json(),
      paid.json(),
    );
    cash = (await f.get('/api/cash')).json();
    assert.equal(cash.goodsLiabilityMinor, 0);
    assert.equal(cash.payoutInTransitMinor, 0);
    assert.equal(cash.operationsBalanceMinor, fee);
    assert.equal(cash.deliveryClearingMinor, fee);
    assert.equal(cash.consistent, true);
    const view = (await f.view()).json();
    assert.equal(view.paidMinor, goods);
    assert.equal(view.consistent, true);
    assert.equal(view.history.length, 3);
    assert.equal((await f.create()).json().code, 'PAYOUT_EXISTS');
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 4);
  } finally {
    await f.close();
  }
});
test('only remitted funds qualify; concurrent reservations, cancellation, strict amounts and merchant scope protect liabilities', async () => {
  const f = await payoutFixture();
  try {
    assert.equal((await f.create()).json().code, 'PAYOUT_NOT_FUNDED');
    const { code } = await f.route();
    await f.deliver(code);
    assert.equal((await f.create()).json().code, 'PAYOUT_NOT_FUNDED');
    await f.receipt(await f.row());
    assert.equal((await f.view('courier-b')).statusCode, 403);
    assert.equal((await f.view('merchant-b')).json().availableMinor, 0);
    assert.equal((await f.create(crypto.randomUUID(), 'merchant-a')).statusCode, 403);
    const results = await Promise.all([f.create(), f.create()]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    let p = results.find((r) => r.statusCode === 200)!.json();
    assert.equal((await f.action(p, 'release', 'merchant-a')).statusCode, 403);
    assert.equal((await f.action(p, 'confirm', 'merchant-b')).statusCode, 404);
    const cancelled = await f.action(p, 'cancel');
    assert.equal(cancelled.statusCode, 200);
    assert.equal((await f.view()).json().availableMinor, f.shipment().collection.goodsMinor);
    p = (await f.create()).json();
    assert.equal(
      (
        await f.action(p, 'release', 'ops', { amountMinor: f.shipment().collection.totalMinor })
      ).json().code,
      'PAYOUT_AMOUNT_MISMATCH',
    );
    assert.equal((await f.action(p, 'release', 'ops', { currency: 'USD' })).statusCode, 422);
    const old = p;
    p = (await f.action(p, 'release')).json();
    assert.equal((await f.action(old, 'cancel')).json().code, 'VERSION_CONFLICT');
    assert.equal((await f.action(p, 'cancel')).json().code, 'PAYOUT_CUSTODY');
    assert.equal((await f.view('merchant-b')).json().total, 0);
    await assert.rejects(
      f.db.query(
        "INSERT INTO cash_payouts(id,shipment_id,merchant_id,amount_minor,currency) VALUES(gen_random_uuid(),$1,'merchant-b',1,'SYP')",
        [f.shipment().id],
      ),
    );
  } finally {
    await f.close();
  }
});
test('reported shortage preserves in-transit cash and liability until actual full merchant receipt, without auto cancellation or writeoff', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    const goods = f.shipment().collection.goodsMinor;
    assert.equal(
      (await f.action(p, 'confirm', 'merchant-a', { amountMinor: goods - 100 })).statusCode,
      422,
    );
    const key = crypto.randomUUID(),
      issue = await f.action(p, 'report_issue', 'merchant-a', { amountMinor: goods - 100 }, key);
    assert.equal(issue.statusCode, 200, issue.body);
    assert.deepEqual(
      (await f.action(p, 'report_issue', 'merchant-a', { amountMinor: goods - 100 }, key)).json(),
      issue.json(),
    );
    p = issue.json();
    const cash = (await f.get('/api/cash')).json();
    assert.equal(cash.goodsLiabilityMinor, goods);
    assert.equal(cash.payoutInTransitMinor, goods);
    assert.equal((await f.view()).json().rows[0].issueOpen, true);
    assert.equal((await f.action(p, 'cancel')).statusCode, 409);
    const paid = await f.action(p, 'confirm', 'merchant-a');
    assert.equal(paid.statusCode, 200);
    assert.equal((await f.view()).json().rows[0].issueOpen, false);
    assert.equal((await f.get('/api/cash')).json().consistent, true);
    await assert.rejects(f.db.query('DELETE FROM cash_payout_events'));
    assert.equal(
      (await f.view()).json().history.filter((e: { action: string }) => e.action === 'report_issue')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('audit or ledger failures roll back reservations, physical release, receipt, versions and replay result; drift blocks payment', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    await f.db.exec(
      "CREATE FUNCTION reject_payout_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$; CREATE TRIGGER reject_payout_event BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION reject_payout_event();",
    );
    const key = crypto.randomUUID();
    assert.equal((await f.create(key)).statusCode, 500);
    assert.equal((await f.view()).json().total, 0);
    await f.db.exec('DROP TRIGGER reject_payout_event ON cash_payout_events');
    let p = (await f.create(key)).json();
    await f.db.exec(
      'CREATE TRIGGER reject_payout_event BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION reject_payout_event()',
    );
    const releaseKey = crypto.randomUUID();
    assert.equal((await f.action(p, 'release', 'ops', {}, releaseKey)).statusCode, 500);
    assert.equal((await f.view()).json().rows[0].version, 1);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 2);
    await f.db.exec('DROP TRIGGER reject_payout_event ON cash_payout_events');
    p = (await f.action(p, 'release', 'ops', {}, releaseKey)).json();
    await f.db.exec(
      'CREATE TRIGGER reject_payout_event BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION reject_payout_event()',
    );
    const receiveKey = crypto.randomUUID();
    assert.equal((await f.action(p, 'confirm', 'merchant-a', {}, receiveKey)).statusCode, 500);
    assert.equal((await f.view()).json().rows[0].status, 'released');
    assert.equal(
      (await f.get('/api/cash')).json().goodsLiabilityMinor,
      f.shipment().collection.goodsMinor,
    );
    await f.db.exec('DROP TRIGGER reject_payout_event ON cash_payout_events');
    const paid = await f.action(p, 'confirm', 'merchant-a', {}, receiveKey);
    assert.equal(paid.statusCode, 200);
    await f.db.query("UPDATE cash_payouts SET status='released',received_at=NULL WHERE id=$1", [
      p.id,
    ]);
    assert.equal((await f.view()).json().consistent, false);
    assert.equal(
      (await f.action(paid.json(), 'confirm', 'merchant-a')).json().code,
      'CASH_INCONSISTENT',
    );
  } finally {
    await f.close();
  }
});
test('upgrade from collection schema preserves sealed cash entries, then payout custody survives restart without repeating money', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'payout-db-'));
  const f = await payoutFixture(path);
  let closed = false;
  try {
    await f.fund();
    const id = f.shipment().id,
      goods = f.shipment().collection.goodsMinor;
    await restoreCashSchema15(f.db);
    // This isolated fixture recreates schema 12, before commercial returns existed.
    await f.db.exec(
      'DROP TABLE commercial_return_events; DROP TABLE commercial_returns; DROP FUNCTION guard_commercial_return(); DROP INDEX checkout_shipment_pair; DELETE FROM schema_migrations WHERE version IN (18,19,21);',
    );
    await f.db.exec(
      "DROP TRIGGER cash_reversal_valid ON cash_journals; DROP FUNCTION validate_cash_reversal(); ALTER TABLE cash_journals DROP COLUMN reverses_journal_id CASCADE; DELETE FROM schema_migrations WHERE version IN (14,15); DROP INDEX cash_original_journal; DROP INDEX cash_payout_journal; ALTER TABLE cash_journals DROP COLUMN payout_id CASCADE; ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check; ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance')); ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_shipment_id_kind_key UNIQUE(shipment_id,kind); DROP TABLE cash_payout_events; DROP TABLE cash_payouts; DROP INDEX shipment_merchant_owner; DELETE FROM schema_migrations WHERE version=13;",
    );
    await f.close();
    closed = true;
    const next = await fixture(path);
    let payoutId: string;
    try {
      assert.equal((await next.get('/api/cash')).json().consistent, true);
      assert.equal((await next.db.query('SELECT * FROM cash_journals')).rows.length, 2);
      const row = (await next.get('/api/payouts')).json().eligible[0];
      assert.equal(row.amountMinor, goods);
      const created = await next.post('/api/payouts', {
        shipmentId: id,
        expectedCollectionVersion: row.collectionVersion,
        reference: 'ترقية وصرف',
        reason: 'اختبار استمرار المستحقات بعد الترقية',
      });
      assert.equal(created.statusCode, 200, created.body);
      payoutId = created.json().id;
      const released = await next.post(`/api/payouts/${payoutId}/actions`, {
        action: 'release',
        expectedVersion: 1,
        amountMinor: goods,
        currency: 'SYP',
        reference: 'محضر خروج',
        reason: 'خرج النقد بعد الترقية',
      });
      assert.equal(released.statusCode, 200, released.body);
    } finally {
      await next.close();
    }
    const last = await fixture(path);
    try {
      const view = (await last.get('/api/payouts')).json();
      assert.equal(view.rows[0].id, payoutId!);
      assert.equal(view.rows[0].status, 'released');
      assert.equal(view.inTransitMinor, goods);
      assert.equal(view.consistent, true);
      assert.equal((await last.db.query('SELECT * FROM cash_journals')).rows.length, 3);
      assert.equal((await last.get('/api/cash')).json().goodsLiabilityMinor, goods);
    } finally {
      await last.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
