import { restoreCashSchema15 } from './helpers/cash-returns.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFixture } from './helpers/payouts.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function paid(f: Awaited<ReturnType<typeof payoutFixture>>) {
  await f.fund();
  let p = (await f.create()).json();
  p = (await f.action(p, 'release')).json();
  const r = await f.action(p, 'confirm', 'merchant-a');
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

test('merchant repayment remains paid until independent physical receipt; paired linked reversals reopen liability once and preserve original receipt', async () => {
  const f = await payoutFixture();
  try {
    let p = await paid(f);
    const goods = f.shipment().collection.goodsMinor,
      fee = f.shipment().collection.feeMinor;
    const before = (await f.view()).json().rows[0].receivedAt;
    assert.equal((await f.action(p, 'receive_recovery')).json().code, 'RECOVERY_NOT_REQUESTED');
    assert.equal((await f.action(p, 'request_recovery', 'ops')).statusCode, 403);
    assert.equal((await f.action(p, 'request_recovery', 'merchant-b')).statusCode, 404);
    assert.equal(
      (await f.action(p, 'request_recovery', 'merchant-a', { amountMinor: goods - 1 })).statusCode,
      422,
    );
    assert.equal(
      (await f.action(p, 'request_recovery', 'merchant-a', { currency: 'USD' })).statusCode,
      422,
    );
    f.advance(60_000);
    const key = crypto.randomUUID(),
      request = await f.action(p, 'request_recovery', 'merchant-a', {}, key);
    assert.equal(request.statusCode, 200, request.body);
    assert.deepEqual(
      (await f.action(p, 'request_recovery', 'merchant-a', {}, key)).json(),
      request.json(),
    );
    const old = p;
    p = request.json();
    const pending = (await f.view()).json();
    assert.equal(pending.rows[0].receivedAt, before);
    assert.equal(pending.paidMinor, goods);
    assert.equal(pending.recoveryPendingMinor, goods);
    assert.equal(pending.consistent, true);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, 0);
    assert.equal((await f.create()).json().code, 'PAYOUT_EXISTS');
    assert.equal((await f.action(old, 'receive_recovery')).json().code, 'VERSION_CONFLICT');
    assert.equal((await f.action(p, 'receive_recovery', 'merchant-a')).statusCode, 403);
    assert.equal(
      (await f.action(p, 'receive_recovery', 'ops', { amountMinor: goods - 1 })).statusCode,
      422,
    );
    const rk = crypto.randomUUID(),
      receipt = await f.action(p, 'receive_recovery', 'ops', {}, rk);
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().status, 'recovered');
    assert.deepEqual((await f.action(p, 'receive_recovery', 'ops', {}, rk)).json(), receipt.json());
    const cash = (await f.get('/api/cash')).json(),
      view = (await f.view()).json();
    assert.equal(view.rows[0].receivedAt, before);
    assert.ok(view.rows[0].recoveredAt);
    assert.equal(view.paidMinor, 0);
    assert.equal(view.recoveryPendingMinor, 0);
    assert.equal(view.availableMinor, goods);
    assert.equal(view.consistent, true);
    assert.equal(cash.operationsBalanceMinor, goods + fee);
    assert.equal(cash.goodsLiabilityMinor, goods);
    assert.equal(cash.payoutInTransitMinor, 0);
    assert.equal(cash.deliveryClearingMinor, fee);
    assert.equal(cash.receivedMinor, goods + fee);
    assert.equal(cash.consistent, true);
    const links = (
      await f.db.query<{ kind: string; source: string }>(
        'SELECT j.kind,r.kind AS source FROM cash_journals j JOIN cash_journals r ON r.id=j.reverses_journal_id ORDER BY j.kind',
      )
    ).rows;
    assert.deepEqual(links, [
      { kind: 'payout_receive_reverse', source: 'payout_receive' },
      { kind: 'payout_return', source: 'payout_release' },
    ]);
    const concurrent = await Promise.all([f.create(), f.create()]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
    p = concurrent.find((r) => r.statusCode === 200)!.json();
    p = (await f.action(p, 'release')).json();
    const repaid = await f.action(p, 'confirm', 'merchant-a');
    assert.equal(repaid.statusCode, 200, repaid.body);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, 0);
    assert.equal((await f.view()).json().paidMinor, goods);
    assert.equal((await f.view()).json().consistent, true);
  } finally {
    await f.close();
  }
});

test('failure of second reversal or audit atomically rolls back both linked journals, status and replay result', async () => {
  const f = await payoutFixture();
  try {
    let p = await paid(f);
    await f.db.exec(
      "CREATE FUNCTION fail_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='request_recovery' OR NEW.action='receive_recovery' THEN RAISE EXCEPTION 'test recovery audit failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_recovery BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION fail_recovery();",
    );
    const requestKey = crypto.randomUUID();
    assert.equal(
      (await f.action(p, 'request_recovery', 'merchant-a', {}, requestKey)).statusCode,
      500,
    );
    assert.equal((await f.view()).json().rows[0].recoveryRequested, false);
    await f.db.exec('DROP TRIGGER fail_recovery ON cash_payout_events;');
    p = (await f.action(p, 'request_recovery', 'merchant-a', {}, requestKey)).json();
    const receiveKey = crypto.randomUUID();
    await f.db.exec(
      "CREATE FUNCTION fail_second_reversal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='payout_return' THEN RAISE EXCEPTION 'test second reversal failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_second_reversal BEFORE INSERT ON cash_journals FOR EACH ROW EXECUTE FUNCTION fail_second_reversal();",
    );
    assert.equal((await f.action(p, 'receive_recovery', 'ops', {}, receiveKey)).statusCode, 500);
    await f.db.exec(
      'DROP TRIGGER fail_second_reversal ON cash_journals; DROP FUNCTION fail_second_reversal(); CREATE TRIGGER fail_recovery BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION fail_recovery();',
    );
    assert.equal((await f.action(p, 'receive_recovery', 'ops', {}, receiveKey)).statusCode, 500);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 4);
    assert.equal((await f.view()).json().rows[0].version, p.version);
    assert.equal((await f.view()).json().paidMinor, f.shipment().collection.goodsMinor);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, 0);
    await f.db.exec(
      'DROP TRIGGER fail_recovery ON cash_payout_events; DROP FUNCTION fail_recovery();',
    );
    const received = await f.action(p, 'receive_recovery', 'ops', {}, receiveKey);
    assert.equal(received.statusCode, 200, received.body);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 6);
    await assert.rejects(
      f.db.query("DELETE FROM cash_journals WHERE kind='payout_receive_reverse'"),
    );
  } finally {
    await f.close();
  }
});

test('receipt reversal requires its own receipt source and exactly opposite account details even when balanced', async () => {
  const f = await payoutFixture();
  try {
    const p = await paid(f),
      amount = f.shipment().collection.goodsMinor;
    const originals = (
      await f.db.query<{ id: string; kind: string }>(
        'SELECT id,kind FROM cash_journals WHERE payout_id=$1',
        [p.id],
      )
    ).rows;
    for (const bad of ['source', 'accounts'])
      await assert.rejects(
        f.db.transaction(async (tx) => {
          const id = crypto.randomUUID(),
            source = originals.find(
              (j) => j.kind === (bad === 'source' ? 'payout_release' : 'payout_receive'),
            )!.id;
          await tx.query(
            "INSERT INTO cash_journals(id,shipment_id,kind,currency,amount_minor,payout_id,reverses_journal_id) VALUES($1,$2,'payout_receive_reverse','SYP',$3,$4,$5)",
            [id, f.shipment().id, amount, p.id, source],
          );
          await tx.query(
            "INSERT INTO cash_postings(journal_id,account_code,amount_minor) VALUES($1,$2,$3),($1,'payout_in_transit',$4)",
            [id, bad === 'accounts' ? 'operations_cash' : 'merchant_payable', -amount, amount],
          );
          await tx.query('UPDATE cash_journals SET sealed=true WHERE id=$1', [id]);
        }),
      );
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 4);
  } finally {
    await f.close();
  }
});

test('schema 14 upgrade preserves paid money and receipt history; pending and completed recovery survive restarts', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'payout-recovery-'));
  const f = await payoutFixture(path);
  let closed = false;
  try {
    const p = await paid(f),
      amount = f.shipment().collection.goodsMinor;
    await restoreCashSchema15(f.db);
    await f.db.exec(
      "ALTER TABLE cash_payouts DROP COLUMN recovery_requested CASCADE; ALTER TABLE cash_payouts DROP COLUMN recovered_at CASCADE; DROP INDEX active_cash_payout; CREATE UNIQUE INDEX active_cash_payout ON cash_payouts(shipment_id) WHERE status NOT IN ('cancelled','returned'); ALTER TABLE cash_payouts DROP CONSTRAINT cash_payouts_status_check; ALTER TABLE cash_payouts DROP CONSTRAINT payout_dates; ALTER TABLE cash_payouts ADD CONSTRAINT cash_payouts_status_check CHECK(status IN ('reserved','released','received','cancelled','returned')); ALTER TABLE cash_payouts ADD CONSTRAINT payout_dates CHECK((status IN ('reserved','cancelled') AND released_at IS NULL AND received_at IS NULL) OR (status IN ('released','returned') AND released_at IS NOT NULL AND received_at IS NULL) OR (status='received' AND released_at IS NOT NULL AND received_at IS NOT NULL)); ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check; ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose; ALTER TABLE cash_journals DROP CONSTRAINT reversal_required; ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive','payout_return')); ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive','payout_return') AND payout_id IS NOT NULL)); ALTER TABLE cash_journals ADD CONSTRAINT reversal_required CHECK((kind='payout_return')=(reverses_journal_id IS NOT NULL)); DELETE FROM schema_migrations WHERE version=15;",
    );
    await f.close();
    closed = true;
    const next = await fixture(path);
    let requestVersion: number;
    const command = {
      amountMinor: amount,
      currency: 'SYP',
      reference: 'إيصال ترقية',
      reason: 'استرداد الدفعة بعد ترقية قاعدة الصرف',
    };
    try {
      assert.equal((await next.get('/api/payouts')).json().paidMinor, amount);
      assert.equal((await next.get('/api/payouts')).json().rows[0].recoveryRequested, false);
      assert.equal((await next.db.query('SELECT * FROM cash_journals')).rows.length, 4);
      const r = await next.post(
        `/api/payouts/${p.id}/actions`,
        { ...command, action: 'request_recovery', expectedVersion: p.version },
        'merchant-a',
      );
      assert.equal(r.statusCode, 200, r.body);
      requestVersion = r.json().version;
    } finally {
      await next.close();
    }
    const again = await fixture(path);
    try {
      assert.equal((await again.get('/api/payouts')).json().recoveryPendingMinor, amount);
      assert.equal((await again.get('/api/cash')).json().goodsLiabilityMinor, 0);
      const r = await again.post(`/api/payouts/${p.id}/actions`, {
        ...command,
        action: 'receive_recovery',
        expectedVersion: requestVersion!,
      });
      assert.equal(r.statusCode, 200, r.body);
    } finally {
      await again.close();
    }
    const last = await fixture(path);
    try {
      const view = (await last.get('/api/payouts')).json();
      assert.equal(view.rows[0].status, 'recovered');
      assert.equal(view.availableMinor, amount);
      assert.equal(view.consistent, true);
      assert.equal((await last.get('/api/cash')).json().goodsLiabilityMinor, amount);
      assert.equal((await last.db.query('SELECT * FROM cash_journals')).rows.length, 6);
    } finally {
      await last.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
