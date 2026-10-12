import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'transfer-browser',
  webhookKey: 'transfer-browser-secret',
  demoMode: true,
});
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith('/api/')
    ? reply.code(404).send({ message: 'غير موجود' })
    : reply.sendFile('index.html'),
);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const cookie = (
  await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId: 'ops' } })
).headers['set-cookie']!.toString().split(';')[0];
const warehouse = await app.inject({
  method: 'POST',
  url: '/api/inventory/sites',
  headers: { cookie, 'idempotency-key': crypto.randomUUID() },
  payload: {
    merchantId: 'merchant-a',
    name: 'مستودع وجهة النقل',
    address: 'دمشق، عنوان وجهة مستقل للاختبار',
    products: ['bag', 'cup'],
    reason: 'تجهيز وجهة النقل للاختبار',
  },
});
assert.equal(warehouse.statusCode, 200, warehouse.body);
const destination = warehouse.json().id;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let lostCreate = true,
    lostReceive = true;
  await ctx.route('**/api/**', async (route) => {
    const request = route.request();
    const response = await route.fetch({
      headers: { ...request.headers(), origin: 'http://127.0.0.1:3001' },
    });
    const creation =
      lostCreate &&
      request.method() === 'POST' &&
      request.url().endsWith('/api/inventory/transfers');
    const receipt =
      lostReceive &&
      request.method() === 'POST' &&
      request.url().endsWith('/actions') &&
      request.postDataJSON()?.action === 'receive';
    if (creation || receipt) {
      assert.equal(response.status(), 200);
      if (creation) lostCreate = false;
      else lostReceive = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'LOST_TRANSFER_REPLY',
          message: 'test response lost after commit',
        }),
      });
    } else await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'النقل بين المواقع', exact: true }).click();
  await page.getByRole('button', { name: 'نقل جديد', exact: true }).click();
  await page.getByLabel('موقع المصدر', { exact: true }).selectOption('site-a');
  await page.getByLabel('موقع الوجهة', { exact: true }).selectOption(destination);
  await page.getByLabel('كمية النقل: حقيبة يومية', { exact: true }).fill('5');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('نقل خمس قطع لتجهيز مخزون الوجهة');
  await page.evaluate(() => document.fonts.ready);
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/transfer-create-mobile.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد حجز النقل', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(await page.getByLabel('موقع المصدر', { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole('button', { name: 'تحديث مهام النقل', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد حجز النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  const rows = (
    await db.query<{ id: string; version: number }>('SELECT id,version FROM inventory_transfers')
  ).rows;
  assert.equal(rows.length, 1);
  const id = rows[0].id;
  assert.equal(
    (
      await db.query<{ reserved: number }>(
        "SELECT reserved FROM inventory_stock WHERE site_id='site-a' AND product_id='bag'",
      )
    ).rows[0].reserved,
    5,
  );
  const confirm = async (button: string, reason: string) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByLabel('سبب إجراء النقل / مرجعه', { exact: true }).fill(reason);
    await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
    await page.locator('.inventory-form').waitFor({ state: 'detached' });
  };
  const account = async (who: string) => {
    await page.getByLabel('حساب العرض').selectOption(who);
    if (await page.getByRole('button', { name: 'فتح القائمة', exact: true }).isVisible())
      await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
    await page.getByRole('button', { name: 'النقل بين المواقع', exact: true }).click();
    await page.getByRole('heading', { name: 'TR-' + id.slice(0, 8), exact: true }).waitFor();
  };
  await page.getByRole('button', { name: 'إسناد النقل', exact: true }).click();
  await page.getByLabel('مندوب النقل', { exact: true }).selectOption('courier-b');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('إسناد حمولة ثلاثة كيلو للمندوب المتاح');
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await account('courier-b');
  assert.equal(
    await page.getByRole('button', { name: 'تأكيد استلام المندوب', exact: true }).count(),
    0,
  );
  await confirm('قبول المهمة', 'قبلت مهمة النقل وراجعت المصدر والوجهة');
  await account('merchant-a');
  await confirm('تسليم عهدة المصدر', 'سُلّمت خمس قطع إلى المندوب المكلف');
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE site_id=$1 AND product_id='bag'",
        [destination],
      )
    ).rows[0].on_hand,
    0,
  );
  assert.equal(await page.getByRole('button', { name: 'إلغاء الحجز', exact: true }).count(), 0);
  await account('courier-b');
  await confirm('تأكيد استلام المندوب', 'استلمت خمس قطع من المصدر بعهدتي');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: 'artifacts/screenshots/transfer-courier-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await account('merchant-a');
  await page.getByRole('button', { name: 'استلام في الوجهة', exact: true }).click();
  await page.getByLabel('المستلم فعليًا: حقيبة يومية', { exact: true }).fill('3');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('استلمت ثلاث قطع؛ قطعتان لم تصلا وتبقيان في عهدة النقل');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.inventory-form').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'artifacts/screenshots/transfer-receive-mobile.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  assert.equal(
    await page.getByLabel('المستلم فعليًا: حقيبة يومية', { exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await page.getByText(/فرق أو تعثر مفتوح: 2 قطع/).waitFor();
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE site_id=$1 AND product_id='bag'",
        [destination],
      )
    ).rows[0].on_hand,
    3,
  );
  assert.equal(
    (
      await db.query(
        "SELECT * FROM inventory_movements WHERE transfer_id=$1 AND kind='transfer_receive'",
        [id],
      )
    ).rows.length,
    1,
  );
  await page.setViewportSize({ width: 360, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/transfer-partial-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await confirm('تسجيل فرق أو تعثر', 'متابعة القطعتين غير المستلمتين دون إضافة مخزون وهمي');
  await page.getByRole('button', { name: 'استلام في الوجهة', exact: true }).click();
  await page.getByLabel('المستلم فعليًا: حقيبة يومية', { exact: true }).fill('2');
  await page
    .getByLabel('سبب إجراء النقل / مرجعه', { exact: true })
    .fill('وصول القطعتين المتبقيتين والتحقق منهما');
  await page.getByRole('button', { name: 'تأكيد إجراء النقل', exact: true }).click();
  await page.locator('.inventory-form').waitFor({ state: 'detached' });
  await page.getByText('اكتمل الاستلام', { exact: true }).waitFor();
  assert.equal(
    (
      await db.query<{ on_hand: number }>(
        "SELECT on_hand FROM inventory_stock WHERE site_id=$1 AND product_id='bag'",
        [destination],
      )
    ).rows[0].on_hand,
    5,
  );
  const report = await app.inject({ url: '/api/inventory/reconciliation', headers: { cookie } });
  assert.equal(report.json().exceptions, 0, report.body);
  await page.getByLabel('حساب العرض').selectOption('merchant-b');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('button', { name: 'النقل بين المواقع', exact: true }).click();
  await page.getByText('لا توجد مهام نقل في نطاقك', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Transfer browser passed: reserve → assign → independent accept/release/pickup → partial actual receipt → report discrepancy → completion; create/receive lost replies replay once, tenant isolation, RTL 1440/390/360.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
