import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

// Visual QA uses isolated data; the running demo and its financial records are untouched.
const db = await openDatabase('memory://');
const { app } = buildApp(db, {
  applicationKey: 'visual-qa',
  webhookKey: 'visual-qa',
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
const errors: string[] = [];
const directory = 'artifacts/screenshots/operations-theme';
await mkdir(directory, { recursive: true });
async function check(page: Page, label: string, width: number) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${directory}/${label}-${width}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) {
    console.log(
      label,
      width,
      await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .map((el) => ({
            class: el.className,
            left: el.getBoundingClientRect().left,
            right: el.getBoundingClientRect().right,
          }))
          .filter((r) => r.left < -1 || r.right > innerWidth + 1)
          .slice(0, 18),
      ),
    );
  }
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${label} overflows at ${width}`,
  );
}
try {
  for (const width of [1440, 1024, 768, 390, 360]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/api/**', async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
      });
      await route.fulfill({ response });
    });
    await page.goto(url);
    await page.locator('.metric').first().waitFor();
    assert.equal(
      await page
        .locator('.app-shell')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--brand-plum').trim()),
      '#762557',
    );
    await check(page, 'overview', width);
    await page.getByRole('button', { name: /^الإشعارات/ }).click();
    await page.locator('.notification-item').first().waitFor();
    await check(page, 'notifications', width);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.notification-panel').count(), 0);
    if (width === 1440) {
      await page.getByRole('button', { name: /^الإشعارات/ }).click();
      await page.getByRole('button', { name: 'تحديد الكل كمقروء' }).click();
      await page.getByText('0 غير مقروءة', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.reload();
      await page.locator('.metric').first().waitFor();
      await page.getByRole('button', { name: /^الإشعارات/ }).click();
      await page.getByText('0 غير مقروءة', { exact: true }).waitFor();
      await page.locator('.notification-item').first().click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
    }
    for (const [id, label] of [
      ['shipments', 'الشحنات'],
      ['network', 'شبكة الشركاء'],
      ['inventory', 'المخزون والتجهيز'],
      ['transfers', 'النقل بين المواقع'],
      ['returns', 'مرتجعات العملاء'],
      ['cash', 'التحصيل وعهدة النقد'],
      ['payouts', 'مستحقات المتاجر'],
      ['integration', 'مختبر التكامل'],
    ]) {
      if (width <= 760)
        await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: label }).click();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: label })
        .getAttribute('aria-current')
        .then((value) => assert.equal(value, 'page'));
      await check(page, id, width);
    }
    if (width <= 760) await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'الشحنات' }).click();
    await page.locator('.reference-button').first().click();
    await page.getByRole('dialog').waitFor();
    await check(page, 'shipment-dialog', width);
    await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
    if (width === 1440 || width === 390) {
      for (const account of ['merchant-a', 'courier-a', 'pickup-a']) {
        await page.getByLabel('حساب العرض').selectOption(account);
        await page.waitForFunction(
          (id) => (document.querySelector('#account') as HTMLSelectElement)?.value === id,
          account,
        );
        await check(page, account, width);
      }
      await page.goto(url + '/shop');
      await page.locator('.shop-header').waitFor();
      assert.equal(
        await page
          .locator('.shop')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('--shop-green').trim()),
        '#762557',
      );
      await check(page, 'customer', width);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: nine operations pages, shipment dialog, merchant/courier/pickup roles, customer identity preserved; 1440/1024/768/390/360px, no horizontal page overflow or browser errors.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
