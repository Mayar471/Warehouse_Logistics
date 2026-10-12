import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account } from '../shared/contracts.js';
import type { Transaction } from './db.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert, idempotent, transactionGate } from './domain.js';
import { journal, validateCash } from './cash-ledger.js';
import { financialActor } from './financial-recovery.js';
export const refundJson = `(SELECT json_build_object('id',f.id,'status',f.status,'version',f.version,'amountMinor',f.amount_minor::double precision,'currency',f.currency,'issueOpen',f.issue_open,'lastReportedMinor',f.last_reported_minor::double precision,'releasedAt',f.released_at,'confirmedAt',f.confirmed_at) FROM customer_refunds f WHERE f.id=r.id)`;
const terms = {
  action: z.enum(['request', 'reserve', 'release', 'cancel', 'confirm', 'report']),
  expectedVersion: z.number().int().positive(),
  amountMinor: z.number().int().min(0).max(1000000000000),
  currency: z.literal('SYP'),
  reference: z.string().trim().min(3).max(100),
  reason: z.string().trim().min(3).max(240),
};
async function event(
  tx: Transaction,
  id: string,
  action: string,
  actorId: string,
  name: string,
  reference: string,
  reason: string,
  details: unknown = {},
) {
  await tx.query(
    'INSERT INTO customer_refund_events(id,refund_id,action,actor_id,actor_name,reference,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), id, action, actorId, name, reference, reason, JSON.stringify(details)],
  );
}
async function funded(tx: Transaction, shipmentId: string) {
  const o = (
    await tx.query<{ status: string; issue_open: boolean }>(
      'SELECT status,issue_open FROM cash_obligations WHERE shipment_id=$1',
      [shipmentId],
    )
  ).rows[0];
  assert(
    o?.status === 'received' && !o.issue_open,
    409,
    'REFUND_NOT_FUNDED',
    'يجب استلام العمليات للتحصيل كاملًا دون فرق قبل رد العميل',
  );
  assert(
    !(
      await tx.query(
        "SELECT id FROM cash_payouts WHERE shipment_id=$1 AND status NOT IN ('cancelled','returned','recovered')",
        [shipmentId],
      )
    ).rows.length,
    409,
    'PAYOUT_BLOCKS_REFUND',
    'ألغ حجز المتجر أو استعد نقد الدفعة قبل رد العميل',
  );
  assert(
    !(
      await tx.query(
        "SELECT id FROM cash_remittance_returns WHERE shipment_id=$1 AND status IN ('requested','released')",
        [shipmentId],
      )
    ).rows.length,
    409,
    'REMITTANCE_RETURN_PENDING',
    'حوالة التحصيل في مسار الرجوع؛ لا يمكن تمويل الرد',
  );
  await validateCash(tx, shipmentId);
}
export function registerRefunds(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (r: FastifyRequest) => Account,
  clock: () => number,
) {
  app.post('/api/refunds/:id/actions', async (req) => {
    const a = account(req);
    financialActor(req, a);
    const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b = z.object(terms).strict().parse(req.body),
      key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    assert(
      ['merchant', 'operator'].includes(a.role),
      403,
      'FORBIDDEN',
      'اعتماد المتجر وتمويل العمليات فقط',
    );
    assert(
      a.role !== 'merchant' || !!a.merchantId,
      403,
      'FORBIDDEN',
      'يلزم متجر محدد لاعتماد الرد',
    );
    assert(
      b.action === 'request'
        ? a.role === 'merchant'
        : b.action === 'cancel'
          ? ['merchant', 'operator'].includes(a.role)
          : a.role === 'operator' && ['reserve', 'release'].includes(b.action),
      403,
      'FORBIDDEN',
      'الإجراء غير متاح لحسابك',
    );
    return write((tx) =>
      idempotent(tx, `${a.id}:refund:${id}`, key, b, async () => {
        const r = (
          await tx.query<{
            status: string;
            version: number;
            shipment_id: string;
            goods_minor: number;
            merchant_id: string;
          }>(
            'SELECT status,version,shipment_id,goods_minor::double precision,merchant_id FROM commercial_returns WHERE id=$1 AND ($2::text IS NULL OR merchant_id=$2)',
            [id, a.role === 'merchant' ? a.merchantId : null],
          )
        ).rows[0];
        assert(r, 404, 'NOT_FOUND', 'الإرجاع غير موجود');
        const f = (
          await tx.query<{ status: string; version: number; amount_minor: number }>(
            'SELECT status,version,amount_minor::double precision FROM customer_refunds WHERE id=$1',
            [id],
          )
        ).rows[0];
        assert(
          b.amountMinor === (f?.amount_minor ?? r.goods_minor),
          422,
          'REFUND_AMOUNT_MISMATCH',
          'رد قيمة البضائع كاملًا فقط؛ رسوم التوصيل غير مشمولة',
        );
        let status: string, version: number;
        if (b.action === 'request') {
          assert(!f, 409, 'REFUND_EXISTS', 'يوجد قرار رد مسجل لهذا الإرجاع');
          assert(
            r.version === b.expectedVersion,
            409,
            'VERSION_CONFLICT',
            'تغير الإرجاع؛ حدّث القراءة',
          );
          assert(r.status === 'received', 409, 'RETURN_NOT_RECEIVED', 'يلزم وصول المرتجع للمنشأ');
          const lines = (
            await tx.query<{
              quantity: number;
              restocked_quantity: number;
              discarded_quantity: number;
            }>(
              'SELECT quantity,restocked_quantity,discarded_quantity FROM inventory_reservations WHERE shipment_id=$1',
              [r.shipment_id],
            )
          ).rows;
          assert(
            lines.length > 0 &&
              lines.every((l) => l.quantity === l.restocked_quantity + l.discarded_quantity),
            409,
            'INSPECTION_PENDING',
            'أكمل فحص جميع القطع قبل اعتماد الرد',
          );
          const collection = (
            await tx.query<{ goods: number }>(
              'SELECT goods_minor::double precision AS goods FROM cash_obligations WHERE shipment_id=$1',
              [r.shipment_id],
            )
          ).rows[0];
          assert(
            collection?.goods === r.goods_minor,
            409,
            'NO_REFUND_COLLECTION',
            'يلزم تحصيل نقدي موثق يطابق قيمة البضائع',
          );
          await funded(tx, r.shipment_id);
          await tx.query(
            "INSERT INTO customer_refunds(id,shipment_id,amount_minor,currency,status) VALUES($1,$2,$3,'SYP','requested')",
            [id, r.shipment_id, r.goods_minor],
          );
          status = 'requested';
          version = 1;
        } else {
          assert(f, 404, 'NOT_FOUND', 'قرار الرد غير موجود');
          assert(
            f.version === b.expectedVersion,
            409,
            'VERSION_CONFLICT',
            'تغير الرد؛ حدّث القراءة',
          );
          if (b.action === 'cancel') {
            assert(
              ['requested', 'reserved'].includes(f.status),
              409,
              'REFUND_CUSTODY_LOCKED',
              'لا يمكن إلغاء نقد خرج للعميل',
            );
            status = 'cancelled';
          } else {
            await funded(tx, r.shipment_id);
            assert(
              f.status === (b.action === 'reserve' ? 'requested' : 'reserved'),
              409,
              'INVALID_STATE',
              'الرد لا ينتظر هذا الإجراء',
            );
            status = b.action === 'reserve' ? 'reserved' : 'released';
            const cash = (
              await tx.query<{ amount: number }>(
                "SELECT COALESCE(SUM(p.amount_minor),0)::double precision amount FROM cash_postings p JOIN cash_journals j ON j.id=p.journal_id WHERE j.shipment_id=$1 AND p.account_code='operations_cash'",
                [r.shipment_id],
              )
            ).rows[0].amount;
            assert(
              cash >= f.amount_minor,
              409,
              'REFUND_NOT_FUNDED',
              'النقد المتاح لهذا التحصيل لا يكفي للرد',
            );
            if (b.action === 'release')
              await journal(
                tx,
                r.shipment_id,
                'refund_release',
                'SYP',
                f.amount_minor,
                [
                  { account: 'customer_refund_transit', amount: f.amount_minor },
                  { account: 'operations_cash', amount: -f.amount_minor },
                ],
                null,
                null,
                null,
                null,
                id,
              );
          }
          await tx.query(
            "UPDATE customer_refunds SET status=$2,version=version+1,released_at=CASE WHEN $2='released' THEN $3 ELSE released_at END WHERE id=$1",
            [id, status, new Date(clock()).toISOString()],
          );
          version = f.version + 1;
        }
        await event(tx, id, b.action, a.id, a.name, b.reference, b.reason, {
          amountMinor: b.amountMinor,
          currency: b.currency,
        });
        await validateCash(tx, r.shipment_id);
        return { id, status, version };
      }),
    );
  });
}
export function registerCustomerRefunds(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  owner: (r: FastifyRequest) => string,
  clock: () => number,
) {
  app.post('/api/storefront/orders/:id/refund', async (req) => {
    const hash = owner(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b = z
        .object({ ...terms, action: z.enum(['confirm', 'report']) })
        .strict()
        .parse(req.body),
      key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `shop:${hash}:refund:${id}`, key, b, async () => {
        const f = (
          await tx.query<{ id: string; status: string; version: number; amount: number }>(
            'SELECT f.id,f.status,f.version,f.amount_minor::double precision AS amount FROM customer_refunds f JOIN storefront_checkouts c ON c.shipment_id=f.shipment_id WHERE f.shipment_id=$1 AND c.owner_hash=$2',
            [id, hash],
          )
        ).rows[0];
        assert(f, 404, 'NOT_FOUND', 'رد الأموال غير موجود');
        assert(f.version === b.expectedVersion, 409, 'VERSION_CONFLICT', 'تغير الرد؛ حدّث الطلب');
        assert(f.status === 'released', 409, 'INVALID_STATE', 'لم يسجل خروج النقد للعميل');
        await validateCash(tx, id);
        if (b.action === 'confirm') {
          assert(
            b.amountMinor === f.amount,
            422,
            'REFUND_AMOUNT_MISMATCH',
            'أكد استلام المبلغ كاملًا أو سجل فرقًا دون إغلاق العهدة',
          );
          await journal(
            tx,
            id,
            'refund_confirm',
            'SYP',
            f.amount,
            [
              { account: 'merchant_payable', amount: f.amount },
              { account: 'customer_refund_transit', amount: -f.amount },
            ],
            null,
            null,
            null,
            null,
            f.id,
          );
        } else
          assert(
            b.amountMinor !== f.amount,
            422,
            'NO_CASH_DIFFERENCE',
            'المبلغ مطابق؛ أكد استلامه كاملًا',
          );
        const status = b.action === 'confirm' ? 'confirmed' : 'released';
        await tx.query(
          'UPDATE customer_refunds SET status=$2,version=version+1,issue_open=$3,confirmed_at=$4,last_reported_minor=CASE WHEN $3 THEN $5 ELSE last_reported_minor END WHERE id=$1',
          [
            f.id,
            status,
            b.action === 'report',
            b.action === 'confirm' ? new Date(clock()).toISOString() : null,
            b.amountMinor,
          ],
        );
        await event(tx, f.id, b.action, hash, 'العميل', b.reference, b.reason, {
          amountMinor: b.amountMinor,
          currency: b.currency,
        });
        await validateCash(tx, id);
        return { id: f.id, status, version: f.version + 1 };
      }),
    );
  });
}
