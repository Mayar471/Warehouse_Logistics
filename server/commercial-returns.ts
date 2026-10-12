import { refundJson } from './customer-refunds.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from './db.js';
import type { Account } from '../shared/contracts.js';
import { z } from 'zod';
import { inventoryTransition } from './inventory.js';
import { reconcileInventory } from './inventory-reconciliation.js';
import { randomUUID } from 'node:crypto';
import {
  assert,
  idempotent,
  transactionGate,
  courierCapacity,
  loadShipment,
  appendEvent,
} from './domain.js';
export const commercialReturnSelect = `SELECT r.id,r.shipment_id AS "shipmentId",s.reference AS "shipmentReference",r.merchant_id AS "merchantId",m.name AS "merchantName",r.status,r.version,r.items,r.goods_minor::double precision AS "goodsMinor",r.currency,r.reason,r.decision_reason AS "decisionReason",r.created_at AS "createdAt",r.reviewed_at AS "reviewedAt",r.cancelled_at AS "cancelledAt",r.courier_id AS "courierId",c.name AS "courierName",o.name AS "originName",r.collection_address AS "collectionAddress",r.assignment_expires_at AS "assignmentExpiresAt",r.accepted_at AS "acceptedAt",r.released_at AS "releasedAt",r.picked_up_at AS "pickedUpAt",r.received_at AS "receivedAt",r.issue_open AS "issueOpen",${refundJson} AS refund,(r.status='received' AND EXISTS(SELECT 1 FROM inventory_reservations i WHERE i.shipment_id=r.shipment_id) AND NOT EXISTS(SELECT 1 FROM inventory_reservations i WHERE i.shipment_id=r.shipment_id AND i.quantity<>i.restocked_quantity+i.discarded_quantity)) AS "inspectionComplete" FROM commercial_returns r JOIN shipments s ON s.id=r.shipment_id JOIN merchants m ON m.id=r.merchant_id JOIN sites o ON o.id=s.origin_id LEFT JOIN couriers c ON c.id=r.courier_id`;
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
      a.role === 'operator' ||
        (a.role === 'merchant' && !!a.merchantId) ||
        (a.role === 'courier' && !!a.courierId),
      403,
      'FORBIDDEN',
      'مراجعة المرتجعات للمتجر المالك وقراءة العمليات',
    );
    return a;
  };
  app.get('/api/commercial-returns', async (req) => {
    const a = access(req);
    return write(async (tx) => {
      const owner = a.role === 'merchant' ? a.merchantId : null,
        courier = a.role === 'courier' ? a.courierId : null;
      const totals = (
        await tx.query(
          "SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='requested')::integer requested,COUNT(*) FILTER(WHERE status='approved')::integer approved,COUNT(*) FILTER(WHERE status IN ('assigned','accepted','released','in_transit'))::integer active,COUNT(*) FILTER(WHERE status='received')::integer received FROM commercial_returns WHERE ($1::text IS NULL OR merchant_id=$1) AND ($2::text IS NULL OR courier_id=$2)",
          [owner, courier],
        )
      ).rows[0];
      const rows = (
        await tx.query(
          commercialReturnSelect +
            " WHERE ($1::text IS NULL OR r.merchant_id=$1) AND ($2::text IS NULL OR r.courier_id=$2) ORDER BY (r.status NOT IN ('rejected','cancelled','received')) DESC,r.created_at DESC,r.id LIMIT 50",
          [owner, courier],
        )
      ).rows;
      const history = (
        await tx.query(
          `SELECT * FROM (
          SELECT e.id,e.return_id AS "returnId",e.action,e.actor_name AS "actorName",e.reference,e.reason,e.created_at AS "createdAt" FROM commercial_return_events e JOIN commercial_returns r ON r.id=e.return_id WHERE ($1::text IS NULL OR r.merchant_id=$1) AND ($2::text IS NULL OR r.courier_id=$2)
          UNION ALL SELECT e.id,e.refund_id AS "returnId",'refund.'||e.action AS action,e.actor_name AS "actorName",e.reference,e.reason,e.created_at AS "createdAt" FROM customer_refund_events e JOIN commercial_returns r ON r.id=e.refund_id WHERE ($1::text IS NULL OR r.merchant_id=$1) AND $2::text IS NULL
          ) h ORDER BY "createdAt" DESC,id LIMIT 30`,
          [owner, courier],
        )
      ).rows;
      const couriers =
        a.role === 'operator'
          ? await Promise.all(
              (
                await tx.query<{
                  id: string;
                  name: string;
                  available: boolean;
                  capacity_kg: number;
                }>('SELECT id,name,available,capacity_kg FROM couriers ORDER BY name,id')
              ).rows.map(async (c) => ({
                id: c.id,
                name: c.name,
                available: c.available,
                capacityKg: c.capacity_kg,
                activeKg: await courierCapacity(tx, c.id),
                vehicle: '',
              })),
            )
          : [];
      return { ...(totals as object), rows, history, couriers };
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
    const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b = z
        .object({
          action: z.enum([
            'approve',
            'reject',
            'assign',
            'accept',
            'decline',
            'unassign',
            'pickup',
            'receive',
            'report',
          ]),
          courierId: z.string().min(1).max(40).optional(),
          collectionAddress: z.string().trim().min(10).max(240).optional(),
          expectedVersion: z.number().int().positive(),
          reference: z.string().trim().min(3).max(100),
          reason: z.string().trim().min(5).max(240),
        })
        .strict()
        .parse(req.body),
      key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `${a.id}:commercial-return:${id}`, key, b, async () => {
        const expectedRole = ['approve', 'reject', 'receive'].includes(b.action)
          ? 'merchant'
          : ['assign', 'unassign'].includes(b.action)
            ? 'operator'
            : 'courier';
        assert(a.role === expectedRole, 403, 'FORBIDDEN', 'هذا الإجراء غير متاح لحسابك');
        assert(
          b.action === 'assign' || (b.courierId === undefined && b.collectionAddress === undefined),
          422,
          'INVALID_FIELDS',
          'حقول الإسناد متاحة مع الإسناد فقط',
        );
        const r = (
          await tx.query<{
            status: string;
            version: number;
            shipment_id: string;
            courier_id: string | null;
            assignment_expires_at: string | null;
          }>(
            'SELECT * FROM commercial_returns WHERE id=$1 AND ($2::text IS NULL OR merchant_id=$2) AND ($3::text IS NULL OR courier_id=$3)',
            [
              id,
              a.role === 'merchant' ? a.merchantId : null,
              a.role === 'courier' ? a.courierId : null,
            ],
          )
        ).rows[0];
        assert(r, 404, 'NOT_FOUND', 'طلب الإرجاع غير موجود');
        assert(
          r.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغير طلب الإرجاع؛ حدّث القراءة وراجع الإجراء',
        );
        const now = new Date(clock()).toISOString();
        let status = r.status;
        const clear =
          'courier_id=NULL,assignment_expires_at=NULL,accepted_at=NULL,issue_open=false';
        if (b.action === 'approve' || b.action === 'reject') {
          assert(r.status === 'requested', 409, 'INVALID_STATE', 'طلب الإرجاع لا ينتظر مراجعة');
          status = b.action === 'approve' ? 'approved' : 'rejected';
          await tx.query(
            'UPDATE commercial_returns SET status=$2,version=version+1,decision_reason=$3,reviewed_at=$4 WHERE id=$1',
            [id, status, b.reason, now],
          );
        } else if (b.action === 'assign') {
          assert(
            r.status === 'approved',
            409,
            'INVALID_STATE',
            'يلزم قبول المتجر قبل إسناد الاستلام',
          );
          assert(
            b.courierId && b.collectionAddress?.includes('دمشق'),
            422,
            'COLLECTION_ADDRESS_REQUIRED',
            'حدد المندوب وعنوان استلام متفقًا عليه في دمشق',
          );
          const courier = (
            await tx.query<{ available: boolean; capacity_kg: number }>(
              'SELECT * FROM couriers WHERE id=$1',
              [b.courierId],
            )
          ).rows[0];
          assert(courier?.available, 422, 'COURIER_UNAVAILABLE', 'المندوب غير متاح');
          const shipment = await loadShipment(tx, r.shipment_id);
          assert(
            (await courierCapacity(tx, b.courierId)) + shipment.weight_kg <= courier.capacity_kg,
            409,
            'CAPACITY_EXCEEDED',
            'سعة المندوب لا تكفي لاستلام المرتجع',
          );
          status = 'assigned';
          await tx.query(
            "UPDATE commercial_returns SET status='assigned',courier_id=$2,collection_address=$3,assignment_expires_at=$4,version=version+1 WHERE id=$1",
            [id, b.courierId, b.collectionAddress, new Date(clock() + 5 * 60_000).toISOString()],
          );
        } else if (b.action === 'accept') {
          assert(r.status === 'assigned', 409, 'INVALID_STATE', 'المهمة لا تنتظر القبول');
          assert(
            r.assignment_expires_at && new Date(r.assignment_expires_at).getTime() > clock(),
            409,
            'ASSIGNMENT_EXPIRED',
            'انتهت مهلة قبول المهمة',
          );
          status = 'accepted';
          await tx.query(
            "UPDATE commercial_returns SET status='accepted',accepted_at=$2,assignment_expires_at=NULL,version=version+1 WHERE id=$1",
            [id, now],
          );
        } else if (b.action === 'decline' || b.action === 'unassign') {
          assert(
            b.action === 'decline'
              ? r.status === 'assigned'
              : ['assigned', 'accepted'].includes(r.status),
            409,
            'CUSTODY_LOCKED',
            'لا يمكن تحرير المهمة بعد تسليم العميل للطرد',
          );
          status = 'approved';
          await tx.query(
            `UPDATE commercial_returns SET status='approved',${clear},version=version+1 WHERE id=$1`,
            [id],
          );
        } else if (b.action === 'pickup') {
          assert(
            r.status === 'released',
            409,
            'CUSTOMER_HANDOVER_REQUIRED',
            'يلزم تأكيد العميل تسليم الطرد إلى المندوب المكلف',
          );
          status = 'in_transit';
          await tx.query(
            "UPDATE commercial_returns SET status='in_transit',picked_up_at=$2,issue_open=false,version=version+1 WHERE id=$1",
            [id, now],
          );
        } else if (b.action === 'receive') {
          assert(
            r.status === 'in_transit',
            409,
            'INVALID_STATE',
            'يلزم استلام المندوب للطرد قبل استلام المنشأ',
          );
          const shipment = await loadShipment(tx, r.shipment_id);
          const lines = (
            await tx.query<{
              product_id: string;
              quantity: number;
              state: string;
              site_id: string;
              merchant_id: string;
            }>('SELECT * FROM inventory_reservations WHERE shipment_id=$1', [shipment.id])
          ).rows;
          const snapshot = (
            await tx.query<{ items: { productId: string; quantity: number }[] }>(
              'SELECT items FROM commercial_returns WHERE id=$1',
              [id],
            )
          ).rows[0].items;
          assert(
            lines.length === snapshot.length &&
              snapshot.every((item) =>
                lines.some(
                  (line) =>
                    line.product_id === item.productId &&
                    line.quantity === item.quantity &&
                    line.state === 'fulfilled' &&
                    line.site_id === shipment.origin_id &&
                    line.merchant_id === shipment.merchant_id,
                ),
              ),
            409,
            'RETURN_SOURCE_INVALID',
            'الكميات لا تطابق الطلب المسلم',
          );
          const report = await reconcileInventory(tx, shipment.merchant_id, shipment.origin_id);
          assert(
            snapshot.every((item) =>
              report.rows.some((row) => row.productId === item.productId && row.matched),
            ),
            409,
            'INVENTORY_INCONSISTENT',
            'راجع مطابقة المخزون قبل استلام المرتجع',
          );
          await inventoryTransition(tx, shipment, 'commercial_receive', a.name, clock());
          await tx.query('UPDATE shipments SET version=version+1,updated_at=now() WHERE id=$1', [
            shipment.id,
          ]);
          await appendEvent(
            tx,
            await loadShipment(tx, shipment.id),
            'shipment.commercial_return_received',
            'استلم المتجر جميع كميات الإرجاع التجاري وعُزلت للفحص؛ لم يُرد نقد العميل',
            a.name,
          );
          status = 'received';
          await tx.query(
            "UPDATE commercial_returns SET status='received',received_at=$2,issue_open=false,version=version+1 WHERE id=$1",
            [id, now],
          );
        } else {
          assert(
            ['accepted', 'released', 'in_transit'].includes(r.status),
            409,
            'INVALID_STATE',
            'الإبلاغ متاح أثناء الاستلام والنقل',
          );
          await tx.query(
            'UPDATE commercial_returns SET issue_open=true,version=version+1 WHERE id=$1',
            [id],
          );
        }
        await returnEvent(tx, id, b.action, a.id, a.name, b.reference, b.reason);
        return { id, status, version: r.version + 1 };
      }),
    );
  });
}

export async function expireCommercialReturns(tx: Transaction, now: number) {
  const expired = (
    await tx.query<{ id: string }>(
      "SELECT id FROM commercial_returns WHERE status='assigned' AND assignment_expires_at<=$1 ORDER BY assignment_expires_at,id LIMIT 100",
      [new Date(now).toISOString()],
    )
  ).rows;
  for (const r of expired) {
    await tx.query(
      "UPDATE commercial_returns SET status='approved',courier_id=NULL,assignment_expires_at=NULL,version=version+1 WHERE id=$1",
      [r.id],
    );
    await returnEvent(
      tx,
      r.id,
      'assignment_expired',
      'system',
      'النظام',
      'انتهاء مهلة القبول',
      'انتهت مهلة قبول المندوب؛ أعيد المرتجع للإسناد دون انتقال عهدة',
    );
  }
}
