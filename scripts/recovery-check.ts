import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:3001/');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  await page.getByRole('button', { name: 'مختبر التكامل', exact: true }).click();
  await page.getByRole('heading', { name: 'مطابقة حالات التطبيق', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'محاكاة توقف المستقبل', exact: true }).count())
    await page.getByRole('button', { name: 'محاكاة توقف المستقبل', exact: true }).click();
  await page.getByRole('button', { name: 'إنشاء شحنة', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('اسم المستلم').fill('عميل فحص التعافي');
  await modal.getByLabel('عنوان التسليم').fill('دمشق، شارع اختبار');
  await modal.getByRole('button', { name: 'عرض خيارات التوصيل' }).click();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/demo-commerce/orders') && r.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'تأكيد طلب التنفيذ' }).click();
  const s = await (await created).json();
  await page.getByRole('button', { name: 'إغلاق النافذة' }).click();
  for (let i = 0; i < 8; i++) {
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/integration/flush'));
    await page.getByRole('button', { name: 'إعادة محاولة المعلق', exact: true }).click();
    await sent;
  }
  const events = await (await page.request.get('http://127.0.0.1:3001/api/integration')).json();
  const failed = events.events.find(
    (e: { shipmentId: string; status: string }) => e.shipmentId === s.id && e.status === 'failed',
  );
  assert.ok(failed);
  const row = page.getByRole('row').filter({ hasText: failed.id.slice(0, 8) });
  await row.getByRole('button', { name: 'إعادة تشغيل الفشل', exact: true }).waitFor();
  await page.getByRole('button', { name: 'استئناف الاستقبال', exact: true }).click();
  await row.getByRole('button', { name: 'إعادة تشغيل الفشل', exact: true }).click();
  await page.getByLabel('سبب إجراء التعافي').fill('عاد المستقبل للعمل بعد اختبار التوقف');
  await page.getByRole('button', { name: 'تأكيد إجراء التعافي', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'إعادة محاولة المعلق', exact: true }).click();
  const after = await (await page.request.get('http://127.0.0.1:3001/api/integration')).json();
  const recovered = after.events.find((e: { id: string }) => e.id === failed.id);
  assert.equal(recovered.status, 'sent');
  assert.equal(recovered.retryCount, 1);
  assert.ok(recovered.attempts >= 9);
  const comparison = await (
    await page.request.get('http://127.0.0.1:3001/api/integration/reconciliation')
  ).json();
  const missing = comparison.differences.find(
    (d: { kind: string; reference: string | null }) => d.kind === 'missing' && d.reference,
  );
  if (missing) {
    const repairRow = page.getByRole('row').filter({ hasText: missing.reference });
    await repairRow.getByRole('button', { name: 'إرسال حالة للمطابقة' }).click();
    await page.getByLabel('سبب إجراء التعافي').fill('استعادة حالة لم تصل إلى المستقبل');
    await page.getByRole('button', { name: 'تأكيد إجراء التعافي', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'إعادة محاولة المعلق', exact: true }).click();
    const next = await (
      await page.request.get('http://127.0.0.1:3001/api/integration/reconciliation')
    ).json();
    assert.ok(
      !next.differences.some((d: { shipmentId: string }) => d.shipmentId === missing.shipmentId),
    );
  }
  await page.getByRole('button', { name: 'تحديث المطابقة' }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: 'artifacts/screenshots/integration-recovery-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: 'artifacts/screenshots/integration-recovery-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      terminalReplay: true,
      projectionRepair: !!missing,
      mobileWidth: 390,
    }),
  );
} finally {
  await browser.close();
}
