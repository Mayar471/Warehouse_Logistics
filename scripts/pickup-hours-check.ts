import { chromium, type Page } from '@playwright/test';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase('memory://');
const { app } = buildApp(db, {
  applicationKey: 'hours-qa',
  webhookKey: 'hours-qa',
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
const directory = 'artifacts/screenshots/pickup-hours';
await mkdir(directory, { recursive: true });
const errors: string[] = [];
async function check(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    name + ' overflow',
  );
  await page.screenshot({
    path: `${directory}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'شبكة الشركاء', exact: true }).click();
  await page.getByRole('button', { name: 'ساعات العمل', exact: true }).click();
  await page.getByRole('button', { name: '09–18 والجمعة عطلة', exact: true }).click();
  assert.equal(await page.getByLabel('الأحد بداية 1', { exact: true }).inputValue(), '09:00');
  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await check(page, 'weekly-' + width);
  }
  await page.locator('details.opening-day').first().locator('summary').click();
  await page
    .locator('details.opening-day')
    .first()
    .getByRole('button', { name: 'إضافة فترة ثانية', exact: true })
    .click();
  assert.equal(await page.getByLabel('الأحد بداية 2', { exact: true }).inputValue(), '18:00');
  await page.getByRole('button', { name: 'حذف الفترة', exact: true }).click();
  await page.getByRole('button', { name: 'إضافة استثناء لليوم المحدد', exact: true }).click();
  await page.getByRole('button', { name: 'حفظ الدوام', exact: true }).click();
  await page.locator('.pickup-hours-form').waitFor({ state: 'detached' });
  await page.getByText('مغلقة الآن وفق استثناء اليوم', { exact: true }).waitFor();
  await page.goto(url + '/shop');
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await page.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  const option = page
    .getByLabel('نقطة الاستلام', { exact: true })
    .locator('option[value="pickup-a"]');
  await option.waitFor({ state: 'attached' });
  assert.equal(await option.evaluate((el) => (el as HTMLOptionElement).disabled), true);
  await page.getByLabel('نقطة الاستلام', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match((await option.textContent()) ?? '', /مغلقة/);
  assert.equal(await page.getByLabel('نقطة الاستلام', { exact: true }).inputValue(), '');
  await check(page, 'customer-closed-360');
  await page.goto(url);
  await page.getByLabel('حساب العرض', { exact: true }).selectOption('pickup-a');
  await page.getByRole('heading', { name: 'ساعات عمل نقطتك', exact: true }).waitFor();
  await check(page, 'point-read-360');
  assert.equal(await page.getByRole('button', { name: 'حفظ الدوام', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: weekly editor at five widths, exceptional closure saved, customer cannot select closed point, pickup employee has read-only hours',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
