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
const lost = new Set(['create', 'release', 'confirm']);
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
  const ops = await pageFor('ops');
  await ops.getByRole('button', { name: 'حجز صرف المستحق', exact: true }).click();
  await fields(ops, 'حجز مستحق ١٠١', 'حجز قيمة البضائع التي وصلت نقدًا');
  await commit(ops);
  await ops.getByRole('button', { name: 'تسليم نقد المستحقات', exact: true }).click();
  await fields(ops, 'محضر تسليم ١٠٢', 'خروج نقد المستحقات للتسليم إلى المتجر', '١٨٥٠٠٠');
  await mkdir('artifacts/screenshots', { recursive: true });
  await ops.screenshot({
    path: 'artifacts/screenshots/payout-release-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await commit(ops);
  await ops.getByText('خرج النقد — بانتظار المتجر', { exact: true }).waitFor();
  assert.equal(
    await ops.getByRole('button', { name: 'تأكيد استلام المستحقات', exact: true }).count(),
    0,
  );
  const merchant = await pageFor('merchant-a');
  await merchant.getByRole('button', { name: 'توثيق فرق في الاستلام', exact: true }).click();
  await fields(merchant, 'محضر نقص ١٠٣', 'فرق عند عد مبلغ المستحقات', '184999');
  await commit(merchant, false);
  await merchant
    .getByText('فرق موثق مفتوح. المال خارج العمليات، والمستحقات لم تُغلق.', { exact: true })
    .waitFor();
  await merchant.getByRole('button', { name: 'تأكيد استلام المستحقات', exact: true }).click();
  await fields(merchant, 'إيصال متجر ١٠٤', 'استلام كامل المستحق بعد مراجعة الفرق', '185000');
  for (const width of [1440, 390, 360]) {
    await merchant.setViewportSize({ width, height: 1100 });
    await merchant.evaluate(() => document.fonts.ready);
    if (!(await merchant.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) {
      await merchant.screenshot({
        path: `artifacts/screenshots/payout-overflow-${width}.png`,
        fullPage: true,
      });
      console.log(
        await merchant.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          elements: Array.from(document.querySelectorAll('*'))
            .filter(
              (e) =>
                (e.getBoundingClientRect().right > innerWidth + 1 ||
                  e.getBoundingClientRect().left < -1) &&
                getComputedStyle(e).visibility !== 'hidden' &&
                !e.closest('.sidebar'),
            )
            .slice(0, 12)
            .map((e) => ({
              tag: e.tagName,
              class: e.className,
              width: e.getBoundingClientRect().width,
              left: e.getBoundingClientRect().left,
              right: e.getBoundingClientRect().right,
              text: e.textContent?.slice(0, 100),
            })),
        })),
      );
    }
    assert.ok(await merchant.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await merchant.screenshot({
      path: `artifacts/screenshots/payout-receipt-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await commit(merchant);
  await merchant.getByText('أكد المتجر الاستلام', { exact: true }).waitFor();
  const unrelated = await pageFor('merchant-b');
  await unrelated.getByText('لا توجد مستحقات قابلة للصرف في نطاقك', { exact: true }).waitFor();
  const cash = (await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })).json();
  assert.equal(cash.goodsLiabilityMinor, 0);
  assert.equal(cash.operationsBalanceMinor, shipment.collection.feeMinor);
  assert.equal(cash.payoutInTransitMinor, 0);
  assert.equal(cash.consistent, true);
  const payouts = (
    await app.inject({ url: '/api/payouts', headers: { cookie: cookies.ops } })
  ).json();
  assert.equal(payouts.total, 1);
  assert.equal(payouts.paidMinor, shipment.collection.goodsMinor);
  assert.equal(payouts.history.length, 4);
  assert.equal(payouts.consistent, true);
  assert.equal((await db.query('SELECT * FROM cash_journals')).rows.length, 4);
  assert.deepEqual(errors, []);
  console.log(
    'Payout reservation/release/merchant receipt, lost replies in all three phases, shortage, isolation and 1440/390/360 layouts verified.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
