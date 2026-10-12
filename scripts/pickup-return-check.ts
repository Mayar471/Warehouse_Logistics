import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

// Isolated memory database and controllable clock: never advance the running demo's clock.
const db = await openDatabase();
let now = Date.now();
const system = buildApp(db, {
  applicationKey: 'isolated-test',
  webhookKey: 'isolated-proof',
  demoMode: true,
  clock: () => now,
});
const { app } = system;
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
await app.listen({ host: '127.0.0.1', port: 3002 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const cookies: Record<string, string> = {};
  for (const accountId of ['ops', 'courier-b', 'pickup-a', 'merchant-a']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId },
    });
    cookies[accountId] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  const customer = (
    await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
  ).headers['set-cookie']!.toString().split(';')[0];
  const q = await app.inject({
    method: 'POST',
    url: '/api/storefront/checkouts',
    headers: { cookie: customer },
    payload: {
      items: [{ productId: 'bag', quantity: 1 }],
      recipientName: 'اختبار إرجاع النقطة',
      district: 'الروضة',
      address: 'عنوان اصطناعي',
      pickupSiteId: 'pickup-a',
    },
  });
  let s = (
    await app.inject({
      method: 'POST',
      url: '/api/storefront/orders',
      headers: { cookie: customer },
      payload: { checkoutId: q.json().id },
    })
  ).json().shipment;
  for (const [action, who] of [
    ['assign', 'ops'],
    ['accept', 'courier-b'],
    ['prepare', 'merchant-a'],
    ['handover_origin', 'merchant-a'],
    ['pickup', 'courier-b'],
    ['depart', 'courier-b'],
    ['arrive_pickup', 'courier-b'],
    ['receive_pickup', 'pickup-a'],
  ] as const) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/shipments/${s.id}/actions`,
      headers: { cookie: cookies[who], 'idempotency-key': randomUUID() },
      payload: {
        action,
        expectedVersion: s.version,
        ...(['assign', 'handover_origin'].includes(action) ? { courierId: 'courier-b' } : {}),
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    s = r.json();
  }
  now += 72 * 60 * 60_000 + 1;
  await system.sweepAssignments();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // The isolated test uses port 3002; preserve the application's fixed production-demo origin allowlist.
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:3002/');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByLabel('اختيار المندوب').selectOption('courier-b');
  await page.getByRole('button', { name: 'إسناد الإرجاع', exact: true }).click();
  await page.getByText('الإرجاع مسند إلى', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'تأكيد وصول المرتجع للمنشأ' }).count(), 0);
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByRole('button', { name: 'قبول المهمة', exact: true }).click();
  await page.getByRole('button', { name: 'قبول المهمة', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('pickup-a');
  await page.getByRole('heading', { name: 'نقطة استلام الروضة', exact: true }).waitFor();
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد تسليم الطرد لمندوب الإرجاع', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page
    .getByRole('button', { name: 'تأكيد تسليم الطرد لمندوب الإرجاع', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد وصول المرتجع للمنشأ', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.locator('.status-returned').first().waitFor();
  assert.equal(
    (await app.inject({ url: `/api/shipments/${s.id}`, headers: { cookie: cookies.ops } })).json()
      .shipment.status,
    'returned',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'expired pickup → return assignment → courier acceptance → point custody handover → origin receipt',
      database: 'isolated memory',
    }),
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
