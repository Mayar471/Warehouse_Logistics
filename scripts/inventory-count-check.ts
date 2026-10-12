import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'count-browser',
  webhookKey: 'count-test-secret',
  demoMode: true,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const cookie = (
  await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId: 'ops' } })
).headers['set-cookie']!.toString().split(';')[0];
const shop = (
  await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
).headers['set-cookie']!.toString().split(';')[0];
const checkout = await app.inject({
  method: 'POST',
  url: '/api/storefront/checkouts',
  headers: { cookie: shop },
  payload: {
    items: [{ productId: 'bag', quantity: 2 }],
    recipientName: 'عميل الجرد',
    district: 'الروضة',
    address: 'عنوان اختبار مستقل',
  },
});
assert.equal(checkout.statusCode, 200, checkout.body);
const order = await app.inject({
  method: 'POST',
  url: '/api/storefront/orders',
  headers: { cookie: shop },
  payload: { checkoutId: checkout.json().id },
});
assert.equal(order.statusCode, 200, order.body);
const f = {
  db,
  stock: async () =>
    (
      await db.query<{ on_hand: number; reserved: number; version: number }>(
        "SELECT * FROM inventory_stock WHERE product_id='bag'",
      )
    ).rows[0],
  post: (url: string, payload: Record<string, unknown>, _who: string, key: string) =>
    app.inject({ method: 'POST', url, payload, headers: { cookie, 'idempotency-key': key } }),
  close: async () => {
    await app.close();
    await db.close();
  },
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let loseResponse = true;
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (
      loseResponse &&
      route.request().method() === 'POST' &&
      route.request().url().endsWith('/api/inventory/counts')
    ) {
      assert.equal(response.status(), 200);
      loseResponse = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEST_LOST_RESPONSE', message: 'response lost after commit' }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page.getByRole('tab', { name: 'الجرد والمطابقة', exact: true }).click();
  await page.getByText('مطابق 6 من 6', { exact: false }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-reconciliation-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const count = page.getByRole('button', {
    name: 'جرد حقيبة يومية في متجر بيت الشام',
    exact: true,
  });
  await count.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('العدد الفعلي', { exact: true }).fill('1');
  await page
    .getByLabel('سبب الفرق / مرجع الجرد', { exact: true })
    .fill('جرد الرف والتحقق من الكمية الفعلية');
  assert.equal(
    await page.getByRole('button', { name: 'مراجعة الجرد', exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel('العدد الفعلي', { exact: true }).fill('27');
  await page.getByText('نقص 3 قطعة', { exact: true }).waitFor();
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-count-mobile.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'مراجعة الجرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الجرد', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الجرد/)
    .waitFor();
  assert.equal(await page.getByLabel('العدد الفعلي', { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole('tab', { name: 'الأرصدة والحركة', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد الجرد', exact: true }).click();
  await page
    .getByRole('status')
    .getByText('تم تسجيل الجرد وتحديث الرصيد', { exact: true })
    .waitFor();
  assert.equal((await f.stock()).on_hand, 27);
  assert.equal((await f.stock()).reserved, 2);
  assert.equal((await f.db.query('SELECT * FROM inventory_counts')).rows.length, 1);
  assert.equal(
    (await f.db.query("SELECT * FROM inventory_movements WHERE kind='adjustment_out'")).rows.length,
    1,
  );
  await count.click();
  await page.getByLabel('العدد الفعلي', { exact: true }).fill('27');
  await page
    .getByLabel('سبب الفرق / مرجع الجرد', { exact: true })
    .fill('إعادة مراجعة الكمية قبل الحفظ');
  const stock = await f.stock();
  const receipt = await f.post(
    '/api/inventory/receipts',
    {
      merchantId: 'merchant-a',
      siteId: 'site-a',
      productId: 'bag',
      quantity: 1,
      expectedVersion: stock.version,
      reason: 'وارد متزامن مع الجرد',
    },
    'ops',
    randomUUID(),
  );
  assert.equal(receipt.statusCode, 200, receipt.body);
  await page.getByRole('button', { name: 'مراجعة الجرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الجرد', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  assert.equal((await f.stock()).on_hand, 28);
  assert.equal((await f.db.query('SELECT * FROM inventory_counts')).rows.length, 1);
  await f.db.query("UPDATE inventory_stock SET on_hand=29 WHERE product_id='bag'");
  await page.getByRole('button', { name: 'تحديث المطابقة', exact: true }).click();
  await page.getByText('1 أرصدة تحتاج تحقيقًا', { exact: true }).waitFor();
  assert.equal(await count.isDisabled(), true);
  await page.setViewportSize({ width: 360, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.inventory-audit').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-discrepancy-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('حساب العرض').selectOption('merchant-b');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page.getByRole('tab', { name: 'الجرد والمطابقة', exact: true }).click();
  await page.getByText('لا توجد أرصدة في نطاق هذا الحساب.', { exact: true }).waitFor();
  assert.equal(
    await page.getByText('جرد الرف والتحقق من الكمية الفعلية', { exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Inventory count browser: protected commitments, lost-response retry exactly once, stale version, read-only discrepancy, tenant isolation, RTL 1440/390/360 passed.',
  );
} finally {
  await browser.close();
  await f.close();
}
