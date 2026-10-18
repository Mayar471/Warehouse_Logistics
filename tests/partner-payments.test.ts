import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { financialPayload, financialScope } from '../shared/financial-recovery.js';
import { mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture } from './helpers/inventory.js';

async function payable(company = false, path?: string) {
  const f = await cashFixture(false, path);
  let companyId: string | null = null;
  if (company) {
    const r = await f.post('/api/network/companies', {
      name: 'مكتب الصرف',
      address: 'عنوان المكتب دمشق',
      location: { latitude: 33.51, longitude: 36.27 },
      rateBps: 6000,
    });
    assert.equal(r.statusCode, 200, r.body);
    companyId = r.json().id;
  }
  await f.db.query("UPDATE couriers SET company_id=$1,rate_bps=6000 WHERE id='courier-b'", [
    companyId,
  ]);
  if (companyId) {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: 'office-' + companyId },
    });
    assert.equal(r.statusCode, 200, r.body);
    f.cookies.office = r.headers['set-cookie']!.toString().split(';')[0];
  }
  const { code } = await f.route();
  assert.equal((await f.deliver(code)).statusCode, 200);
  const n = (await f.get('/api/execution-earnings')).json().rows[0].amountMinor as number;
  const view = async (who = 'ops') => (await f.get('/api/partner-payments', who)).json();
  const fund = (value = n, reference = 'FUND-' + crypto.randomUUID(), key = crypto.randomUUID()) =>
    f.post(
      '/api/partner-funding',
      { amountMinor: value, currency: 'SYP', reference, reason: 'تمويل مستقل من الشركة' },
      'ops',
      key,
    );
  const reserve = (key = crypto.randomUUID()) =>
    f.post(
      '/api/partner-payments',
      { shipmentId: f.shipment().id, reference: 'حجز آلي', reason: 'حجز أجر التنفيذ' },
      'ops',
      key,
    );
  const act = (
    p: { id: string; version: number },
    action: string,
    who = 'ops',
    actual = n,
    key = crypto.randomUUID(),
  ) =>
    f.post(
      `/api/partner-payments/${p.id}/actions`,
      {
        action,
        expectedVersion: p.version,
        amountMinor: actual,
        currency: 'SYP',
        reference: 'إقرار مالي',
        reason: action === 'report_issue' ? 'استلمت مبلغًا ناقصًا' : 'إقرار مستقل للأجور',
      },
      who,
      key,
    );
  const row = async () => (await view()).rows[0];
  return {
    ...f,
    n,
    view,
    fund,
    reserve,
    act,
    row,
    beneficiary: company ? 'office' : 'courier-b',
    companyId,
  };
}
for (const company of [false, true])
  test(`partner payout ${company ? 'office' : 'independent'} is funded separately, reserved once and confirmed only by beneficiary`, async () => {
    const f = await payable(company);
    try {
      // Even remitted customer cash cannot fund this separate treasury.
      const collection = (await f.get('/api/cash'))
        .json()
        .rows.find((r: { shipmentId: string }) => r.shipmentId === f.shipment().id);
      assert.equal((await f.receipt(collection)).statusCode, 200);
      assert.equal((await f.reserve()).json().code, 'INSUFFICIENT_PARTNER_FUNDS');
      const key = crypto.randomUUID(),
        reference = 'FUND-' + crypto.randomUUID();
      assert.equal((await f.fund(f.n, reference, key)).statusCode, 200);
      assert.equal((await f.fund(f.n, reference, key)).statusCode, 200);
      assert.equal((await f.fund(f.n, reference)).json().code, 'DUPLICATE_FUNDING');
      const requests = await Promise.all([f.reserve(), f.reserve()]);
      assert.deepEqual(requests.map((r) => r.statusCode).sort(), [200, 409]);
      let p = await f.row();
      assert.equal((await f.act(p, 'release', f.beneficiary)).statusCode, 403);
      assert.equal((await f.act(p, 'confirm', 'ops')).statusCode, 403);
      assert.equal((await f.act(p, 'release')).statusCode, 200);
      p = await f.row();
      assert.equal((await f.act({ ...p, version: 1 }, 'cancel')).json().code, 'VERSION_CONFLICT');
      assert.equal(
        (await f.act(p, 'confirm', f.beneficiary, f.n - 1)).json().code,
        'AMOUNT_MISMATCH',
      );
      assert.equal((await f.act(p, 'report_issue', f.beneficiary, f.n - 1)).statusCode, 200);
      p = await f.row();
      assert.equal(p.issueOpen, true);
      const confirmKey = crypto.randomUUID();
      assert.equal((await f.act(p, 'confirm', f.beneficiary, f.n, confirmKey)).statusCode, 200);
      assert.equal((await f.act(p, 'confirm', f.beneficiary, f.n, confirmKey)).statusCode, 200);
      const v = await f.view();
      assert.equal(v.rows[0].status, 'received');
      assert.equal(v.rows[0].issueOpen, false);
      assert.equal(v.balance.paidMinor, f.n);
      assert.equal(v.balance.treasuryMinor, 0);
      assert.equal((await f.get('/api/partner-payments', 'merchant-a')).statusCode, 403);
      assert.equal((await f.view(f.beneficiary)).balance, null);
      if (company) {
        assert.equal((await f.view('courier-b')).rows.length, 0);
        assert.equal((await f.get('/api/company-portal', 'office')).json().couriers.length, 1);
        assert.equal((await f.get('/api/bootstrap', 'office')).json().shipments.length, 0);
        for (const url of ['/api/cash', '/api/shipments', '/api/network/audit', '/api/payouts'])
          assert.equal((await f.get(url, 'office')).statusCode, 403, url);
        const second = await f.post('/api/network/companies', {
          name: 'مكتب آخر',
          address: 'دمشق المزة',
          location: { latitude: 33.5, longitude: 36.2 },
          rateBps: 5000,
        });
        const login = await f.app.inject({
          method: 'POST',
          url: '/api/demo/session',
          payload: { accountId: 'office-' + second.json().id },
        });
        f.cookies.other = login.headers['set-cookie']!.toString().split(';')[0];
        assert.equal((await f.view('other')).rows.length, 0);
        assert.equal((await f.act(await f.row(), 'request_recovery', 'other')).statusCode, 404);
      }
      const posts = (
        await f.db.query<{ value: number }>(
          'SELECT SUM(treasury_minor+in_transit_minor+paid_minor+capital_minor)::double precision value FROM partner_money_entries',
        )
      ).rows[0];
      assert.equal(posts.value, 0);
      await assert.rejects(f.db.query('DELETE FROM partner_money_entries'));
    } finally {
      await f.close();
    }
  });
test('partner return and recovery require two parties, restore funding and allow a new reservation', async () => {
  const f = await payable();
  try {
    await f.fund();
    await f.reserve();
    let p = await f.row();
    await f.act(p, 'release');
    p = await f.row();
    assert.equal((await f.act(p, 'receive_return')).statusCode, 409);
    assert.equal((await f.act(p, 'request_return', f.beneficiary)).statusCode, 200);
    p = await f.row();
    assert.equal((await f.act(p, 'confirm', f.beneficiary)).statusCode, 409);
    assert.equal((await f.act(p, 'receive_return', 'ops', f.n - 1)).statusCode, 409);
    assert.equal((await f.act(p, 'receive_return')).statusCode, 200);
    assert.equal((await f.view()).balance.availableMinor, f.n);
    await f.reserve();
    p = await f.row();
    await f.act(p, 'release');
    p = await f.row();
    await f.act(p, 'confirm', f.beneficiary);
    p = await f.row();
    assert.equal((await f.act(p, 'receive_recovery')).statusCode, 409);
    await f.act(p, 'request_recovery', f.beneficiary);
    p = await f.row();
    assert.equal((await f.act(p, 'receive_recovery')).statusCode, 200);
    assert.equal((await f.view()).balance.paidMinor, 0);
    assert.equal((await f.view()).balance.availableMinor, f.n);
    assert.equal((await f.reserve()).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('partner cancellation returns reservation only; audit failure rolls back release and idempotency', async () => {
  const f = await payable();
  try {
    await f.fund();
    await f.reserve();
    let p = await f.row();
    await f.db.exec(
      `CREATE FUNCTION reject_partner_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='release' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_partner_event BEFORE INSERT ON partner_payment_events FOR EACH ROW EXECUTE FUNCTION reject_partner_event();`,
    );
    const key = crypto.randomUUID();
    assert.equal((await f.act(p, 'release', 'ops', f.n, key)).statusCode, 500);
    assert.equal((await f.row()).version, p.version);
    assert.equal((await f.view()).balance.treasuryMinor, f.n);
    assert.equal(
      (await f.db.query('SELECT key FROM idempotency WHERE key=$1', [key])).rows.length,
      0,
    );
    await f.db.exec('DROP TRIGGER fail_partner_event ON partner_payment_events');
    assert.equal((await f.act(p, 'cancel')).statusCode, 200);
    assert.equal((await f.view()).balance.availableMinor, f.n);
    assert.equal((await f.reserve()).statusCode, 200);
    p = await f.row();
    // Amount/earning and state/ledger drift are rejected rather than silently repaired.
    await f.db.query('UPDATE partner_payments SET amount_minor=amount_minor+1 WHERE id=$1', [p.id]);
    assert.equal((await f.get('/api/partner-payments')).json().code, 'PARTNER_LEDGER_INCONSISTENT');
    await f.db.query('UPDATE partner_payments SET amount_minor=amount_minor-1 WHERE id=$1', [p.id]);
    await f.db.query("UPDATE partner_payments SET status='received' WHERE id=$1", [p.id]);
    assert.equal((await f.get('/api/partner-payments')).json().code, 'PARTNER_LEDGER_INCONSISTENT');
  } finally {
    await f.close();
  }
});
test('new partner financial commands use recoverable scopes and strict payloads', () => {
  const id = crypto.randomUUID();
  for (const [url, extra, scope] of [
    ['/api/partner-funding', { amountMinor: 100, currency: 'SYP' }, 'ops:partner:funding'],
    ['/api/partner-payments', { shipmentId: id }, 'ops:partner:create'],
    [
      `/api/partner-payments/${id}/actions`,
      { action: 'release', expectedVersion: 1, amountMinor: 100, currency: 'SYP' },
      `ops:partner:${id}`,
    ],
  ] as const) {
    const body = { reference: 'مرجع', reason: 'إقرار', ...extra };
    assert.deepEqual(financialPayload(url, JSON.stringify(body)), body);
    assert.equal(financialScope('ops', url), scope);
    assert.throws(() => financialPayload(url, JSON.stringify({ ...body, unknown: 1 })));
  }
});

test('partner payout ledger, pending custody and command receipt survive database restart and migration', async () => {
  const path = await mkdtemp(join(resolve('artifacts'), 'partner-payments-'));
  const f = await payable(false, path);
  let id = '',
    version = 0,
    n = 0,
    shipmentId = '';
  const fundingKey = crypto.randomUUID(),
    reference = 'RESTART-FUND';
  try {
    await f.db.query('DELETE FROM schema_migrations WHERE version=27');
    n = f.n;
    shipmentId = f.shipment().id;
    await f.fund(n, reference, fundingKey);
    await f.reserve();
    const p = await f.row();
    await f.act(p, 'release');
    id = p.id;
    version = (await f.row()).version;
  } finally {
    await f.close();
  }
  const next = await fixture(path);
  try {
    const view = (await next.get('/api/partner-payments')).json();
    assert.equal(view.balance.inTransitMinor, n);
    assert.equal(view.rows[0].version, version);
    assert.equal(
      (await next.db.query('SELECT version FROM schema_migrations WHERE version=27')).rows.length,
      1,
    );
    const body = JSON.stringify({
      amountMinor: n,
      currency: 'SYP',
      reference,
      reason: 'تمويل مستقل من الشركة',
    });
    assert.equal(
      (
        await next.post('/api/financial-commands/status', {
          url: '/api/partner-funding',
          body,
          key: fundingKey,
        })
      ).json().state,
      'committed',
    );
    const wrongActor = await next.app.inject({
      method: 'POST',
      url: `/api/partner-payments/${id}/actions`,
      headers: {
        cookie: next.cookies['courier-b'],
        'idempotency-key': crypto.randomUUID(),
        'x-financial-actor': 'ops',
      },
      payload: {
        action: 'confirm',
        expectedVersion: version,
        amountMinor: n,
        currency: 'SYP',
        reference: 'إقرار',
        reason: 'استلام مستقل',
      },
    });
    assert.equal(wrongActor.json().code, 'ACCOUNT_CHANGED');
    assert.equal(
      (
        await next.post(
          `/api/partner-payments/${id}/actions`,
          {
            action: 'confirm',
            expectedVersion: version,
            amountMinor: n,
            currency: 'SYP',
            reference: 'إقرار',
            reason: 'استلام مستقل',
          },
          'courier-b',
        )
      ).statusCode,
      200,
    );
    assert.equal((await next.get('/api/partner-payments')).json().balance.paidMinor, n);
    assert.equal(
      (
        await next.db.query('SELECT shipment_id FROM execution_earnings WHERE shipment_id=$1', [
          shipmentId,
        ])
      ).rows.length,
      1,
    );
  } finally {
    await next.close();
  }
  // Preserved under ignored artifacts for inspection; no user database is used or deleted.
});
