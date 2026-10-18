import { chromium, type Page } from '@playwright/test';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture } from '../tests/helpers/inventory.js';
import { buildApp } from '../server/app.js';
const f = await fixture();
const s = (await f.order((await f.checkout()).id)).json().shipment;
await f.app.close();
let now = Date.now();
const { app } = buildApp(f.db, {
  applicationKey: 'dispute-qa',
  webhookKey: 'dispute-qa',
  demoMode: true,
  clock: () => now,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const directory = 'artifacts/screenshots/disputes';
await mkdir(directory, { recursive: true });
const errors: string[] = [];
async function context(customer = false) {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await c.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  if (customer) await c.addCookies([{ name: 'shop', value: f.shop.slice('shop='.length), url }]);
  const p = await c.newPage();
  p.on('pageerror', (e) => {
    errors.push(e.message);
  });
  return p;
}
async function save(page: Page) {
  const wait = page.waitForResponse(
    (r) => r.url().includes('/disputes') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'حفظ الإجراء', exact: true }).click();
  const response = await wait;
  assert.equal(response.status(), 200, await response.text());
  await page.locator('.dispute-detail fieldset[disabled]').waitFor({ state: 'detached' });
}
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
  const customer = await context(true);
  await customer.goto(url + '/shop?view=orders');
  await customer.getByRole('button', { name: 'فتح متابعة لهذا الطلب', exact: true }).click();
  await customer.getByLabel('السجل المرتبط', { exact: true }).selectOption(s.id);
  await customer
    .getByLabel('وصف المشكلة', { exact: true })
    .fill('يرجى مراجعة تأخر تنفيذ طلبي التجريبي');
  const created = customer.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/disputes') && r.request().method() === 'POST',
  );
  await customer.getByRole('button', { name: 'تسجيل المتابعة', exact: true }).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 200, await createdResponse.text());
  const c = await createdResponse.json();
  await customer.locator('.dispute-detail').waitFor();
  const ops = await context();
  await ops.goto(url);
  await ops.getByRole('button', { name: /^الإشعارات/ }).click();
  await ops.locator('.notification-item').filter({ hasText: c.reference }).click();
  await ops.locator('.dispute-detail').waitFor();
  assert.equal(
    (await f.db.query<{ version: number }>('SELECT version FROM disputes WHERE id=$1', [c.id]))
      .rows[0].version,
    1,
  );
  await ops.getByLabel('الإجراء', { exact: true }).selectOption('internal_note');
  await ops
    .getByLabel('ملاحظة خاصة بالعمليات', { exact: true })
    .fill('ملاحظة مراجعة داخلية لا تظهر للعميل');
  await save(ops);
  await ops.locator('.dispute-events .internal').waitFor();
  await ops.getByLabel('الإجراء', { exact: true }).selectOption('request_reply');
  await ops.getByLabel('الطرف المطلوب ردّه', { exact: true }).selectOption({ label: 'العميل' });
  await save(ops);
  await customer.getByRole('button', { name: 'تحديث المتابعات', exact: true }).click();
  await customer
    .getByText(/بانتظار رد/)
    .first()
    .waitFor();
  assert.equal(
    await customer.getByText('ملاحظة مراجعة داخلية لا تظهر للعميل', { exact: true }).count(),
    0,
  );
  await customer
    .getByRole('button', { name: 'أراجع الحالة وسأوافيكم بالتفاصيل.', exact: true })
    .click();
  await save(customer);
  await ops.getByRole('button', { name: 'تحديث المتابعات', exact: true }).click();
  await ops.getByLabel('الإجراء', { exact: true }).selectOption('assign');
  await ops.getByLabel('مهلة جديدة من الآن', { exact: true }).selectOption('4');
  await save(ops);
  now += 5 * 3600000;
  await ops.getByRole('button', { name: /تجاوزت المهلة/ }).click();
  await ops.locator('.dispute-list-item').filter({ hasText: c.reference }).click();
  await ops.getByText('تجاوزت المهلة — تحتاج متابعة', { exact: true }).waitFor();
  await ops.getByLabel('الإجراء', { exact: true }).selectOption('escalate');
  await save(ops);
  for (const width of [1440, 1024, 768, 390, 360]) {
    await ops.setViewportSize({ width, height: 1000 });
    await check(ops, 'operations-' + width);
  }
  await ops.getByLabel('الإجراء', { exact: true }).selectOption('resolve');
  await ops
    .getByLabel('تفسير القرار للأطراف', { exact: true })
    .fill('تمت المراجعة وتوجيه فريق التنفيذ دون تغيير العهدة أو الأموال.');
  await save(ops);
  await ops.locator('.dispute-decision').waitFor();
  await customer.getByRole('button', { name: 'تحديث المتابعات', exact: true }).click();
  await customer.locator('.dispute-decision').waitFor();
  await customer.getByLabel('الإجراء', { exact: true }).selectOption('close');
  await save(customer);
  await customer
    .getByText(/أغلقت المتابعة/)
    .first()
    .waitFor();
  await customer.setViewportSize({ width: 390, height: 1000 });
  await check(customer, 'customer-closed-390');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: customer source-linked case, notification jump without mutation, internal privacy, requested reply, owner/deadline, overdue metric, escalation, decision and requester closure; five responsive widths',
  );
} finally {
  await browser.close();
  await app.close();
  await f.db.close();
}
