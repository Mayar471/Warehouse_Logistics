import { chromium, type Page } from '@playwright/test';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase('memory://');
await db.query("UPDATE sites SET latitude=33.51,longitude=36.29 WHERE id='site-a'");
const { app } = buildApp(db, {
  applicationKey: 'dispatch-qa',
  webhookKey: 'dispatch-qa',
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
const directory = 'artifacts/screenshots/dispatch';
await mkdir(directory, { recursive: true });
const errors: string[] = [];
async function context() {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    geolocation: { latitude: 33.511, longitude: 36.29, accuracy: 15 },
    permissions: ['geolocation'],
  });
  await c.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
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
  const customer = await context();
  await customer.goto(url + '/shop');
  await customer.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await customer.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await customer.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await customer.getByLabel('اسم المستلم', { exact: true }).fill('عميل الأولوية');
  await customer.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  await customer.getByLabel('نقطة الاستلام', { exact: true }).selectOption('pickup-a');
  await customer.getByRole('button', { name: 'مستعجل', exact: true }).click();
  assert.equal(
    await customer
      .getByRole('button', { name: 'مستعجل', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  for (const width of [1440, 1024, 768, 390, 360]) {
    await customer.setViewportSize({ width, height: 1000 });
    await check(customer, 'customer-' + width);
  }
  await customer.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await customer.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).waitFor();
  const orderWait = customer.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await customer.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  const response = await orderWait;
  assert.equal(response.status(), 200, await response.text());
  const order = await response.json(),
    s = order.shipment;
  assert.equal(s.priority, 'urgent');
  const courier = await context();
  await courier.goto(url);
  await courier.getByLabel('حساب العرض', { exact: true }).selectOption('courier-a');
  await courier.getByRole('button', { name: 'مشاركة موقعي للترشيح', exact: true }).click();
  await courier.getByRole('button', { name: 'تحديث موقعي بموافقتي', exact: true }).waitFor();
  for (const width of [1440, 1024, 768, 390, 360]) {
    await courier.setViewportSize({ width, height: 1000 });
    await check(courier, 'courier-' + width);
  }
  const ops = await context();
  await ops.goto(url);
  await ops.getByRole('button', { name: /^الشحنات/ }).click();
  await ops.getByRole('button', { name: s.reference, exact: true }).click();
  const recommendation = ops.getByRole('region', { name: 'ترشيح المندوب', exact: true });
  await recommendation.getByText('المرشح الأول: أحمد منصور', { exact: true }).waitFor();
  for (const width of [1440, 1024, 768, 390, 360]) {
    await ops.setViewportSize({ width, height: 1000 });
    await recommendation.scrollIntoViewIfNeeded();
    await check(ops, 'recommendation-' + width);
  }
  let lost = false;
  await ops.route('**/api/shipments/*/dispatch', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (!lost && route.request().method() === 'POST') {
      lost = true;
      assert.equal(response.status(), 200, await response.text());
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'isolated response loss' }),
      });
    } else await route.fulfill({ response });
  });
  await recommendation.getByRole('button', { name: 'إسناد إلى المرشح الأول', exact: true }).click();
  await recommendation
    .getByRole('button', { name: 'استعادة نتيجة الإسناد', exact: true })
    .waitFor();
  assert.equal(
    await ops.getByRole('button', { name: 'إسناد يدوي', exact: true }).isDisabled(),
    true,
  );
  await recommendation.getByRole('button', { name: 'استعادة نتيجة الإسناد', exact: true }).click();
  await recommendation.waitFor({ state: 'detached' });
  assert.equal(
    (
      await db.query("SELECT * FROM timeline WHERE shipment_id=$1 AND type='shipment.assign'", [
        s.id,
      ])
    ).rows.length,
    1,
  );
  await courier.getByRole('button', { name: 'إيقاف المشاركة', exact: true }).click();
  await courier.getByRole('button', { name: 'مشاركة موقعي للترشيح', exact: true }).waitFor();
  assert.equal(
    (await db.query("SELECT * FROM dispatch_locations WHERE courier_id='courier-a'")).rows.length,
    0,
  );
  let unexpectedShares = 0;
  courier.on('request', (r) => {
    if (
      r.url().endsWith('/api/dispatch/location') &&
      r.method() === 'POST' &&
      r.postDataJSON()?.action === 'share'
    )
      unexpectedShares++;
  });
  await courier.evaluate(`Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
    configurable: true, value: function(success) { window.releaseGps = function() {
      success({coords:{latitude:33.511,longitude:36.29,accuracy:15},timestamp:Date.now()});
    }; }
  })`);
  await courier.getByRole('button', { name: 'مشاركة موقعي للترشيح', exact: true }).click();
  await courier.getByLabel('حساب العرض', { exact: true }).selectOption('courier-b');
  await courier.getByRole('button', { name: 'مشاركة موقعي للترشيح', exact: true }).waitFor();
  await courier.evaluate(`(async function() { window.releaseGps();
    await new Promise(function(r) { requestAnimationFrame(function() { requestAnimationFrame(r); }); });
  })()`);
  assert.equal(unexpectedShares, 0, 'GPS consent from old account must not write for new account');
  await courier.evaluate(`Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
    configurable: true, value: function(_success, reject) { reject({code:1,message:'Permission denied'}); }
  })`);
  await courier.getByRole('button', { name: 'مشاركة موقعي للترشيح', exact: true }).click();
  await courier.getByRole('alert').filter({ hasText: 'اسمح بالوصول للموقع' }).waitFor();
  assert.equal(unexpectedShares, 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: customer urgent checkout persisted; courier geolocation consent and revoke; operator recommendation at five widths; committed assignment recovered after lost response without duplication; manual assignment locked while uncertain; delayed GPS cannot cross accounts; permission denial writes no location',
  );
} catch (e) {
  for (const [i, c] of browser.contexts().entries()) {
    for (const p of c.pages()) {
      console.log('Failure page', i, (await p.locator('body').innerText()).slice(-5000));
      await p.screenshot({ path: `${directory}/failure-${i}.png`, fullPage: true });
    }
  }
  throw e;
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
