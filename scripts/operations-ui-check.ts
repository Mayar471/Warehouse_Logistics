import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import staticFiles from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

// Visual QA uses isolated data; the running demo and its financial records are untouched.
const db = await openDatabase('memory://');
const { app } = buildApp(db, {
  applicationKey: 'visual-qa',
  webhookKey: 'visual-qa',
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
const errors: string[] = [];
const directory = 'artifacts/screenshots/operations-theme';
await mkdir(directory, { recursive: true });
async function check(page: Page, label: string, width: number) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${directory}/${label}-${width}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) {
    console.log(
      label,
      width,
      await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .map((el) => ({
            class: el.className,
            left: el.getBoundingClientRect().left,
            right: el.getBoundingClientRect().right,
          }))
          .filter((r) => r.left < -1 || r.right > innerWidth + 1)
          .slice(0, 18),
      ),
    );
  }
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${label} overflows at ${width}`,
  );
}
try {
  for (const width of [1440, 1024, 768, 390, 360]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    let tileRequests = 0;
    await context.route('https://tile.openstreetmap.org/**', async (route) => {
      const headers = await route.request().allHeaders();
      assert.equal(headers.referer, new URL(url).origin + '/');
      tileRequests++;
      await route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/api/**', async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
      });
      await route.fulfill({ response });
    });
    await page.goto(url);
    await page.locator('.metric').first().waitFor();
    assert.equal(
      await page
        .locator('.app-shell')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--brand-plum').trim()),
      '#762557',
    );
    await check(page, 'overview', width);
    assert.equal(await page.getByRole('button', { name: 'طلب نقل طرد', exact: true }).count(), 0);
    assert.equal(await page.locator('.route-map').count(), 0);
    const bootstrap = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    for (const [label, condition, value] of [
      [
        'تحتاج متابعة',
        (s: any) => ['failed', 'pickup_expired'].includes(s.status) || s.pickupOverdue,
        'attention',
      ],
      [
        'قيد التنفيذ',
        (s: any) =>
          [
            'ready',
            'assigned',
            'picked_up',
            'in_transit',
            'awaiting_handover',
            'ready_for_pickup',
            'returning',
          ].includes(s.status),
        'active',
      ],
      ['تم التسليم', (s: any) => s.status === 'delivered', 'delivered'],
      ['إجمالي الشحنات', () => true, 'all'],
    ] as const) {
      const expected = bootstrap.shipments.filter(condition);
      const metric = page
        .locator('.stats-grid')
        .getByRole('button', { name: new RegExp('^' + label) });
      assert.equal(
        await metric.locator('strong').innerText(),
        new Intl.NumberFormat('ar-SY').format(expected.length),
      );
      const listed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/shipments?') &&
          new URL(r.url()).searchParams.get('filter') === value,
      );
      await metric.click();
      assert.equal((await listed).status(), 200);
      await page.waitForFunction(
        (n) => document.querySelectorAll('.shipments-panel tbody tr').length === n,
        expected.length,
      );
      assert.equal(await page.getByLabel('تصفية حالة الشحنة').inputValue(), value);
      assert.equal(await page.locator('.shipments-panel tbody tr').count(), expected.length);
      if (expected.length) {
        await page.locator('.shipments-panel .reference-button').first().click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
      }
      if (width <= 760)
        await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: 'نظرة عامة' }).click();
    }
    await page.getByRole('button', { name: /^الإشعارات/ }).click();
    await page.locator('.notification-item').first().waitFor();
    await check(page, 'notifications', width);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.notification-panel').count(), 0);
    if (width === 1440) {
      await page.getByRole('button', { name: /^الإشعارات/ }).click();
      await page.getByRole('button', { name: 'تحديد الكل كمقروء' }).click();
      await page.getByText('0 غير مقروءة', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.reload();
      await page.locator('.metric').first().waitFor();
      await page.getByRole('button', { name: /^الإشعارات/ }).click();
      await page.getByText('0 غير مقروءة', { exact: true }).waitFor();
      await page.locator('.notification-item').first().click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
    }
    if (width === 1440) {
      await page.getByRole('navigation').getByRole('button', { name: 'نظرة عامة' }).click();
      await db.query(
        `INSERT INTO shipments(id,reference,application_id,external_reference,merchant_id,recipient_name,destination,origin_id,weight_kg,status,fee_minor,currency,tracking_token,created_at,updated_at) VALUES($1,'AUTO-LIVE','visual-qa','AUTO-LIVE','merchant-a','عميل تحديث القائمة','الروضة، دمشق','site-a',1,'ready',100,'SYP',$2,now(),now())`,
        [crypto.randomUUID(), crypto.randomUUID()],
      );
      await page.waitForFunction(
        () =>
          document.querySelector('.stats-grid .metric strong')?.textContent ===
          new Intl.NumberFormat('ar-SY').format(7),
      );
      await page.getByRole('button', { name: 'AUTO-LIVE', exact: true }).waitFor();
    }
    for (const [id, label] of [
      ['shipments', 'الشحنات'],
      ['network', 'شبكة الشركاء'],
      ['inventory', 'المخزون والتجهيز'],
      ['transfers', 'النقل بين المواقع'],
      ['returns', 'مرتجعات العملاء'],
      ['cash', 'التحصيل وعهدة النقد'],
      ['payouts', 'مستحقات المتاجر'],
      ['earnings', 'أجور التوصيل'],
      ['integration', 'مختبر التكامل'],
    ]) {
      if (width <= 760)
        await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: label }).click();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: label })
        .getAttribute('aria-current')
        .then((value) => assert.equal(value, 'page'));
      await check(page, id, width);
      if (id === 'network' && (width === 1440 || width === 390)) {
        await context.grantPermissions(['geolocation']);
        await context.setGeolocation({ latitude: 33.514, longitude: 36.28, accuracy: 10 });
        await page.getByRole('button', { name: 'إضافة مكتب توصيل', exact: true }).click();
        let partnerDialog = page.getByRole('dialog');
        await partnerDialog.getByLabel('الاسم', { exact: true }).fill('مكتب اختبار الواجهة');
        await partnerDialog.getByRole('button', { name: 'موقعي الحالي', exact: true }).click();
        await partnerDialog
          .getByText('تم تحديد الموقع؛ يمكنك تعديل الدبوس.', { exact: true })
          .waitFor();
        await partnerDialog.getByRole('button', { name: 'حفظ', exact: true }).click();
        await partnerDialog.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'إضافة مندوب', exact: true }).click();
        partnerDialog = page.getByRole('dialog');
        await partnerDialog.getByLabel('الاسم', { exact: true }).fill('مندوب اختبار الواجهة');
        await partnerDialog
          .getByLabel('التبعية وجهة تسوية الأجور')
          .selectOption({ label: 'مكتب اختبار الواجهة — التسوية مع المكتب' });
        await partnerDialog.getByRole('button', { name: 'حفظ', exact: true }).click();
        await partnerDialog.waitFor({ state: 'detached' });
        await page
          .getByText('تابع لـ مكتب اختبار الواجهة · الأجور للمكتب', { exact: true })
          .first()
          .waitFor();
        await page.getByRole('button', { name: 'إضافة نقطة استلام', exact: true }).click();
        partnerDialog = page.getByRole('dialog');
        await partnerDialog.getByLabel('اسم النقطة').fill('نقطة اختبار الواجهة');
        await partnerDialog.getByRole('button', { name: 'موقعي الحالي', exact: true }).click();
        await partnerDialog
          .getByText('تم تحديد الموقع؛ يمكنك تعديل الدبوس.', { exact: true })
          .waitFor();
        await partnerDialog
          .getByRole('button', { name: 'حفظ إعدادات النقطة', exact: true })
          .click();
        await partnerDialog.waitFor({ state: 'detached' });
        await check(page, 'network-created-partners', width);
        assert.ok(tileRequests > 0, 'Location maps must send the origin referrer');
        for (const name of ['نقطة اختبار الواجهة', 'مندوب اختبار الواجهة']) {
          const removeButton = page.getByRole('button', { name: 'حذف ' + name, exact: true });
          const before = await removeButton.count();
          await removeButton.first().click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'تأكيد الإزالة', exact: true })
            .click();
          await page.getByRole('dialog').waitFor({ state: 'detached' });
          assert.equal(await removeButton.count(), before - 1);
        }
        await page.getByRole('button', { name: 'المتاجر', exact: true }).click();
        await page.getByRole('button', { name: 'حذف متجر بيت الشام', exact: true }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'تأكيد الإزالة', exact: true })
          .click();
        await page.getByRole('dialog').getByRole('alert').waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'تراجع', exact: true }).click();
      }
    }
    if (width <= 760) await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'الشحنات' }).click();
    await page.locator('.reference-button').first().click();
    await page.getByRole('dialog').waitFor();
    await check(page, 'shipment-dialog', width);
    await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
    if (width === 1440 || width === 390) {
      for (const account of ['merchant-a', 'courier-a', 'pickup-a']) {
        await page.getByLabel('حساب العرض').selectOption(account);
        await page.waitForFunction(
          (id) => (document.querySelector('#account') as HTMLSelectElement)?.value === id,
          account,
        );
        if (account === 'courier-a' && width <= 760) {
          await page.locator('.courier-tasks tbody tr').first().waitFor();
          assert.equal(await page.locator('.task-open').first().isVisible(), true);
          assert.equal(
            await page
              .locator('.courier-tasks tbody tr')
              .first()
              .evaluate((row) => {
                const cells = [...row.querySelectorAll('td')].map((cell) =>
                  cell.getBoundingClientRect(),
                );
                return cells.every((a, i) =>
                  cells
                    .slice(i + 1)
                    .every(
                      (b) =>
                        Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 ||
                        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
                    ),
                );
              }),
            true,
            'Mobile task cells must not overlap',
          );
        }
        await check(page, account, width);
        if (account === 'merchant-a') {
          assert.equal(
            await page.getByRole('button', { name: 'طلب نقل طرد', exact: true }).count(),
            0,
          );
          if (width <= 760)
            await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
          await page.getByRole('navigation').getByRole('button', { name: 'الشحنات' }).click();
          await page.getByRole('button', { name: 'طلب نقل طرد', exact: true }).click();
          const dialog = page.getByRole('dialog');
          assert.equal(await dialog.getByLabel('رقم الطلب الداخلي في متجرك').isVisible(), false);
          await dialog.getByLabel('اسم المستلم').fill('عميل اختبار النقل');
          await dialog.getByLabel('عنوان التسليم').fill('الروضة، شارع تجريبي، دمشق');
          const quoted = page.waitForResponse(
            (r) => r.url().endsWith('/api/demo-commerce/quotes') && r.request().method() === 'POST',
          );
          await dialog.getByRole('button', { name: 'حساب تكلفة النقل', exact: true }).click();
          const response = await quoted;
          assert.equal(response.status(), 200);
          assert.match(response.request().postDataJSON().input.externalReference, /^MANUAL-/);
          await dialog.getByRole('button', { name: 'تأكيد طلب النقل', exact: true }).waitFor();
          await check(page, 'merchant-transport', width);
          await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
        }
      }
      await page.goto(url + '/shop');
      await page.locator('.shop-header').waitFor();
      assert.equal(
        await page
          .locator('.shop')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('--shop-green').trim()),
        '#762557',
      );
      await check(page, 'customer', width);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: nine operations pages, shipment dialog, merchant/courier/pickup roles, customer identity preserved; 1440/1024/768/390/360px, no horizontal page overflow or browser errors.',
  );
} finally {
  await browser.close();
  await app.close();
  await db.close();
}
