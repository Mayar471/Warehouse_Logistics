import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'location-browser',
  webhookKey: 'location-browser-secret',
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
cookies.shop = (
  await app.inject({ method: 'POST', url: '/api/storefront/session', payload: {} })
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
const q = await post(
  '/api/storefront/checkouts',
  {
    items: [{ productId: 'bag', quantity: 1 }],
    recipientName: 'عميل خريطة الاختبار',
    district: 'الروضة',
    address: 'عنوان اختبار اصطناعي',
  },
  'shop',
);
let shipment = (await post('/api/storefront/orders', { checkoutId: q.id }, 'shop')).shipment;
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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2e8"/><path d="M0 65H256M0 190H256M55 0V256M190 0V256" stroke="#ffffff" stroke-width="12"/><path d="M0 65H256M0 190H256M55 0V256M190 0V256" stroke="#d6dfd4" stroke-width="1"/><text x="82" y="132" fill="#a1afa1" font-size="12">TEST MAP TILE</text></svg>`;
let lost = true,
  lostStop = true,
  tileRequests = 0;
async function context(who: string, geo = false) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    ...(geo
      ? {
          permissions: ['geolocation'],
          geolocation: { latitude: 33.5138, longitude: 36.2765, accuracy: 18 },
        }
      : {}),
  });
  const [name, value] = cookies[who].split('=');
  await ctx.addCookies([{ name, value, url }]);
  await ctx.route('https://tile.openstreetmap.org/**', async (route) => {
    tileRequests++;
    await route.fulfill({ contentType: 'image/svg+xml', body: tile });
  });
  await ctx.route('**/api/**', async (route) => {
    const request = route.request();
    const response = await route.fetch({
      headers: { ...request.headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (
      lost &&
      request.method() === 'POST' &&
      request.url().endsWith('/location/sharing') &&
      request.postDataJSON()?.action === 'start'
    ) {
      lost = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'فقد رد اختبار بعد الحفظ' }),
      });
    } else if (
      lostStop &&
      request.method() === 'POST' &&
      request.url().endsWith('/location/sharing') &&
      request.postDataJSON()?.action === 'stop'
    ) {
      lostStop = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'فقد رد إيقاف اختبار بعد الحفظ' }),
      });
    } else await route.fulfill({ response });
  });
  return ctx;
}
try {
  const courierCtx = await context('courier-b', true),
    courier = await courierCtx.newPage();
  courier.on('pageerror', (e) => errors.push(e.message));
  await courier.goto(url);
  await courier.getByRole('button', { name: shipment.reference, exact: true }).click();
  await courier.getByText('المندوب لا يشارك موقعه حاليًا.', { exact: true }).first().waitFor();
  await courier
    .getByLabel('أوافق على مشاركة موقعي للمتجر والعمليات أثناء توصيل هذه الشحنة لمدة 30 دقيقة.')
    .check();
  await courier.getByRole('button', { name: 'تفعيل مشاركة الموقع', exact: true }).click();
  await courier.getByRole('button', { name: 'إعادة تأكيد إجراء المشاركة', exact: true }).click();
  await courier.getByRole('region', { name: 'خريطة موقع المندوب', exact: true }).waitFor();
  await mkdir('artifacts/screenshots', { recursive: true });
  await courier.screenshot({
    path: 'artifacts/screenshots/location-courier-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const customerCtx = await context('shop'),
    customer = await customerCtx.newPage();
  customer.on('pageerror', (e) => errors.push(e.message));
  await customer.goto(url + '/shop');
  await customer.getByRole('button', { name: 'طلباتي', exact: true }).click();
  await customer.getByRole('button', { name: 'عرض موقع المندوب', exact: true }).click();
  await customer.getByRole('region', { name: 'خريطة موقع المندوب', exact: true }).waitFor();
  await customer.getByText('OpenStreetMap contributors', { exact: true }).waitFor();
  assert.equal(
    await customer.getByRole('button', { name: 'إيقاف المشاركة', exact: true }).count(),
    0,
  );
  for (const width of [1440, 390, 360]) {
    await customer.setViewportSize({ width, height: 1000 });
    await customer.evaluate(() => document.fonts.ready);
    assert.ok(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await customer.screenshot({
      path: `artifacts/screenshots/location-customer-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await courier.getByRole('button', { name: 'إيقاف المشاركة', exact: true }).click();
  await courier.getByRole('button', { name: 'إعادة تأكيد إجراء المشاركة', exact: true }).waitFor();
  assert.equal(
    await courier.getByRole('region', { name: 'خريطة موقع المندوب', exact: true }).count(),
    0,
  );
  await courier.getByRole('button', { name: 'إعادة تأكيد إجراء المشاركة', exact: true }).click();
  await courier.getByText('المندوب لا يشارك موقعه حاليًا.', { exact: true }).first().waitFor();
  await customer
    .getByRole('region', { name: 'خريطة موقع المندوب', exact: true })
    .waitFor({ state: 'detached', timeout: 15000 });
  const r = (
    await app.inject({
      url: `/api/storefront/orders/${shipment.id}/location`,
      headers: { cookie: cookies.shop },
    })
  ).json();
  assert.equal(r.point, null);
  assert.equal(r.state, 'off');
  const events = (await db.query<{ action: string }>('SELECT action FROM location_audit')).rows;
  assert.equal(events.filter((e) => e.action === 'started').length, 1);
  assert.equal(events.filter((e) => e.action === 'stopped').length, 1);
  assert.ok(tileRequests > 0);
  assert.deepEqual(errors, []);
  console.log(
    'Courier GPS mock consent + lost reply replay, customer map, OSM attribution, stop/revocation and 1440/390/360 layouts verified. Tiles are locally mocked; no public tile traffic.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
