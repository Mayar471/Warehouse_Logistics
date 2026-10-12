import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase();
const { app } = buildApp(db, {
  applicationKey: 'payout-browser',
  webhookKey: 'payout-browser-secret',
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
for (const accountId of ['ops', 'merchant-a', 'merchant-b', 'courier-b'])
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
    paymentMode: 'cod',
    recipientName: 'عميل صرف تجريبي',
    district: 'الروضة',
    address: 'عنوان اختبار صرف المستحقات',
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
const proof = await post(`/api/storefront/orders/${shipment.id}/delivery-code`, {}, 'shop');
shipment = await post(
  `/api/shipments/${shipment.id}/actions`,
  {
    action: 'deliver',
    expectedVersion: shipment.version,
    deliveryCode: proof.code,
    cash: {
      amountMinor: shipment.collection.totalMinor,
      currency: 'SYP',
      reference: 'تحصيل عميل الصرف',
    },
  },
  'courier-b',
);
await post(`/api/cash/${shipment.id}/actions`, {
  action: 'receive',
  expectedVersion: shipment.collection.version,
  amountMinor: shipment.collection.totalMinor,
  currency: 'SYP',
  reference: 'إيصال خزينة المصدر',
  reason: 'استلام نقد فعلي تجريبي قبل الصرف',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [],
  writes: { action: string; key: string; forwarded: boolean }[] = [];
let stage: 'create_lost' | 'release_aborted' | 'confirm_held' | 'none' = 'create_lost';
let heldResolve: () => void = () => {},
  releaseHeld: () => void = () => {};
const held = new Promise<void>((r) => (heldResolve = r)),
  gate = new Promise<void>((r) => (releaseHeld = r));
async function context(who: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const [name, value] = cookies[who].split('=');
  await ctx.addCookies([{ name, value, url }]);
  await ctx.route('**/api/**', async (route) => {
    const req = route.request(),
      action =
        req.method() === 'POST' &&
        (req.url().endsWith('/api/payouts') || /\/api\/payouts\/[^/]+\/actions$/.test(req.url()))
          ? req.url().endsWith('/api/payouts')
            ? 'create'
            : req.postDataJSON()?.action
          : null;
    const entry = action
      ? { action, key: req.headers()['idempotency-key'], forwarded: true }
      : null;
    if (entry) writes.push(entry);
    if (action === 'release' && stage === 'release_aborted') {
      stage = 'none';
      entry!.forwarded = false;
      await route.abort('failed');
      return;
    }
    if (action === 'confirm' && stage === 'confirm_held') {
      heldResolve();
      await gate;
    }
    const response = await route.fetch({
      headers: { ...req.headers(), origin: 'http://127.0.0.1:3001' },
    });
    if (
      (action === 'create' && stage === 'create_lost') ||
      (action === 'confirm' && stage === 'confirm_held')
    ) {
      stage = 'none';
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'رد مفقود بعد حفظ الإقرار' }),
      });
    } else await route.fulfill({ response });
  });
  return ctx;
}
async function pageFor(ctx: Awaited<ReturnType<typeof context>>) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  return page;
}
async function formFields(
  page: Awaited<ReturnType<typeof pageFor>>,
  reference: string,
  amount?: string,
) {
  if (amount !== undefined) await page.getByLabel('المبلغ الفعلي بالليرة السورية').fill(amount);
  await page.getByLabel('مرجع إقرار الصرف').fill(reference);
  await page.getByLabel('سبب إجراء الصرف').fill('إقرار مالي محفوظ لاختبار الاستعادة');
  await page.getByLabel('راجعت أثر الإقرار على النقد والمستحقات وأؤكد التسجيل باسم حسابي.').check();
}
const recovery = (page: Awaited<ReturnType<typeof pageFor>>) =>
  page.getByRole('region', { name: 'استعادة الإقرار المالي' });
const stored = (page: Awaited<ReturnType<typeof pageFor>>, actor = 'ops') =>
  page.evaluate(
    (id) => localStorage.getItem(`logistics:financial-command:v1:${encodeURIComponent(id)}`),
    actor,
  );
async function cash() {
  return (await app.inject({ url: '/api/cash', headers: { cookie: cookies.ops } })).json();
}
try {
  const opsCtx = await context('ops');
  let ops = await pageFor(opsCtx);
  await ops.getByRole('button', { name: 'مستحقات المتاجر', exact: true }).click();
  await ops.getByRole('button', { name: 'حجز صرف المستحق', exact: true }).click();
  await formFields(ops, 'حجز يستعاد بعد إغلاق التبويب');
  await ops.getByRole('button', { name: 'تأكيد إقرار الصرف', exact: true }).click();
  await ops
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  const saved = JSON.parse((await stored(ops))!);
  assert.equal(saved.actorId, 'ops');
  await ops.close();
  ops = await pageFor(opsCtx);
  await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  await recovery(ops).waitFor();
  assert.equal(
    await ops.getByRole('button', { name: 'تسليم نقد المستحقات', exact: true }).isDisabled(),
    true,
  );
  await ops.getByLabel('حساب العرض').selectOption('merchant-b');
  await ops.waitForFunction(
    () => document.querySelector<HTMLSelectElement>('#account')?.value === 'merchant-b',
  );
  assert.equal(
    await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).count(),
    0,
  );
  assert.equal(await ops.getByText('حجز يستعاد بعد إغلاق التبويب', { exact: false }).count(), 0);
  await ops.getByLabel('حساب العرض').selectOption('ops');
  await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  const cookie = (await opsCtx.cookies()).find((c) => c.name === 'session')!;
  cookies.ops = `session=${cookie.value}`;
  await mkdir('artifacts/screenshots', { recursive: true });
  for (const width of [1440, 390, 360]) {
    await ops.setViewportSize({ width, height: 1100 });
    await ops.evaluate(() => document.fonts.ready);
    assert.ok(await ops.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ops.screenshot({
      path: `artifacts/screenshots/financial-recovery-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await recovery(ops).getByRole('button', { name: 'فحص نتيجة الحفظ', exact: true }).click();
  await recovery(ops).waitFor({ state: 'detached' });
  assert.equal(await stored(ops), null);
  assert.equal(writes.filter((w) => w.action === 'create').length, 1);
  stage = 'release_aborted';
  await ops.getByRole('button', { name: 'تسليم نقد المستحقات', exact: true }).click();
  await formFields(ops, 'خروج محفوظ لم يصل للخادم', '185000');
  await ops.getByRole('button', { name: 'تأكيد إقرار الصرف', exact: true }).click();
  await ops
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  const before = JSON.parse((await stored(ops))!);
  await ops.reload();
  await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  await recovery(ops).getByRole('button', { name: 'فحص نتيجة الحفظ', exact: true }).click();
  await recovery(ops)
    .getByText(/لم يجد الخادم إقرارًا محفوظًا/)
    .waitFor();
  assert.equal(
    await recovery(ops)
      .getByRole('button', { name: 'إعادة إرسال الإقرار المحفوظ', exact: true })
      .isDisabled(),
    true,
  );
  await recovery(ops)
    .getByLabel('راجعت الإقرار المحفوظ وأوافق على إعادة إرساله دون تغيير.')
    .check();
  await recovery(ops)
    .getByRole('button', { name: 'إعادة إرسال الإقرار المحفوظ', exact: true })
    .click();
  await recovery(ops).waitFor({ state: 'detached' });
  const releases = writes.filter((w) => w.action === 'release');
  assert.equal(releases.length, 2);
  assert.equal(releases[0].key, before.key);
  assert.equal(releases[1].key, before.key);
  assert.equal(releases.filter((w) => w.forwarded).length, 1);
  const merchantCtx = await context('merchant-a'),
    merchant = await pageFor(merchantCtx);
  await merchant.getByRole('button', { name: 'مستحقات المتاجر', exact: true }).click();
  await merchant.getByRole('button', { name: 'تأكيد استلام المستحقات', exact: true }).click();
  await formFields(merchant, 'استلام المتجر المحفوظ', '185000');
  stage = 'confirm_held';
  await merchant.getByRole('button', { name: 'تأكيد إقرار الصرف', exact: true }).click();
  await held;
  const another = await pageFor(merchantCtx);
  await another.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  await recovery(another)
    .getByLabel('راجعت الإقرار المحفوظ وأوافق على إعادة إرساله دون تغيير.')
    .check();
  await recovery(another)
    .getByRole('button', { name: 'إعادة إرسال الإقرار المحفوظ', exact: true })
    .click();
  await recovery(another)
    .getByText(/تجري متابعة إقرار لهذا الحساب في صفحة أخرى/)
    .waitFor();
  assert.equal(writes.filter((w) => w.action === 'confirm').length, 1);
  releaseHeld();
  await merchant
    .getByRole('alert')
    .getByText(/لم نتأكد من نتيجة الحفظ/)
    .waitFor();
  await merchant.close();
  await recovery(another).getByRole('button', { name: 'فحص نتيجة الحفظ', exact: true }).click();
  await recovery(another).waitFor({ state: 'detached' });
  assert.equal(await stored(another, 'merchant-a'), null);
  assert.equal(writes.filter((w) => w.action === 'confirm').length, 1);
  const balances = await cash();
  assert.equal(balances.goodsLiabilityMinor, 0);
  assert.equal(balances.payoutInTransitMinor, 0);
  assert.equal(balances.consistent, true);
  assert.equal((await db.query('SELECT * FROM cash_journals')).rows.length, 4);
  await ops.evaluate(
    (c) => localStorage.setItem('logistics:financial-command:v1:ops', JSON.stringify(c)),
    { ...before, key: crypto.randomUUID() },
  );
  await ops.reload();
  await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  await recovery(ops)
    .getByLabel('راجعت الإقرار المحفوظ وأوافق على إعادة إرساله دون تغيير.')
    .check();
  await recovery(ops)
    .getByRole('button', { name: 'إعادة إرسال الإقرار المحفوظ', exact: true })
    .click();
  await ops
    .getByRole('alert')
    .getByText(/تغير طلب الصرف/)
    .waitFor();
  assert.equal(await stored(ops), null);
  assert.equal((await db.query('SELECT * FROM cash_journals')).rows.length, 4);
  await ops.evaluate(() => localStorage.setItem('logistics:financial-command:v1:ops', '{broken'));
  await ops.reload();
  await ops.getByRole('button', { name: 'متابعة الإقرار المالي', exact: true }).click();
  await recovery(ops)
    .getByText(/تعذر قراءة سجل الإقرار المحفوظ/)
    .waitFor();
  assert.equal(
    await ops.getByRole('button', { name: 'طلب رجوع الحوالة', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await stored(ops), '{broken');
  assert.deepEqual(errors, []);
  console.log(
    'Closed-tab recovery, read-only committed lookup, explicit replay of unsent request, actor isolation, cross-tab lock, corrupt storage and responsive layouts verified.',
  );
} finally {
  releaseHeld();
  await browser.close();
  await app.close();
  await db.close();
}
