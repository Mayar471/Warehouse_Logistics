import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import { partnerActions, type PartnerPayment } from '../shared/partner-payments.js';
import type { Transaction } from './db.js';
import { assert, idempotent, transactionGate } from './domain.js';
import { financialActor } from './financial-recovery.js';

const amount = z.number().int().positive().max(1000000000000);
const terms = {
  reference: z.string().trim().min(3).max(100),
  reason: z.string().trim().min(3).max(240),
};
const select = `SELECT p.id,p.shipment_id AS "shipmentId",s.reference,e.beneficiary_name AS "beneficiaryName",e.company_id AS "companyId",e.courier_id AS "courierId",p.amount_minor::double precision AS "amountMinor",p.status,p.version,p.issue_open AS "issueOpen",p.return_requested AS "returnRequested",p.recovery_requested AS "recoveryRequested" FROM partner_payments p JOIN execution_earnings e ON e.shipment_id=p.shipment_id JOIN shipments s ON s.id=p.shipment_id`;
function scope(a: Account) {
  return a.role === 'operator'
    ? { sql: '$1::text IS NULL', params: [null] }
    : a.role === 'company'
      ? { sql: 'e.company_id=$1', params: [a.companyId] }
      : { sql: 'e.courier_id=$1 AND e.company_id IS NULL', params: [a.courierId] };
}
async function balances(tx: Transaction) {
  const b = (
    await tx.query<{
      treasuryMinor: number;
      inTransitMinor: number;
      paidMinor: number;
      reservedMinor: number;
    }>(
      `SELECT COALESCE(SUM(treasury_minor),0)::double precision AS "treasuryMinor",COALESCE(SUM(in_transit_minor),0)::double precision AS "inTransitMinor",COALESCE(SUM(paid_minor),0)::double precision AS "paidMinor",(SELECT COALESCE(SUM(amount_minor),0)::double precision FROM partner_payments WHERE status='reserved') AS "reservedMinor" FROM partner_money_entries`,
    )
  ).rows[0];
  const availableMinor = b.treasuryMinor - b.reservedMinor;
  assert(
    [...Object.values(b), availableMinor].every((n) => Number.isSafeInteger(n) && n >= 0),
    409,
    'PARTNER_LEDGER_INCONSISTENT',
    'تعذر مطابقة رصيد تمويل الأجور',
  );
  const bad = (
    await tx.query(
      `SELECT p.id FROM partner_payments p JOIN execution_earnings e ON e.shipment_id=p.shipment_id LEFT JOIN (SELECT payment_id,SUM(treasury_minor) treasury,SUM(in_transit_minor) transit,SUM(paid_minor) paid FROM partner_money_entries GROUP BY payment_id) l ON l.payment_id=p.id WHERE e.amount_minor IS NULL OR p.amount_minor<>e.amount_minor OR COALESCE(l.transit,0)<>CASE WHEN p.status='released' THEN p.amount_minor ELSE 0 END OR COALESCE(l.paid,0)<>CASE WHEN p.status='received' THEN p.amount_minor ELSE 0 END OR COALESCE(l.treasury,0)<>CASE WHEN p.status IN ('released','received') THEN -p.amount_minor ELSE 0 END LIMIT 1`,
    )
  ).rows;
  assert(!bad.length, 409, 'PARTNER_LEDGER_INCONSISTENT', 'دفتر صرف الأجور لا يطابق حالات الدفعات');
  return { ...b, availableMinor };
}
export function registerPartnerPayments(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (r: FastifyRequest) => Account,
) {
  const access = (req: FastifyRequest) => {
    const a = account(req);
    financialActor(req, a);
    assert(
      ['operator', 'courier', 'company'].includes(a.role),
      403,
      'FORBIDDEN',
      'صرف الأجور للعمليات والمستفيد فقط',
    );
    assert(a.role !== 'company' || !!a.companyId, 403, 'FORBIDDEN', 'يلزم حساب مكتب محدد');
    assert(a.role !== 'courier' || !!a.courierId, 403, 'FORBIDDEN', 'يلزم حساب مندوب محدد');
    return a;
  };
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  async function event(
    tx: Transaction,
    a: Account,
    paymentId: string | null,
    action: string,
    b: unknown & { reference: string; reason: string },
  ) {
    await tx.query(
      'INSERT INTO partner_payment_events(id,payment_id,actor_id,actor_name,action,reference,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), paymentId, a.id, a.name, action, b.reference, b.reason, JSON.stringify(b)],
    );
  }
  async function entry(
    tx: Transaction,
    a: Account,
    id: string | null,
    kind: string,
    reference: string,
    n: number,
  ) {
    const treasury =
      kind === 'release' ? -n : ['funding', 'return', 'recover'].includes(kind) ? n : 0;
    const transit = kind === 'release' ? n : ['confirm', 'return'].includes(kind) ? -n : 0;
    const paid = kind === 'confirm' ? n : kind === 'recover' ? -n : 0;
    await tx.query(
      'INSERT INTO partner_money_entries(id,payment_id,kind,reference,actor_id,treasury_minor,in_transit_minor,paid_minor,capital_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        id,
        kind,
        reference,
        a.id,
        treasury,
        transit,
        paid,
        kind === 'funding' ? -n : 0,
      ],
    );
  }
  app.get('/api/partner-payments', async (req) => {
    const a = access(req),
      s = scope(a);
    return write(async (tx) => {
      const balance = await balances(tx);
      const eligible = (
        await tx.query(
          `SELECT e.shipment_id AS "shipmentId",s.reference,e.beneficiary_name AS "beneficiaryName",e.amount_minor::double precision AS "amountMinor" FROM execution_earnings e JOIN shipments s ON s.id=e.shipment_id WHERE (${s.sql}) AND e.amount_minor>0 AND NOT EXISTS(SELECT 1 FROM partner_payments p WHERE p.shipment_id=e.shipment_id AND p.status IN ('reserved','released','received')) ORDER BY e.earned_at,e.shipment_id LIMIT 100`,
          s.params,
        )
      ).rows;
      const rows = (
        await tx.query(
          select +
            ` WHERE ${s.sql} ORDER BY (p.status IN ('reserved','released') OR p.issue_open OR p.recovery_requested) DESC,p.created_at DESC,p.id LIMIT 100`,
          s.params,
        )
      ).rows;
      const history = (
        await tx.query(
          `SELECT v.id,v.action,v.actor_name AS "actorName",v.reference,v.reason,v.details FROM partner_payment_events v LEFT JOIN partner_payments p ON p.id=v.payment_id LEFT JOIN execution_earnings e ON e.shipment_id=p.shipment_id WHERE ${s.sql} ORDER BY v.created_at DESC,v.id LIMIT 50`,
          s.params,
        )
      ).rows;
      return {
        eligible,
        rows,
        history,
        balance: a.role === 'operator' ? balance : null,
        displayLimit: 100,
      };
    });
  });
  app.post('/api/partner-funding', async (req) => {
    const a = access(req);
    assert(a.role === 'operator', 403, 'FORBIDDEN', 'إقرار التمويل للعمليات فقط');
    const b = z
      .object({ ...terms, amountMinor: amount, currency: z.literal('SYP') })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:partner:funding`, key(req), b, async () => {
        await balances(tx);
        assert(
          !(
            await tx.query(
              "SELECT id FROM partner_money_entries WHERE kind='funding' AND reference=$1",
              [b.reference],
            )
          ).rows.length,
          409,
          'DUPLICATE_FUNDING',
          'سند التمويل مسجل مسبقًا',
        );
        await entry(tx, a, null, 'funding', b.reference, b.amountMinor);
        await event(tx, a, null, 'funding', b);
        return balances(tx);
      }),
    );
  });
  app.post('/api/partner-payments', async (req) => {
    const a = access(req);
    assert(a.role === 'operator', 403, 'FORBIDDEN', 'حجز الأجور للعمليات فقط');
    const b = z
      .object({ ...terms, shipmentId: z.string().uuid() })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:partner:create`, key(req), b, async () => {
        const balance = await balances(tx);
        const e = (
          await tx.query<{ amount: number }>(
            `SELECT amount_minor::double precision amount FROM execution_earnings WHERE shipment_id=$1`,
            [b.shipmentId],
          )
        ).rows[0];
        assert(
          e && Number.isSafeInteger(e.amount) && e.amount > 0 && e.amount <= 1000000000000,
          409,
          'NO_PAYABLE_EARNING',
          'لا يوجد أجر موجب محسوب لهذه الشحنة',
        );
        assert(
          !(
            await tx.query(
              "SELECT id FROM partner_payments WHERE shipment_id=$1 AND status IN ('reserved','released','received')",
              [b.shipmentId],
            )
          ).rows.length,
          409,
          'PAYMENT_EXISTS',
          'هذا الأجر محجوز أو مصروف مسبقًا',
        );
        assert(
          balance.availableMinor >= e.amount,
          409,
          'INSUFFICIENT_PARTNER_FUNDS',
          'موّل صندوق الأجور أولًا؛ أموال العملاء والمتاجر لا تُستخدم للصرف',
        );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO partner_payments(id,shipment_id,amount_minor,status) VALUES($1,$2,$3,'reserved')",
          [id, b.shipmentId, e.amount],
        );
        await event(tx, a, id, 'reserve', b);
        await balances(tx);
        return { id };
      }),
    );
  });
  app.post('/api/partner-payments/:id/actions', async (req) => {
    const a = access(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const b = z
      .object({
        ...terms,
        action: z.enum(
          Object.keys(partnerActions) as [
            keyof typeof partnerActions,
            ...(keyof typeof partnerActions)[],
          ],
        ),
        expectedVersion: z.number().int().positive(),
        amountMinor: z.number().int().min(0).max(1000000000000),
        currency: z.literal('SYP'),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:partner:${id}`, key(req), b, async () => {
        await balances(tx);
        const s = scope(a);
        const p = (
          await tx.query<PartnerPayment>(select + ` WHERE p.id=$2 AND (${s.sql})`, [
            ...s.params,
            id,
          ])
        ).rows[0];
        assert(p, 404, 'NOT_FOUND', 'الدفعة غير موجودة');
        assert(
          p.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت الدفعة؛ حدّث القراءة قبل المتابعة',
        );
        const ops = a.role === 'operator',
          action = b.action;
        assert(
          ['release', 'cancel', 'receive_return', 'receive_recovery'].includes(action) ? ops : !ops,
          403,
          'FORBIDDEN',
          'هذا الإقرار يتطلب الطرف المستقل المختص',
        );
        let status = p.status,
          issue = p.issueOpen,
          returned = p.returnRequested,
          recovery = p.recoveryRequested;
        const exact = () =>
          assert(
            b.amountMinor === p.amountMinor,
            409,
            'AMOUNT_MISMATCH',
            'يلزم إقرار كامل المبلغ؛ الفرق يبقى قيد المتابعة ولا يشطب العهدة',
          );
        if (action === 'release' || action === 'cancel') {
          assert(status === 'reserved', 409, 'INVALID_STATE', 'الدفعة ليست محجوزة');
          exact();
          status = action === 'release' ? 'released' : 'cancelled';
          if (action === 'release') await entry(tx, a, id, 'release', b.reference, p.amountMinor);
        } else if (action === 'confirm') {
          assert(
            status === 'released' && !returned,
            409,
            'INVALID_STATE',
            'الدفعة ليست متاحة للاستلام',
          );
          exact();
          status = 'received';
          issue = false;
          await entry(tx, a, id, 'confirm', b.reference, p.amountMinor);
        } else if (action === 'report_issue') {
          assert(
            status === 'released' && !returned && b.amountMinor !== p.amountMinor,
            409,
            'INVALID_STATE',
            'توثيق الفرق يتطلب دفعة خارجة ومبلغًا مختلفًا',
          );
          issue = true;
        } else if (action === 'request_return') {
          assert(
            status === 'released' && !returned,
            409,
            'INVALID_STATE',
            'لا توجد عهدة متاحة للإعادة',
          );
          exact();
          returned = true;
        } else if (action === 'receive_return') {
          assert(
            status === 'released' && returned,
            409,
            'INVALID_STATE',
            'يلزم إقرار إعادة من المستفيد أولًا',
          );
          exact();
          status = 'returned';
          issue = false;
          returned = false;
          await entry(tx, a, id, 'return', b.reference, p.amountMinor);
        } else if (action === 'request_recovery') {
          assert(
            status === 'received' && !recovery,
            409,
            'INVALID_STATE',
            'لا توجد دفعة مستلمة متاحة للرد',
          );
          exact();
          recovery = true;
        } else {
          assert(
            status === 'received' && recovery,
            409,
            'INVALID_STATE',
            'يلزم إقرار رد من المستفيد أولًا',
          );
          exact();
          status = 'recovered';
          recovery = false;
          issue = false;
          await entry(tx, a, id, 'recover', b.reference, p.amountMinor);
        }
        await tx.query(
          'UPDATE partner_payments SET status=$2,version=version+1,issue_open=$3,return_requested=$4,recovery_requested=$5 WHERE id=$1',
          [id, status, issue, returned, recovery],
        );
        await event(tx, a, id, action, b);
        await balances(tx);
        return { id, status, version: p.version + 1 };
      }),
    );
  });
}
