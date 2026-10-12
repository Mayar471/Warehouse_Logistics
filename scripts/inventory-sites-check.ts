import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'sites-browser',
  webhookKey: 'sites-secret',
  demoMode: true,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let loseCreate = true,
    loseProducts = true;
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    const request = route.request();
    const creation =
      loseCreate && request.method() === 'POST' && request.url().endsWith('/api/inventory/sites');
    const products =
      loseProducts &&
      request.method() === 'POST' &&
      /\/api\/inventory\/sites\/[^/]+\/products$/.test(request.url());
    if (creation || products) {
      assert.equal(response.status(), 200);
      if (creation) loseCreate = false;
      else loseProducts = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'LOST_RESPONSE', message: 'test response lost after commit' }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page.getByRole('tab', { name: 'مواقع المخزون', exact: true }).click();
  await page.getByRole('button', { name: 'إضافة موقع تخزين', exact: true }).click();
  await page.getByLabel('المتجر المالك', { exact: true }).selectOption('merchant-a');
  await page.getByLabel('اسم الموقع', { exact: true }).fill('مستودع العرض الجديد');
  await page
    .getByLabel('عنوان موقع التخزين', { exact: true })
    .fill('دمشق، موقع تخزين مستقل للاختبار');
  await page.getByRole('checkbox', { name: 'حقيبة يومية', exact: true }).check();
  await page.getByRole('checkbox', { name: 'كوب سيراميك', exact: true }).check();
  await page
    .getByLabel('سبب الإضافة / مرجعها', { exact: true })
    .fill('تفعيل موقع تخزين جديد بأرصدة صفرية');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('artifacts/screenshots', { recursive: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-site-create-mobile.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد ربط المنتجات', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('اسم الموقع', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('نطاق المخزون', { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole('tab', { name: 'الأرصدة والحركة', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد ربط المنتجات', exact: true }).click();
  await page.getByRole('heading', { name: 'مستودع العرض الجديد', exact: true }).waitFor();
  const site = (
    await db.query<{ id: string }>("SELECT id FROM sites WHERE name='مستودع العرض الجديد'")
  ).rows;
  assert.equal(site.length, 1);
  const id = site[0].id;
  assert.equal(
    (await db.query('SELECT * FROM inventory_stock WHERE site_id=$1', [id])).rows.length,
    2,
  );
  assert.equal(
    (await db.query('SELECT * FROM inventory_movements WHERE site_id=$1', [id])).rows.length,
    0,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-sites-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const card = page
    .locator('.inventory-site-card')
    .filter({ has: page.getByRole('heading', { name: 'مستودع العرض الجديد', exact: true }) });
  await card.getByRole('button', { name: 'عرض أرصدة الموقع', exact: true }).click();
  await page.getByRole('heading', { name: 'أرصدة المنتجات', exact: true }).waitFor();
  await page.getByLabel('نطاق المخزون', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'تسجيل وارد', exact: true }).click();
  await page.getByLabel('المنتج', { exact: true }).selectOption('0');
  await page.getByLabel('الكمية المستلمة', { exact: true }).fill('8');
  await page
    .getByLabel('سبب الحركة / مرجعها', { exact: true })
    .fill('استلام ثماني قطع في موقع التخزين الجديد');
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page.getByRole('status').getByText('تم تسجيل حركة المخزون', { exact: true }).waitFor();
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE site_id=$1 AND product_id='bag'",
        [id],
      )
    ).rows[0].on_hand,
    8,
  );
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE site_id='site-a' AND product_id='bag'",
      )
    ).rows[0].on_hand,
    30,
  );
  await page.getByRole('tab', { name: 'الجرد والمطابقة', exact: true }).click();
  await page.getByText('مطابق 2 من 2', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'مواقع المخزون', exact: true }).click();
  await card.getByRole('button', { name: 'ربط منتجات', exact: true }).click();
  await page.getByRole('checkbox', { name: 'محفظة بسيطة', exact: true }).check();
  await page
    .getByLabel('سبب الإضافة / مرجعها', { exact: true })
    .fill('إضافة منتج جديد دون تغيير رصيد الحقيبة');
  await page.getByRole('button', { name: 'تأكيد ربط المنتجات', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: 'محفظة بسيطة', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد ربط المنتجات', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await card.getByText('محفظة بسيطة', { exact: true }).waitFor();
  assert.equal(
    (await db.query('SELECT * FROM inventory_stock WHERE site_id=$1', [id])).rows.length,
    3,
  );
  assert.equal(
    (await db.query('SELECT * FROM network_audit WHERE site_id=$1', [id])).rows.length,
    2,
  );
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-sites-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('حساب العرض').selectOption('merchant-b');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page.getByRole('tab', { name: 'مواقع المخزون', exact: true }).click();
  await page.getByRole('heading', { name: 'متجر نواة', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: 'مستودع العرض الجديد', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'ربط منتجات', exact: true }).click();
  await page.getByRole('checkbox', { name: 'كوب سيراميك', exact: true }).check();
  await page
    .getByLabel('سبب الإضافة / مرجعها', { exact: true })
    .fill('ربط منتج بموقع المتجر المالك');
  await page.getByRole('button', { name: 'تأكيد ربط المنتجات', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'عرض أرصدة الموقع', exact: true }).click();
  await page.getByRole('tab', { name: 'الجرد والمطابقة', exact: true }).click();
  await page.getByText('مطابق 1 من 1', { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Inventory sites browser passed: zero opening, create/register lost-response replay, scoped receipt and reconciliation, owner isolation, RTL 1440/390/360.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
