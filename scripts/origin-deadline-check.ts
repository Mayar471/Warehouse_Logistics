import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
let now = Date.now();
const system = buildApp(db, {
  applicationKey: 'deadline-test',
  webhookKey: 'deadline-secret',
  demoMode: true,
  clock: () => now,
});
const { app } = system;
await app.register(staticFiles, { root: resolve('dist'), index: 'index.html' });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const sessions: Record<string, string> = {};
  for (const accountId of ['ops', 'courier-b'])
    sessions[accountId] = (
      await app.inject({ method: 'POST', url: '/api/demo/session', payload: { accountId } })
    ).headers['set-cookie']!.toString().split(';')[0];
  const headers = { authorization: 'Bearer deadline-test', 'x-merchant-id': 'merchant-a' };
  const q = await app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers,
    payload: {
      externalReference: randomUUID(),
      recipientName: 'اختبار تأخر المنشأ',
      originId: 'site-a',
      destination: 'الروضة، دمشق',
      weightKg: 1,
    },
  });
  let s = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { quoteId: q.json().id },
    })
  ).json();
  for (const [action, who] of [
    ['assign', 'ops'],
    ['accept', 'courier-b'],
  ] as const) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/shipments/${s.id}/actions`,
      headers: { cookie: sessions[who], 'idempotency-key': randomUUID() },
      payload: {
        action,
        expectedVersion: s.version,
        ...(action === 'assign' ? { courierId: 'courier-b' } : {}),
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    s = r.json();
  }
  now += 30 * 60_000 + 1;
  await system.sweepAssignments();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // This isolated ephemeral server reuses the fixed demo origin policy; origin rejection has separate API tests.
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'متابعة تأخر ' + s.reference, exact: true }).click();
  await page
    .getByRole('alert')
    .getByText(/تأخر الاستلام من المنشأ/)
    .waitFor();
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({
    path: 'artifacts/screenshots/origin-overdue-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/origin-overdue-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('merchant-a');
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد تجهيز الطرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد تسليم الطرد للمندوب', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByText('سجل المتجر التسليم إلى', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'تحرير الإسناد قبل الاستلام' }).count(), 0);
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('button', { name: s.reference, exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('button', { name: 'بدء التوصيل', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('button', { name: s.reference, exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'متابعة تأخر ' + s.reference, exact: true })
    .waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'accepted pickup deadline → visible operations alert → merchant preparation and release → blocked reassignment → courier receipt clears alert',
      screenshots: 2,
      database: 'isolated memory',
    }),
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
