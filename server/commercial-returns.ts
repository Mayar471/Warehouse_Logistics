import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from './db.js';
import type { Account } from '../shared/contracts.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assert, idempotent, transactionGate } from './domain.js';
export const commercialReturnSelect = `SELECT r.id,r.shipment_id AS "shipmentId",s.reference AS "shipmentReference",r.merchant_id AS "merchantId",m.name AS "merchantName",r.status,r.version,r.items,r.goods_minor::double precision AS "goodsMinor",r.currency,r.reason,r.decision_reason AS "decisionReason",r.created_at AS "createdAt",r.reviewed_at AS "reviewedAt",r.cancelled_at AS "cancelledAt" FROM commercial_returns r JOIN shipments s ON s.id=r.shipment_id JOIN merchants m ON m.id=r.merchant_id`;
export async function returnEvent(
  tx: Transaction,
  id: string,
  action: string,
  actorId: string,
  actorName: string,
  reference: string,
  reason: string,
) {
  await tx.query(
    'INSERT INTO commercial_return_events(id,return_id,action,actor_id,actor_name,reference,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), id, action, actorId, actorName, reference, reason],
  );
}
export function registerCommercialReturns(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
) {
  const access = (req: FastifyRequest) => {
    const a = account(req);
    assert(
      a.role === 'operator' || (a.role === 'merchant' && !!a.merchantId),
      403,
      'FORBIDDEN',
      'مراجعة المرتجعات للمتجر المالك وقراءة العمليات',
    );
    return a;
  };
  app.get('/api/commercial-returns', async (req) => {
    const a = access(req);
    return write(async (tx) => {
      const owner = a.role === 'operator' ? null : a.merchantId;
      const totals = (
        await tx.query(
          "SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='requested')::integer requested,COUNT(*) FILTER(WHERE status='approved')::integer approved FROM commercial_returns WHERE ($1::text IS NULL OR merchant_id=$1)",
          [owner],
        )
      ).rows[0];
      const rows = (
        await tx.query(
          commercialReturnSelect +
            " WHERE ($1::text IS NULL OR r.merchant_id=$1) ORDER BY (r.status IN ('requested','approved')) DESC,r.created_at DESC,r.id LIMIT 50",
          [owner],
        )
      ).rows;
      const history = (
        await tx.query(
          'SELECT e.id,e.return_id AS "returnId",e.action,e.actor_name AS "actorName",e.reference,e.reason,e.created_at AS "createdAt" FROM commercial_return_events e JOIN commercial_returns r ON r.id=e.return_id WHERE ($1::text IS NULL OR r.merchant_id=$1) ORDER BY e.created_at DESC,e.id LIMIT 30',
          [owner],
        )
      ).rows;
      return { ...(totals as object), rows, history };
    });
  });
  app.post('/api/commercial-returns/:id/actions', async (req) => {
    const a = access(req);
    assert(
      req.headers['x-review-actor'] === undefined || req.headers['x-review-actor'] === a.id,
      403,
      'ACCOUNT_CHANGED',
      'تغير حساب الجلسة؛ عد إلى حساب مراجعة الإرجاع',
    );
    assert(a.role === 'merchant', 403, 'FORBIDDEN', 'قرار قبول أو رفض الإرجاع للمتجر المالك فقط');
    const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b = z
        .object({
          action: z.enum(['approve', 'reject']),
          expectedVersion: z.number().int().positive(),
          reference: z.string().trim().min(3).max(100),
          reason: z.string().trim().min(5).max(240),
        })
        .strict()
        .parse(req.body),
      key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `${a.id}:commercial-return:${id}`, key, b, async () => {
        const r = (
          await tx.query<{ status: string; version: number }>(
            'SELECT status,version FROM commercial_returns WHERE id=$1 AND merchant_id=$2',
            [id, a.merchantId],
          )
        ).rows[0];
        assert(r, 404, 'NOT_FOUND', 'طلب الإرجاع غير موجود');
        assert(
          r.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير طلب الإرجاع؛ حدّث القراءة وراجع القرار',
        );
        assert(r.status === 'requested', 409, 'INVALID_STATE', 'طلب الإرجاع لا ينتظر مراجعة');
        const status = b.action === 'approve' ? 'approved' : 'rejected';
        await tx.query(
          'UPDATE commercial_returns SET status=$2,version=version+1,decision_reason=$3,reviewed_at=$4 WHERE id=$1',
          [id, status, b.reason, new Date(clock()).toISOString()],
        );
        await returnEvent(tx, id, b.action, a.id, a.name, b.reference, b.reason);
        return { id, status, version: r.version + 1 };
      }),
    );
  });
}
