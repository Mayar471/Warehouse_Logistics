import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'inventory-browser',
  webhookKey: 'inventory-browser-secret',
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
  const cookies: Record<string, string> = {};
  for (const accountId of ['ops', 'merchant-a', 'courier-b'])
    cookies[accountId] = (
      await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
    ).headers['set-cookie']!.toString().split(';')[0];
  const shop = (
    await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
  ).headers['set-cookie']!.toString().split(';')[0];
  const quote = await app.inject({
    method: 'POST',
    url: '/api/storefront/checkouts',
    headers: { cookie: shop },
    payload: {
      items: [{ productId: 'bag', quantity: 3 }],
      recipientName: 'عميل فحص المخزون',
      district: 'الروضة',
      address: 'عنوان اختبار مستقل',
    },
  });
  assert.equal(quote.statusCode, 200, quote.body);
  let shipment = (
    await app.inject({
      method: 'POST',
      url: '/api/storefront/orders',
      headers: { cookie: shop },
      payload: { checkoutId: quote.json().id },
    })
  ).json().shipment;
  for (const [action, who] of [
    ['prepare', 'merchant-a'],
    ['assign', 'ops'],
    ['accept', 'courier-b'],
    ['handover_origin', 'merchant-a'],
    ['pickup', 'courier-b'],
    ['return', 'ops'],
    ['receive_return', 'ops'],
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/shipments/${shipment.id}/actions`,
      headers: { cookie: cookies[who], 'idempotency-key': randomUUID() },
      payload: {
        action,
        expectedVersion: shipment.version,
        ...(['assign', 'handover_origin'].includes(action) ? { courierId: 'courier-b' } : {}),
        ...(action === 'return' ? { reason: 'تعذر التسليم للعميل' } : {}),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    shipment = response.json();
  }
  await db.query("UPDATE inventory_stock SET on_hand=0 WHERE product_id='wallet'");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let hideReceiptResult = true;
  let hidePartialResult = true;
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (
      hideReceiptResult &&
      route.request().url().endsWith('/api/inventory/receipts') &&
      route.request().method() === 'POST'
    ) {
      assert.equal(response.status(), 200);
      hideReceiptResult = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'UNCERTAIN_TEST',
          message: 'simulated response lost after commit',
        }),
      });
    } else if (
      hidePartialResult &&
      route.request().url().endsWith('/inspect') &&
      route.request().method() === 'POST'
    ) {
      assert.equal(response.status(), 200);
      hidePartialResult = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'UNCERTAIN_TEST',
          message: 'simulated partial inspection response lost after commit',
        }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page.getByRole('heading', { name: 'أرصدة المنتجات', exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'فحص المرتجع ' + shipment.reference, exact: true })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تسجيل وارد', exact: true }).click();
  await page.getByLabel('المنتج', { exact: true }).selectOption('0');
  await page.getByLabel('الكمية المستلمة', { exact: true }).fill('4');
  await page
    .getByLabel('سبب الحركة / مرجعها', { exact: true })
    .fill('استلام دفعة التوريد التجريبية');
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-receipt-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('الكمية المستلمة', { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole('button', { name: 'تحديث المخزون', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page.getByRole('status').getByText('تم تسجيل حركة المخزون').waitFor();
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE product_id='bag'",
      )
    ).rows[0].on_hand,
    34,
  );
  await page
    .getByRole('button', { name: 'فحص المرتجع ' + shipment.reference, exact: true })
    .click();
  await page.getByLabel('نتيجة الفحص').selectOption('partial');
  await page.getByLabel('صالح للبيع: حقيبة يومية').fill('1');
  await page.getByLabel('تالف: حقيبة يومية').fill('1');
  await page.getByText('يبقى معزولًا بعد الحفظ: 1 قطعة', { exact: true }).waitFor();
  await page
    .getByLabel('سبب الحركة / مرجعها', { exact: true })
    .fill('فحص جميع القطع والتغليف والتأكد من الصلاحية');
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'artifacts/screenshots/inventory-inspection-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('صالح للبيع: حقيبة يومية').isDisabled(), true);
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await db.query<{ quarantine: number; on_hand: number }>(
        "SELECT quarantine,on_hand FROM inventory_stock WHERE product_id='bag'",
      )
    ).rows[0].quarantine,
    1,
  );
  await page
    .getByRole('button', { name: 'فحص المرتجع ' + shipment.reference, exact: true })
    .click();
  await page.getByText('متبقٍ للفحص: 1 من أصل 3', { exact: true }).waitFor();
  await page.getByLabel('صالح للبيع: حقيبة يومية').fill('1');
  await page
    .getByLabel('سبب الحركة / مرجعها', { exact: true })
    .fill('إكمال فحص القطعة المتبقية والتأكد من الصلاحية');
  await page.getByRole('button', { name: 'تأكيد حركة المخزون', exact: true }).click();
  await page
    .getByRole('button', { name: 'فحص المرتجع ' + shipment.reference, exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(
    (
      await db.query<{ quarantine: number }>(
        "SELECT quarantine FROM inventory_stock WHERE product_id='bag'",
      )
    ).rows[0].quarantine,
    0,
  );
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE product_id='bag'",
      )
    ).rows[0].on_hand,
    33,
  );
  await page.setViewportSize({ width: 360, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByLabel('حساب العرض').selectOption('merchant-b');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page
    .getByText('لا يوجد مخزون مُدار لهذا المتجر في التجربة الحالية.', { exact: true })
    .waitFor();
  assert.equal(await page.getByRole('cell', { name: 'حقيبة يومية' }).count(), 0);
  await page.goto(url + '/shop');
  const wallet = page.getByRole('button', { name: 'أضف محفظة بسيطة إلى السلة', exact: true });
  await wallet.waitFor();
  await page.getByText('نفدت الكمية', { exact: true }).waitFor();
  assert.equal(await wallet.isDisabled(), true);
  assert.equal(
    await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة', exact: true }).isEnabled(),
    true,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'reserved → prepared → dispatched → returned quarantine → receipt UI → inspection UI → stock availability and tenant isolation',
      responsiveWidths: [1440, 390, 360],
      screenshots: 4,
      database: 'isolated memory',
    }),
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
