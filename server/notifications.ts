import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account } from '../shared/contracts.js';
import type { UserNotification } from '../shared/notifications.js';
import { statusLabels } from '../shared/contracts.js';
import { z } from 'zod';
import { assert, transactionGate } from './domain.js';
import { disputeNotifications } from './disputes.js';

export function registerNotifications(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  identity: (req: FastifyRequest) => Account | string,
  prefix = '/api/notifications',
  clock: () => number = Date.now,
) {
  async function feed(req: FastifyRequest) {
    const user = identity(req),
      customer = typeof user === 'string';
    const audience = customer ? `customer:${user}` : `account:${user.id}`;
    const role = customer ? 'customer' : user.role;
    const scope = customer
      ? 'EXISTS(SELECT 1 FROM storefront_checkouts c WHERE c.shipment_id=s.id AND c.owner_hash=$1)'
      : role === 'merchant'
        ? 's.merchant_id=$1'
        : role === 'courier'
          ? 's.courier_id=$1'
          : role === 'pickup'
            ? 's.pickup_site_id=$1'
            : 'true';
    const value = customer
      ? user
      : role === 'merchant'
        ? user.merchantId
        : role === 'courier'
          ? user.courierId
          : role === 'pickup'
            ? user.pickupSiteId
            : null;
    return write(async (tx) => {
      type Row = {
        kind: Exclude<UserNotification['kind'], 'dispute'>;
        id: string;
        reference: string;
        status: string;
        version: number;
        at: string;
        issue: boolean;
        reply: string | null;
      };
      // Every source is independently scoped: courier return assignments need not match the original courier.
      const shipmentScope = scope === 'true' ? '($1::text IS NULL)' : scope;
      const returnScope = customer
        ? scope
        : role === 'merchant'
          ? 'r.merchant_id=$1'
          : role === 'courier'
            ? 'r.courier_id=$1'
            : role === 'operator'
              ? '($1::text IS NULL)'
              : 'false AND ($1::text IS NULL OR true)';
      const transferScope =
        role === 'merchant'
          ? 't.merchant_id=$1'
          : role === 'courier'
            ? 't.courier_id=$1'
            : role === 'operator'
              ? '($1::text IS NULL)'
              : 'false AND ($1::text IS NULL OR true)';
      const payoutScope =
        role === 'merchant'
          ? 'p.merchant_id=$1'
          : role === 'operator'
            ? '($1::text IS NULL)'
            : 'false AND ($1::text IS NULL OR true)';
      const cashScope =
        role === 'operator'
          ? '($2::text IS NULL)'
          : role === 'courier' || role === 'pickup'
            ? 'o.collector_id=$2'
            : 'false AND ($2::text IS NULL OR true)';
      const rows =
        role === 'company'
          ? []
          : (
              await tx.query<Row>(
                `SELECT * FROM (
        SELECT 'shipment'::text kind,s.id,s.reference,s.status,s.version,s.updated_at at,(s.pickup_overdue OR s.status IN ('failed','pickup_expired')) issue,CASE WHEN s.assignment_accepted THEN 'accepted' ELSE NULL END reply FROM shipments s WHERE ${shipmentScope}
        UNION ALL SELECT 'return',r.id,s.reference,r.status,r.version,COALESCE((SELECT MAX(e.created_at) FROM commercial_return_events e WHERE e.return_id=r.id),r.created_at),r.issue_open,r.inspection_reply FROM commercial_returns r JOIN shipments s ON s.id=r.shipment_id WHERE ${returnScope}
        UNION ALL SELECT 'refund',f.id,s.reference,f.status,f.version,COALESCE((SELECT MAX(e.created_at) FROM customer_refund_events e WHERE e.refund_id=f.id),f.created_at),f.issue_open,NULL FROM customer_refunds f JOIN shipments s ON s.id=f.shipment_id WHERE ${shipmentScope}
        UNION ALL SELECT 'transfer',t.id,'نقل بين المواقع',t.status,t.version,t.updated_at,t.issue_open,NULL FROM inventory_transfers t WHERE ${transferScope}
        UNION ALL SELECT 'payout',p.id,s.reference,p.status,p.version,COALESCE((SELECT MAX(e.created_at) FROM cash_payout_events e WHERE e.payout_id=p.id),p.created_at),p.issue_open,NULL FROM cash_payouts p JOIN shipments s ON s.id=p.shipment_id WHERE ${payoutScope}
        UNION ALL SELECT 'cash',s.id,s.reference,o.status,o.version,COALESCE(o.received_at,o.collected_at,s.created_at),o.issue_open,NULL FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id WHERE ${cashScope} AND o.status='collected'
      ) n WHERE at > now()-interval '30 days' OR status NOT IN ('delivered','returned','cancelled','rejected','confirmed','received','recovered') OR (kind='return' AND status='received' AND reply IS NULL) ORDER BY issue DESC,(status IN ('delivered','returned','cancelled','rejected','confirmed','received','recovered') AND NOT(kind='return' AND status='received' AND reply IS NULL)),at DESC,kind,id LIMIT 100`,
                [value ?? null, customer ? null : user.id],
              )
            ).rows;
      const seen = new Set(
        (
          await tx.query<{ notification_id: string }>(
            'SELECT notification_id FROM notification_reads WHERE audience=$1',
            [audience],
          )
        ).rows.map((r) => r.notification_id),
      );
      const items: UserNotification[] = rows.map((r) => {
        let title = '',
          required = r.issue;
        const names: Record<string, string> = {
          requested: 'بانتظار المراجعة',
          approved: 'بانتظار إسناد المندوب',
          assigned: 'مهمة جديدة بانتظار القبول',
          accepted: 'مهمة مقبولة بانتظار الاستلام',
          released: 'تم التسليم — بانتظار تأكيد المستلم',
          in_transit: 'في الطريق',
          received: 'تم تأكيد الاستلام',
          reserved: 'بانتظار التسليم',
          cancelled: 'أُلغي الطلب',
          rejected: 'رُفض طلب الإرجاع',
          confirmed: 'تم تأكيد رد الأموال',
          resolved: 'أُغلقت العهدة بتسوية موثقة',
          recovered: 'استُردت الدفعة',
          returned: 'تم تأكيد الرجوع',
        };
        if (r.kind === 'shipment') {
          title = statusLabels[r.status as keyof typeof statusLabels] ?? r.status;
          if (role === 'operator' && r.status === 'ready') {
            title = 'طلب جديد يحتاج إسنادًا';
            required = true;
          }
          if (role === 'courier' && r.status === 'assigned') {
            title =
              r.reply === 'accepted'
                ? 'مهمة مقبولة: أكّد استلام الطرد من المنشأ'
                : 'مهمة توصيل جديدة بانتظار قبولك';
            required = true;
          }
          if (role === 'merchant' && r.status === 'ready') {
            title = 'طلب يحتاج تجهيزًا وتسليمًا';
            required = true;
          }
          if (
            role === 'pickup' &&
            ['awaiting_handover', 'ready_for_pickup', 'pickup_expired'].includes(r.status)
          ) {
            title = 'طرد في نقطة الاستلام: ' + title;
            required = true;
          }
        } else {
          const labels = {
            return: 'مرتجع العميل',
            refund: 'رد الأموال',
            transfer: 'نقل المخزون',
            payout: 'مستحقات المتجر',
            cash: 'عهدة النقد',
          };
          title = labels[r.kind] + ': ' + (names[r.status] ?? r.status);
          if (r.kind === 'return' && r.reply) title = 'وصل رد المتجر بعد الفحص';
          required ||=
            (r.kind === 'return' &&
              ((role === 'merchant' && ['requested', 'received'].includes(r.status) && !r.reply) ||
                (role === 'operator' && r.status === 'approved') ||
                (role === 'courier' &&
                  ['assigned', 'accepted', 'released', 'in_transit'].includes(r.status)))) ||
            (r.kind === 'refund' &&
              ((role === 'operator' && ['requested', 'reserved'].includes(r.status)) ||
                (customer && r.status === 'released'))) ||
            (r.kind === 'payout' &&
              ((role === 'operator' && r.status === 'reserved') ||
                (role === 'merchant' && r.status === 'released'))) ||
            (r.kind === 'transfer' &&
              ['reserved', 'assigned', 'accepted', 'released', 'in_transit'].includes(r.status)) ||
            r.kind === 'cash';
        }
        if (r.issue) title = 'تحتاج متابعة: ' + title;
        const id = `${r.kind}:${r.id}:${r.version}`;
        const pages = {
          shipment: 'shipments',
          return: 'returns',
          transfer: 'transfers',
          cash: 'cash',
          payout: 'payouts',
          refund: 'returns',
        } as const;
        return {
          id,
          kind: r.kind,
          targetId: r.id,
          reference: r.reference,
          title,
          createdAt: new Date(r.at).toISOString(),
          actionRequired: required,
          page: customer ? 'orders' : pages[r.kind],
          read: seen.has(id),
        };
      });
      items.push(
        ...(await disputeNotifications(tx, audience, role === 'operator', clock())).map((n) => ({
          ...n,
          read: seen.has(n.id),
        })),
      );
      items.sort(
        (a, b) =>
          Number(b.actionRequired) - Number(a.actionRequired) ||
          b.createdAt.localeCompare(a.createdAt),
      );
      const limited = items.slice(0, 100);
      return { audience, items: limited, unread: limited.filter((n) => !n.read).length };
    });
  }
  app.get(prefix, async (req) => {
    const { items, unread } = await feed(req);
    return { items, unread };
  });
  app.post(prefix + '/read', async (req) => {
    const ids = z
      .object({ ids: z.array(z.string().max(110)).max(100) })
      .strict()
      .parse(req.body).ids;
    const current = await feed(req),
      allowed = new Set(current.items.map((n) => n.id));
    assert(
      ids.every((id) => allowed.has(id)),
      404,
      'NOTIFICATION_NOT_FOUND',
      'الإشعار غير متاح لحسابك',
    );
    await write(async (tx) => {
      for (const id of new Set(ids))
        await tx.query(
          'INSERT INTO notification_reads(audience,notification_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [current.audience, id],
        );
    });
    return { ok: true };
  });
}
