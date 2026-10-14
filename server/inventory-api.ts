import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import { assert, idempotent, transactionGate, loadShipment, appendEvent } from './domain.js';
import { movement } from './inventory.js';
import { reconcileInventory } from './inventory-reconciliation.js';
import { randomUUID } from 'node:crypto';
import { catalog } from '../shared/catalog.js';

export function registerInventory(
  app: FastifyInstance,
  db: PGlite,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
) {
  const access = (req: FastifyRequest) => {
    const a = account(req);
    assert(
      ['operator', 'merchant'].includes(a.role),
      403,
      'FORBIDDEN',
      'المخزون متاح للعمليات والمتجر صاحب المخزون',
    );
    return a;
  };
  const scope = (a: Account, merchantId: string) =>
    assert(
      a.role === 'operator' || a.merchantId === merchantId,
      404,
      'NOT_FOUND',
      'رصيد المخزون غير موجود',
    );
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  const selectedSite = async (req: FastifyRequest, a: Account) => {
    const { siteId } = z
      .object({ siteId: z.string().min(1).max(40).optional() })
      .strict()
      .parse(req.query);
    if (!siteId) return null;
    const site = (
      await db.query<{ merchant_id: string }>(
        "SELECT merchant_id FROM sites WHERE id=$1 AND archived_at IS NULL AND kind IN ('store','warehouse')",
        [siteId],
      )
    ).rows[0];
    assert(site?.merchant_id, 404, 'NOT_FOUND', 'موقع المخزون غير موجود');
    scope(a, site.merchant_id);
    return siteId;
  };
  const products = z
    .array(z.string().refine((id) => catalog.some((p) => p.id === id), 'منتج غير معروف'))
    .min(1)
    .max(catalog.length)
    .refine((ids) => new Set(ids).size === ids.length, 'المنتج مكرر');
  app.get('/api/inventory/sites', async (req) => {
    const a = access(req);
    const merchantId = a.role === 'merchant' ? a.merchantId : null;
    const sites = (
      await db.query(
        `SELECT s.id,s.name,s.address,s.city,s.kind,s.version,s.merchant_id AS "merchantId",m.name AS "merchantName",COALESCE(jsonb_agg(i.product_id ORDER BY i.product_id) FILTER(WHERE i.product_id IS NOT NULL),'[]'::jsonb) AS products
      FROM sites s JOIN merchants m ON m.id=s.merchant_id LEFT JOIN inventory_stock i ON i.site_id=s.id AND i.merchant_id=s.merchant_id
      WHERE s.archived_at IS NULL AND s.kind IN ('store','warehouse') AND ($1::text IS NULL OR s.merchant_id=$1) GROUP BY s.id,m.name ORDER BY m.name,s.name`,
        [merchantId],
      )
    ).rows;
    const merchants = (
      await db.query(
        'SELECT id,name FROM merchants WHERE ($1::text IS NULL OR id=$1) ORDER BY name',
        [merchantId],
      )
    ).rows;
    const audit = (
      await db.query(
        `SELECT a.id,a.site_id AS "siteId",s.name AS "siteName",a.action,a.actor_name AS "actorName",a.reason,a.created_at AS "createdAt" FROM network_audit a JOIN sites s ON s.id=a.site_id WHERE a.action IN ('inventory_site_created','inventory_products_registered') AND ($1::text IS NULL OR s.merchant_id=$1) ORDER BY a.created_at DESC,a.id LIMIT 30`,
        [merchantId],
      )
    ).rows;
    return { sites, merchants, audit };
  });
  app.post('/api/inventory/sites', async (req) => {
    const a = access(req);
    const body = z
      .object({
        merchantId: z.string().min(1).max(40),
        name: z.string().trim().min(3).max(80),
        address: z.string().trim().min(5).max(130),
        products,
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    scope(a, body.merchantId);
    return write((tx) =>
      idempotent(tx, `${a.id}:inventory:site`, key(req), body, async () => {
        assert(
          (await tx.query('SELECT id FROM merchants WHERE id=$1', [body.merchantId])).rows.length,
          404,
          'NOT_FOUND',
          'المتجر غير موجود',
        );
        const count = (
          await tx.query<{ count: number }>(
            "SELECT COUNT(*)::integer count FROM sites WHERE merchant_id=$1 AND archived_at IS NULL AND kind IN ('store','warehouse')",
            [body.merchantId],
          )
        ).rows[0].count;
        assert(count < 50, 409, 'SITE_LIMIT', 'حد التجربة 50 موقع مخزون لكل متجر');
        assert(
          !(
            await tx.query(
              "SELECT id FROM sites WHERE merchant_id=$1 AND name=$2 AND archived_at IS NULL AND kind IN ('store','warehouse')",
              [body.merchantId, body.name],
            )
          ).rows.length,
          409,
          'DUPLICATE_SITE',
          'اسم الموقع مستخدم لهذا المتجر',
        );
        const id = 'warehouse-' + randomUUID().replaceAll('-', '').slice(0, 24);
        await tx.query(
          "INSERT INTO sites(id,name,city,address,kind,merchant_id) VALUES($1,$2,'دمشق',$3,'warehouse',$4)",
          [id, body.name, body.address, body.merchantId],
        );
        for (const productId of body.products)
          await tx.query(
            'INSERT INTO inventory_stock(merchant_id,site_id,product_id) VALUES($1,$2,$3)',
            [body.merchantId, id, productId],
          );
        await tx.query(
          'INSERT INTO network_audit(id,site_id,actor_name,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            id,
            a.name,
            'inventory_site_created',
            body.reason,
            JSON.stringify({
              name: body.name,
              address: body.address,
              merchantId: body.merchantId,
              products: body.products,
              openingQuantity: 0,
            }),
          ],
        );
        return { id, version: 1 };
      }),
    );
  });
  app.post('/api/inventory/sites/:id/products', async (req) => {
    const a = access(req);
    const id = z
      .string()
      .min(1)
      .max(40)
      .parse((req.params as { id: string }).id);
    const body = z
      .object({
        products,
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:inventory:products:${id}`, key(req), body, async () => {
        const site = (
          await tx.query<{ merchant_id: string; version: number }>(
            "SELECT merchant_id,version FROM sites WHERE id=$1 AND archived_at IS NULL AND kind IN ('store','warehouse')",
            [id],
          )
        ).rows[0];
        assert(site?.merchant_id, 404, 'NOT_FOUND', 'موقع المخزون غير موجود');
        scope(a, site.merchant_id);
        assert(
          site.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت منتجات الموقع؛ حدّث القائمة وأعد المحاولة',
        );
        for (const productId of body.products) {
          assert(
            !(
              await tx.query(
                'SELECT product_id FROM inventory_stock WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
                [site.merchant_id, id, productId],
              )
            ).rows.length,
            409,
            'PRODUCT_ALREADY_REGISTERED',
            'المنتج مرتبط بالموقع بالفعل',
          );
          await tx.query(
            'INSERT INTO inventory_stock(merchant_id,site_id,product_id) VALUES($1,$2,$3)',
            [site.merchant_id, id, productId],
          );
        }
        await tx.query('UPDATE sites SET version=version+1 WHERE id=$1', [id]);
        await tx.query(
          'INSERT INTO network_audit(id,site_id,actor_name,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            id,
            a.name,
            'inventory_products_registered',
            body.reason,
            JSON.stringify({ products: body.products, openingQuantity: 0 }),
          ],
        );
        return { id, version: site.version + 1 };
      }),
    );
  });
  app.get('/api/inventory/reconciliation', async (req) => {
    const a = access(req);
    const siteId = await selectedSite(req, a);
    return write((tx) =>
      reconcileInventory(tx, a.role === 'merchant' ? a.merchantId : null, siteId),
    );
  });
  app.get('/api/inventory/counts', async (req) => {
    const a = access(req);
    const siteId = await selectedSite(req, a);
    return {
      counts: (
        await db.query(
          'SELECT id,merchant_id AS "merchantId",site_id AS "siteId",product_id AS "productId",before_on_hand AS before,counted_on_hand AS counted,delta,reserved,quarantine,actor_name AS "actorName",reason,created_at AS "createdAt" FROM inventory_counts WHERE ($1::text IS NULL OR merchant_id=$1) AND ($2::text IS NULL OR site_id=$2) ORDER BY created_at DESC,id LIMIT 30',
          [a.role === 'merchant' ? a.merchantId : null, siteId],
        )
      ).rows,
    };
  });
  app.post('/api/inventory/counts', async (req) => {
    const a = access(req);
    const body = z
      .object({
        merchantId: z.string().min(1).max(40),
        siteId: z.string().min(1).max(40),
        productId: z.string().min(1).max(40),
        expectedVersion: z.number().int().positive(),
        counted: z.number().int().min(0).max(1000000),
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    scope(a, body.merchantId);
    return write((tx) =>
      idempotent(tx, `${a.id}:inventory:count`, key(req), body, async () => {
        const report = await reconcileInventory(tx, body.merchantId, body.siteId, body.productId);
        const row = report.rows[0];
        assert(
          row &&
            row.onHand !== null &&
            row.version !== null &&
            row.reserved !== null &&
            row.quarantine !== null,
          404,
          'NOT_FOUND',
          'رصيد المخزون غير موجود',
        );
        assert(
          row.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير الرصيد أثناء الجرد؛ حدّث المخزون وأعد العد قبل التأكيد',
        );
        assert(
          row.matched,
          409,
          'INVENTORY_INCONSISTENT',
          'يوجد اختلاف بين الرصيد والسجل أو الطلبات؛ راجع المطابقة قبل تسجيل تصحيح الجرد',
        );
        assert(
          body.counted >= row.reserved + row.quarantine,
          409,
          'COUNT_BELOW_COMMITTED',
          'العدد الفعلي أقل من المحجوز والمعزول؛ يلزم التحقيق وتسوية الالتزامات قبل تصحيح الرصيد',
        );
        const delta = body.counted - row.onHand;
        const id = randomUUID();
        await tx.query(
          'UPDATE inventory_stock SET on_hand=$4,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
          [body.merchantId, body.siteId, body.productId, body.counted],
        );
        await tx.query(
          'INSERT INTO inventory_counts(id,merchant_id,site_id,product_id,before_on_hand,counted_on_hand,delta,reserved,quarantine,actor_name,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            id,
            body.merchantId,
            body.siteId,
            body.productId,
            row.onHand,
            body.counted,
            delta,
            row.reserved,
            row.quarantine,
            a.name,
            body.reason,
          ],
        );
        if (delta)
          await movement(
            tx,
            {
              merchant_id: body.merchantId,
              site_id: body.siteId,
              product_id: body.productId,
              quantity: Math.abs(delta),
              state: 'count',
            },
            null,
            delta > 0 ? 'adjustment_in' : 'adjustment_out',
            a.name,
            body.reason,
          );
        return { id, delta, version: row.version + 1 };
      }),
    );
  });
  app.get('/api/inventory', async (req) => {
    const a = access(req);
    const merchantId = a.role === 'merchant' ? a.merchantId : null;
    const siteId = await selectedSite(req, a);
    return write(async (db) => {
      const totals = (
        await db.query(
          `SELECT COUNT(*)::integer AS "stockTotal",COALESCE(SUM(on_hand-reserved-quarantine),0)::double precision AS available,COALESCE(SUM(reserved),0)::double precision AS reserved,COALESCE(SUM(quarantine),0)::double precision AS quarantine FROM inventory_stock WHERE ($1::text IS NULL OR merchant_id=$1) AND ($2::text IS NULL OR site_id=$2)`,
          [merchantId, siteId],
        )
      ).rows[0];
      const stocks = await db.query(
        `SELECT s.merchant_id AS "merchantId",m.name AS "merchantName",s.site_id AS "siteId",p.name AS "siteName",s.product_id AS "productId",s.on_hand AS "onHand",s.reserved,s.quarantine,s.on_hand-s.reserved-s.quarantine AS available,s.version,
      COALESCE((SELECT SUM(r.quantity)::integer FROM inventory_reservations r WHERE r.merchant_id=s.merchant_id AND r.site_id=s.site_id AND r.product_id=s.product_id AND r.state='prepared'),0) AS prepared,
      (COALESCE((SELECT SUM(r.quantity)::integer FROM inventory_reservations r WHERE r.merchant_id=s.merchant_id AND r.site_id=s.site_id AND r.product_id=s.product_id AND r.state='dispatched'),0)+COALESCE((SELECT SUM(l.quantity-l.received-l.lost)::integer FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id WHERE l.merchant_id=s.merchant_id AND l.source_id=s.site_id AND l.product_id=s.product_id AND t.status IN ('released','in_transit')),0)) AS "inTransit"
      FROM inventory_stock s JOIN merchants m ON m.id=s.merchant_id JOIN sites p ON p.id=s.site_id WHERE ($1::text IS NULL OR s.merchant_id=$1) AND ($2::text IS NULL OR s.site_id=$2) ORDER BY m.name,p.name,s.product_id LIMIT 100`,
        [merchantId, siteId],
      );
      const history = await db.query(
        'SELECT i.id,i.product_id AS "productId",i.site_id AS "siteId",s.name AS "siteName",m.name AS "merchantName",i.shipment_id AS "shipmentId",i.kind,i.quantity,i.actor_name AS "actorName",i.reason,i.created_at AS "createdAt" FROM inventory_movements i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN merchants m ON m.id=i.merchant_id WHERE ($1::text IS NULL OR i.merchant_id=$1) AND ($2::text IS NULL OR i.site_id=$2) ORDER BY i.created_at DESC,i.id LIMIT 30',
        [merchantId, siteId],
      );
      const returns = await db.query(
        `SELECT s.id,s.reference,s.version, jsonb_agg(jsonb_build_object('productId',r.product_id,'quantity',r.quantity-r.restocked_quantity-r.discarded_quantity,'originalQuantity',r.quantity,'restocked',r.restocked_quantity,'discarded',r.discarded_quantity) ORDER BY r.product_id) AS items FROM inventory_reservations r JOIN shipments s ON s.id=r.shipment_id WHERE r.state='quarantined' AND ($1::text IS NULL OR r.merchant_id=$1) AND ($2::text IS NULL OR r.site_id=$2) GROUP BY s.id ORDER BY s.updated_at,s.id LIMIT 20`,
        [merchantId, siteId],
      );
      return {
        stocks: stocks.rows,
        movements: history.rows,
        returns: returns.rows,
        totals,
        displayLimit: 100,
      };
    });
  });
  app.post('/api/inventory/receipts', async (req) => {
    const a = access(req);
    const body = z
      .object({
        merchantId: z.string().max(40),
        siteId: z.string().max(40),
        productId: z.string().max(40),
        quantity: z.number().int().min(1).max(10000),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    scope(a, body.merchantId);
    return write((tx) =>
      idempotent(tx, `${a.id}:inventory:receipt`, key(req), body, async () => {
        const stock = (
          await tx.query<{ version: number }>(
            'SELECT version FROM inventory_stock WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
            [body.merchantId, body.siteId, body.productId],
          )
        ).rows[0];
        assert(stock, 404, 'NOT_FOUND', 'رصيد المخزون غير موجود');
        assert(
          stock.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير الرصيد؛ حدّث المخزون ثم أعد المحاولة',
        );
        await tx.query(
          'UPDATE inventory_stock SET on_hand=on_hand+$4,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
          [body.merchantId, body.siteId, body.productId, body.quantity],
        );
        await movement(
          tx,
          {
            merchant_id: body.merchantId,
            site_id: body.siteId,
            product_id: body.productId,
            quantity: body.quantity,
            state: 'receipt',
          },
          null,
          'receipt',
          a.name,
          body.reason,
        );
        return { ok: true };
      }),
    );
  });
  app.post('/api/inventory/returns/:id/inspect', async (req) => {
    const a = access(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const common = {
      expectedVersion: z.number().int().positive(),
      reason: z.string().trim().min(3).max(240),
    };
    const body = z
      .union([
        z.object({ ...common, disposition: z.enum(['restock', 'discard']) }).strict(),
        z
          .object({
            ...common,
            items: z
              .array(
                z
                  .object({
                    productId: z.string().min(1).max(40),
                    restock: z.number().int().min(0).max(10000),
                    discard: z.number().int().min(0).max(10000),
                  })
                  .strict(),
              )
              .min(1)
              .max(6),
          })
          .strict(),
      ])
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:inventory:inspect`, key(req), { id, ...body }, async () => {
        const row = await loadShipment(tx, id);
        scope(a, row.merchant_id);
        assert(
          row.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير المرتجع؛ حدّث البيانات ثم أعد المحاولة',
        );
        assert(
          row.status === 'returned' ||
            (row.status === 'delivered' &&
              (
                await tx.query(
                  "SELECT id FROM commercial_returns WHERE shipment_id=$1 AND status='received'",
                  [id],
                )
              ).rows.length > 0),
          409,
          'INVALID_TRANSITION',
          'لم يصل المرتجع إلى المنشأ',
        );
        const lines = (
          await tx.query<{
            merchant_id: string;
            site_id: string;
            product_id: string;
            quantity: number;
            state: string;
            restocked_quantity: number;
            discarded_quantity: number;
          }>(
            "SELECT * FROM inventory_reservations WHERE shipment_id=$1 AND state='quarantined' ORDER BY product_id",
            [id],
          )
        ).rows;
        assert(lines.length, 409, 'ALREADY_INSPECTED', 'لا يوجد مرتجع معزول ينتظر الفحص');
        const items =
          'items' in body
            ? body.items
            : lines.map((line) => ({
                productId: line.product_id,
                restock:
                  body.disposition === 'restock'
                    ? line.quantity - line.restocked_quantity - line.discarded_quantity
                    : 0,
                discard:
                  body.disposition === 'discard'
                    ? line.quantity - line.restocked_quantity - line.discarded_quantity
                    : 0,
              }));
        assert(
          new Set(items.map((i) => i.productId)).size === items.length,
          422,
          'DUPLICATE_PRODUCT',
          'المنتج مكرر في نتيجة الفحص',
        );
        assert(
          items.some((i) => i.restock + i.discard > 0),
          422,
          'EMPTY_INSPECTION',
          'حدد قطعة واحدة على الأقل تم فحصها',
        );
        let restocked = 0,
          discarded = 0;
        for (const item of items) {
          const line = lines.find((l) => l.product_id === item.productId);
          assert(line, 422, 'INVALID_PRODUCT', 'المنتج غير موجود ضمن القطع المعزولة لهذا المرتجع');
          const processed = item.restock + item.discard;
          assert(
            processed <= line.quantity - line.restocked_quantity - line.discarded_quantity,
            409,
            'INSPECTION_EXCEEDS_REMAINING',
            'مجموع الصالح والتالف يتجاوز الكمية المتبقية للفحص',
          );
          if (!processed) continue;
          restocked += item.restock;
          discarded += item.discard;
          await tx.query(
            'UPDATE inventory_stock SET quarantine=quarantine-$4,on_hand=on_hand-$5,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
            [line.merchant_id, line.site_id, line.product_id, processed, item.discard],
          );
          await tx.query(
            `UPDATE inventory_reservations SET restocked_quantity=restocked_quantity+$3,discarded_quantity=discarded_quantity+$4,
            state=CASE WHEN restocked_quantity+discarded_quantity+$3+$4<quantity THEN 'quarantined' WHEN restocked_quantity+$3=quantity THEN 'restocked' WHEN discarded_quantity+$4=quantity THEN 'discarded' ELSE 'inspected' END WHERE shipment_id=$1 AND product_id=$2`,
            [id, line.product_id, item.restock, item.discard],
          );
          if (item.restock)
            await movement(
              tx,
              { ...line, quantity: item.restock },
              id,
              'restock',
              a.name,
              body.reason,
            );
          if (item.discard)
            await movement(
              tx,
              { ...line, quantity: item.discard },
              id,
              'discard',
              a.name,
              body.reason,
            );
        }
        await tx.query('UPDATE shipments SET version=version+1,updated_at=now() WHERE id=$1', [id]);
        await appendEvent(
          tx,
          await loadShipment(tx, id),
          'shipment.inventory_inspected',
          `فحص المرتجع: أعيد للبيع ${restocked}، واستُبعد تالف ${discarded}؛ تبقى القطع غير المفحوصة معزولة. ${body.reason}`,
          a.name,
        );
        return { ok: true };
      }),
    );
  });
}
