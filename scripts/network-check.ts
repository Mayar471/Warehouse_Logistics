import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors: string[] = [];
let failNextBootstrap = false;
let creationCalls = 0;
await ctx.route('**/api/bootstrap', async (route) => {
  if (failNextBootstrap) {
    failNextBootstrap = false;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'TEST_REFRESH_FAILURE', message: 'انقطاع عرض اصطناعي' }),
    });
  } else await route.continue();
});
page.on('request', (r) => {
  if (r.url().endsWith('/api/network/pickup-sites') && r.method() === 'POST') creationCalls++;
});
page.on('pageerror', (e) => errors.push(e.message));
await mkdir('artifacts/screenshots', { recursive: true });
try {
  await page.goto('http://127.0.0.1:3001/');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByRole('button', { name: 'شبكة الشركاء', exact: true }).click();
  await page.getByRole('button', { name: 'إضافة نقطة استلام', exact: true }).click();
  const name = 'نقطة عرض ' + Date.now();
  await page.getByLabel('اسم النقطة', { exact: true }).fill(name);
  await page.getByLabel('العنوان في دمشق', { exact: true }).fill('شارع اصطناعي، دمشق');
  await page.getByLabel('السعة القصوى بالكيلوغرام').fill('25');
  await page.getByLabel('سبب الإجراء', { exact: true }).fill('اختبار إنشاء نقطة من الواجهة');
  await page.screenshot({
    path: 'artifacts/screenshots/network-create-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/network/pickup-sites') && r.request().method() === 'POST',
  );
  failNextBootstrap = true;
  await page.getByRole('button', { name: 'حفظ إعدادات النقطة', exact: true }).click();
  const result = await created;
  assert.equal(result.status(), 200);
  const site = await result.json();
  await page.getByRole('button', { name: 'إعادة تحميل الشبكة', exact: true }).waitFor();
  assert.equal(await page.getByLabel('اسم النقطة', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'إعادة تحميل الشبكة', exact: true }).click();
  assert.equal(creationCalls, 1, 'Retrying display refresh must not create another point');
  await page.getByRole('button', { name: 'إدارة ' + name, exact: true }).waitFor();
  const shop = await ctx.newPage();
  await shop.goto('http://127.0.0.1:3001/shop');
  await shop.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await shop.getByRole('button', { name: /السلة،/ }).click();
  await shop.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await shop.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  assert.ok(
    await shop
      .getByLabel('نقطة الاستلام', { exact: true })
      .locator(`option[value="${site.id}"]`)
      .count(),
  );
  await page.getByRole('button', { name: 'إدارة ' + name, exact: true }).click();
  await page.getByLabel('السعة القصوى بالكيلوغرام').fill('30');
  await page.getByRole('checkbox', { name: /استقبال طلبات جديدة/ }).uncheck();
  await page
    .getByLabel('سبب الإجراء', { exact: true })
    .fill('إنهاء اختبار العرض وإيقاف استقبال طلبات جديدة');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/network-edit-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'حفظ إعدادات النقطة', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page
    .locator('.network-audit-row')
    .filter({ hasText: name })
    .getByText('إنهاء اختبار العرض وإيقاف استقبال طلبات جديدة', { exact: true })
    .waitFor();
  await page.screenshot({
    path: 'artifacts/screenshots/network-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await shop.reload();
  await shop.getByRole('button', { name: /السلة،/ }).click();
  await shop.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await shop.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  assert.equal(
    await shop
      .getByLabel('نقطة الاستلام', { exact: true })
      .locator(`option[value="${site.id}"]`)
      .count(),
    0,
  );
  await page.getByLabel('حساب العرض').selectOption(site.id);
  await page.getByRole('heading', { name, exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'إضافة نقطة استلام', exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'create point → customer discovery → edit capacity and disable intake → audit → isolated point account',
      screenshots: 3,
      siteLeftDisabled: true,
    }),
  );
} finally {
  await browser.close();
}
