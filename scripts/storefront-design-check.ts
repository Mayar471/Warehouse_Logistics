import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await mkdir('artifacts/screenshots', { recursive: true });
try {
  await page.goto('http://127.0.0.1:3001/shop');
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = [...document.querySelectorAll<HTMLImageElement>('.shop img')];
    await Promise.all(
      images.map((image) => {
        image.loading = 'eager';
        return image.decode();
      }),
    );
  });
  assert.equal(await page.locator('.shop-product').count(), 6);
  assert.equal(
    await page
      .locator('.shop-product img')
      .evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth >= 1600),
      ),
    true,
  );
  assert.match(
    await page.locator('.shop h1').evaluate((element) => getComputedStyle(element).fontFamily),
    /Tajawal/,
  );
  await page.locator('.ambient-scene canvas').waitFor();
  assert.equal(await page.locator('.shop-product canvas').count(), 0);
  await page.screenshot({
    path: 'artifacts/screenshots/trend-sy-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .locator('.shop-hero')
    .screenshot({ path: 'artifacts/screenshots/trend-sy-hero.png', animations: 'disabled' });
  await page.getByRole('link', { name: /تقنية بإيقاعك/ }).click();
  assert.equal(await page.locator('.shop-product').count(), 2);
  await page.getByRole('button', { name: 'جميع الأقسام', exact: false }).click();
  await page.getByRole('button', { name: 'حقائب', exact: true }).click();
  assert.equal(await page.locator('.shop-product').count(), 1);
  await page
    .locator('.catalog-stage')
    .getByRole('heading', { name: 'رفيق كل مشوار.', exact: true })
    .waitFor();
  await page.locator('.catalog-background-model canvas').waitFor();
  await page.locator('.catalog-stage').scrollIntoViewIfNeeded();
  const initial = await page.locator('.catalog-background-model').screenshot();
  await page.waitForTimeout(220);
  assert.ok(
    !initial.equals(await page.locator('.catalog-background-model').screenshot()),
    'Backdrop model must animate',
  );
  await page
    .locator('.shop-products')
    .screenshot({ path: 'artifacts/screenshots/trend-sy-bags-filter.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'سماعات', exact: true }).click();
  assert.equal(await page.locator('.shop-product').count(), 1);
  await page.getByRole('heading', { name: 'على إيقاعك.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'مسح الفلاتر' }).click();
  await page.getByLabel('ترتيب حسب').selectOption('price-low');
  assert.equal(await page.locator('.shop-product h3').first().textContent(), 'كوب سيراميك');
  await page.getByLabel('ترتيب حسب').selectOption('price-high');
  assert.equal(await page.locator('.shop-product h3').first().textContent(), 'ساعة ذكية');
  await page.getByLabel('المتوفر فقط').check();
  await page.getByRole('button', { name: 'مسح الفلاتر' }).click();
  await page.getByRole('button', { name: 'جميع الأقسام', exact: false }).click();
  await page.getByRole('button', { name: 'تفاصيل حقيبة يومية', exact: true }).click();
  await page.getByRole('heading', { name: 'حقيبة يومية', exact: true }).waitFor();
  await page.locator('.detail-visual img').waitFor();
  await page.getByRole('button', { name: 'العودة للمجموعة' }).click();
  await page.getByLabel('ابحث عن منتج').fill('مصباح');
  assert.equal(await page.locator('.shop-product').count(), 1);
  await page.getByLabel('ابحث عن منتج').fill('غير موجود');
  await page.getByRole('heading', { name: 'لم نجد منتجًا بهذا الاسم' }).waitFor();
  await page.getByRole('button', { name: 'عرض الجميع', exact: true }).click();
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: 'إغلاق الإشعار' }).click();
  await page.getByRole('button', { name: 'السلة، 1 منتجات' }).click();
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await page.getByLabel('اسم المستلم').waitFor();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole('button', { name: 'اكتشف', exact: true }).click();
    await page.screenshot({
      path: `artifacts/screenshots/trend-sy-mobile-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'حقائب', exact: true }).click();
    await page.locator('.catalog-stage').scrollIntoViewIfNeeded();
    await page.locator('.catalog-background-model canvas').waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.locator('.shop-products').screenshot({
      path: 'artifacts/screenshots/trend-sy-bags-mobile-' + width + '.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'مسح الفلاتر' }).click();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.locator('.ambient-scene canvas').waitFor();
  assert.equal(
    await page
      .locator('.collage-main img')
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: photos, typography, contextual animated 3D, category/type filters, price sorting, stock filter/reset, search, details, cart/address, 390/360px, reduced motion; no runtime errors.',
  );
} finally {
  await browser.close();
}
