import { financialActor } from './financial-recovery.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account } from '../shared/contracts.js';
import type { Payout } from '../shared/payouts.js';
import type { Transaction } from './db.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert, idempotent, transactionGate } from './domain.js';
import { journal, validateCash } from './cash-ledger.js';
const select = `SELECT p.id,p.shipment_id AS "shipmentId",s.reference AS "shipmentReference",p.merchant_id AS "merchantId",m.name AS "merchantName",p.amount_minor::double precision AS "amountMinor",p.currency,p.status,p.version,p.issue_open AS "issueOpen",p.return_requested AS "returnRequested",p.returned_at AS "returnedAt",p.recovery_requested AS "recoveryRequested",p.recovered_at AS "recoveredAt",p.created_at AS "createdAt",p.released_at AS "releasedAt",p.received_at AS "receivedAt" FROM cash_payouts p JOIN shipments s ON s.id=p.shipment_id JOIN merchants m ON m.id=p.merchant_id`;
async function event(
  tx: Transaction,
  payoutId: string,
  a: Account,
  action: string,
  reference: string,
  reason: string,
  details: unknown,
) {
  await tx.query(
    'INSERT INTO cash_payout_events(id,payout_id,actor_id,actor_name,action,reference,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), payoutId, a.id, a.name, action, reference, reason, JSON.stringify(details)],
  );
}
export function registerPayouts(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
) {
  const access = (req: FastifyRequest) => {
    const a = account(req);
    financialActor(req, a);
    assert(
      ['operator', 'merchant'].includes(a.role),
      403,
      'FORBIDDEN',
      'صرف المستحقات للعمليات والمتجر المالك فقط',
    );
    assert(
      a.role !== 'merchant' || !!a.merchantId,
      403,
      'FORBIDDEN',
      'يلزم سياق متجر محدد لقراءة المستحقات',
    );
    return a;
  };
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  const terms = {
    reference: z.string().trim().min(3).max(100),
    reason: z.string().trim().min(3).max(240),
  };
  app.get('/api/payouts', async (req) => {
    const a = access(req);
    return write(async (tx) => {
      const owner = a.role === 'operator' ? null : a.merchantId;
      const scope = '($1::text IS NULL OR s.merchant_id=$1)';
      const eligibleSql = `FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id JOIN merchants m ON m.id=s.merchant_id WHERE ${scope} AND o.status='received' AND NOT EXISTS(SELECT 1 FROM customer_refunds f WHERE f.shipment_id=o.shipment_id AND f.status<>'cancelled') AND NOT o.issue_open AND NOT EXISTS(SELECT 1 FROM cash_remittance_returns r WHERE r.shipment_id=o.shipment_id AND r.status IN ('requested','released')) AND NOT EXISTS(SELECT 1 FROM cash_payouts p WHERE p.shipment_id=o.shipment_id AND p.status NOT IN ('cancelled','returned','recovered'))`;
      const available = (
        await tx.query<{ value: number }>(
          `SELECT COALESCE(SUM(o.goods_minor),0)::double precision AS value ${eligibleSql}`,
          [owner],
        )
      ).rows[0].value;
      const eligible = (
        await tx.query(
          `SELECT o.shipment_id AS "shipmentId",s.reference AS "shipmentReference",m.name AS "merchantName",o.goods_minor::double precision AS "amountMinor",o.version AS "collectionVersion" ${eligibleSql} ORDER BY o.received_at,s.id LIMIT 50`,
          [owner],
        )
      ).rows;
      const totals = (
        await tx.query<{
          total: number;
          reservedMinor: number;
          inTransitMinor: number;
          paidMinor: number;
          recoveryPendingMinor: number;
        }>(
          `SELECT COUNT(*)::integer total,COALESCE(SUM(p.amount_minor) FILTER(WHERE p.status='reserved'),0)::double precision AS "reservedMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.status='released'),0)::double precision AS "inTransitMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.status='received'),0)::double precision AS "paidMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.status='received' AND p.recovery_requested),0)::double precision AS "recoveryPendingMinor" FROM cash_payouts p JOIN shipments s ON s.id=p.shipment_id WHERE ${scope}`,
          [owner],
        )
      ).rows[0];
      const ledger = (
        await tx.query<{ released: number; paid: number }>(
          `SELECT -COALESCE(SUM(cp.amount_minor) FILTER(WHERE j.kind IN ('payout_release','payout_return') AND cp.account_code='operations_cash'),0)::double precision AS released,COALESCE(SUM(cp.amount_minor) FILTER(WHERE j.kind IN ('payout_receive','payout_receive_reverse') AND cp.account_code='merchant_payable'),0)::double precision AS paid FROM cash_journals j JOIN cash_postings cp ON cp.journal_id=j.id JOIN shipments s ON s.id=j.shipment_id WHERE ${scope}`,
          [owner],
        )
      ).rows[0];
      assert(
        [available, ...Object.values(totals), ...Object.values(ledger)].every(Number.isSafeInteger),
        409,
        'CASH_RANGE',
        'إجمالي المستحقات خارج حدود هذه الشريحة',
      );
      const rows = (
        await tx.query<Payout>(
          select +
            " WHERE ($1::text IS NULL OR p.merchant_id=$1) ORDER BY (p.status IN ('reserved','released') OR (p.status='received' AND p.recovery_requested)) DESC,p.created_at DESC,p.id LIMIT 50",
          [owner],
        )
      ).rows;
      const history = (
        await tx.query(
          `SELECT e.id,e.payout_id AS "payoutId",e.action,e.actor_name AS "actorName",e.reference,e.reason,e.created_at AS "createdAt",e.details FROM cash_payout_events e JOIN cash_payouts p ON p.id=e.payout_id WHERE ($1::text IS NULL OR p.merchant_id=$1) ORDER BY e.created_at DESC,e.id LIMIT 30`,
          [owner],
        )
      ).rows;
      return {
        availableMinor: available,
        ...totals,
        consistent:
          ledger.released === totals.inTransitMinor + totals.paidMinor &&
          ledger.paid === totals.paidMinor,
        eligible,
        rows,
        history,
      };
    });
  });
  app.post('/api/payouts', async (req) => {
    const a = access(req);
    assert(a.role === 'operator', 403, 'FORBIDDEN', 'حجز الصرف للعمليات فقط');
    const b = z
      .object({
        ...terms,
        shipmentId: z.string().uuid(),
        expectedCollectionVersion: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:payout:create`, key(req), b, async () => {
        const o = (
          await tx.query<{
            merchant_id: string;
            goods: number;
            status: string;
            version: number;
            issue_open: boolean;
            currency: string;
          }>(
            'SELECT s.merchant_id,o.goods_minor::double precision AS goods,o.status,o.version,o.issue_open,o.currency FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id WHERE o.shipment_id=$1',
            [b.shipmentId],
          )
        ).rows[0];
        assert(o, 404, 'NOT_FOUND', 'التحصيل غير موجود');
        assert(
          o.version === b.expectedCollectionVersion,
          409,
          'VERSION_CONFLICT',
          'تغير التحصيل؛ راجع المستحقات',
        );
        assert(
          o.status === 'received' && !o.issue_open,
          409,
          'PAYOUT_NOT_FUNDED',
          'الصرف من نقد استلمته العمليات كاملًا دون فرق مفتوح فقط',
        );
        await validateCash(tx, b.shipmentId);
        assert(
          !(
            await tx.query(
              "SELECT id FROM customer_refunds WHERE shipment_id=$1 AND status<>'cancelled'",
              [b.shipmentId],
            )
          ).rows.length,
          409,
          'REFUND_BLOCKS_PAYOUT',
          'يوجد رد عميل معتمد؛ لا يمكن صرف مستحق الطلب للمتجر',
        );
        assert(
          !(
            await tx.query(
              "SELECT id FROM cash_remittance_returns WHERE shipment_id=$1 AND status IN ('requested','released')",
              [b.shipmentId],
            )
          ).rows.length,
          409,
          'REMITTANCE_RETURN_PENDING',
          'الحوالة قيد الرجوع إلى محصلها؛ لا يمكن حجز صرف منها',
        );
        assert(
          !(
            await tx.query(
              "SELECT id FROM cash_payouts WHERE shipment_id=$1 AND status NOT IN ('cancelled','returned','recovered')",
              [b.shipmentId],
            )
          ).rows.length,
          409,
          'PAYOUT_EXISTS',
          'المستحق محجوز أو خرج للصرف أو صُرف مسبقًا',
        );
        const id = randomUUID();
        await tx.query(
          'INSERT INTO cash_payouts(id,shipment_id,merchant_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',
          [id, b.shipmentId, o.merchant_id, o.goods, o.currency],
        );
        await event(tx, id, a, 'reserved', b.reference, b.reason, {
          amountMinor: o.goods,
          currency: o.currency,
        });
        return { id, version: 1, status: 'reserved' };
      }),
    );
  });
  app.post('/api/payouts/:id/actions', async (req) => {
    const a = access(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const common = { ...terms, expectedVersion: z.number().int().positive() };
    const b = z
      .discriminatedUnion('action', [
        z.object({ ...common, action: z.literal('cancel') }).strict(),
        z
          .object({
            ...common,
            action: z.enum([
              'release',
              'confirm',
              'report_issue',
              'request_return',
              'receive_return',
              'request_recovery',
              'receive_recovery',
            ]),
            amountMinor: z.number().int().min(0).max(1000000000000),
            currency: z.literal('SYP'),
          })
          .strict(),
      ])
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:payout:${id}`, key(req), b, async () => {
        const p = (await tx.query<Payout>(select + ' WHERE p.id=$1', [id])).rows[0];
        assert(
          p && (a.role === 'operator' || a.merchantId === p.merchantId),
          404,
          'NOT_FOUND',
          'طلب الصرف غير موجود',
        );
        assert(
          p.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير طلب الصرف؛ حدّثه وراجع الإقرار',
        );
        await validateCash(tx, p.shipmentId);
        let status = p.status,
          issue = p.issueOpen;
        if (b.action === 'request_recovery' || b.action === 'receive_recovery') {
          assert(
            p.status === 'received',
            409,
            'INVALID_STATE',
            'استرداد الدفعة بعد إقرار المتجر باستلامها فقط',
          );
          assert(
            b.currency === p.currency && b.amountMinor === p.amountMinor,
            422,
            'PAYOUT_AMOUNT_MISMATCH',
            'يلزم إرجاع كامل الدفعة والعملة نفسها',
          );
          if (b.action === 'request_recovery') {
            assert(
              a.role === 'merchant' && a.merchantId === p.merchantId,
              403,
              'FORBIDDEN',
              'إقرار رد الدفعة للمتجر المالك فقط',
            );
            assert(
              !p.recoveryRequested,
              409,
              'RECOVERY_PENDING',
              'رد الدفعة موثق وينتظر وصول النقد إلى العمليات',
            );
            await tx.query('UPDATE cash_payouts SET recovery_requested=true WHERE id=$1', [id]);
          } else {
            assert(a.role === 'operator', 403, 'FORBIDDEN', 'استلام الدفعة المرتجعة للعمليات فقط');
            assert(
              p.recoveryRequested,
              409,
              'RECOVERY_NOT_REQUESTED',
              'يلزم إقرار المتجر برد الدفعة أولًا',
            );
            const originals = (
              await tx.query<{ id: string; kind: string }>(
                "SELECT id,kind FROM cash_journals WHERE payout_id=$1 AND kind IN ('payout_release','payout_receive')",
                [id],
              )
            ).rows;
            const receive = originals.find((j) => j.kind === 'payout_receive'),
              release = originals.find((j) => j.kind === 'payout_release');
            assert(receive && release, 409, 'CASH_INCONSISTENT', 'قيود الدفعة الأصلية غير مكتملة');
            await journal(
              tx,
              p.shipmentId,
              'payout_receive_reverse',
              p.currency,
              p.amountMinor,
              [
                { account: 'merchant_payable', amount: -p.amountMinor },
                { account: 'payout_in_transit', amount: p.amountMinor },
              ],
              p.id,
              receive.id,
            );
            await journal(
              tx,
              p.shipmentId,
              'payout_return',
              p.currency,
              p.amountMinor,
              [
                { account: 'operations_cash', amount: p.amountMinor },
                { account: 'payout_in_transit', amount: -p.amountMinor },
              ],
              p.id,
              release.id,
            );
            status = 'recovered';
            issue = false;
          }
        } else if (b.action === 'request_return' || b.action === 'receive_return') {
          assert(
            b.currency === p.currency && b.amountMinor === p.amountMinor,
            422,
            'PAYOUT_AMOUNT_MISMATCH',
            'الإرجاع يتطلب كامل المبلغ والعملة نفسها',
          );
          assert(
            p.status === 'released',
            409,
            'INVALID_STATE',
            'الإرجاع لعهدة خرجت ولم يؤكد المتجر استلامها',
          );
          if (b.action === 'request_return') {
            assert(
              a.role === 'merchant' && a.merchantId === p.merchantId,
              403,
              'FORBIDDEN',
              'إقرار إرجاع النقد للمتجر المالك',
            );
            assert(
              !p.returnRequested,
              409,
              'RETURN_PENDING',
              'إرجاع النقد موثق؛ ينتظر استلام العمليات',
            );
            await tx.query('UPDATE cash_payouts SET return_requested=true WHERE id=$1', [id]);
          } else {
            assert(a.role === 'operator', 403, 'FORBIDDEN', 'استلام النقد المرتجع للعمليات فقط');
            assert(
              p.returnRequested,
              409,
              'RETURN_NOT_REQUESTED',
              'يلزم إقرار المتجر بإرجاع النقد أولًا',
            );
            const original = (
              await tx.query<{ id: string }>(
                "SELECT id FROM cash_journals WHERE payout_id=$1 AND kind='payout_release'",
                [id],
              )
            ).rows[0];
            assert(original, 409, 'CASH_INCONSISTENT', 'قيد الخروج الأصلي غير موجود');
            await journal(
              tx,
              p.shipmentId,
              'payout_return',
              p.currency,
              p.amountMinor,
              [
                { account: 'operations_cash', amount: p.amountMinor },
                { account: 'payout_in_transit', amount: -p.amountMinor },
              ],
              p.id,
              original.id,
            );
            status = 'returned';
            issue = false;
          }
        } else if (b.action === 'cancel') {
          assert(a.role === 'operator', 403, 'FORBIDDEN', 'إلغاء حجز الصرف للعمليات');
          assert(
            p.status === 'reserved',
            409,
            'PAYOUT_CUSTODY',
            'خرجت الأموال؛ لا يمكن إلغاء عهدتها',
          );
          status = 'cancelled';
        } else {
          assert(
            !p.returnRequested,
            409,
            'RETURN_PENDING',
            'النقد قيد الإرجاع؛ ينتظر استلام العمليات',
          );
          assert(b.currency === p.currency, 422, 'CURRENCY_MISMATCH', 'عملة الصرف مختلفة');
          if (b.action === 'report_issue') {
            assert(p.status === 'released', 409, 'INVALID_STATE', 'التعثر بعد خروج عهدة الصرف');
            assert(
              b.amountMinor !== p.amountMinor,
              422,
              'NO_CASH_DIFFERENCE',
              'المبلغ مطابق؛ أكد الاستلام إذا استلمته كاملًا',
            );
            issue = true;
          } else {
            assert(
              b.amountMinor === p.amountMinor,
              422,
              'PAYOUT_AMOUNT_MISMATCH',
              'يلزم إقرار كامل المبلغ؛ سجل الفرق دون إغلاق المستحقات',
            );
            if (b.action === 'release') {
              assert(a.role === 'operator', 403, 'FORBIDDEN', 'إقرار خروج النقد للعمليات فقط');
              assert(p.status === 'reserved', 409, 'INVALID_STATE', 'طلب الصرف لا ينتظر الخروج');
              await journal(
                tx,
                p.shipmentId,
                'payout_release',
                p.currency,
                p.amountMinor,
                [
                  { account: 'payout_in_transit', amount: p.amountMinor },
                  { account: 'operations_cash', amount: -p.amountMinor },
                ],
                p.id,
              );
              status = 'released';
            } else {
              assert(
                a.role === 'merchant' && a.merchantId === p.merchantId,
                403,
                'FORBIDDEN',
                'إقرار الاستلام للمتجر المالك وحده',
              );
              assert(
                p.status === 'released',
                409,
                'INVALID_STATE',
                'يلزم خروج النقد من العمليات أولًا',
              );
              await journal(
                tx,
                p.shipmentId,
                'payout_receive',
                p.currency,
                p.amountMinor,
                [
                  { account: 'merchant_payable', amount: p.amountMinor },
                  { account: 'payout_in_transit', amount: -p.amountMinor },
                ],
                p.id,
              );
              status = 'received';
              issue = false;
            }
          }
        }
        await tx.query(
          "UPDATE cash_payouts SET status=$2,issue_open=$3,version=version+1,recovered_at=CASE WHEN $2='recovered' THEN $4 ELSE recovered_at END,returned_at=CASE WHEN $2='returned' THEN $4 ELSE returned_at END,released_at=CASE WHEN $2='released' AND released_at IS NULL THEN $4 ELSE released_at END,received_at=CASE WHEN $2='received' AND received_at IS NULL THEN $4 ELSE received_at END WHERE id=$1",
          [id, status, issue, new Date(clock()).toISOString()],
        );
        await event(tx, id, a, b.action, b.reference, b.reason, b);
        return { id, status, version: p.version + 1 };
      }),
    );
  });
}
