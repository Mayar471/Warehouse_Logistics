import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'payout-browser',
  webhookKey: 'payout-browser-secret',
  demoMode: true,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const cookies: Record<string, string> = {};
for (const accountId of ['ops', 'merchant-a', 'merchant-b', 'courier-b'])
  cookies[accountId] = (
    await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
  ).headers['set-cookie']!.toString().split(';')[0];
cookies.shop = (
  await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
).headers['set-cookie']!.toString().split(';')[0];
async function post(url: string, payload: Record<string, unknown>, who = 'ops') {
  const r = await app.inject({
    method: 'POST',
    url,
    payload,
    headers: { cookie: cookies[who], 'idempotency-key': crypto.randomUUID() },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const q = await post(
  '/api/storefront/checkouts',
  {
    items: [{ productId: 'bag', quantity: 1 }],
    paymentMode: 'cod',
    recipientName: 'عميل صرف تجريبي',
    district: 'الروضة',
    address: 'عنوان اختبار صرف المستحقات',
  },
  'shop',
);
let shipment = (await post('/api/storefront/orders', { checkoutId: q.id }, 'shop')).shipment;
for (const [action, who, extra] of [
  ['prepare', 'merchant-a', {}],
  ['assign', 'ops', { courierId: 'courier-b' }],
  ['accept', 'courier-b', {}],
  ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
  ['pickup', 'courier-b', {}],
  ['depart', 'courier-b', {}],
] as const)
  shipment = await post(
    `/api/shipments/${shipment.id}/actions`,
    { action, expectedVersion: shipment.version, ...extra },
    who,
  );
const proof = await post(`/api/storefront/orders/${shipment.id}/delivery-code`, {}, 'shop');
shipment = await post(
  `/api/shipments/${shipment.id}/actions`,
  {
    action: 'deliver',
    expectedVersion: shipment.version,
    deliveryCode: proof.code,
    cash: {
      amountMinor: shipment.collection.totalMinor,
      currency: 'SYP',
      reference: 'تحصيل عميل الصرف',
    },
  },
  'courier-b',
);
await post(`/api/cash/${shipment.id}/actions`, {
  action: 'receive',
  expectedVersion: shipment.collection.version,
  amountMinor: shipment.collection.totalMinor,
  currency: 'SYP',
  reference: 'إيصال خزينة المصدر',
  reason: 'استلام نقد فعلي تجريبي قبل الصرف',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const lost = new Set(['request_recovery', 'receive_recovery']);
async function pageFor(who: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const [name, value] = cookies[who].split('=');
  await ctx.addCookies([{ name, value, url }]);
  await ctx.route('**/api/**', async (route) => {
    const req = route.request(),
      response = await route.fetch({
        headers: { ...req.headers(), origin: 'http://127.0.0.1:3001' },
      });
    const action =
      req.method() === 'POST' && req.url().includes('/api/payouts')
        ? req.url().endsWith('/api/payouts')
          ? 'create'
          : req.postDataJSON()?.action
        : null;
    if (action && lost.has(action)) {
      lost.delete(action);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'رد اختبار مفقود بعد حفظ الصرف' }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'مستحقات المتاجر', exact: true }).click();
  return page;
}
async function fields(
  page: Awaited<ReturnType<typeof pageFor>>,
  reference: string,
  reason: string,
  amount?: string,
) {
  if (amount !== undefined) await page.getByLabel('المبلغ الفعلي بالليرة السورية').fill(amount);
  await page.getByLabel('مرجع إقرار الصرف').fill(reference);
  await page.getByLabel('سبب إجراء الصرف').fill(reason);
  await page.getByLabel('راجعت أثر الإقرار على النقد والمستحقات وأؤكد التسجيل باسم حسابي.').check();
}
async function commit(page: Awaited<ReturnType<typeof pageFor>>, retry = true) {
  await page.getByRole('button', { name: 'تأكيد إقرار الصرف', exact: true }).click();
  if (retry) {
    await page
      .getByRole('alert')
      .getByText(/لم نتأكد من نتيجة الحفظ/)
      .waitFor();
    assert.equal(await page.getByLabel('مرجع إقرار الصرف').isDisabled(), true);
    await page.getByRole('button', { name: 'تأكيد إقرار الصرف', exact: true }).click();
  }
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
}
try {
  const row = (await app.inject({ url: '/api/payouts', headers: { cookie: cookies.ops } })).json()
    .eligible[0];
  const created = await post('/api/payouts', {
    shipmentId: shipment.id,
    expectedCollectionVersion: row.collectionVersion,
    reference: 'حجز تجربة الإرجاع',
    reason: 'صرف تجريبي قبل الإرجاع',
  });
  await post(`/api/payouts/${created.id}/actions`, {
    action: 'release',
    expectedVersion: created.version,
    amountMinor: shipment.collection.goodsMinor,
    currency: 'SYP',
    reference: 'خروج تجربة الإرجاع',
    reason: 'إقرار خروج كامل النقد',
  });
  await post(
    `/api/payouts/${created.id}/actions`,
    {
      action: 'confirm',
      expectedVersion: 2,
      amountMinor: shipment.collection.goodsMinor,
      currency: 'SYP',
      reference: 'إيصال المتجر الأصلي',
      reason: 'تأكيد استلام كامل الدفعة قبل ردها',
    },
    'merchant-a',
  );
  const merchant = await pageFor('merchant-a');
  await merchant.getByRole('button', { name: 'إقرار رد الدفعة المستلمة', exact: true }).click();
  await fields(merchant, 'محضر إرجاع ١٠١', 'إرجاع كامل النقد إلى العمليات', '185000');
  await commit(merchant);
  await merchant.getByText('رد دفعة مستلمة — بانتظار العمليات', { exact: true }).waitFor();
  assert.equal(
    await merchant.getByRole('button', { name: 'تأكيد استلام المستحقات', exact: true }).count(),
    0,
  );
  const pendingCash = (
    await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })
  ).json();
  assert.equal(pendingCash.goodsLiabilityMinor, 0);
  assert.equal(pendingCash.operationsBalanceMinor, shipment.collection.feeMinor);
  const pendingView = (
    await app.inject({ url: '/api/payouts', headers: { cookie: cookies.ops } })
  ).json();
  assert.equal(pendingView.paidMinor, shipment.collection.goodsMinor);
  assert.equal(pendingView.recoveryPendingMinor, shipment.collection.goodsMinor);
  assert.equal(pendingView.availableMinor, 0);
  const ops = await pageFor('ops');
  await ops.getByRole('button', { name: 'استلام الدفعة المرتجعة', exact: true }).click();
  await fields(ops, 'إيصال رجوع ١٠٢', 'استلمت العمليات كامل النقد فعليًا', '١٨٥٠٠٠');
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await ops.setViewportSize({ width, height: 1100 });
    await ops.evaluate(() => document.fonts.ready);
    assert.ok(await ops.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ops.screenshot({
      path: `artifacts/screenshots/payout-recovery-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await commit(ops);
  await ops.getByText('استُردت الدفعة — المستحق مفتوح مجددًا', { exact: true }).waitFor();
  await ops.getByRole('button', { name: 'حجز صرف المستحق', exact: true }).waitFor();
  const cash = (await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })).json();
  assert.equal(cash.operationsBalanceMinor, shipment.collection.totalMinor);
  assert.equal(cash.payoutInTransitMinor, 0);
  assert.equal(cash.goodsLiabilityMinor, shipment.collection.goodsMinor);
  assert.equal(cash.consistent, true);
  const view = (await app.inject({ url: '/api/payouts', headers: { cookie: cookies.ops } })).json();
  assert.equal(view.consistent, true);
  assert.equal(view.availableMinor, shipment.collection.goodsMinor);
  assert.equal(view.history.length, 5);
  assert.equal(
    (await db.query("SELECT * FROM cash_journals WHERE kind='payout_return'")).rows.length,
    1,
  );
  assert.equal(view.paidMinor, 0);
  assert.equal(view.recoveryPendingMinor, 0);
  assert.equal(
    (await db.query("SELECT * FROM cash_journals WHERE kind='payout_receive_reverse'")).rows.length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Paid merchant recovery and independent operations receipt, lost committed replies in both phases, paired linked reversals and desktop/mobile layouts verified.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
