import { chromium } from '@playwright/test';
import staticFiles from '@fastify/static';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';
const db = await openDatabase('memory://');
const { app } = buildApp(db, {
  applicationKey: 'ux-audit',
  webhookKey: 'ux-audit',
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
const dir = 'artifacts/ux-audit';
await mkdir(dir, { recursive: true });
const results: any[] = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await ctx.route('**/api/**', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: 'http://127.0.0.1:3001' },
    });
    await route.fulfill({ response });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.push({ pageError: e.message }));
  async function capture(label: string) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${dir}/${label}.png`, fullPage: true, animations: 'disabled' });
    results.push({
      label,
      ...(await page.evaluate(() => ({
        url: location.href,
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        text: document.body.innerText,
        focus: document.activeElement?.outerHTML,
        smallTargets: [...document.querySelectorAll('button,a,input,select')]
          .filter((e) => e.getClientRects().length)
          .map((e) => ({
            text: e.getAttribute('aria-label') || e.textContent?.trim(),
            width: Math.round(e.getBoundingClientRect().width),
            height: Math.round(e.getBoundingClientRect().height),
          }))
          .filter((e) => e.width < 24 || e.height < 24),
      }))),
    });
  }
  await page.goto(url);
  await page.locator('.metric').first().waitFor();
  await capture('operations-desktop');
  await page.getByRole('button', { name: 'SHP-1001', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Shift+Tab');
  results.push({
    modalInitialShiftTab: await page.evaluate(() => ({
      inside: !!document.activeElement?.closest('[role="dialog"]'),
      focus: document.activeElement?.outerHTML,
    })),
  });
  await page.getByRole('button', { name: 'إغلاق النافذة', exact: true }).click();
  await page.getByRole('button', { name: 'المخزون والتجهيز', exact: true }).click();
  await page
    .locator('.inventory')
    .first()
    .waitFor({ timeout: 2000 })
    .catch(() => {});
  await capture('inventory-desktop');
  await page.reload();
  await page.locator('.metric').first().waitFor();
  results.push({
    refreshResetsOperations: await page
      .getByRole('heading', { name: 'مركز العمليات', exact: true })
      .count(),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('operations-mobile');
  await page.getByLabel('حساب العرض').selectOption('courier-b');
  await page.getByRole('heading', { name: 'جولتك اليوم', exact: true }).waitFor();
  await capture('courier-mobile');
  results.push({
    courierTaskPosition: await page
      .locator('.courier-tasks')
      .evaluate((el) => ({ top: el.getBoundingClientRect().top + scrollY, viewport: innerHeight })),
  });
  await page.getByLabel('حساب العرض').selectOption('ops');
  await page.getByRole('heading', { name: 'مركز العمليات', exact: true }).waitFor();
  const observer = await ctx.newPage();
  await observer.goto(url);
  await observer.locator('.metric').first().waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url + '/shop');
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).waitFor();
  await capture('shop-desktop');
  results.push({
    firstProductPosition: await page
      .locator('.shop-product')
      .first()
      .evaluate((el) => ({ top: el.getBoundingClientRect().top + scrollY, viewport: innerHeight })),
  });
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).click();
  await page.getByRole('button', { name: /السلة،/ }).click();
  await capture('cart-desktop');
  await page.getByRole('button', { name: 'المتابعة إلى التوصيل' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('address-mobile');
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  results.push({
    validationViewport: await page.getByRole('alert').evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      viewport: innerHeight,
      invalidFields: document.querySelectorAll('[aria-invalid="true"]').length,
    })),
  });
  await page.screenshot({ path: `${dir}/validation-viewport.png`, animations: 'disabled' });
  await capture('validation-mobile');
  await page.getByLabel('اسم المستلم').fill('عميل تدقيق التجربة');
  await page.getByLabel('العنوان بالتفصيل').fill('شارع اختبار، بناء ٢، الطابق الأول');
  await page.getByRole('button', { name: 'حساب التوصيل ومراجعة الطلب' }).click();
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).waitFor();
  await capture('review-mobile');
  const createdResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/storefront/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'تأكيد الطلب التجريبي' }).click();
  const order = await (await createdResponse).json();
  await page.getByRole('heading', { name: 'طلبك وصل إلينا.' }).waitFor();
  await capture('success-mobile');
  await page.waitForTimeout(16000);
  results.push({
    operationsAfterNewOrder: {
      reference: order.shipment.reference,
      visibleAfter16Seconds: await observer
        .getByRole('button', { name: order.shipment.reference, exact: true })
        .count(),
    },
  });
  await observer.getByRole('button', { name: 'تحديث البيانات', exact: true }).click();
  await observer.getByRole('button', { name: order.shipment.reference, exact: true }).waitFor();
  results.push({ operationsOrderAfterManualRefresh: true });
  await page.getByRole('button', { name: 'متابعة طلباتي' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'أضف حقيبة يومية إلى السلة' }).waitFor();
  results.push({ refreshResetsShop: true });
  await capture('shop-mobile');
} finally {
  await writeFile(`${dir}/observations.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await app.close();
  await db.close();
}
console.log('UX audit captures completed: ' + dir);
