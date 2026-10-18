import { chromium, type Page } from '@playwright/test';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { cashFixture } from '../tests/helpers/cash.js';
import { buildApp } from '../server/app.js';

const f = await cashFixture();
console.log('UI: fixture ready');
const office = (
  await f.post('/api/network/companies', {
    name: 'مكتب عرض الأجور',
    address: 'دمشق الروضة',
    location: { latitude: 33.51, longitude: 36.27 },
    rateBps: 6000,
  })
).json();
await f.db.query("UPDATE couriers SET company_id=$1 WHERE id='courier-b'", [office.id]);
const { code } = await f.route();
assert.equal((await f.deliver(code)).statusCode, 200);
const amountMinor = (await f.get('/api/execution-earnings')).json().rows[0].amountMinor as number;
await f.app.close();
console.log('UI: isolated payable ready');
const { app } = buildApp(f.db, { applicationKey: 'qa', webhookKey: 'qa', demoMode: true });
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
console.log('UI: server listening');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const dir = 'artifacts/screenshots/partner-payments';
await mkdir(dir, { recursive: true });
async function check(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    name + ' overflow',
  );
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: 'disabled' });
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  await page.goto(url);
  console.log('UI: page loaded');
  await page.getByRole('button', { name: 'أجور التوصيل', exact: true }).click();
  await page.getByRole('heading', { name: 'صرف أجور الشركاء', exact: true }).waitFor();
  await page.getByRole('button', { name: 'إثبات تمويل صندوق الأجور', exact: true }).click();
  await page
    .getByLabel('المبلغ الفعلي بالليرة السورية', { exact: true })
    .fill(String(amountMinor / 100));
  await page.getByLabel('رقم سند التمويل الخارجي', { exact: true }).fill('QA-FUND-001');
  await page.locator('.partner-confirm input').check();
  await page.getByRole('button', { name: 'تأكيد الإقرار', exact: true }).click();
  await page.locator('.partner-payment-form').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'حجز الأجر', exact: true }).click();
  await page.locator('.partner-confirm input').check();
  await page.getByRole('button', { name: 'تأكيد الإقرار', exact: true }).click();
  await page.getByRole('button', { name: 'تسليم الأجر للمستفيد', exact: true }).waitFor();
  await page.getByRole('button', { name: 'تسليم الأجر للمستفيد', exact: true }).click();
  await page
    .getByRole('button', { name: 'استلمت / سلّمت كامل المبلغ المحدد', exact: true })
    .click();
  await page.locator('.partner-confirm input').check();
  await page.getByRole('button', { name: 'تأكيد الإقرار', exact: true }).click();
  await page.getByText('خرج النقد — بانتظار إقرار المستفيد', { exact: false }).waitFor();
  await check(page, 'operations-1440');
  await page.evaluate(async (accountId) => {
    await fetch('/api/demo/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
  }, 'office-' + office.id);
  await page.reload();
  await page.getByRole('heading', { name: office.name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'تأكيد استلام كامل الأجر', exact: true }).click();
  await page
    .getByRole('button', { name: 'استلمت / سلّمت كامل المبلغ المحدد', exact: true })
    .click();
  await page.locator('.partner-confirm input').check();
  await page.getByRole('button', { name: 'تأكيد الإقرار', exact: true }).click();
  await page.getByRole('button', { name: 'إقرار رد الأجر المستلم', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'إثبات تمويل صندوق الأجور' }).count(), 0);
  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await check(page, 'office-' + width);
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: browser funding, reservation, release, office independent receipt, role scope and five responsive widths',
  );
} finally {
  await browser.close();
  await app.close();
  await f.db.close();
}
