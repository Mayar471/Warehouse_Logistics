import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture } from './helpers/inventory.js';
import { cashFixture } from './helpers/cash.js';
async function setup(path?: string) {
  const f = await fixture(path);
  let s = (await f.order((await f.checkout()).id)).json().shipment;
  s = await f.act(s, 'assign', 'ops', { courierId: 'courier-b' });
  const prefix = (who: string) => (who === 'shop' ? '/api/storefront/disputes' : '/api/disputes');
  const get = (url: string, who = 'ops') =>
    f.app.inject({ url, headers: { cookie: who === 'shop' ? f.shop : f.cookies[who] } });
  const create = (who = 'shop', key = crypto.randomUUID(), subjectId = s.id, topic = 'delay') =>
    f.post(
      prefix(who),
      { subjectKind: 'shipment', subjectId, topic, summary: 'أرجو مراجعة تأخر تنفيذ هذا الطلب' },
      who,
      key,
    );
  const detail = async (id: string, who = 'ops') => get(prefix(who) + '/' + id, who);
  const act = (
    id: string,
    version: number,
    action: string,
    who = 'ops',
    extra: Record<string, unknown> = {},
    key = crypto.randomUUID(),
  ) =>
    f.post(
      prefix(who) + '/' + id + '/actions',
      { action, expectedVersion: version, text: 'إجراء متابعة موثق للاختبار', ...extra },
      who,
      key,
    );
  return { ...f, s, get, create, detail, act };
}
test('case creation is source scoped, freezes participants, prevents duplicate cases and rejects forged actor', async () => {
  const f = await setup();
  try {
    assert.equal((await f.create('merchant-b')).statusCode, 404);
    const key = crypto.randomUUID(),
      r = await f.create('shop', key);
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    assert.equal((await f.create('shop', key)).json().id, id);
    assert.equal((await f.create()).json().code, 'CASE_EXISTS');
    assert.equal((await f.detail(id, 'merchant-b')).statusCode, 404);
    assert.equal((await f.detail(id, 'courier-b')).statusCode, 200);
    const other = (
      await f.app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
    ).headers['set-cookie']!.toString().split(';')[0];
    assert.equal(
      (await f.app.inject({ url: '/api/storefront/disputes/' + id, headers: { cookie: other } }))
        .statusCode,
      404,
    );
    const d = (await f.detail(id)).json();
    assert.equal(
      d.participants.some((p: { role: string }) => p.role === 'customer'),
      true,
    );
    assert.equal(JSON.stringify(d).includes('customer:'), false);
    const mismatch = await f.app.inject({
      method: 'POST',
      url: `/api/disputes/${id}/actions`,
      headers: {
        cookie: f.cookies['courier-b'],
        'x-dispute-actor': 'ops',
        'idempotency-key': crypto.randomUUID(),
      },
      payload: { action: 'reply', expectedVersion: 1, text: 'رد من حساب سابق' },
    });
    assert.equal(mismatch.json().code, 'ACCOUNT_CHANGED');
    const shipment = (await f.get('/api/shipments/' + f.s.id)).json().shipment;
    const unassign = await f.post(
      '/api/shipments/' + f.s.id + '/actions',
      {
        action: 'unassign',
        expectedVersion: shipment.version,
        reason: 'إعادة إسناد المهمة لاختبار عزل الحالة',
      },
      'ops',
    );
    assert.equal(unassign.statusCode, 200, unassign.body);
    const reassigned = await f.post(
      '/api/shipments/' + f.s.id + '/actions',
      { action: 'assign', expectedVersion: unassign.json().version, courierId: 'courier-a' },
      'ops',
    );
    assert.equal(reassigned.statusCode, 200);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: 'courier-a' },
    });
    f.cookies['courier-a'] = login.headers['set-cookie']!.toString().split(';')[0];
    assert.equal((await f.detail(id, 'courier-a')).statusCode, 404);
    assert.equal((await f.detail(id, 'courier-b')).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('office dispute and notifications expose only its payment beneficiary, while transfers stay within merchant scope', async () => {
  const f = await cashFixture();
  try {
    const office = (
      await f.post('/api/network/companies', {
        name: 'مكتب متابعة الأجر',
        address: 'عنوان تجريبي دمشق',
        location: { latitude: 33.51, longitude: 36.27 },
        rateBps: 6000,
      })
    ).json();
    await f.db.query("UPDATE couriers SET company_id=$1 WHERE id='courier-b'", [office.id]);
    const { code } = await f.route();
    assert.equal((await f.deliver(code)).statusCode, 200);
    const earning = (await f.get('/api/execution-earnings')).json().rows[0];
    await f.post('/api/partner-funding', {
      amountMinor: earning.amountMinor,
      currency: 'SYP',
      reference: 'FUND-DISPUTE',
      reason: 'تمويل مستقل للأجور',
    });
    const payment = (
      await f.post('/api/partner-payments', {
        shipmentId: f.shipment().id,
        reference: 'حجز أجر',
        reason: 'حجز من تمويل مستقل',
      })
    ).json();
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: 'office-' + office.id },
    });
    f.cookies.office = login.headers['set-cookie']!.toString().split(';')[0];
    const r = await f.post(
      '/api/disputes',
      {
        subjectKind: 'partner_payment',
        subjectId: payment.id,
        topic: 'payment',
        summary: 'يرجى متابعة صرف الأجر المحجوز',
      },
      'office',
    );
    assert.equal(r.statusCode, 200, r.body);
    const feed = (await f.get('/api/notifications', 'office')).json();
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].kind, 'dispute');
    assert.equal((await f.get('/api/disputes/' + r.json().id, 'courier-b')).statusCode, 404);
    assert.equal(
      (await f.get('/api/disputes/subjects?kind=shipment', 'office')).json().rows.length,
      0,
    );
    assert.equal(
      (
        await f.post(
          '/api/disputes',
          {
            subjectKind: 'shipment',
            subjectId: f.shipment().id,
            topic: 'delivery',
            summary: 'طلب لا يخص حساب المكتب',
          },
          'office',
        )
      ).statusCode,
      404,
    );
    const before = (await f.get('/api/partner-payments')).json().balance;
    const d = (await f.get('/api/disputes/' + r.json().id)).json();
    await f.post('/api/disputes/' + r.json().id + '/actions', {
      action: 'resolve',
      expectedVersion: d.case.version,
      decision: 'referred_finance',
      text: 'إحالة للمالية دون تغيير صندوق الأجر',
    });
    assert.deepEqual((await f.get('/api/partner-payments')).json().balance, before);
    const site = (
      await f.post('/api/inventory/sites', {
        merchantId: 'merchant-a',
        name: 'موقع متابعة النقل',
        address: 'عنوان نقل داخل دمشق',
        products: ['bag'],
        reason: 'تهيئة نقل تجريبي',
      })
    ).json();
    const transfer = await f.post('/api/inventory/transfers', {
      merchantId: 'merchant-a',
      sourceId: 'site-a',
      destinationId: site.id,
      items: [{ productId: 'bag', quantity: 1, sourceVersion: (await f.stock()).version }],
      reason: 'نقل داخلي لاختبار المتابعة',
    });
    assert.equal(transfer.statusCode, 200, transfer.body);
    const t = await f.post(
      '/api/disputes',
      {
        subjectKind: 'transfer',
        subjectId: transfer.json().id,
        topic: 'delay',
        summary: 'يرجى متابعة تنفيذ النقل الداخلي',
      },
      'merchant-a',
    );
    assert.equal(t.statusCode, 200, t.body);
    assert.equal((await f.get('/api/disputes/' + t.json().id, 'merchant-b')).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('case pages and actionable metrics cover the full authorized scope beyond one page', async () => {
  const f = await setup();
  try {
    await f.create();
    for (let i = 0; i < 26; i++) {
      const s = (await f.order((await f.checkout()).id)).json().shipment;
      assert.equal((await f.create('shop', crypto.randomUUID(), s.id)).statusCode, 200);
    }
    const first = (await f.get('/api/disputes')).json();
    assert.equal(first.total, 27);
    assert.equal(first.rows.length, 25);
    assert.equal(first.stats.active, 27);
    assert.equal((await f.get('/api/disputes?page=1')).json().rows.length, 2);
    assert.equal(
      (await f.get('/api/disputes?search=' + encodeURIComponent(f.s.reference))).json().total,
      1,
    );
    assert.equal((await f.get('/api/disputes?search=%25')).json().total, 0);
    assert.equal((await f.get('/api/disputes', 'merchant-b')).json().total, 0);
  } finally {
    await f.close();
  }
});
test('requested reply, internal notes and notification reads preserve participant privacy and correct responsibility', async () => {
  const f = await setup();
  try {
    const id = (await f.create()).json().id;
    let d = (await f.detail(id)).json();
    const merchant = d.participants.find((p: { role: string }) => p.role === 'merchant');
    assert.equal(
      (await f.act(id, d.case.version, 'request_reply', 'ops', { participantId: merchant.id }))
        .statusCode,
      200,
    );
    d = (await f.detail(id, 'merchant-a')).json();
    assert.equal(d.case.waitingForMe, true);
    const feed = async () =>
      (await f.get('/api/storefront/notifications', 'shop'))
        .json()
        .items.filter((n: { kind: string }) => n.kind === 'dispute');
    const seen = await feed();
    assert.equal(seen.length, 1);
    assert.equal(
      (await f.post('/api/storefront/notifications/read', { ids: [seen[0].id] }, 'shop'))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.act(id, d.case.version, 'internal_note', 'ops', {
          text: 'ملاحظة تحقيق خاصة لا تظهر للعميل',
        })
      ).statusCode,
      200,
    );
    assert.equal((await feed())[0].id, seen[0].id);
    assert.equal((await feed())[0].read, true);
    const customer = (await f.detail(id, 'shop')).json();
    assert.equal(JSON.stringify(customer).includes('ملاحظة تحقيق خاصة'), false);
    assert.equal((await f.act(id, customer.case.version, 'reply', 'courier-b')).statusCode, 200);
    d = (await f.detail(id, 'merchant-a')).json();
    assert.equal(d.case.status, 'waiting_reply');
    assert.equal(d.case.waitingForMe, true);
    assert.equal((await f.act(id, d.case.version, 'reply', 'merchant-a')).statusCode, 200);
    assert.equal((await f.detail(id)).json().case.status, 'under_review');
    assert.equal(
      (await f.act(id, (await f.detail(id)).json().case.version, 'internal_note', 'shop'))
        .statusCode,
      403,
    );
    await assert.rejects(f.db.query('DELETE FROM dispute_events WHERE dispute_id=$1', [id]));
  } finally {
    await f.close();
  }
});
test('case decision requires assigned operations, supports appeal and requester closure without modifying cash or custody', async () => {
  const f = await setup();
  try {
    const id = (await f.create()).json().id;
    const before = (await f.get('/api/shipments/' + f.s.id)).json();
    assert.equal(
      (await f.act(id, 1, 'resolve', 'merchant-a', { decision: 'no_action' })).statusCode,
      403,
    );
    assert.equal(
      (await f.act(id, 1, 'assign', 'ops', { assigneeId: 'merchant-a', dueHours: 4 })).json().code,
      'INVALID_ASSIGNEE',
    );
    assert.equal(
      (
        await f.act(id, 1, 'resolve', 'ops', {
          decision: 'referred_finance',
          text: 'إحالة للمالية لمراجعة السند دون تنفيذ صرف',
        })
      ).statusCode,
      200,
    );
    let d = (await f.detail(id)).json();
    assert.equal((await f.act(id, d.case.version, 'close', 'ops')).statusCode, 403);
    assert.equal((await f.act(id, d.case.version, 'reopen', 'shop')).statusCode, 200);
    d = (await f.detail(id)).json();
    assert.equal(d.case.decision, null);
    await f.act(id, d.case.version, 'resolve', 'ops', { decision: 'operational_guidance' });
    d = (await f.detail(id)).json();
    assert.equal((await f.act(id, d.case.version, 'close', 'shop')).statusCode, 200);
    assert.equal((await f.act(id, d.case.version + 1, 'reply', 'shop')).json().code, 'CASE_CLOSED');
    assert.deepEqual((await f.get('/api/shipments/' + f.s.id)).json(), before);
    assert.equal((await f.db.query('SELECT id FROM partner_payments')).rows.length, 0);
    assert.equal((await f.create()).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('overdue filters and escalation use server clock, remain visible without workers and retain a single escalation per cycle', async () => {
  const f = await setup();
  try {
    const id = (await f.create()).json().id;
    assert.equal((await f.act(id, 1, 'escalate', 'shop')).json().code, 'ESCALATION_UNAVAILABLE');
    f.advance(24 * 3600000 + 1);
    const v = (await f.get('/api/disputes?attention=overdue')).json();
    assert.equal(v.total, 1);
    assert.equal(v.stats.overdue, 1);
    const d = (await f.detail(id)).json();
    assert.equal(d.case.overdue, true);
    const key = crypto.randomUUID();
    assert.equal((await f.act(id, 1, 'escalate', 'shop', {}, key)).statusCode, 200);
    assert.equal((await f.act(id, 1, 'escalate', 'shop', {}, key)).statusCode, 200);
    assert.equal((await f.get('/api/disputes?attention=escalated')).json().total, 1);
    assert.equal((await f.act(id, 2, 'escalate', 'shop')).json().code, 'ESCALATION_UNAVAILABLE');
    assert.equal((await f.act(id, 1, 'reply', 'shop')).json().code, 'VERSION_CONFLICT');
    const feed = (await f.get('/api/storefront/notifications', 'shop')).json();
    assert.equal(
      feed.items.some(
        (n: { kind: string; title: string }) => n.kind === 'dispute' && n.title.includes('تجاوزت'),
      ),
      true,
    );
  } finally {
    await f.close();
  }
});
test('audit failures roll back case and participant creation, versions and idempotency receipts', async () => {
  const f = await setup();
  try {
    await f.db.exec(
      `CREATE FUNCTION reject_dispute_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_dispute_event BEFORE INSERT ON dispute_events FOR EACH ROW EXECUTE FUNCTION reject_dispute_event();`,
    );
    const key = crypto.randomUUID();
    assert.equal((await f.create('shop', key)).statusCode, 500);
    assert.equal((await f.db.query('SELECT id FROM disputes')).rows.length, 0);
    assert.equal((await f.db.query('SELECT id FROM dispute_participants')).rows.length, 0);
    assert.equal(
      (await f.db.query('SELECT key FROM idempotency WHERE key=$1', [key])).rows.length,
      0,
    );
    await f.db.exec('DROP TRIGGER fail_dispute_event ON dispute_events');
    const id = (await f.create('shop', key)).json().id;
    await f.db.exec(
      'CREATE TRIGGER fail_dispute_event BEFORE INSERT ON dispute_events FOR EACH ROW EXECUTE FUNCTION reject_dispute_event()',
    );
    assert.equal((await f.act(id, 1, 'reply', 'shop')).statusCode, 500);
    assert.equal((await f.detail(id)).json().case.version, 1);
  } finally {
    await f.close();
  }
});
test('case, private history and immutable participant scope survive schema migration and database restart', async () => {
  const path = await mkdtemp(join(resolve('artifacts'), 'disputes-'));
  const f = await setup(path);
  let id = '';
  try {
    id = (await f.create()).json().id;
    await f.act(id, 1, 'internal_note', 'ops', { text: 'ملاحظة خاصة قبل إعادة التشغيل' });
    await f.db.query('DELETE FROM schema_migrations WHERE version=29');
  } finally {
    await f.close();
  }
  const next = await fixture(path);
  try {
    const d = (await next.get('/api/disputes/' + id)).json();
    assert.equal(d.case.version, 2);
    assert.equal(d.events.length, 2);
    assert.equal((await next.get('/api/disputes/' + id, 'merchant-b')).statusCode, 404);
    assert.equal(
      (await next.db.query('SELECT version FROM schema_migrations WHERE version=29')).rows.length,
      1,
    );
  } finally {
    await next.close();
  }
});
