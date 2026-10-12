import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'cash-browser',
  webhookKey: 'cash-browser-secret',
  demoMode: true,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const cookies: Record<string, string> = {};
for (const accountId of ['ops', 'merchant-a', 'courier-b'])
  cookies[accountId] = (
    await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
  ).headers['set-cookie']!.toString().split(';')[0];
async function post(url: string, payload: Record<string, unknown>, who = 'ops') {
  const r = await app.inject({
    method: 'POST',
    url,
    payload,
    headers: { cookie: cookies[who], 'idempotency-key': crypto.randomUUID() },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let lostDelivery = true,
  lostReceipt = true;
const errors: string[] = [];
async function context(who?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  if (who) {
    const [name, value] = cookies[who].split('=');
    await ctx.addCookies([{ name, value, url }]);
  }
  await ctx.route('**/api/**', async (route) => {
    const req = route.request();
    const response = await route.fetch({
      headers: { ...req.headers(), origin: 'http://127.0.0.1:3001' },
    });
    const delivery =
      lostDelivery &&
      req.method() === 'POST' &&
      req.url().includes('/api/shipments/') &&
      req.url().endsWith('/actions') &&
      req.postDataJSON()?.action === 'deliver';
    const receipt =
      lostReceipt &&
      req.method() === 'POST' &&
      req.url().includes('/api/cash/') &&
      req.postDataJSON()?.action === 'receive';
    if (delivery || receipt) {
      if (delivery) lostDelivery = false;
      else lostReceipt = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'رد اختبار مفقود بعد الحفظ' }),
      });
    } else await route.fulfill({ response });
  });
  return ctx;
}
try {
  const customerCtx = await context(),
    customer = await customerCtx.newPage();
  customer.on('pageerror', (e) => errors.push(e.message));
  await customer.goto(url + '/shop');
  await customer.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await customer.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await customer.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await customer.getByLabel('اسم المستلم').fill('عميل التحصيل التجريبي');
  await customer.getByLabel('العنوان بالتفصيل').fill('عنوان تجريبي واضح في دمشق');
  await customer.getByLabel('طريقة الدفع في التجربة').selectOption('cod');
  await customer.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await customer
    .getByText('الدفع نقدًا عند الاستلام: كامل الإجمالي الظاهر أعلاه.', { exact: true })
    .waitFor();
  await mkdir('artifacts/screenshots', { recursive: true });
  await customer.setViewportSize({ width: 390, height: 1000 });
  await customer.screenshot({
    path: 'artifacts/screenshots/cash-checkout-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  const ordered = customer.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await customer.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  let shipment = (await (await ordered).json()).shipment;
  assert.ok(shipment.collection);
  for (const [action, who, extra] of [
    ['prepare', 'merchant-a', {}],
    ['assign', 'ops', { courierId: 'courier-b' }],
    ['accept', 'courier-b', {}],
    ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
    ['pickup', 'courier-b', {}],
    ['depart', 'courier-b', {}],
  ] as const)
    shipment = await post(
      `/api/shipments/${shipment.id}/actions`,
      { action, expectedVersion: shipment.version, ...extra },
      who,
    );
  await customer.getByRole('button', { name: 'طلباتي', exact: true }).click();
  await customer.getByRole('button', { name: 'إظهار رمز الاستلام', exact: true }).click();
  const code = await customer.getByTestId('delivery-code').innerText();
  const courierCtx = await context('courier-b'),
    courier = await courierCtx.newPage();
  courier.on('pageerror', (e) => errors.push(e.message));
  await courier.goto(url);
  await courier.getByRole('button', { name: shipment.reference, exact: true }).click();
  await courier.getByRole('button', { name: 'تأكيد التسليم برمز العميل', exact: true }).click();
  await courier.getByLabel('رمز استلام العميل', { exact: true }).fill(code);
  await courier
    .getByLabel('المبلغ النقدي المستلم بالليرة السورية')
    .fill(String(shipment.collection.totalMinor / 100));
  await courier.getByLabel('مرجع إقرار التحصيل').fill('إقرار تحصيل العميل ١٠١');
  await courier.getByLabel('أؤكد استلام كامل النقد فعليًا في تجربة العرض.').check();
  await courier.screenshot({
    path: 'artifacts/screenshots/cash-collection-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await courier.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await courier.getByRole('button', { name: 'إعادة تأكيد الإجراء المعلق', exact: true }).waitFor();
  assert.equal(
    await courier.getByLabel('المبلغ النقدي المستلم بالليرة السورية').isDisabled(),
    true,
  );
  await courier.getByRole('button', { name: 'إعادة تأكيد الإجراء المعلق', exact: true }).click();
  await courier.getByText('تم التسليم', { exact: true }).first().waitFor();
  await courier.keyboard.press('Escape');
  const opsCtx = await context('ops'),
    ops = await opsCtx.newPage();
  ops.on('pageerror', (e) => errors.push(e.message));
  await ops.goto(url);
  await ops.getByRole('button', { name: 'التحصيل وعهدة النقد', exact: true }).click();
  await ops.getByRole('button', { name: 'تسجيل فرق نقدي', exact: true }).click();
  await ops
    .getByLabel('المبلغ المعدود فعليًا بالليرة السورية')
    .fill(String(shipment.collection.totalMinor / 100 - 1));
  await ops.getByLabel('مرجع الإيصال أو محضر الفرق').fill('محضر فرق ١٠١');
  await ops.getByLabel('سبب الإقرار المالي').fill('نقص عند العد في تجربة العرض');
  await ops.getByLabel('راجعت المبلغ والمرجع وأؤكد الإقرار باسم حسابي.').check();
  await ops.getByRole('button', { name: 'تأكيد الإقرار المالي', exact: true }).click();
  await ops.locator('.inventory-form').waitFor({ state: 'detached' });
  await ops
    .getByText('فرق نقدي مفتوح؛ لم تُغلق العهدة ولم يُشطب المبلغ.', { exact: true })
    .waitFor();
  await ops.getByRole('button', { name: 'استلام عهدة الأموال', exact: true }).click();
  await ops
    .getByLabel('المبلغ المعدود فعليًا بالليرة السورية')
    .fill(String(shipment.collection.totalMinor / 100));
  await ops.getByLabel('مرجع الإيصال أو محضر الفرق').fill('إيصال استلام ١٠٢');
  await ops.getByLabel('سبب الإقرار المالي').fill('استلام كامل النقد بعد مراجعة الفرق');
  await ops.getByLabel('راجعت المبلغ والمرجع وأؤكد الإقرار باسم حسابي.').check();
  for (const width of [1440, 390, 360]) {
    await ops.setViewportSize({ width, height: 1100 });
    await ops.evaluate(() => document.fonts.ready);
    assert.ok(await ops.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ops.screenshot({
      path: `artifacts/screenshots/cash-receipt-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await ops.getByRole('button', { name: 'تأكيد الإقرار المالي', exact: true }).click();
  await ops
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await ops.getByLabel('المبلغ المعدود فعليًا بالليرة السورية').isDisabled(), true);
  await ops.getByRole('button', { name: 'تأكيد الإقرار المالي', exact: true }).click();
  await ops.locator('.inventory-form').waitFor({ state: 'detached' });
  const view = (await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })).json();
  assert.equal(view.heldMinor, 0);
  assert.equal(view.receivedMinor, shipment.collection.totalMinor);
  assert.equal(view.goodsLiabilityMinor, shipment.collection.goodsMinor);
  assert.equal(view.consistent, true);
  assert.equal((await db.query('SELECT * FROM cash_journals')).rows.length, 2);
  assert.equal(view.history.length, 3);
  assert.deepEqual(errors, []);
  console.log(
    'COD storefront + courier proof/cash, lost delivery and receipt replies, difference audit, separate operations receipt and responsive 1440/390/360 layouts verified.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
