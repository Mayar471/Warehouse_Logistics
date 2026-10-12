import { confirmOriginHandover } from './origin-browser.js';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir('artifacts/screenshots', { recursive: true });
try {
  await page.goto('http://127.0.0.1:3001/shop');
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: /السلة،/ }).click();
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await page.getByLabel('اسم المستلم').fill('عميل اختبار نقطة الاستلام');
  await page.getByRole('radio', { name: /الاستلام من نقطة قريبة/ }).check();
  await page.getByLabel('نقطة الاستلام', { exact: true }).selectOption('pickup-a');
  assert.equal(await page.getByLabel('العنوان بالتفصيل').count(), 0);
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: `artifacts/screenshots/pickup-checkout-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).waitFor();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  const order = await (await created).json();
  assert.equal(order.shipment.pickupSiteId, 'pickup-a');
  await page.getByRole('button', { name: 'متابعة طلباتي' }).click();
  const staff = await ctx.newPage();
  staff.on('pageerror', (e) => errors.push(e.message));
  await staff.goto('http://127.0.0.1:3001/');
  await staff.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await staff.getByRole('button', { name: order.shipment.reference, exact: true }).click();
  await staff.getByLabel('اختيار المندوب').selectOption('courier-b');
  await staff.getByRole('button', { name: 'إسناد المهمة', exact: true }).click();
  await staff.getByText('بانتظار قبول المهمة من حساب المندوب المكلف.', { exact: true }).waitFor();
  await staff.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await staff.getByLabel('حساب العرض').selectOption('courier-b');
  await staff.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await staff.getByRole('button', { name: order.shipment.reference, exact: true }).click();
  await staff.getByRole('button', { name: 'قبول المهمة', exact: true }).click();
  await confirmOriginHandover(staff, order.shipment.reference, false);
  await staff.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).click();
  await staff.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await staff.getByRole('button', { name: 'بدء التوصيل', exact: true }).click();
  assert.equal(
    await staff.getByRole('button', { name: 'تأكيد التسليم برمز العميل', exact: true }).count(),
    0,
  );
  await staff.getByRole('button', { name: 'تأكيد الوصول إلى النقطة', exact: true }).click();
  await staff.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await staff.getByText('بانتظار تأكيد موظف النقطة استلام العهدة.', { exact: false }).waitFor();
  await staff.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await staff.getByLabel('حساب العرض').selectOption('pickup-a');
  await staff.getByRole('heading', { name: 'نقطة استلام الروضة', exact: true }).waitFor();
  assert.equal(await staff.getByRole('button', { name: 'إنشاء شحنة', exact: true }).count(), 0);
  await staff.getByRole('button', { name: order.shipment.reference, exact: true }).click();
  await staff.getByRole('button', { name: 'تأكيد استلام الطرد من المندوب', exact: true }).click();
  await staff.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await staff.getByRole('button', { name: 'تسليم العميل برمز الاستلام', exact: true }).waitFor();
  await staff.screenshot({
    path: 'artifacts/screenshots/pickup-custody-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'إظهار رمز الاستلام' }).waitFor();
  await page.getByRole('button', { name: 'إظهار رمز الاستلام' }).click();
  const code = await page.getByTestId('delivery-code').textContent();
  assert.match(code!, /^\d{6}$/);
  await page.setViewportSize({ width: 360, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/pickup-ready-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await staff.getByRole('button', { name: 'تسليم العميل برمز الاستلام', exact: true }).click();
  await staff.getByLabel('رمز استلام العميل').fill(code!);
  await staff.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByText('تم التسليم', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'إظهار رمز الاستلام' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'customer pickup checkout → courier → independent point custody → customer code → point delivery',
      screenshots: 5,
      mobileWidths: [390, 360],
    }),
  );
} finally {
  await browser.close();
}
