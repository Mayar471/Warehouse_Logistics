import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

// Explicitly in-memory: never open .local/postgres or the user's orders.
const db = await openDatabase('memory://');
const { app } = buildApp(db, {
  applicationKey: 'delivery-ui-test',
  webhookKey: 'delivery-ui-secret',
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
for (const accountId of ['ops', 'merchant-a', 'courier-b', 'pickup-a'])
  cookies[accountId] = (
    await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
  ).headers['set-cookie']!.toString().split(';')[0];
async function post(path: string, payload: Record<string, unknown>, who: string) {
  const response = await app.inject({
    method: 'POST',
    url: path,
    payload,
    headers: { cookie: cookies[who], 'idempotency-key': crypto.randomUUID() },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
async function page(who?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (who) {
    const [name, value] = cookies[who].split('=');
    await ctx.addCookies([{ name, value, url }]);
  }
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}
try {
  const customer = await page();
  await customer.goto(url + '/shop');
  await customer.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await customer.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await customer.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await customer.getByLabel('اسم المستلم').fill('عميل اختبار التأكيد');
  await customer.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  await customer.getByLabel('نقطة الاستلام', { exact: true }).selectOption('pickup-a');
  await customer.getByLabel('طريقة الدفع في التجربة').selectOption('cod');
  await customer.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  const ordered = customer.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await customer.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  let shipment = (await (await ordered).json()).shipment;
  for (const [action, who, extra] of [
    ['prepare', 'merchant-a', {}],
    ['assign', 'ops', { courierId: 'courier-b' }],
    ['accept', 'courier-b', {}],
    ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
    ['pickup', 'courier-b', {}],
    ['depart', 'courier-b', {}],
    ['arrive_pickup', 'courier-b', {}],
  ] as const)
    shipment = await post(
      `/api/shipments/${shipment.id}/actions`,
      { action, expectedVersion: shipment.version, ...extra },
      who,
    );
  const observer = await page('ops');
  await observer.goto(url);
  await observer.getByRole('button', { name: shipment.reference, exact: true }).click();
  const diagram = observer.getByLabel('مخطط تقدم التسليم');
  await diagram.getByText('المنشأ · مكتمل', { exact: true }).waitFor();
  assert.equal(await diagram.locator('.stop-done').count(), 1);
  const point = await page('pickup-a');
  await point.goto(url);
  await point.getByRole('button', { name: shipment.reference, exact: true }).click();
  await point.getByRole('button', { name: 'تأكيد استلام الطرد من المندوب', exact: true }).click();
  await point.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await diagram.getByText('نقطة الاستلام · مكتمل', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await diagram.locator('.stop-done').count(), 2);
  await observer.locator('.custody').getByText('نقطة استلام الروضة', { exact: true }).waitFor();
  assert.equal(
    await observer
      .locator('.timeline-recorded .timeline-dot')
      .evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).backgroundColor === 'rgb(52, 129, 106)'),
      ),
    true,
  );
  await customer.getByRole('button', { name: 'طلباتي', exact: true }).click();
  await customer.getByRole('button', { name: 'إظهار رمز الاستلام', exact: true }).click();
  const code = await customer.getByTestId('delivery-code').innerText();
  await point.getByRole('button', { name: 'تسليم العميل برمز الاستلام', exact: true }).click();
  await point
    .getByLabel('رمز استلام العميل', { exact: true })
    .fill(code.replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d))));
  assert.equal(await point.getByLabel('رمز استلام العميل', { exact: true }).inputValue(), code);
  await point
    .getByLabel('المبلغ النقدي المستلم بالليرة السورية')
    .fill(String(shipment.collection.totalMinor / 100));
  await point.getByLabel('مرجع إقرار التحصيل', { exact: true }).fill('،');
  await point.getByLabel('أؤكد استلام كامل النقد فعليًا في تجربة العرض.').check();
  const confirm = point.getByRole('button', { name: 'تأكيد الإجراء', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await point
    .locator('#confirmation-requirements')
    .getByText(/اكتب مرجع إقرار التحصيل من 3 أحرف/)
    .waitFor();
  await point.getByLabel('مرجع إقرار التحصيل', { exact: true }).fill('إيصال اختبار 123');
  assert.equal(
    await point.getByLabel('أؤكد استلام كامل النقد فعليًا في تجربة العرض.').isChecked(),
    false,
  );
  await point.getByLabel('أؤكد استلام كامل النقد فعليًا في تجربة العرض.').check();
  assert.equal(await confirm.isEnabled(), true);
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await point.setViewportSize({ width, height: 1000 });
    assert.ok(await point.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await point.screenshot({
      path: `artifacts/screenshots/delivery-confirmation-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await confirm.click();
  await diagram.getByText('استلام العميل · مكتمل', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await diagram.locator('.stop-done').count(), 3);
  await observer.locator('.custody').getByText('العميل', { exact: true }).waitFor();
  await customer.getByText('تم التسليم', { exact: true }).first().waitFor({ timeout: 15000 });
  assert.equal(await customer.locator('.shop-progress .done').count(), 5);
  await customer.getByRole('button', { name: 'طلب إرجاع كامل الطلب', exact: true }).click();
  await customer.getByLabel('سبب طلب الإرجاع').fill('المنتج لا يناسب احتياجات العميل');
  await customer.getByLabel('راجعت طلب الإرجاع وأؤكد تسجيله لطلبي.').check();
  await customer.getByRole('button', { name: 'تأكيد طلب الإرجاع', exact: true }).click();
  await customer.getByRole('button', { name: 'سحب طلب الإرجاع', exact: true }).waitFor();
  const merchant = await page('merchant-a');
  await merchant.goto(url);
  await merchant.getByRole('button', { name: 'مرتجعات العملاء', exact: true }).click();
  await merchant.getByRole('button', { name: 'قبول طلب الإرجاع', exact: true }).click();
  await merchant.getByLabel('مرجع قرار الإرجاع').fill('قرار تجريبي 123');
  await merchant
    .getByLabel('رد المتجر الموضح للعميل')
    .fill('قبول طلب الإرجاع لتنظيم استلام البضاعة');
  await merchant.getByLabel('راجعت طلب العميل وأثر القرار وأوافق على عرضه للعميل.').check();
  await merchant.getByRole('button', { name: 'تأكيد قرار الإرجاع', exact: true }).click();
  await customer
    .getByText('رد المتجر: قبول طلب الإرجاع لتنظيم استلام البضاعة', { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(await customer.locator('.shop-progress .done').count(), 5);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: pickup COD confirmation guidance, Arabic digits, review reset, live route/timeline and customer progress, responsive 1440/390/360.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
