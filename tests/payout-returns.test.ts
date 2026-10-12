import { restoreCashSchema15 } from './helpers/cash-returns.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFixture } from './helpers/payouts.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('returned cash requires separate merchant and operations acknowledgements; exact reversal preserves liability and allows one new payout', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    const goods = f.shipment().collection.goodsMinor,
      total = f.shipment().collection.totalMinor;
    assert.equal((await f.action(p, 'receive_return')).json().code, 'RETURN_NOT_REQUESTED');
    assert.equal((await f.action(p, 'request_return', 'ops')).statusCode, 403);
    assert.equal((await f.action(p, 'request_return', 'merchant-b')).statusCode, 404);
    assert.equal(
      (await f.action(p, 'request_return', 'merchant-a', { amountMinor: goods - 1 })).statusCode,
      422,
    );
    const k = crypto.randomUUID(),
      requested = await f.action(p, 'request_return', 'merchant-a', {}, k);
    assert.equal(requested.statusCode, 200, requested.body);
    assert.deepEqual(
      (await f.action(p, 'request_return', 'merchant-a', {}, k)).json(),
      requested.json(),
    );
    const old = p;
    p = requested.json();
    assert.equal((await f.action(old, 'confirm', 'merchant-a')).json().code, 'VERSION_CONFLICT');
    assert.equal((await f.action(p, 'confirm', 'merchant-a')).json().code, 'RETURN_PENDING');
    assert.equal((await f.create()).json().code, 'PAYOUT_EXISTS');
    assert.equal((await f.get('/api/cash')).json().payoutInTransitMinor, goods);
    assert.equal((await f.action(p, 'receive_return', 'merchant-a')).statusCode, 403);
    assert.equal(
      (await f.action(p, 'receive_return', 'ops', { amountMinor: goods - 1 })).statusCode,
      422,
    );
    const rk = crypto.randomUUID(),
      received = await f.action(p, 'receive_return', 'ops', {}, rk);
    assert.equal(received.statusCode, 200, received.body);
    assert.deepEqual((await f.action(p, 'receive_return', 'ops', {}, rk)).json(), received.json());
    assert.equal(received.json().status, 'returned');
    const cash = (await f.get('/api/cash')).json(),
      view = (await f.view()).json();
    assert.equal(cash.operationsBalanceMinor, total);
    assert.equal(cash.payoutInTransitMinor, 0);
    assert.equal(cash.goodsLiabilityMinor, goods);
    assert.equal(cash.consistent, true);
    assert.equal(view.consistent, true);
    assert.equal(view.availableMinor, goods);
    assert.equal(view.inTransitMinor, 0);
    const linked = (
      await f.db.query<{ reverses_journal_id: string; id: string; kind: string }>(
        'SELECT j.reverses_journal_id,r.id,r.kind FROM cash_journals j JOIN cash_journals r ON r.id=j.reverses_journal_id',
      )
    ).rows[0];
    assert.equal(linked.reverses_journal_id, linked.id);
    assert.equal(linked.kind, 'payout_release');
    const concurrent = await Promise.all([f.create(), f.create()]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
    p = concurrent.find((r) => r.statusCode === 200)!.json();
    p = (await f.action(p, 'release')).json();
    const paid = await f.action(p, 'confirm', 'merchant-a');
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal((await f.action(paid.json(), 'request_return', 'merchant-a')).statusCode, 409);
    assert.equal((await f.get('/api/cash')).json().goodsLiabilityMinor, 0);
    assert.equal((await f.view()).json().consistent, true);
    assert.equal(
      (await f.db.query("SELECT * FROM cash_journals WHERE kind='payout_return'")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('failed return audit rolls back reversal, treasury, version and idempotency before retry', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    p = (await f.action(p, 'request_return', 'merchant-a')).json();
    await f.db.exec(
      "CREATE FUNCTION reject_return_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='receive_return' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_return_event BEFORE INSERT ON cash_payout_events FOR EACH ROW EXECUTE FUNCTION reject_return_event();",
    );
    const k = crypto.randomUUID();
    assert.equal((await f.action(p, 'receive_return', 'ops', {}, k)).statusCode, 500);
    assert.equal((await f.view()).json().rows[0].version, p.version);
    assert.equal(
      (await f.db.query("SELECT * FROM cash_journals WHERE kind='payout_return'")).rows.length,
      0,
    );
    assert.equal(
      (await f.get('/api/cash')).json().payoutInTransitMinor,
      f.shipment().collection.goodsMinor,
    );
    await f.db.exec(
      'DROP TRIGGER reject_return_event ON cash_payout_events; DROP FUNCTION reject_return_event();',
    );
    assert.equal((await f.action(p, 'receive_return', 'ops', {}, k)).statusCode, 200);
    assert.equal((await f.view()).json().consistent, true);
    await assert.rejects(f.db.query("DELETE FROM cash_journals WHERE kind='payout_return'"));
  } finally {
    await f.close();
  }
});

test('database rejects a balanced reversal with a different amount from its immutable source', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    const source = (
      await f.db.query<{ id: string }>("SELECT id FROM cash_journals WHERE kind='payout_release'")
    ).rows[0].id;
    await assert.rejects(
      f.db.transaction(async (tx) => {
        const id = crypto.randomUUID();
        await tx.query(
          "INSERT INTO cash_journals(id,shipment_id,kind,currency,amount_minor,payout_id,reverses_journal_id) VALUES($1,$2,'payout_return','SYP',1,$3,$4)",
          [id, f.shipment().id, p.id, source],
        );
        await tx.query(
          "INSERT INTO cash_postings(journal_id,account_code,amount_minor) VALUES($1,'operations_cash',1),($1,'payout_in_transit',-1)",
          [id],
        );
        await tx.query('UPDATE cash_journals SET sealed=true WHERE id=$1', [id]);
      }),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM cash_journals WHERE kind='payout_return'")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('schema 13 upgrade preserves released cash and the completed return survives restart', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'payout-return-'));
  let closed = false;
  const f = await payoutFixture(path);
  try {
    await f.fund();
    let p = (await f.create()).json();
    p = (await f.action(p, 'release')).json();
    const goods = f.shipment().collection.goodsMinor;
    await restoreCashSchema15(f.db);
    await f.db.exec(
      "ALTER TABLE cash_payouts DROP COLUMN recovery_requested CASCADE; ALTER TABLE cash_payouts DROP COLUMN recovered_at CASCADE; DELETE FROM schema_migrations WHERE version=15; DROP TRIGGER cash_reversal_valid ON cash_journals; DROP FUNCTION validate_cash_reversal(); ALTER TABLE cash_journals DROP COLUMN reverses_journal_id CASCADE; ALTER TABLE cash_journals DROP CONSTRAINT cash_journals_kind_check; ALTER TABLE cash_journals DROP CONSTRAINT cash_journal_purpose; ALTER TABLE cash_journals ADD CONSTRAINT cash_journals_kind_check CHECK(kind IN ('collection','remittance','payout_release','payout_receive')); ALTER TABLE cash_journals ADD CONSTRAINT cash_journal_purpose CHECK((kind IN ('collection','remittance') AND payout_id IS NULL) OR (kind IN ('payout_release','payout_receive') AND payout_id IS NOT NULL)); ALTER TABLE cash_payouts DROP COLUMN return_requested CASCADE; ALTER TABLE cash_payouts DROP COLUMN returned_at CASCADE; ALTER TABLE cash_payouts DROP CONSTRAINT payout_dates; ALTER TABLE cash_payouts DROP CONSTRAINT cash_payouts_status_check; ALTER TABLE cash_payouts ADD CONSTRAINT cash_payouts_status_check CHECK(status IN ('reserved','released','received','cancelled')); ALTER TABLE cash_payouts ADD CHECK((status IN ('reserved','cancelled') AND released_at IS NULL AND received_at IS NULL) OR (status='released' AND released_at IS NOT NULL AND received_at IS NULL) OR (status='received' AND released_at IS NOT NULL AND received_at IS NOT NULL)); DROP INDEX active_cash_payout; CREATE UNIQUE INDEX active_cash_payout ON cash_payouts(shipment_id) WHERE status<>'cancelled'; DELETE FROM schema_migrations WHERE version=14;",
    );
    await f.close();
    closed = true;
    const next = await fixture(path);
    const command = async (action: string, version: number, who = 'ops') =>
      next.post(
        `/api/payouts/${p.id}/actions`,
        {
          action,
          expectedVersion: version,
          amountMinor: goods,
          currency: 'SYP',
          reference: 'محضر الترقية',
          reason: 'عودة النقد بعد ترقية قاعدة الصرف',
        },
        who,
      );
    try {
      assert.equal((await next.get('/api/payouts')).json().rows[0].returnRequested, false);
      assert.equal((await next.db.query('SELECT * FROM cash_journals')).rows.length, 3);
      const request = await command('request_return', p.version, 'merchant-a');
      assert.equal(request.statusCode, 200, request.body);
      const receipt = await command('receive_return', request.json().version);
      assert.equal(receipt.statusCode, 200, receipt.body);
    } finally {
      await next.close();
    }
    const last = await fixture(path);
    try {
      const view = (await last.get('/api/payouts')).json();
      assert.equal(view.rows[0].status, 'returned');
      assert.equal(view.availableMinor, goods);
      assert.equal(view.consistent, true);
      assert.equal((await last.db.query('SELECT * FROM cash_journals')).rows.length, 4);
      assert.equal((await last.get('/api/cash')).json().payoutInTransitMinor, 0);
    } finally {
      await last.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
