import { registerRefunds } from './customer-refunds.js';
import { registerNotifications } from './notifications.js';
import { registerCommercialReturns, expireCommercialReturns } from './commercial-returns.js';
import { registerFinancialRecovery } from './financial-recovery.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerStorefront } from './storefront.js';
import { registerLocation } from './location.js';
import { registerCash } from './cash.js';
import { registerPayouts } from './payouts.js';
import { expireSharing } from './location-storage.js';
import { registerInventory } from './inventory-api.js';
import { registerTransfers, expireTransfers } from './inventory-transfers.js';
import { registerNetwork } from './network.js';
import { registerRecovery } from './integration-recovery.js';
import { needsProof, verifyProof } from './delivery-proof.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { PGlite } from '@electric-sql/pglite';
import type { Account, Action, Courier } from '../shared/contracts.js';
import { demoAccounts, type ShipmentRow } from './db.js';
import {
  applyAction,
  expireAssignments,
  assert,
  canonical,
  courierCapacity,
  createQuote,
  createShipment,
  DomainError,
  idempotent,
  loadShipment,
  mapShipment,
  mayRead,
  transactionGate,
} from './domain.js';

const inputSchema = z
  .object({
    collection: z
      .object({
        goodsMinor: z.number().int().positive().max(1000000000000),
        currency: z.literal('SYP'),
      })
      .strict()
      .optional(),
    externalReference: z.string().trim().min(3).max(80),
    pickupSiteId: z.string().min(1).max(40).optional(),
    originId: z.string().min(1).max(40),
    recipientName: z.string().trim().min(2).max(80),
    destination: z.string().trim().min(5).max(180),
    weightKg: z.number().finite().positive().max(50),
  })
  .strict();
const actionSchema = z
  .object({
    cash: z
      .object({
        amountMinor: z.number().int().positive().max(1000000000000),
        currency: z.literal('SYP'),
        reference: z.string().trim().min(3).max(100),
      })
      .strict()
      .optional(),
    action: z.enum([
      'prepare',
      'handover_origin',
      'arrive_pickup',
      'receive_pickup',
      'release_pickup',
      'assign_return',
      'handover_return',
      'assign',
      'accept',
      'decline',
      'unassign',
      'pickup',
      'depart',
      'deliver',
      'fail',
      'cancel',
      'return',
      'receive_return',
    ]),
    expectedVersion: z.number().int().positive(),
    courierId: z.string().max(40).optional(),
    reason: z.string().trim().max(240).optional(),
    deliveryCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
const uuid = z.string().uuid();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildApp(
  db: PGlite,
  options: {
    applicationKey: string;
    webhookKey: string;
    demoMode: boolean;
    logger?: boolean;
    clock?: () => number;
    receiverUrl?: string;
    transport?: (raw: string, headers: Record<string, string>) => Promise<number>;
  },
) {
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: (request: { method?: string; url?: string }) => ({
              method: request.method,
              url: (request.url ?? '')
                .split('?')[0]
                .replace(/\/api\/tracking\/[^/]+/, '/api/tracking/[redacted]'),
            }),
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        }
      : false,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
  });
  app.register(cookie);
  const write = transactionGate(db);
  const clock = options.clock ?? Date.now;
  const sweepAssignments = () =>
    write(async (tx) => {
      const shipments = await expireAssignments(tx, clock());
      await expireTransfers(tx, clock());
      await expireCommercialReturns(tx, clock());
      await expireSharing(tx, clock());
      return shipments;
    });
  const sessions = new Map<string, { account: Account; expiresAt: number }>();
  const limits = new Map<string, { count: number; until: number }>();
  let flushing = false;
  const allowedOrigins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:3001',
    'http://localhost:3001',
  ]);

  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    const now = Date.now();
    if (limits.size > 2000)
      for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const limit = limits.get(req.ip);
    if (!limit || limit.until < now) limits.set(req.ip, { count: 1, until: now + 60_000 });
    else {
      limit.count++;
      assert(limit.count <= 600, 429, 'RATE_LIMIT', 'طلبات كثيرة؛ انتظر قليلًا ثم أعد المحاولة');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      assert(
        allowedOrigins.has(req.headers.origin),
        403,
        'ORIGIN_REJECTED',
        'مصدر الطلب غير مسموح',
      );
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message, requestId: req.id });
    if (error instanceof ZodError)
      return reply.code(422).send({
        code: 'VALIDATION_ERROR',
        message: 'تحقق من الحقول المطلوبة وحدودها',
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.id,
      });
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    )
      return reply
        .code(error.statusCode)
        .send({ code: 'BAD_REQUEST', message: 'تعذر قراءة الطلب', requestId: req.id });
    req.log.error(
      { errorType: error instanceof Error ? error.name : 'UnknownError', requestId: req.id },
      'Unhandled application error',
    );
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'تعذر إتمام العملية؛ احتفظ بمرجع الطلب للمراجعة',
      requestId: req.id,
    });
  });

  function account(req: { cookies: Record<string, string | undefined> }) {
    const token = req.cookies.session;
    const session = token ? sessions.get(hash(token)) : undefined;
    assert(
      session && session.expiresAt > Date.now(),
      401,
      'UNAUTHENTICATED',
      'اختر حساب العرض للدخول',
    );
    return session.account;
  }
  function operator(req: Parameters<typeof account>[0]) {
    const a = account(req);
    assert(a.role === 'operator', 403, 'FORBIDDEN', 'هذا الإجراء متاح لإدارة العمليات فقط');
    return a;
  }
  function appIdentity(req: { headers: Record<string, unknown> }) {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    assert(
      equal(hash(token), hash(options.applicationKey)),
      401,
      'INVALID_APPLICATION_KEY',
      'هوية التطبيق غير صالحة',
    );
    const merchantId = String(req.headers['x-merchant-id'] ?? '');
    assert(
      ['merchant-a', 'merchant-b'].includes(merchantId),
      403,
      'MERCHANT_NOT_GRANTED',
      'المتجر غير مخول لهذا التطبيق',
    );
    return { applicationId: 'demo-commerce', merchantId };
  }
  function requestKey(req: { headers: Record<string, unknown> }) {
    return z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  }
  function commerceScope(a: Account, merchantId: string) {
    assert(
      a.role === 'operator' || (a.role === 'merchant' && a.merchantId === merchantId),
      403,
      'FORBIDDEN',
      'ليس لديك صلاحية لهذا المتجر',
    );
  }

  app.get('/api/health', async () => ({
    status: 'ok',
    mode: 'demo',
    database: 'embedded-postgresql',
    slice: 'local-parcel',
  }));
  registerStorefront(app, db, options, write);
  registerLocation(app, write, account, clock);
  registerCash(app, write, account, clock);
  registerFinancialRecovery(app, write, account);
  registerCommercialReturns(app, write, account, clock);
  registerNotifications(app, write, account);
  registerPayouts(app, write, account, clock);
  registerRefunds(app, write, account, clock);
  registerInventory(app, db, write, account);
  registerTransfers(app, db, write, account, clock);
  registerRecovery(app, db, write, operator);
  registerNetwork(app, db, write, operator);
  async function availableAccounts(): Promise<Account[]> {
    const points = (
      await db.query<{ id: string; name: string }>(
        "SELECT id,name FROM sites WHERE kind='pickup' AND id<>'pickup-a' ORDER BY name",
      )
    ).rows;
    return [
      ...demoAccounts,
      ...points.map((p) => ({
        id: p.id,
        name: 'موظف ' + p.name,
        role: 'pickup' as const,
        pickupSiteId: p.id,
        merchantId: null,
        courierId: null,
      })),
    ];
  }
  app.get('/api/demo/accounts', async () => {
    assert(options.demoMode, 404, 'NOT_FOUND', 'غير متاح');
    return { accounts: await availableAccounts() };
  });
  app.post('/api/demo/session', async (req, reply) => {
    assert(options.demoMode, 404, 'NOT_FOUND', 'غير متاح');
    const host = String(req.headers.host ?? '').split(':')[0];
    assert(
      ['localhost', '127.0.0.1'].includes(host),
      403,
      'HOST_REJECTED',
      'حسابات العرض متاحة عبر المضيف المحلي فقط',
    );
    const { accountId } = z
      .object({ accountId: z.string().max(40) })
      .strict()
      .parse(req.body);
    const a = (await availableAccounts()).find((x) => x.id === accountId);
    assert(a, 422, 'INVALID_ACCOUNT', 'حساب العرض غير متاح');
    if (req.cookies.session) sessions.delete(hash(req.cookies.session));
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [key, s] of sessions) if (s.expiresAt < now) sessions.delete(key);
    assert(sessions.size < 1000, 429, 'SESSION_LIMIT', 'وصلت جلسات العرض إلى الحد المسموح');
    sessions.set(hash(token), { account: a, expiresAt: now + 8 * 60 * 60_000 });
    reply.setCookie('session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60,
    });
    return { account: a };
  });
  app.delete('/api/session', async (req, reply) => {
    if (req.cookies.session) sessions.delete(hash(req.cookies.session));
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/bootstrap', async (req) => {
    const a = account(req);
    let where = '';
    let params: string[] = [];
    if (a.role === 'merchant') {
      where = ' WHERE merchant_id=$1';
      params = [a.merchantId!];
    }
    if (a.role === 'courier') {
      where = ' WHERE courier_id=$1';
      params = [a.courierId!];
    }
    if (a.role === 'pickup') {
      where = ' WHERE pickup_site_id=$1';
      params = [a.pickupSiteId!];
    }
    const rows = await db.query<ShipmentRow>(
      'SELECT * FROM shipments' + where + ' ORDER BY created_at DESC LIMIT 100',
      params,
    );
    const shipments = await Promise.all(rows.rows.map((s) => mapShipment(db, s)));
    const cs = await db.query<{
      id: string;
      name: string;
      vehicle: string;
      capacity_kg: number;
      available: boolean;
    }>('SELECT * FROM couriers ORDER BY id');
    const couriers: Courier[] = [];
    if (a.role === 'operator')
      for (const c of cs.rows)
        couriers.push({
          id: c.id,
          name: c.name,
          vehicle: c.vehicle,
          capacityKg: c.capacity_kg,
          activeKg: await courierCapacity(db, c.id),
          available: c.available,
        });
    const siteSql =
      a.role === 'merchant'
        ? 'SELECT * FROM sites WHERE merchant_id=$1'
        : a.role === 'courier'
          ? 'SELECT * FROM sites WHERE id IN (SELECT origin_id FROM shipments WHERE courier_id=$1)'
          : a.role === 'pickup'
            ? 'SELECT * FROM sites WHERE id=$1'
            : 'SELECT * FROM sites';
    const siteResult = await db.query<{
      id: string;
      name: string;
      city: string;
      address: string;
      kind: string;
      merchant_id: string | null;
      version: number;
      pickup_enabled: boolean;
      pickup_capacity_kg: number;
    }>(
      siteSql,
      a.role === 'merchant'
        ? [a.merchantId]
        : a.role === 'courier'
          ? [a.courierId]
          : a.role === 'pickup'
            ? [a.pickupSiteId]
            : [],
    );
    const reserved = (
      await db.query<{ id: string; kg: number }>(
        "SELECT pickup_site_id id,SUM(weight_kg)::real kg FROM shipments WHERE pickup_site_id IS NOT NULL AND status NOT IN ('delivered','returned','cancelled') AND NOT(status='returning' AND custody_site_id IS NULL) GROUP BY pickup_site_id",
      )
    ).rows;
    const reservedBySite = new Map(reserved.map((row) => [row.id, row.kg]));
    const sites = siteResult.rows.map((s) => ({
      version: s.version,
      pickupEnabled: s.pickup_enabled,
      pickupCapacityKg: s.pickup_capacity_kg,
      reservedKg: reservedBySite.get(s.id) ?? 0,
      id: s.id,
      name: s.name,
      city: s.city,
      address: s.address,
      kind: s.kind,
      merchantId: s.merchant_id,
    }));
    return {
      account: a,
      shipments,
      couriers,
      sites,
      stats: {
        total: shipments.length,
        active: shipments.filter((s) =>
          [
            'ready',
            'assigned',
            'picked_up',
            'in_transit',
            'awaiting_handover',
            'ready_for_pickup',
            'returning',
          ].includes(s.status),
        ).length,
        delivered: shipments.filter((s) => s.status === 'delivered').length,
        exceptions: shipments.filter(
          (s) => ['failed', 'pickup_expired'].includes(s.status) || s.pickupOverdue,
        ).length,
      },
    };
  });
  app.get('/api/shipments/pickup-alerts', async (req) => {
    operator(req);
    const total = await db.query<{ total: number }>(
      'SELECT COUNT(*)::integer AS total FROM shipments WHERE pickup_overdue',
    );
    const alerts = await db.query(
      'SELECT id,reference,pickup_due_at AS "dueAt",origin_released AS released FROM shipments WHERE pickup_overdue ORDER BY pickup_due_at,id LIMIT 20',
    );
    return { total: total.rows[0].total, alerts: alerts.rows };
  });
  app.get('/api/shipments/:id', async (req) => {
    const a = account(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const row = await loadShipment(db, id);
    assert(mayRead(a, row), 404, 'NOT_FOUND', 'الشحنة غير موجودة');
    const timeline = await db.query(
      'SELECT id,shipment_id AS "shipmentId",type,description,actor_name AS "actorName",created_at AS "createdAt" FROM timeline WHERE shipment_id=$1 ORDER BY created_at,id',
      [id],
    );
    const inventory = await db.query(
      'SELECT product_id AS "productId",quantity,state,expires_at AS "expiresAt",restocked_quantity AS restocked,discarded_quantity AS discarded FROM inventory_reservations WHERE shipment_id=$1 ORDER BY product_id',
      [id],
    );
    return {
      shipment: await mapShipment(db, row),
      timeline: timeline.rows,
      inventory: inventory.rows,
    };
  });
  app.post('/api/shipments/:id/actions', async (req) => {
    const a = account(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const body = actionSchema.parse(req.body);
    const key = requestKey(req);
    const outcome = await write(async (tx) => {
      // Replay an actor's own completed command even when declining removed their assignment.
      // New commands still enforce ownership inside applyAction.
      const current = await loadShipment(tx, id);
      if (
        ((body.action === 'deliver' &&
          current.status === 'in_transit' &&
          !current.pickup_site_id &&
          a.role === 'courier' &&
          a.courierId === current.courier_id) ||
          (body.action === 'release_pickup' &&
            current.status === 'ready_for_pickup' &&
            current.pickup_expires_at &&
            new Date(current.pickup_expires_at).getTime() > clock() &&
            a.role === 'pickup' &&
            a.pickupSiteId === current.custody_site_id)) &&
        current.version === body.expectedVersion &&
        (await needsProof(tx, current))
      ) {
        const failure = await verifyProof(tx, id, body.deliveryCode, clock(), options.webhookKey);
        if (failure) return { proofFailure: failure };
      }
      return idempotent(tx, `${a.id}:${id}:action`, key, body, () =>
        applyAction(
          tx,
          a,
          id,
          body.action as Action,
          body.expectedVersion,
          body.courierId,
          body.reason,
          clock(),
          body.deliveryCode,
          options.webhookKey,
          body.cash,
        ),
      );
    });
    if ('proofFailure' in outcome) throw outcome.proofFailure;
    return outcome;
  });

  app.post('/api/v1/quotes', async (req) => {
    const identity = appIdentity(req);
    const input = inputSchema.parse(req.body);
    return write((tx) => createQuote(tx, identity.applicationId, identity.merchantId, input));
  });
  app.post('/api/v1/fulfillments', async (req) => {
    const identity = appIdentity(req);
    const body = z.object({ quoteId: uuid }).strict().parse(req.body);
    const key = requestKey(req);
    return write((tx) =>
      createShipment(tx, identity.applicationId, identity.merchantId, body.quoteId, key),
    );
  });
  app.get('/api/v1/fulfillments/:id', async (req) => {
    const identity = appIdentity(req);
    const row = await loadShipment(db, uuid.parse((req.params as { id: string }).id));
    assert(identity.merchantId === row.merchant_id, 404, 'NOT_FOUND', 'الشحنة غير موجودة');
    return mapShipment(db, row);
  });

  // Demo commerce BFF: app credentials never reach the browser. It calls the same public API contract.
  app.post('/api/demo-commerce/quotes', async (req, reply) => {
    const a = account(req);
    const body = z.object({ merchantId: z.string(), input: inputSchema }).strict().parse(req.body);
    commerceScope(a, body.merchantId);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: {
        authorization: 'Bearer ' + options.applicationKey,
        'x-merchant-id': body.merchantId,
      },
      payload: body.input,
    });
    return reply.code(response.statusCode).send(response.json());
  });
  app.post('/api/demo-commerce/orders', async (req, reply) => {
    const a = account(req);
    const body = z.object({ merchantId: z.string(), quoteId: uuid }).strict().parse(req.body);
    commerceScope(a, body.merchantId);
    const key = requestKey(req);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/fulfillments',
      headers: {
        authorization: 'Bearer ' + options.applicationKey,
        'x-merchant-id': body.merchantId,
        'idempotency-key': key,
      },
      payload: { quoteId: body.quoteId },
    });
    return reply.code(response.statusCode).send(response.json());
  });

  app.get('/api/tracking/:token', async (req) => {
    const token = z
      .string()
      .min(20)
      .max(80)
      .parse((req.params as { token: string }).token);
    const rows = await db.query<ShipmentRow>(
      "SELECT * FROM shipments WHERE tracking_token=$1 AND status<>'cancelled'",
      [token],
    );
    const r = rows.rows[0];
    assert(r, 404, 'TRACKING_UNAVAILABLE', 'رابط التتبع غير متاح أو أُلغي');
    const events = await db.query<{ description: string; createdAt: string; type: string }>(
      `SELECT type,description,created_at AS "createdAt" FROM timeline WHERE shipment_id=$1 ORDER BY created_at,id`,
      [r.id],
    );
    return {
      reference: r.reference,
      status: r.status,
      city: 'دمشق',
      updatedAt: r.updated_at,
      timeline: events.rows.map((e) => ({ type: e.type, createdAt: e.createdAt })),
    };
  });

  app.get('/api/integration', async (req) => {
    operator(req);
    const settings = await db.query<{ webhook_paused: boolean }>(
      'SELECT webhook_paused FROM demo_settings WHERE id=1',
    );
    const events = await db.query(
      'SELECT id,shipment_id AS "shipmentId",type,status,attempts,retry_count AS "retryCount",cycle_attempts AS "cycleAttempts",last_error AS "lastError",created_at AS "createdAt" FROM outbox ORDER BY created_at DESC LIMIT 50',
    );
    const received = await db.query(
      'SELECT event_id AS "eventId",type,shipment_id AS "shipmentId",received_at AS "receivedAt" FROM received_events ORDER BY received_at DESC LIMIT 50',
    );
    return {
      paused: settings.rows[0].webhook_paused,
      events: events.rows,
      received: received.rows,
    };
  });
  app.post('/api/integration/receiver', async (req) => {
    operator(req);
    assert(options.demoMode, 404, 'NOT_FOUND', 'غير متاح');
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(req.body);
    await write((tx) =>
      tx.query('UPDATE demo_settings SET webhook_paused=$1 WHERE id=1', [paused]),
    );
    return { paused };
  });
  app.post('/api/integration/flush', async (req) => {
    operator(req);
    assert(options.demoMode, 404, 'NOT_FOUND', 'غير متاح');
    await flushOutbox(true);
    return { ok: true };
  });

  // This receiver is fixed to the local commerce simulator; arbitrary callback URLs are not accepted.
  app.post('/api/demo-commerce/webhook', async (req, reply) => {
    const timestamp = String(req.headers['x-webhook-timestamp'] ?? '');
    assert(
      /^\d{13}$/.test(timestamp) && Math.abs(Date.now() - Number(timestamp)) < 5 * 60_000,
      401,
      'WEBHOOK_EXPIRED',
      'توقيت الإشعار غير صالح',
    );
    const raw = JSON.stringify(req.body);
    const signature = createHmac('sha256', options.webhookKey)
      .update(timestamp + '.' + raw)
      .digest('hex');
    assert(
      equal(signature, String(req.headers['x-webhook-signature'] ?? '')),
      401,
      'INVALID_SIGNATURE',
      'توقيع الإشعار غير صالح',
    );
    const event = z
      .object({
        id: uuid,
        type: z.string().min(1).max(80),
        shipmentId: uuid,
        version: z.number().int().positive(),
        status: z.enum([
          'awaiting_handover',
          'ready_for_pickup',
          'pickup_expired',
          'ready',
          'assigned',
          'picked_up',
          'in_transit',
          'delivered',
          'failed',
          'cancelled',
          'returning',
          'returned',
        ]),
        occurredAt: z.string().datetime(),
      })
      .strict()
      .parse(req.body);
    const settings = await db.query<{ webhook_paused: boolean }>(
      'SELECT webhook_paused FROM demo_settings WHERE id=1',
    );
    if (settings.rows[0].webhook_paused)
      return reply
        .code(503)
        .send({ code: 'SIMULATED_FAILURE', message: 'مستقبل الإشعارات التجريبي متوقف' });
    await write(async (tx) => {
      const fingerprint = hash(canonical(event));
      const existing = await tx.query<{ fingerprint: string | null }>(
        'SELECT fingerprint FROM received_events WHERE event_id=$1',
        [event.id],
      );
      if (existing.rows.length) {
        assert(
          existing.rows[0].fingerprint === fingerprint,
          409,
          'EVENT_CONFLICT',
          'أعيد استخدام معرف الحدث بمحتوى مختلف',
        );
        return;
      }
      await tx.query(
        'INSERT INTO received_events(event_id,type,shipment_id,version,fingerprint) VALUES($1,$2,$3,$4,$5)',
        [event.id, event.type, event.shipmentId, event.version, fingerprint],
      );
      await tx.query(
        `INSERT INTO commerce_projection VALUES($1,$2,$3,now()) ON CONFLICT(shipment_id)
        DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status,updated_at=now() WHERE commerce_projection.version<EXCLUDED.version`,
        [event.shipmentId, event.version, event.status],
      );
    });
    return { accepted: true };
  });
  async function flushOutbox(force = false) {
    if (flushing) return;
    flushing = true;
    try {
      const events = await db.query<{
        id: string;
        payload: unknown;
        attempts: number;
        cycle_attempts: number;
      }>(
        `SELECT id,payload,attempts,cycle_attempts FROM outbox WHERE status='pending' ${force ? '' : 'AND next_attempt_at<=now()'} ORDER BY created_at,id LIMIT 20`,
      );
      for (const event of events.rows) {
        const raw = JSON.stringify(event.payload);
        const timestamp = String(Date.now());
        const headers = {
          'content-type': 'application/json',
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': createHmac('sha256', options.webhookKey)
            .update(timestamp + '.' + raw)
            .digest('hex'),
        };
        let code = 0;
        try {
          if (options.transport) code = await options.transport(raw, headers);
          else {
            const r = await fetch(
              options.receiverUrl ?? 'http://127.0.0.1:3001/api/demo-commerce/webhook',
              {
                method: 'POST',
                headers,
                body: raw,
                signal: AbortSignal.timeout(4000),
                redirect: 'error',
              },
            );
            code = r.status;
            await r.body?.cancel();
          }
        } catch {
          /* persisted attempt and backoff below */
        }
        const success = code >= 200 && code < 300;
        const attempts = event.attempts + 1;
        const cycleAttempts = event.cycle_attempts + 1;
        const terminal =
          !success && ((code >= 400 && code < 500 && code !== 429) || cycleAttempts >= 8);
        const next = new Date(
          Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(cycleAttempts, 8)),
        ).toISOString();
        await write((tx) =>
          tx.query(
            'UPDATE outbox SET status=$1,attempts=$2,next_attempt_at=$3,sent_at=$4,cycle_attempts=$6,last_error=$7 WHERE id=$5',
            [
              success ? 'sent' : terminal ? 'failed' : 'pending',
              attempts,
              next,
              success ? new Date().toISOString() : null,
              event.id,
              cycleAttempts,
              success ? null : code === 0 ? 'TRANSPORT_ERROR' : `HTTP_${code}`,
            ],
          ),
        );
      }
    } finally {
      flushing = false;
    }
  }
  return { app, flushOutbox, write, sweepAssignments };
}
