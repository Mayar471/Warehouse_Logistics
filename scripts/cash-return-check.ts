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
const errors: string[] = [],
  lost = new Set(['return_request', 'return_release', 'return_confirm', 'receive']);
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
      req.method() === 'POST' && req.url().includes('/api/cash/')
        ? req.postDataJSON()?.action
        : null;
    if (action && lost.has(action)) {
      lost.delete(action);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'رد مفقود بعد حفظ تصحيح الحوالة' }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'التحصيل وعهدة النقد', exact: true }).click();
  return page;
}
async function fields(page: Awaited<ReturnType<typeof pageFor>>, reference: string) {
  await page
    .getByLabel('المبلغ المعدود فعليًا بالليرة السورية')
    .fill(String(shipment.collection.totalMinor / 100));
  await page.getByLabel('مرجع الإيصال أو محضر الفرق').fill(reference);
  await page.getByLabel('سبب الإقرار المالي').fill('تصحيح حوالة مع عد كامل النقد فعليًا');
  await page.getByLabel('راجعت المبلغ والمرجع وأؤكد الإقرار باسم حسابي.').check();
}
async function commit(page: Awaited<ReturnType<typeof pageFor>>) {
  await page.getByRole('button', { name: 'تأكيد الإقرار المالي', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('مرجع الإيصال أو محضر الفرق').isDisabled(), true);
  await page.getByRole('button', { name: 'تأكيد الإقرار المالي', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
}
async function cash() {
  return (await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })).json();
}
try {
  const total = shipment.collection.totalMinor;
  const ops = await pageFor('ops');
  await ops.getByRole('button', { name: 'طلب رجوع الحوالة', exact: true }).click();
  await fields(ops, 'طلب رجوع ١٠١');
  await commit(ops);
  assert.equal((await cash()).operationsBalanceMinor, total);
  await ops.getByRole('button', { name: 'تسليم نقد الحوالة المرتجع', exact: true }).click();
  await fields(ops, 'تسليم رجوع ١٠٢');
  await commit(ops);
  const released = await cash();
  assert.equal(released.operationsBalanceMinor, 0);
  assert.equal(released.remittanceReturnTransitMinor, total);
  assert.equal(released.heldMinor, 0);
  assert.equal(released.consistent, true);
  assert.equal(
    await ops.getByRole('button', { name: 'تأكيد استلام الحوالة المرتجعة', exact: true }).count(),
    0,
  );
  const courier = await pageFor('courier-b');
  await courier.getByRole('button', { name: 'تأكيد استلام الحوالة المرتجعة', exact: true }).click();
  await fields(courier, 'وصول للمحصل ١٠٣');
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await courier.setViewportSize({ width, height: 1100 });
    await courier.evaluate(() => document.fonts.ready);
    assert.ok(await courier.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await courier.screenshot({
      path: `artifacts/screenshots/cash-return-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await commit(courier);
  await courier.getByText('في عهدة المحصل', { exact: true }).waitFor();
  const returned = await cash();
  assert.equal(returned.heldMinor, total);
  assert.equal(returned.netRemittedMinor, 0);
  assert.equal(returned.remittanceReturnTransitMinor, 0);
  assert.equal(returned.goodsLiabilityMinor, shipment.collection.goodsMinor);
  assert.equal(returned.consistent, true);
  await ops.getByRole('button', { name: 'تحديث العهدة المالية', exact: true }).click();
  await ops.getByRole('button', { name: 'استلام عهدة الأموال', exact: true }).click();
  await fields(ops, 'حوالة جديدة ١٠٤');
  await commit(ops);
  const received = await cash();
  assert.equal(received.receivedMinor, total * 2);
  assert.equal(received.netRemittedMinor, total);
  assert.equal(received.operationsBalanceMinor, total);
  assert.equal(received.heldMinor, 0);
  assert.equal(received.consistent, true);
  assert.equal(received.rows[0].remittanceCount, 2);
  assert.equal(
    (await db.query("SELECT * FROM cash_journals WHERE kind='collection'")).rows.length,
    1,
  );
  assert.equal(
    (await db.query("SELECT * FROM cash_journals WHERE kind='remittance_reverse'")).rows.length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Three independent cash return phases, lost committed replies, collector ownership, unchanged customer collection, re-remittance and responsive layouts verified.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
