import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { cashFixture } from '../tests/helpers/cash.js';
import { buildApp } from '../server/app.js';

// Only in-memory orders and simulated GPS; never the customer's actual browser or demo database.
const f = await cashFixture(true);
const { code } = await f.route();
assert.equal((await f.deliver(code)).statusCode, 200);
for (let i = 0; i < 6; i++)
  assert.equal(
    (
      await f.post(
        '/api/network/pickup-sites',
        {
          name: `نقطة اختبار ${i + 1}`,
          address: 'عنوان تجريبي واضح في دمشق',
          capacityKg: 100,
          enabled: true,
          reason: 'تهيئة مراجعة واجهة معزولة',
          location: { latitude: 33.514 + i * 0.002, longitude: 36.28 + i * 0.001 },
        },
        'ops',
      )
    ).statusCode,
    200,
  );
await f.app.close();
const { app } = buildApp(f.db, { applicationKey: 'geo-ui', webhookKey: 'geo-ui', demoMode: true });
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 }),
  browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
await mkdir('artifacts/screenshots/customer-locations', { recursive: true });
try {
  for (const width of [1440, 390, 360]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      permissions: ['geolocation'],
      geolocation: { latitude: 33.514, longitude: 36.28, accuracy: 15 },
      reducedMotion: 'reduce',
    });
    const [name, value] = f.shop.split('=');
    await context.addCookies([{ name, value, url }]);
    await context.route('**/api/**', async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
      });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '/shop');
    await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
    await page.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
    await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
    await page.getByLabel('اسم المستلم').fill('عميل اختبار الموقع');
    if (width === 1440) {
      await page.getByRole('button', { name: /^موقعك الحالي/ }).click();
      await page.getByText(/تم تحديد موقعك الحالي/).waitFor();
      await page.getByRole('button', { name: 'تعديل أو حفظ الموقع' }).click();
      await page.getByLabel('حفظ باسم').selectOption('home');
      await page.getByLabel('العنوان بالتفصيل').fill('البناء 12 الطابق الثاني');
      const save = page.waitForResponse(
        (r) => r.url().endsWith('/api/storefront/addresses') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'حفظ العنوان', exact: true }).click();
      assert.equal((await save).status(), 200);
    } else {
      await page.getByRole('button', { name: /^البيت/ }).click();
      await page.getByText(/البيت · الروضة/).waitFor();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({
      path: `artifacts/screenshots/customer-locations/home-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const homeQuote = page.waitForResponse(
      (r) => r.url().endsWith('/api/storefront/checkouts') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب', exact: true }).click();
    const homeResponse = await homeQuote;
    assert.equal(homeResponse.status(), 200);
    const quoteBody = homeResponse.request().postDataJSON();
    assert.deepEqual(quoteBody.location, { latitude: 33.514, longitude: 36.28 });
    await page.getByRole('button', { name: 'تعديل البيانات / تحديث العرض', exact: true }).click();
    await page.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
    await page.getByRole('button', { name: 'اختيار الأقرب', exact: true }).click();
    const near = page.waitForResponse((r) =>
      r.url().endsWith('/api/storefront/pickup-sites/nearest'),
    );
    await page.getByRole('button', { name: /^البيت/ }).click();
    assert.equal((await near).status(), 200);
    await page.locator('.pickup-recommendations button').last().waitFor();
    assert.equal(await page.locator('.pickup-recommendations button').count(), 5);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({
      path: `artifacts/screenshots/customer-locations/nearest-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'طلباتي', exact: true }).click();
    const order = page.locator('.shop-order').filter({ hasText: f.shipment().reference });
    await order.getByRole('heading', { name: 'كيف كانت تجربة الاستلام؟' }).waitFor();
    if (width === 1440) {
      await order
        .getByRole('group', { name: 'نجوم المندوب' })
        .getByRole('button', { name: '4 من 5', exact: true })
        .click();
      await order.getByRole('button', { name: 'إرسال تقييم المندوب', exact: true }).click();
      await order.getByText('شكرًا لتقييمك · 4 / 5', { exact: true }).waitFor();
      await order
        .getByRole('group', { name: 'نجوم نقطة الاستلام' })
        .getByRole('button', { name: '5 من 5', exact: true })
        .click();
      await order.getByRole('button', { name: 'إرسال تقييم النقطة', exact: true }).click();
      await order.getByText('شكرًا لتقييمك · 5 / 5', { exact: true }).waitFor();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({
      path: `artifacts/screenshots/customer-locations/ratings-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    if (width === 360) {
      await context.clearPermissions();
      await context.grantPermissions([]);
      await context.setGeolocation(null);
      await page.goto(url + '/shop');
      await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
      await page.getByRole('button', { name: /السلة،/ }).click();
      await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
      await page.getByRole('button', { name: /^موقعك الحالي/ }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /لم تسمح|تعذر تحديد/ })
        .waitFor({ timeout: 16000 });
      await page.getByRole('button', { name: /^البيت/ }).click();
      await page.getByText(/البيت · الروضة/).waitFor();
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: simulated current-location permission, home persistence, nearest-five pickup list, verified courier and pickup rating, GPS failure fallback; 1440/390/360px.',
  );
} finally {
  await browser.close();
  await app.close();
  await f.db.close();
}
