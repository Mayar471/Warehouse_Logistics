import { confirmOriginHandover } from './origin-browser.js';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const output = resolve('artifacts/screenshots');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:3001');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByText('الشحنات الأخيرة', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, '01-overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'إنشاء شحنة', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('اسم المستلم').fill('عميل رحلة المتصفح');
  await dialog.getByLabel('عنوان التسليم').fill('الروضة، شارع تجريبي، دمشق');
  await dialog.getByRole('button', { name: 'عرض خيارات التوصيل' }).click();
  await dialog.getByRole('button', { name: 'تأكيد طلب التنفيذ' }).waitFor();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/demo-commerce/orders') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'تأكيد طلب التنفيذ' }).click();
  const shipment = await (await created).json();
  assert.ok(shipment.id, JSON.stringify(shipment));
  await page.getByLabel('اختيار المندوب').selectOption('courier-b');
  await page.getByRole('button', { name: 'إسناد المهمة', exact: true }).click();
  await page.getByText('بانتظار قبول المهمة من حساب المندوب المكلف.', { exact: true }).waitFor();
  await page.getByText(/مهلة قبول المهمة حتى/).waitFor();
  await page.getByRole('button', { name: 'تحرير الإسناد قبل الاستلام' }).click();
  await page.getByLabel('سبب الإجراء').fill('إعادة توزيع المهام');
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('button', { name: 'إسناد المهمة', exact: true }).waitFor();
  await page.getByLabel('اختيار المندوب').selectOption('courier-b');
  await page.getByRole('button', { name: 'إسناد المهمة', exact: true }).click();
  await page.screenshot({
    path: resolve(output, '02-shipment-details-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await page.getByRole('button', { name: shipment.reference, exact: true }).click();
  await page.getByRole('button', { name: 'رفض المهمة', exact: true }).click();
  await page.getByLabel('سبب الإجراء').fill('انتهاء فترة عملي');
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('button', { name: shipment.reference, exact: true }).click();
  await page.getByLabel('اختيار المندوب').selectOption('courier-b');
  await page.getByRole('button', { name: 'إسناد المهمة', exact: true }).click();
  await page.getByText('بانتظار قبول المهمة من حساب المندوب المكلف.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('button', { name: shipment.reference, exact: true }).click();
  await page.getByRole('button', { name: 'قبول المهمة', exact: true }).click();
  await confirmOriginHandover(page, shipment.reference, true);
  await page.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('button', { name: 'بدء التوصيل', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد التسليم التجريبي', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByText('اكتملت هذه الرحلة. سجل الأحداث محفوظ للمراجعة.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByRole('button', { name: 'شبكة الشركاء', exact: true }).click();
  await page.getByRole('heading', { name: 'فريق النقل', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, '03-network-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'مختبر التكامل', exact: true }).click();
  await page.getByRole('button', { name: 'محاكاة توقف المستقبل', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, '04-integration-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'نظرة عامة', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, '05-overview-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Page overflows at 390px',
  );
  await page.getByRole('button', { name: 'إنشاء شحنة', exact: true }).click();
  await page.screenshot({
    path: resolve(output, '06-create-mobile.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Escape must close modal');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Page overflows at 360px',
  );
  const publicPage = await browser.newPage();
  await publicPage.goto('http://127.0.0.1:3001/?tracking=' + shipment.trackingToken);
  await publicPage.getByRole('heading', { name: 'تتبّع شحنتك', exact: true }).waitFor();
  await publicPage.getByText('تم التسليم', { exact: true }).waitFor();
  assert.ok(!(await publicPage.locator('body').innerText()).includes('عميل رحلة المتصفح'));
  await publicPage.close();
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'create → assign → accept → merchant preparation and handover → courier pickup → depart → delivered',
      responsiveWidths: [1440, 390, 360],
      publicPrivacy: true,
      modalEscape: true,
      screenshots: 8,
    }),
  );
} finally {
  await browser.close();
}
