import type { Page } from '@playwright/test';
import assert from 'node:assert/strict';

export async function confirmOriginHandover(page: Page, reference: string, capture = false) {
  assert.equal(
    await page.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'بدء التوصيل', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('merchant-a');
  await page.getByRole('heading', { name: 'طلبات متجرك', exact: true }).waitFor();
  await page.getByRole('button', { name: reference, exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد تجهيز الطرد', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد تسليم الطرد للمندوب', exact: true }).waitFor();
  if (capture) {
    const viewport = page.viewportSize()!;
    await page
      .getByRole('button', { name: 'تأكيد تسليم الطرد للمندوب', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: 'artifacts/screenshots/origin-merchant-desktop.png',
      fullPage: false,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page
      .getByRole('button', { name: 'تأكيد تسليم الطرد للمندوب', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: 'artifacts/screenshots/origin-merchant-mobile.png',
      fullPage: false,
      animations: 'disabled',
    });
    await page.setViewportSize(viewport);
  }
  await page.getByRole('button', { name: 'تأكيد تسليم الطرد للمندوب', exact: true }).click();
  await page.getByRole('button', { name: 'تأكيد الإجراء', exact: true }).click();
  await page.getByText('سجل المتجر التسليم إلى', { exact: false }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'إلغاء قبل الاستلام', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await page.getByRole('button', { name: reference, exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'تأكيد استلام الطرد', exact: true }).isEnabled(),
    true,
  );
}
