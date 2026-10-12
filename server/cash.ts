import { financialActor } from './financial-recovery.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from './db.js';
import type { Account } from '../shared/contracts.js';
import type { CashRow } from '../shared/cash.js';
import { z } from 'zod';
import { assert, idempotent, transactionGate } from './domain.js';
import { cashEvent, journal, validateCash } from './cash-ledger.js';
const select = `SELECT s.status AS "shipmentStatus",o.shipment_id AS "shipmentId",s.reference AS "shipmentReference",m.name AS "merchantName",o.goods_minor::double precision AS "goodsMinor",o.fee_minor::double precision AS "feeMinor",o.total_minor::double precision AS "totalMinor",o.currency,o.status,o.version,o.remittance_count AS "remittanceCount",(SELECT json_build_object('id',r.id,'status',r.status,'issueOpen',r.issue_open,'lastReportedMinor',r.last_reported_minor::double precision) FROM cash_remittance_returns r WHERE r.shipment_id=o.shipment_id AND r.status IN ('requested','released') LIMIT 1) AS "remittanceReturn",o.issue_open AS "issueOpen",o.collector_name AS "collectorName",o.collected_at AS "collectedAt",o.received_at AS "receivedAt" FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id JOIN merchants m ON m.id=s.merchant_id`;
const scope = `($1='operator' OR ($1='merchant' AND s.merchant_id=$2) OR (o.collector_id=$3 AND $1 IN ('courier','pickup')) OR (o.status='pending' AND (($1='courier' AND s.courier_id=$4 AND s.pickup_site_id IS NULL) OR ($1='pickup' AND s.pickup_site_id=$5))))`;
export function registerCash(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
) {
  app.get('/api/cash', async (req) => {
    const a = account(req);
    return write(async (tx) => {
      const params = [a.role, a.merchantId, a.id, a.courierId, a.pickupSiteId];
      const totals = (
        await tx.query<{
          refundedMinor: number;
          refundInTransitMinor: number;
          total: number;
          returnIssueCount: number;
          pendingMinor: number;
          heldMinor: number;
          receivedMinor: number;
          goodsLiabilityMinor: number;
          deliveryClearingMinor: number;
        }>(
          `SELECT COUNT(*)::integer total,COALESCE(SUM((SELECT COUNT(*) FROM cash_remittance_returns r WHERE r.shipment_id=o.shipment_id AND r.issue_open)),0)::integer AS "returnIssueCount",COALESCE(SUM(o.total_minor) FILTER(WHERE o.status='pending' AND s.status NOT IN ('cancelled','returned','returning')),0)::double precision AS "pendingMinor",COALESCE(SUM(o.total_minor) FILTER(WHERE o.status='collected'),0)::double precision AS "heldMinor",COALESCE(SUM(o.total_minor) FILTER(WHERE o.status='received'),0)::double precision AS "receivedMinor",(COALESCE(SUM(o.goods_minor) FILTER(WHERE o.status IN ('collected','received')),0)-COALESCE(SUM((SELECT COALESCE(SUM(p.amount_minor),0) FROM cash_payouts p WHERE p.shipment_id=o.shipment_id AND p.status='received')),0)-COALESCE(SUM((SELECT COALESCE(SUM(f.amount_minor),0) FROM customer_refunds f WHERE f.shipment_id=o.shipment_id AND f.status='confirmed')),0))::double precision AS "goodsLiabilityMinor",COALESCE(SUM((SELECT COALESCE(SUM(f.amount_minor),0) FROM customer_refunds f WHERE f.shipment_id=o.shipment_id AND f.status='confirmed')),0)::double precision AS "refundedMinor",COALESCE(SUM((SELECT COALESCE(SUM(f.amount_minor),0) FROM customer_refunds f WHERE f.shipment_id=o.shipment_id AND f.status='released')),0)::double precision AS "refundInTransitMinor",COALESCE(SUM(o.fee_minor) FILTER(WHERE o.status IN ('collected','received')),0)::double precision AS "deliveryClearingMinor" FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id WHERE ${scope}`,
          params,
        )
      ).rows[0];
      assert(
        Object.values(totals).every(Number.isSafeInteger),
        409,
        'CASH_RANGE',
        'إجمالي الأموال تجاوز حدود هذه الشريحة',
      );
      const ledger = (
        await tx.query<{
          ledgerRefundInTransitMinor: number;
          netRemittedMinor: number;
          remittanceReturnTransitMinor: number;
          operationsBalanceMinor: number;
          payoutInTransitMinor: number;
          heldMinor: number;
          receivedMinor: number;
          goodsLiabilityMinor: number;
          deliveryClearingMinor: number;
        }>(
          `SELECT COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code LIKE 'holder:%'),0)::double precision AS "heldMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='operations_cash' AND j.kind='remittance'),0)::double precision AS "receivedMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='operations_cash' AND j.kind IN ('remittance','remittance_reverse')),0)::double precision AS "netRemittedMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='remittance_return_transit'),0)::double precision AS "remittanceReturnTransitMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='operations_cash'),0)::double precision AS "operationsBalanceMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='customer_refund_transit'),0)::double precision AS "ledgerRefundInTransitMinor",COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='payout_in_transit'),0)::double precision AS "payoutInTransitMinor",-COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='merchant_payable'),0)::double precision AS "goodsLiabilityMinor",-COALESCE(SUM(p.amount_minor) FILTER(WHERE p.account_code='delivery_clearing'),0)::double precision AS "deliveryClearingMinor" FROM cash_postings p JOIN cash_journals j ON j.id=p.journal_id JOIN cash_obligations o ON o.shipment_id=j.shipment_id JOIN shipments s ON s.id=o.shipment_id WHERE ${scope}`,
          params,
        )
      ).rows[0];
      assert(
        Object.values(ledger).every(Number.isSafeInteger),
        409,
        'CASH_RANGE',
        'إجمالي القيود خارج حدود الشريحة',
      );
      const consistent =
        totals.refundInTransitMinor === ledger.ledgerRefundInTransitMinor &&
        (
          ['heldMinor', 'receivedMinor', 'goodsLiabilityMinor', 'deliveryClearingMinor'] as const
        ).every(
          (key) => totals[key] === ledger[key === 'receivedMinor' ? 'netRemittedMinor' : key],
        );
      const rows = (
        await tx.query<CashRow>(
          select +
            ` WHERE ${scope} ORDER BY EXISTS(SELECT 1 FROM cash_remittance_returns r WHERE r.shipment_id=o.shipment_id AND r.issue_open) DESC,(o.status='collected' OR EXISTS(SELECT 1 FROM cash_remittance_returns r WHERE r.shipment_id=o.shipment_id AND r.status IN ('requested','released'))) DESC,o.issue_open DESC,o.collected_at DESC NULLS LAST,s.created_at DESC,o.shipment_id LIMIT 50`,
          params,
        )
      ).rows;
      const history = (
        await tx.query(
          `SELECT e.id,s.reference AS "shipmentReference",e.action,e.actor_name AS "actorName",e.reference,e.reason,e.details,e.created_at AS "createdAt" FROM cash_events e JOIN cash_obligations o ON o.shipment_id=e.shipment_id JOIN shipments s ON s.id=o.shipment_id WHERE ${scope} ORDER BY e.created_at DESC,e.id LIMIT 30`,
          params,
        )
      ).rows;
      return { ...totals, ...ledger, consistent, rows, history };
    });
  });
  app.post('/api/cash/:id/actions', async (req) => {
    const a = account(req);
    financialActor(req, a);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const body = z
      .object({
        action: z.enum([
          'receive',
          'report_difference',
          'return_request',
          'return_release',
          'return_confirm',
          'return_cancel',
          'return_difference',
        ]),
        expectedVersion: z.number().int().positive(),
        amountMinor: z.number().int().min(0).max(1000000000000),
        currency: z.literal('SYP'),
        reference: z.string().trim().min(3).max(100),
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    assert(
      body.action === 'return_confirm'
        ? ['courier', 'pickup'].includes(a.role)
        : body.action === 'return_difference'
          ? ['operator', 'courier', 'pickup'].includes(a.role)
          : a.role === 'operator',
      403,
      'FORBIDDEN',
      'العمليات تدير رجوع الحوالة؛ إقرار وصولها للمحصل الأصلي وحده',
    );
    const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `${a.id}:cash:${id}`, key, body, async () => {
        const r = (
          await tx.query<CashRow & { collector_id: string }>(
            select.replace('SELECT s.status', 'SELECT o.collector_id,s.status') +
              ' WHERE o.shipment_id=$1',
            [id],
          )
        ).rows[0];
        assert(
          r &&
            (!(
              body.action === 'return_confirm' ||
              (body.action === 'return_difference' && a.role !== 'operator')
            ) ||
              r.collector_id === a.id),
          404,
          'NOT_FOUND',
          'التحصيل غير موجود',
        );
        if (body.action.startsWith('return_')) {
          return returnRemittance(tx, r, a, body, clock());
        }
        assert(
          r.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت العهدة المالية؛ حدّثها وراجع الإجراء',
        );
        assert(
          r.status === 'collected',
          409,
          'INVALID_STATE',
          'يلزم تحصيل مؤكد قبل إقرار استلام الأموال',
        );
        await validateCash(tx, id);
        assert(
          body.currency === r.currency,
          422,
          'CURRENCY_MISMATCH',
          'العملة تختلف عن عهدة التحصيل',
        );
        if (body.action === 'receive') {
          assert(
            body.amountMinor === r.totalMinor,
            422,
            'REMITTANCE_MISMATCH',
            'المبلغ الفعلي لا يطابق كامل العهدة. سجل الفرق بدل إغلاقها تلقائيًا',
          );
          await journal(
            tx,
            id,
            'remittance',
            r.currency,
            r.totalMinor,
            [
              { account: 'operations_cash', amount: r.totalMinor },
              { account: 'holder:' + r.collector_id, amount: -r.totalMinor },
            ],
            null,
            null,
            null,
            r.remittanceCount + 1,
          );
          await tx.query(
            "UPDATE cash_obligations SET status='received',remittance_count=remittance_count+1,received_at=$2,issue_open=false,version=version+1 WHERE shipment_id=$1",
            [id, new Date(clock()).toISOString()],
          );
        } else {
          assert(
            body.amountMinor !== r.totalMinor,
            422,
            'NO_CASH_DIFFERENCE',
            'لا يوجد فرق في المبلغ المذكور',
          );
          await tx.query(
            'UPDATE cash_obligations SET issue_open=true,version=version+1 WHERE shipment_id=$1',
            [id],
          );
        }
        await cashEvent(tx, id, a, body.action, body.reference, body.reason, {
          actualMinor: body.amountMinor,
          expectedMinor: r.totalMinor,
          currency: r.currency,
          differenceMinor: body.amountMinor - r.totalMinor,
        });
        return {
          shipmentId: id,
          version: r.version + 1,
          status: body.action === 'receive' ? 'received' : 'collected',
        };
      }),
    );
  });
}

async function returnRemittance(
  tx: Transaction,
  r: CashRow & { collector_id: string },
  a: Account,
  b: {
    action: string;
    expectedVersion: number;
    amountMinor: number;
    currency: string;
    reference: string;
    reason: string;
  },
  now: number,
) {
  assert(
    r.version === b.expectedVersion,
    409,
    'VERSION_CONFLICT',
    'تغيرت العهدة؛ حدّثها وراجع الإقرار',
  );
  assert(r.status === 'received', 409, 'INVALID_STATE', 'رجوع الحوالة بعد استلام العمليات فقط');
  assert(
    (b.action === 'return_difference' || b.amountMinor === r.totalMinor) &&
      b.currency === r.currency,
    422,
    'REMITTANCE_MISMATCH',
    'رجوع الحوالة يتطلب كامل المبلغ والعملة نفسها',
  );
  await validateCash(tx, r.shipmentId);
  assert(
    !(
      await tx.query(
        "SELECT id FROM cash_payouts WHERE shipment_id=$1 AND status NOT IN ('cancelled','returned','recovered')",
        [r.shipmentId],
      )
    ).rows.length,
    409,
    'PAYOUT_BLOCKS_RETURN',
    'المبلغ مرتبط بصرف متجر؛ أنهِ الحجز أو أعد نقد الصرف أولًا',
  );
  assert(
    !(
      await tx.query(
        "SELECT id FROM customer_refunds WHERE shipment_id=$1 AND status<>'cancelled'",
        [r.shipmentId],
      )
    ).rows.length,
    409,
    'REFUND_BLOCKS_RETURN',
    'يوجد رد عميل معتمد؛ لا يمكن إرجاع حوالة تمويله',
  );
  let c = (
    await tx.query<{
      id: string;
      status: string;
      original_journal_id: string;
      collector_id: string;
      issue_open: boolean;
      last_reported_minor: number | null;
    }>(
      "SELECT id,status,original_journal_id,collector_id,issue_open,last_reported_minor::double precision FROM cash_remittance_returns WHERE shipment_id=$1 AND status IN ('requested','released')",
      [r.shipmentId],
    )
  ).rows[0];
  if (b.action === 'return_request') {
    assert(!c, 409, 'RETURN_PENDING', 'رجوع حوالة مفتوح مسبقًا');
    const original = (
      await tx.query<{ id: string }>(
        "SELECT id FROM cash_journals WHERE shipment_id=$1 AND kind='remittance' AND remittance_round=$2",
        [r.shipmentId, r.remittanceCount],
      )
    ).rows[0];
    assert(original, 409, 'CASH_INCONSISTENT', 'الحوالة الأصلية غير موجودة');
    c = {
      id: randomUUID(),
      status: 'requested',
      original_journal_id: original.id,
      collector_id: r.collector_id,
      issue_open: false,
      last_reported_minor: null,
    };
    await tx.query(
      'INSERT INTO cash_remittance_returns(id,shipment_id,original_journal_id,collector_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6)',
      [c.id, r.shipmentId, original.id, r.collector_id, r.totalMinor, r.currency],
    );
  } else {
    assert(c, 409, 'RETURN_NOT_REQUESTED', 'يلزم طلب رجوع الحوالة أولًا');
    if (b.action === 'return_difference') {
      assert(
        c.status === 'released',
        409,
        'INVALID_STATE',
        'توثيق فرق الرجوع بعد خروج النقد إلى المحصل فقط',
      );
      assert(
        b.amountMinor !== r.totalMinor,
        422,
        'NO_CASH_DIFFERENCE',
        'المبلغ مطابق؛ يؤكد المحصل استلامه كاملًا عند وصوله',
      );
      await tx.query(
        'UPDATE cash_remittance_returns SET issue_open=true,last_reported_minor=$2 WHERE id=$1',
        [c.id, b.amountMinor],
      );
    } else if (b.action === 'return_cancel') {
      assert(c.status === 'requested', 409, 'RETURN_CUSTODY', 'خرج النقد؛ لا يمكن إلغاء عهدته');
      await tx.query("UPDATE cash_remittance_returns SET status='cancelled' WHERE id=$1", [c.id]);
    } else if (b.action === 'return_release') {
      assert(c.status === 'requested', 409, 'INVALID_STATE', 'النقد المرتجع لا ينتظر الخروج');
      await journal(
        tx,
        r.shipmentId,
        'remittance_return_release',
        r.currency,
        r.totalMinor,
        [
          { account: 'remittance_return_transit', amount: r.totalMinor },
          { account: 'operations_cash', amount: -r.totalMinor },
        ],
        null,
        null,
        c.id,
      );
      await tx.query(
        "UPDATE cash_remittance_returns SET status='released',released_at=$2 WHERE id=$1",
        [c.id, new Date(now).toISOString()],
      );
    } else {
      assert(
        c.status === 'released' && c.collector_id === a.id,
        409,
        'INVALID_STATE',
        'يلزم خروج كامل النقد إلى المحصل الأصلي أولًا',
      );
      const release = (
        await tx.query<{ id: string }>(
          "SELECT id FROM cash_journals WHERE remittance_return_id=$1 AND kind='remittance_return_release'",
          [c.id],
        )
      ).rows[0];
      assert(release, 409, 'CASH_INCONSISTENT', 'قيد رجوع النقد غير موجود');
      await journal(
        tx,
        r.shipmentId,
        'remittance_reverse',
        r.currency,
        r.totalMinor,
        [
          { account: 'holder:' + r.collector_id, amount: r.totalMinor },
          { account: 'operations_cash', amount: -r.totalMinor },
        ],
        null,
        c.original_journal_id,
        c.id,
      );
      await journal(
        tx,
        r.shipmentId,
        'remittance_return_restore',
        r.currency,
        r.totalMinor,
        [
          { account: 'operations_cash', amount: r.totalMinor },
          { account: 'remittance_return_transit', amount: -r.totalMinor },
        ],
        null,
        release.id,
        c.id,
      );
      await tx.query(
        "UPDATE cash_remittance_returns SET status='confirmed',issue_open=false,confirmed_at=$2 WHERE id=$1",
        [c.id, new Date(now).toISOString()],
      );
    }
  }
  const confirmed = b.action === 'return_confirm';
  await tx.query(
    "UPDATE cash_obligations SET status=CASE WHEN $2 THEN 'collected' ELSE status END,received_at=CASE WHEN $2 THEN NULL ELSE received_at END,version=version+1 WHERE shipment_id=$1",
    [r.shipmentId, confirmed],
  );
  await cashEvent(tx, r.shipmentId, a, b.action, b.reference, b.reason, {
    returnId: c.id,
    originalJournalId: c.original_journal_id,
    actualMinor: b.amountMinor,
    expectedMinor: r.totalMinor,
    differenceMinor: b.amountMinor - r.totalMinor,
    ...(confirmed && c.issue_open
      ? { resolvedDifferenceMinor: (c.last_reported_minor ?? r.totalMinor) - r.totalMinor }
      : {}),
    currency: r.currency,
  });
  return {
    shipmentId: r.shipmentId,
    version: r.version + 1,
    status: confirmed ? 'collected' : 'received',
  };
}
