import { registerCustomerRefunds } from './customer-refunds.js';
import { registerNotifications } from './notifications.js';
import { registerDisputes } from './disputes.js';
import {
  registerCustomerLocations,
  coordinatesSchema,
  pickupOptions,
} from './customer-locations.js';
import { commercialReturnSelect, returnEvent } from './commercial-returns.js';
import type { CommercialReturn } from '../shared/commercial-returns.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalog, type StoreCheckout } from '../shared/catalog.js';
import { issueProof } from './delivery-proof.js';
import { availability, selectStoreOrigin } from './inventory.js';
import { locationView } from './location.js';
import {
  assert,
  idempotent,
  createQuote,
  loadShipment,
  mapShipment,
  transactionGate,
} from './domain.js';

export function registerStorefront(
  app: FastifyInstance,
  db: PGlite,
  options: { demoMode: boolean; applicationKey: string; webhookKey: string; clock?: () => number },
  write: ReturnType<typeof transactionGate>,
) {
  const headers = {
    authorization: 'Bearer ' + options.applicationKey,
    'x-merchant-id': 'merchant-a',
  };
  function guard(req: FastifyRequest) {
    assert(options.demoMode, 404, 'NOT_FOUND', 'غير متاح');
    assert(
      ['localhost', '127.0.0.1'].includes(String(req.headers.host ?? '').split(':')[0]),
      403,
      'HOST_REJECTED',
      'المتجر التجريبي محلي فقط',
    );
  }
  function owner(req: FastifyRequest) {
    guard(req);
    const token = req.cookies.shop;
    assert(
      token && /^[a-f0-9]{64}$/.test(token),
      401,
      'SHOP_SESSION_REQUIRED',
      'أعد فتح المتجر لبدء التجربة',
    );
    return createHash('sha256').update(token).digest('hex');
  }
  registerCustomerRefunds(app, write, owner, options.clock ?? Date.now);
  registerNotifications(
    app,
    write,
    owner,
    '/api/storefront/notifications',
    options.clock ?? Date.now,
  );
  registerDisputes(
    app,
    write,
    owner,
    options.clock ?? Date.now,
    undefined,
    '/api/storefront/disputes',
  );
  registerCustomerLocations(app, write, owner, options.clock ?? Date.now);
  app.post('/api/storefront/session', async (req, reply) => {
    guard(req);
    if (!req.cookies.shop || !/^[a-f0-9]{64}$/.test(req.cookies.shop))
      reply.setCookie('shop', randomBytes(32).toString('hex'), {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });
    const pickupSites = await write((tx) => pickupOptions(tx, (options.clock ?? Date.now)()));
    return {
      catalog,
      merchant: 'بيت الشام',
      city: 'دمشق',
      pickupSites,
      availability: await availability(db),
    };
  });
  app.get('/api/storefront/availability', async (req) => {
    owner(req);
    return { availability: await availability(db) };
  });
  app.get('/api/storefront/pickup-sites', async (req) => {
    owner(req);
    return write(async (tx) => ({ sites: await pickupOptions(tx, (options.clock ?? Date.now)()) }));
  });
  app.post('/api/storefront/checkouts', async (req, reply) => {
    const ownerHash = owner(req);
    const body = z
      .object({
        paymentMode: z.enum(['none', 'cod']).default('none'),
        priority: z.enum(['normal', 'urgent']).default('normal'),
        items: z
          .array(
            z.object({ productId: z.string(), quantity: z.number().int().min(1).max(5) }).strict(),
          )
          .min(1)
          .max(6),
        pickupSiteId: z.string().max(40).optional(),
        recipientName: z.string().trim().min(2).max(80),
        district: z.enum(['الروضة', 'المزة', 'المالكي', 'الصالحية', 'كفرسوسة', 'أبو رمانة']),
        address: z.string().trim().min(5).max(130),
        location: coordinatesSchema.optional(),
      })
      .strict()
      .parse(req.body);
    assert(
      new Set(body.items.map((i) => i.productId)).size === body.items.length,
      422,
      'DUPLICATE_PRODUCT',
      'المنتج مكرر في السلة',
    );
    let subtotalMinor = 0;
    let weightKg = 0;
    for (const item of body.items) {
      const product = catalog.find((p) => p.id === item.productId);
      assert(product, 422, 'UNKNOWN_PRODUCT', 'منتج غير موجود');
      subtotalMinor += product.priceMinor * item.quantity;
      weightKg += product.weightKg * item.quantity;
    }
    let destination = body.location
      ? `${body.address}، دمشق`
      : `${body.district}، ${body.address}، دمشق`;
    if (body.location && !body.pickupSiteId)
      assert(
        body.location.latitude >= 33.35 &&
          body.location.latitude <= 33.7 &&
          body.location.longitude >= 36.05 &&
          body.location.longitude <= 36.5,
        422,
        'OUTSIDE_COVERAGE',
        'الموقع خارج تغطية تجربة دمشق الحالية؛ اختر عنوانًا داخل التغطية',
      );
    if (body.pickupSiteId) {
      const point = (
        await db.query<{ address: string; city: string }>(
          "SELECT address,city FROM sites WHERE id=$1 AND kind='pickup'",
          [body.pickupSiteId],
        )
      ).rows[0];
      assert(point?.city === 'دمشق', 422, 'INVALID_PICKUP_SITE', 'نقطة الاستلام غير متاحة');
      destination = point.address;
    }
    return write(async (tx) => {
      const id = randomUUID();
      const fulfillmentOrigin = await selectStoreOrigin(tx, body.items);
      const quote = await createQuote(
        tx,
        'demo-commerce',
        'merchant-a',
        {
          externalReference: 'SHOP-' + id,
          priority: body.priority,
          originId: fulfillmentOrigin.id,
          ...(body.paymentMode === 'cod'
            ? { collection: { goodsMinor: subtotalMinor, currency: 'SYP' as const } }
            : {}),
          recipientName: body.recipientName,
          destination,
          ...(body.pickupSiteId ? { pickupSiteId: body.pickupSiteId } : {}),
          weightKg: Math.round(weightKg * 100) / 100,
        },
        (options.clock ?? Date.now)(),
      );
      await tx.query(
        'INSERT INTO storefront_checkouts(id,owner_hash,quote_id,items,subtotal_minor,inventory_required,delivery_location) VALUES($1,$2,$3,$4,$5,true,$6)',
        [
          id,
          ownerHash,
          quote.id,
          JSON.stringify(body.items),
          subtotalMinor,
          body.pickupSiteId ? null : body.location ? JSON.stringify(body.location) : null,
        ],
      );
      return {
        id,
        quote,
        subtotalMinor,
        items: body.items,
        fulfillmentOrigin,
        paymentMode: body.paymentMode,
      };
    });
  });
  app.post('/api/storefront/orders', async (req, reply) => {
    const ownerHash = owner(req);
    const { checkoutId } = z.object({ checkoutId: z.string().uuid() }).strict().parse(req.body);
    const result = await db.query<{
      id: string;
      quote_id: string;
      items: StoreCheckout['items'];
      subtotal_minor: number;
      delivery_location: import('../shared/customer-locations.js').Coordinates | null;
    }>('SELECT * FROM storefront_checkouts WHERE id=$1 AND owner_hash=$2', [checkoutId, ownerHash]);
    const checkout = result.rows[0];
    assert(checkout, 404, 'CHECKOUT_NOT_FOUND', 'عرض الطلب غير موجود');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: { ...headers, 'idempotency-key': 'shop-order-' + checkoutId },
      payload: { quoteId: checkout.quote_id },
    });
    if (response.statusCode !== 200) return reply.code(response.statusCode).send(response.json());
    const shipment = { ...response.json(), deliveryLocation: checkout.delivery_location ?? null };
    // Recoverable linkage: retry uses the same fulfillment key even if this update failed.
    await write((tx) =>
      tx.query('UPDATE storefront_checkouts SET shipment_id=$1 WHERE id=$2 AND owner_hash=$3', [
        shipment.id,
        checkoutId,
        ownerHash,
      ]),
    );
    return { checkoutId, items: checkout.items, subtotalMinor: checkout.subtotal_minor, shipment };
  });
  app.get('/api/storefront/orders', async (req) => {
    const ownerHash = owner(req);
    return write(async (tx) => {
      const result = await tx.query<{
        id: string;
        shipment_id: string;
        items: StoreCheckout['items'];
        subtotal_minor: number;
      }>(
        'SELECT * FROM storefront_checkouts WHERE owner_hash=$1 AND shipment_id IS NOT NULL ORDER BY created_at DESC LIMIT 50',
        [ownerHash],
      );
      const cases = (
        await tx.query<CommercialReturn>(
          commercialReturnSelect + ' WHERE r.shipment_id=ANY($1::uuid[])',
          [result.rows.map((row) => row.shipment_id)],
        )
      ).rows;
      const byShipment = new Map(cases.map((r) => [r.shipmentId, r]));
      return {
        orders: await Promise.all(
          result.rows.map(async (row) => ({
            commercialReturn: byShipment.get(row.shipment_id) ?? null,
            ratings: (
              await tx.query(
                'SELECT kind,score,comment FROM service_ratings WHERE shipment_id=$1 AND owner_hash=$2',
                [row.shipment_id, ownerHash],
              )
            ).rows,
            checkoutId: row.id,
            items: row.items,
            subtotalMinor: row.subtotal_minor,
            shipment: await mapShipment(tx, await loadShipment(tx, row.shipment_id)),
          })),
        ),
      };
    });
  });
  app.post('/api/storefront/orders/:id/returns', async (req) => {
    const ownerHash = owner(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const reason = z.string().trim().min(5).max(500);
    const b = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('request'),
            expectedShipmentVersion: z.number().int().positive(),
            reason,
          })
          .strict(),
        z
          .object({
            action: z.enum(['cancel', 'handover']),
            expectedReturnVersion: z.number().int().positive(),
            reason: reason.optional(),
          })
          .strict(),
      ])
      .parse(req.body);
    const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `shop:${ownerHash}:commercial-return:${id}`, key, b, async () => {
        const sale = (
          await tx.query<{
            id: string;
            subtotal: number;
            items: { productId: string; quantity: number }[];
            status: string;
            version: number;
            merchant_id: string;
            origin_id: string;
            inventory_required: boolean;
          }>(
            'SELECT c.id,c.items,c.subtotal_minor::double precision AS subtotal,c.inventory_required,s.status,s.version,s.merchant_id,s.origin_id FROM storefront_checkouts c JOIN shipments s ON s.id=c.shipment_id WHERE c.shipment_id=$1 AND c.owner_hash=$2',
            [id, ownerHash],
          )
        ).rows[0];
        assert(sale, 404, 'NOT_FOUND', 'الطلب غير موجود');
        const existing = (
          await tx.query<{ id: string; status: string; version: number }>(
            'SELECT id,status,version FROM commercial_returns WHERE shipment_id=$1 AND checkout_id=$2',
            [id, sale.id],
          )
        ).rows[0];
        if (b.action !== 'request') {
          assert(existing, 404, 'NOT_FOUND', 'طلب الإرجاع غير موجود');
          assert(
            existing.version === b.expectedReturnVersion,
            409,
            'VERSION_CONFLICT',
            'تغير طلب الإرجاع؛ راجع حالته',
          );
          assert(
            b.action === 'handover'
              ? existing.status === 'accepted'
              : ['requested', 'approved', 'assigned', 'accepted'].includes(existing.status),
            409,
            'INVALID_STATE',
            'لا يمكن سحب طلب الإرجاع في حالته الحالية',
          );
          const status = b.action === 'handover' ? 'released' : 'cancelled';
          await tx.query(
            b.action === 'handover'
              ? "UPDATE commercial_returns SET status='released',version=version+1,released_at=$2 WHERE id=$1"
              : "UPDATE commercial_returns SET status='cancelled',version=version+1,cancelled_at=$2,courier_id=NULL,accepted_at=NULL,assignment_expires_at=NULL,issue_open=false WHERE id=$1",
            [existing.id, new Date((options.clock ?? Date.now)()).toISOString()],
          );
          await returnEvent(
            tx,
            existing.id,
            b.action,
            ownerHash,
            'العميل',
            b.action === 'handover' ? 'تسليم العميل للمندوب' : 'سحب طلب العميل',
            b.reason ??
              (b.action === 'handover'
                ? 'أكد العميل تسليم كامل المرتجع للمندوب المكلف'
                : 'سحب العميل طلب الإرجاع قبل انتقال العهدة'),
          );
          return { id: existing.id, status, version: existing.version + 1 };
        }
        assert(
          sale.status === 'delivered',
          409,
          'RETURN_NOT_DELIVERED',
          'الإرجاع التجاري لطلب استلمه العميل فقط',
        );
        assert(
          sale.version === b.expectedShipmentVersion,
          409,
          'VERSION_CONFLICT',
          'تغير الطلب؛ حدّث القراءة',
        );
        assert(!existing, 409, 'RETURN_EXISTS', 'يوجد طلب إرجاع مسجل لهذا الطلب؛ راجع حالته');
        const lines = (
          await tx.query<{
            product_id: string;
            quantity: number;
            state: string;
            merchant_id: string;
            site_id: string;
          }>(
            'SELECT product_id,quantity,state,merchant_id,site_id FROM inventory_reservations WHERE shipment_id=$1',
            [id],
          )
        ).rows;
        assert(
          sale.inventory_required &&
            sale.items.length > 0 &&
            lines.length === sale.items.length &&
            sale.items.every((item) =>
              lines.some(
                (line) =>
                  line.product_id === item.productId &&
                  line.quantity === item.quantity &&
                  line.state === 'fulfilled' &&
                  line.merchant_id === sale.merchant_id &&
                  line.site_id === sale.origin_id,
              ),
            ),
          409,
          'RETURN_SOURCE_INVALID',
          'بنود الطلب لا تطابق سجل البضاعة المسلمة',
        );
        const returnId = randomUUID();
        await tx.query(
          'INSERT INTO commercial_returns(id,checkout_id,shipment_id,merchant_id,items,goods_minor,currency,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            returnId,
            sale.id,
            id,
            sale.merchant_id,
            JSON.stringify(sale.items),
            sale.subtotal,
            'SYP',
            b.reason,
          ],
        );
        await returnEvent(tx, returnId, 'request', ownerHash, 'العميل', 'طلب إرجاع كامل', b.reason);
        return { id: returnId, status: 'requested', version: 1 };
      }),
    );
  });
  app.get('/api/storefront/orders/:id/location', async (req) => {
    const ownerHash = owner(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    return write(async (tx) => {
      const owned = await tx.query(
        'SELECT id FROM storefront_checkouts WHERE shipment_id=$1 AND owner_hash=$2',
        [id, ownerHash],
      );
      assert(owned.rows.length, 404, 'NOT_FOUND', 'الطلب غير موجود');
      return locationView(tx, id, (options.clock ?? Date.now)(), null);
    });
  });
  app.post('/api/storefront/orders/:id/delivery-code', async (req) => {
    const ownerHash = owner(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    return write(async (tx) => {
      const owned = await tx.query(
        'SELECT id FROM storefront_checkouts WHERE shipment_id=$1 AND owner_hash=$2',
        [id, ownerHash],
      );
      assert(owned.rows.length, 404, 'NOT_FOUND', 'الطلب غير موجود');
      const row = await loadShipment(tx, id);
      assert(
        row.pickup_site_id
          ? row.status === 'ready_for_pickup' &&
              row.pickup_expires_at &&
              new Date(row.pickup_expires_at).getTime() > (options.clock ?? Date.now)()
          : row.status === 'in_transit',
        409,
        'PROOF_NOT_AVAILABLE',
        row.pickup_site_id
          ? 'يظهر الرمز بعد استلام النقطة للطرد وخلال مهلة استلام العميل'
          : 'يظهر رمز الاستلام عندما تكون الشحنة في الطريق',
      );
      return issueProof(tx, id, (options.clock ?? Date.now)(), options.webhookKey);
    });
  });
}
