import { chromium } from '@playwright/test';
import staticFiles from '@fastify/static';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'resolution-browser',
  webhookKey: 'resolution-browser-secret',
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
for (const accountId of ['ops', 'merchant-a', 'courier-b'])
  cookies[accountId] = (
    await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
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
const site = await post('/api/inventory/sites', {
  merchantId: 'merchant-a',
  name: 'مستودع الفحص',
  address: 'عنوان وجهة اختبار في دمشق',
  products: ['bag', 'cup'],
  reason: 'إعداد وجهة تسوية النقل',
});
let task = await post('/api/inventory/transfers', {
  merchantId: 'merchant-a',
  sourceId: 'site-a',
  destinationId: site.id,
  items: [
    { productId: 'bag', quantity: 5, sourceVersion: 1 },
    { productId: 'cup', quantity: 4, sourceVersion: 1 },
  ],
  reason: 'نقل فعلي لاختبار التسوية',
});
for (const [action, who, extra] of [
  ['assign', 'ops', { courierId: 'courier-b' }],
  ['accept', 'courier-b', {}],
  ['release', 'merchant-a', {}],
  ['pickup', 'courier-b', {}],
  ['receive', 'merchant-a', { items: [{ productId: 'bag', quantity: 2 }] }],
] as const)
  task = await post(
    `/api/inventory/transfers/${task.id}/actions`,
    { action, expectedVersion: task.version, reason: 'إقرار مستقل لاختبار العهدة', ...extra },
    who,
  );
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  let lost = true;
  await ctx.route('**/api/**', async (route) => {
    const req = route.request();
    const response = await route.fetch({
      headers: { ...req.headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (
      lost &&
      req.method() === 'POST' &&
      req.url().endsWith('/actions') &&
      req.postDataJSON()?.action === 'resolve_issue'
    ) {
      lost = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'test reply lost' }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'النقل بين المواقع', exact: true }).click();
  await page.getByRole('button', { name: 'مراجعة الفقد والتلف', exact: true }).click();
  await page.getByLabel('مفقود: حقيبة يومية', { exact: true }).fill('1');
  await page.getByLabel('تالف وصل فعليًا: حقيبة يومية', { exact: true }).fill('2');
  await page.getByLabel('تالف وصل فعليًا: كوب سيراميك', { exact: true }).fill('4');
  await page.getByLabel('مرجع التحقيق / محضر التسوية', { exact: true }).fill('محضر الفحص ١٠١');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('وصلت قطع تالفة وثبت فقد قطعة بعد المراجعة');
  await page.getByRole('checkbox').check();
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `artifacts/screenshots/transfer-resolution-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('مفقود: حقيبة يومية', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await page.getByText('أُغلقت العهدة بتسوية موثقة', { exact: true }).waitFor();
  await page.getByLabel('حساب العرض').selectOption('merchant-a');
  if (await page.getByRole('button', { name: 'فتح القائمة', exact: true }).isVisible())
    await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('button', { name: 'النقل بين المواقع', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'مراجعة الفقد والتلف', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'فحص تلف النقل', exact: true }).click();
  await page.getByLabel('صالح بعد الفحص: حقيبة يومية', { exact: true }).fill('1');
  await page.getByLabel('تالف للاستبعاد: حقيبة يومية', { exact: true }).fill('1');
  await page.getByLabel('صالح بعد الفحص: كوب سيراميك', { exact: true }).fill('1');
  await page.getByLabel('تالف للاستبعاد: كوب سيراميك', { exact: true }).fill('2');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('فحص جزئي موثق للصالح والتالف');
  await page.getByRole('checkbox').check();
  await page.screenshot({
    path: 'artifacts/screenshots/transfer-damage-inspection-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  const stock = (
    await app.inject({ url: '/api/inventory?siteId=' + site.id, headers: { cookie: cookies.ops } })
  ).json().stocks;
  assert.equal(stock.find((s: { productId: string }) => s.productId === 'bag').available, 3);
  assert.equal(stock.find((s: { productId: string }) => s.productId === 'cup').quarantine, 1);
  const detail = (
    await app.inject({
      url: '/api/inventory/transfers/' + task.id,
      headers: { cookie: cookies.ops },
    })
  ).json();
  assert.equal(
    detail.history.filter((e: { action: string }) => e.action === 'resolve_issue').length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Resolution, lost reply replay, merchant inspection, quarantine and 1440/390/360 layouts verified.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
