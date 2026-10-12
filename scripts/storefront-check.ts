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
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: 'artifacts/screenshots/shop-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'تقنية', exact: true }).click();
  assert.equal(await page.locator('.shop-product').count(), 2);
  await page.getByRole('button', { name: 'جميع الأقسام', exact: false }).click();
  await page.getByRole('button', { name: 'حقيبة يومية', exact: true }).click();
  await page.getByRole('heading', { name: 'حقيبة يومية', exact: true }).waitFor();
  await page.screenshot({
    path: 'artifacts/screenshots/shop-product.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'العودة للمجموعة' }).click();
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: 'أضف كوب سيراميك إلى السلة' }).click();
  await page.getByRole('button', { name: 'السلة، 2 منتجات' }).click();
  await page.getByRole('button', { name: 'زيادة حقيبة يومية' }).click();
  await page.getByRole('button', { name: 'تقليل حقيبة يومية' }).click();
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  assert.equal(
    await page.getByRole('alert').count(),
    0,
    'Opening the address step must not submit the form',
  );
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await page.getByRole('alert').getByText('اكتب اسم المستلم من حرفين على الأقل.').waitFor();
  await page.getByLabel('اسم المستلم').fill('عميل تجربة المتجر');
  await page.getByLabel('العنوان بالتفصيل').fill('شارع اختبار، بناء ٢، الطابق الأول');
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).waitFor();
  await page.screenshot({
    path: 'artifacts/screenshots/shop-checkout.png',
    fullPage: true,
    animations: 'disabled',
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  const order = await (await created).json();
  assert.ok(order.shipment.id);
  await page.getByRole('heading', { name: 'طلبك وصل إلينا.' }).waitFor();
  await page.screenshot({
    path: 'artifacts/screenshots/shop-success.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'متابعة طلباتي' }).click();
  await page.getByText(order.shipment.reference, { exact: true }).waitFor();
  // A second tab performs the actual operations and courier journey; customer sees the same shipment.
  const ops = await ctx.newPage();
  await ops.goto('http://127.0.0.1:3001/');
  await ops.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await ops.getByRole('button', { name: order.shipment.reference, exact: true }).click();
  await ops.getByLabel('اختيار المندوب').selectOption('courier-b');
  await ops.getByRole('button', { name: 'إسناد المهمة', exact: true }).click();
  await ops.getByText('بانتظار قبول المهمة من حساب المندوب المكلف.', { exact: true }).waitFor();
  await ops.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await ops.getByLabel('حساب العرض').selectOption('courier-b');
  await ops.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await ops.getByRole('button', { name: order.shipment.reference, exact: true }).click();
  await ops.getByRole('button', { name: 'قبول المهمة', exact: true }).click();
  await confirmOriginHandover(ops, order.shipment.reference, false);
  await ops.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).click();
  await ops.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await ops.getByRole('button', { name: 'بدء التوصيل', exact: true }).click();
  await page.getByRole('button', { name: 'إظهار رمز الاستلام' }).waitFor();
  await page.getByRole('button', { name: 'إظهار رمز الاستلام' }).click();
  const deliveryCode = await page.getByTestId('delivery-code').textContent();
  assert.match(deliveryCode!, /^\d{6}$/);
  await page.screenshot({
    path: 'artifacts/screenshots/shop-delivery-code.png',
    fullPage: true,
    animations: 'disabled',
  });
  await ops.getByRole('button', { name: 'تأكيد التسليم برمز العميل', exact: true }).click();
  await ops.getByLabel('رمز استلام العميل').fill(deliveryCode!);
  await ops.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByText('تم التسليم', { exact: true }).first().waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'طلباتي', exact: true }).click();
  await page.getByText(order.shipment.reference, { exact: true }).waitFor();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'اكتشف', exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: `artifacts/screenshots/shop-mobile-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'أضف مصباح مكتبي إلى السلة' }).click();
    await page.getByRole('button', { name: /السلة،/ }).click();
    await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: `artifacts/screenshots/shop-address-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      journey:
        'browse → cart → address → quote → confirm → operations → courier → delivered → customer refresh',
      screenshots: 9,
      mobileWidths: [390, 360],
    }),
  );
} finally {
  await browser.close();
}
