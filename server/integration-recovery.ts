import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import type { PGlite } from '@electric-sql/pglite';
import { assert, idempotent, loadShipment, transactionGate } from './domain.js';

export function registerRecovery(
  app: FastifyInstance,
  db: PGlite,
  write: ReturnType<typeof transactionGate>,
  operator: (req: FastifyRequest) => Account,
) {
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  const uuid = z.string().uuid();
  app.get('/api/integration/events', async (req) => {
    operator(req);
    const { status, page } = z
      .object({
        status: z.enum(['all', 'failed', 'pending']).default('all'),
        page: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .strict()
      .parse(req.query);
    return write(async (tx) => {
      const count = await tx.query<{ total: number }>(
        "SELECT COUNT(*)::int total FROM outbox WHERE ($1='all' OR status=$1)",
        [status],
      );
      const events = await tx.query(
        'SELECT id,shipment_id AS "shipmentId",type,status,attempts,retry_count AS "retryCount",cycle_attempts AS "cycleAttempts",last_error AS "lastError",created_at AS "createdAt" FROM outbox WHERE ($1=\'all\' OR status=$1) ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET $2',
        [status, page * 10],
      );
      return { events: events.rows, total: count.rows[0].total, page, pageSize: 10 };
    });
  });
  app.get('/api/integration/reconciliation', async (req) => {
    operator(req);
    return write(async (tx) => {
      const differences =
        await tx.query(`SELECT s.id AS "shipmentId",s.reference,s.version AS "sourceVersion",s.status AS "sourceStatus",p.version AS "receiverVersion",p.status AS "receiverStatus",
 CASE WHEN s.id IS NULL THEN 'orphan' WHEN p.shipment_id IS NULL THEN 'missing' WHEN p.version<s.version THEN 'behind' WHEN p.version>s.version THEN 'ahead' ELSE 'conflict' END AS kind
 FROM (SELECT * FROM shipments WHERE application_id='demo-commerce') s FULL JOIN commerce_projection p ON p.shipment_id=s.id
 WHERE s.id IS NULL OR p.shipment_id IS NULL OR s.version<>p.version OR s.status<>p.status ORDER BY s.updated_at DESC NULLS LAST,p.shipment_id LIMIT 100`);
      const totals = await tx.query<{ total: number; matched: number }>(
        `SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE s.version=p.version AND s.status=p.status)::int AS matched FROM shipments s LEFT JOIN commerce_projection p ON p.shipment_id=s.id WHERE s.application_id='demo-commerce'`,
      );
      const audit = await tx.query(
        'SELECT actor_id AS "actorId",action,entity_id AS "entityId",reason,created_at AS "createdAt" FROM integration_audit ORDER BY created_at DESC,id LIMIT 20',
      );
      return {
        checkedAt: new Date().toISOString(),
        ...totals.rows[0],
        differences: differences.rows,
        displayLimit: 100,
        audit: audit.rows,
      };
    });
  });
  app.post('/api/integration/events/:id/retry', async (req) => {
    const actor = operator(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z
      .object({
        reason: z.string().trim().min(3).max(240),
        expectedRetryCount: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${actor.id}:${id}:event-retry`, key(req), body, async () => {
        const result = await tx.query<{
          status: string;
          retry_count: number;
          attempts: number;
          last_retried_at: string | null;
        }>('SELECT * FROM outbox WHERE id=$1', [id]);
        const event = result.rows[0];
        assert(event, 404, 'NOT_FOUND', 'الحدث غير موجود');
        assert(
          event.retry_count === body.expectedRetryCount,
          409,
          'RETRY_CONFLICT',
          'تغيرت محاولات الحدث؛ حدّث القائمة',
        );
        assert(
          event.status === 'failed',
          409,
          'NOT_FAILED',
          'إعادة التشغيل متاحة للفشل النهائي فقط',
        );
        assert(
          event.retry_count < 3,
          409,
          'RETRY_LIMIT',
          'بلغ الحد الأقصى لثلاث دورات إعادة تشغيل؛ يلزم فحص السبب',
        );
        assert(
          !event.last_retried_at || Date.now() - new Date(event.last_retried_at).getTime() >= 60000,
          429,
          'RETRY_COOLDOWN',
          'انتظر دقيقة بين دورات إعادة التشغيل',
        );
        await tx.query(
          "UPDATE outbox SET status='pending',cycle_attempts=0,retry_count=retry_count+1,next_attempt_at=now(),last_retried_at=now() WHERE id=$1",
          [id],
        );
        await tx.query(
          'INSERT INTO integration_audit(id,actor_id,action,entity_id,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            actor.id,
            'event.retry',
            id,
            body.reason,
            JSON.stringify({ previousAttempts: event.attempts, retryCount: event.retry_count + 1 }),
          ],
        );
        return { eventId: id, retryCount: event.retry_count + 1, status: 'pending' };
      }),
    );
  });
  app.post('/api/integration/reconciliation/:id/repair', async (req) => {
    const actor = operator(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z
      .object({
        reason: z.string().trim().min(3).max(240),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${actor.id}:${id}:reconcile`, key(req), body, async () => {
        const row = await loadShipment(tx, id);
        assert(row.application_id === 'demo-commerce', 404, 'NOT_FOUND', 'الشحنة غير موجودة');
        assert(
          row.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت الشحنة؛ أعد المطابقة',
        );
        const receiver = await tx.query<{ version: number; status: string }>(
          'SELECT * FROM commerce_projection WHERE shipment_id=$1',
          [id],
        );
        const p = receiver.rows[0];
        assert(
          !p || p.version < row.version,
          409,
          'MANUAL_REVIEW_REQUIRED',
          'الحالة مطابقة أو تحتاج تحقيقًا في تعارض الإصدار؛ لن نستبدلها تلقائيًا',
        );
        const pending = await tx.query<{ id: string }>(
          "SELECT id FROM outbox WHERE shipment_id=$1 AND type='shipment.snapshot' AND status='pending' AND (payload->>'version')::int=$2 LIMIT 1",
          [id, row.version],
        );
        assert(!pending.rows.length, 409, 'REPAIR_PENDING', 'هناك رسالة مطابقة معلقة لهذا الإصدار');
        const eventId = randomUUID();
        const now = new Date().toISOString();
        await tx.query(
          'INSERT INTO outbox(id,shipment_id,type,payload,created_at) VALUES($1,$2,$3,$4,$5)',
          [
            eventId,
            id,
            'shipment.snapshot',
            JSON.stringify({
              id: eventId,
              type: 'shipment.snapshot',
              shipmentId: id,
              version: row.version,
              status: row.status,
              occurredAt: now,
            }),
            now,
          ],
        );
        await tx.query(
          'INSERT INTO integration_audit(id,actor_id,action,entity_id,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            actor.id,
            'projection.repair',
            id,
            body.reason,
            JSON.stringify({
              eventId,
              sourceVersion: row.version,
              receiverVersion: p?.version ?? null,
            }),
          ],
        );
        return { eventId, status: 'pending' };
      }),
    );
  });
}
