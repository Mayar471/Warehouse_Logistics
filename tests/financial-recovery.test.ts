import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFixture } from './helpers/payouts.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('financial receipt lookup distinguishes an exact committed command from unknown or conflicting content without exposing another actor or changing journals', async () => {
  const f = await payoutFixture();
  try {
    const { code } = await f.route();
    await f.deliver(code);
    const row = await f.row();
    const body = {
        action: 'receive',
        expectedVersion: row.version,
        amountMinor: row.totalMinor,
        currency: 'SYP',
        reference: '  إيصال المحصل  ',
        reason: '  استلام نقد كامل  ',
      },
      key = crypto.randomUUID(),
      url = `/api/cash/${row.shipmentId}/actions`;
    const lookup = (payload = body, who = 'ops', k = key) =>
      f.post('/api/financial-commands/status', { url, body: JSON.stringify(payload), key: k }, who);
    assert.equal((await lookup()).json().state, 'unknown');
    const committed = await f.post(url, body, 'ops', key);
    assert.equal(committed.statusCode, 200, committed.body);
    const count = (await f.db.query('SELECT * FROM idempotency')).rows.length;
    assert.equal((await lookup()).json().state, 'committed');
    assert.equal(
      (
        await lookup({ ...body, reference: body.reference.trim(), reason: body.reason.trim() })
      ).json().state,
      'committed',
    );
    assert.equal((await lookup({ ...body, amountMinor: 1 })).json().state, 'conflict');
    assert.equal((await lookup(body, 'merchant-a')).json().state, 'unknown');
    assert.equal((await lookup(body, 'courier-b')).json().state, 'unknown');
    assert.equal((await f.db.query('SELECT * FROM idempotency')).rows.length, count);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 2);
    const unsupported = await f.post('/api/financial-commands/status', {
      url: '/api/session',
      body: JSON.stringify(body),
      key,
    });
    assert.equal(unsupported.statusCode, 422);
  } finally {
    await f.close();
  }
});

test('financial actor header prevents stale session cash or payout execution; receipt lookup uses the matching cash and payout namespaces', async () => {
  const f = await payoutFixture();
  try {
    await f.fund();
    const row = await f.row();
    const createBody = {
      shipmentId: row.shipmentId,
      expectedCollectionVersion: row.version,
      reference: 'حجز محفوظ',
      reason: 'اختبار استعادة حجز الصرف',
    };
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/payouts',
      headers: {
        cookie: f.cookies.ops,
        'idempotency-key': crypto.randomUUID(),
        'x-financial-actor': 'merchant-a',
      },
      payload: createBody,
    });
    assert.equal(stale.json().code, 'ACCOUNT_CHANGED');
    const cash = await f.app.inject({
      method: 'POST',
      url: `/api/cash/${row.shipmentId}/actions`,
      headers: {
        cookie: f.cookies.ops,
        'idempotency-key': crypto.randomUUID(),
        'x-financial-actor': 'courier-b',
      },
      payload: {
        action: 'return_request',
        expectedVersion: row.version,
        amountMinor: row.totalMinor,
        currency: 'SYP',
        reference: 'طلب محفوظ',
        reason: 'اختبار حساب مختلف',
      },
    });
    assert.equal(cash.json().code, 'ACCOUNT_CHANGED');
    assert.equal((await f.view()).json().total, 0);
    const key = crypto.randomUUID(),
      created = await f.post('/api/payouts', createBody, 'ops', key);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(
      (
        await f.post('/api/financial-commands/status', {
          url: '/api/payouts',
          body: JSON.stringify(createBody),
          key,
        })
      ).json().state,
      'committed',
    );
    const p = created.json(),
      action = {
        action: 'release',
        expectedVersion: p.version,
        amountMinor: row.goodsMinor,
        currency: 'SYP',
        reference: 'خروج محفوظ',
        reason: 'اختبار استعادة إقرار خروج',
      },
      actionKey = crypto.randomUUID(),
      url = `/api/payouts/${p.id}/actions`;
    assert.equal((await f.post(url, action, 'ops', actionKey)).statusCode, 200);
    assert.equal(
      (
        await f.post('/api/financial-commands/status', {
          url,
          body: JSON.stringify(action),
          key: actionKey,
        })
      ).json().state,
      'committed',
    );
    const mismatch = await f.app.inject({
      method: 'POST',
      url: '/api/financial-commands/status',
      headers: { cookie: f.cookies.ops, 'x-financial-actor': 'merchant-a' },
      payload: { url, body: JSON.stringify(action), key: actionKey },
    });
    assert.equal(mismatch.statusCode, 403);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 3);
  } finally {
    await f.close();
  }
});

test('committed financial command remains discoverable after database restart with no replayed cash or new migration', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'financial-recovery-'));
  const f = await payoutFixture(path);
  let closed = false;
  try {
    await f.fund();
    const row = await f.row(),
      key = crypto.randomUUID(),
      url = '/api/payouts',
      body = {
        shipmentId: row.shipmentId,
        expectedCollectionVersion: row.version,
        reference: 'حجز قبل الإغلاق',
        reason: 'اختبار استمرار نتيجة الإقرار',
      };
    const result = await f.post(url, body, 'ops', key);
    assert.equal(result.statusCode, 200, result.body);
    await f.close();
    closed = true;
    const next = await fixture(path);
    try {
      assert.equal(
        (
          await next.post('/api/financial-commands/status', {
            url,
            body: JSON.stringify(body),
            key,
          })
        ).json().state,
        'committed',
      );
      assert.equal((await next.db.query('SELECT * FROM cash_journals')).rows.length, 2);
      assert.equal((await next.get('/api/payouts')).json().total, 1);
    } finally {
      await next.close();
    }
  } finally {
    if (!closed) await f.close();
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
