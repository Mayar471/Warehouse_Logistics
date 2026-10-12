import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'origin-browser',
  webhookKey: 'origin-browser-secret',
  demoMode: true,
});
const f = {
  app,
  post: async (url: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { cookie, 'idempotency-key': crypto.randomUUID() },
    }),
  close: async () => {
    await app.close();
    await db.close();
  },
};
await f.app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
f.app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await f.app.listen({ host: '127.0.0.1', port: 0 });
const cookie = (
  await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId: 'ops' } })
).headers['set-cookie']!.toString().split(';')[0];
const created = await f.post('/api/inventory/sites', {
  merchantId: 'merchant-a',
  name: 'مستودع تريند سي',
  address: 'عنوان تجربة واضح في دمشق',
  products: ['bag'],
  reason: 'اختبار اختيار منشأ كامل السلة',
});
assert.equal(created.statusCode, 200, created.body);
const id = created.json().id;
assert.equal(
  (
    await f.post('/api/inventory/receipts', {
      merchantId: 'merchant-a',
      siteId: id,
      productId: 'bag',
      quantity: 3,
      expectedVersion: 1,
      reason: 'استلام فعلي للاختبار',
    })
  ).statusCode,
  200,
);
assert.equal(
  (
    await f.post('/api/inventory/counts', {
      merchantId: 'merchant-a',
      siteId: 'site-a',
      productId: 'bag',
      counted: 0,
      expectedVersion: 1,
      reason: 'اختبار نفاد موقع المتجر',
    })
  ).statusCode,
  200,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route('**/api/**', async (route) => {
    const r = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response: r });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '/shop');
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await page.getByLabel('اسم المستلم').fill('عميل تجربة');
  await page.getByLabel('العنوان بالتفصيل').fill('عنوان تجربة واضح');
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await page.getByText('مستودع تريند سي', { exact: true }).waitFor();
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `artifacts/screenshots/shop-origin-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  assert.equal((await (await response).json()).shipment.originId, id);
  await page.getByRole('heading', { name: 'طلبك وصل إلينا.' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Whole basket warehouse checkout verified at 1440/390/360 without overflow or page errors.',
  );
} finally {
  await browser.close();
  await f.close();
}
