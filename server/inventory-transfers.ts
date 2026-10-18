import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import type { InventoryTransfer, TransferStatus } from '../shared/transfers.js';
import type { Transaction } from './db.js';
import { assert, courierCapacity, idempotent, transactionGate } from './domain.js';
import { movement } from './inventory.js';
import { reconcileInventory } from './inventory-reconciliation.js';
import { catalog } from '../shared/catalog.js';
type Row = Omit<InventoryTransfer, 'lines'>;
type Line = {
  merchant_id: string;
  source_id: string;
  destination_id: string;
  product_id: string;
  quantity: number;
  received: number;
  lost: number;
  damaged: number;
  restocked: number;
  discarded: number;
};
const select = `SELECT t.id,t.merchant_id AS "merchantId",m.name AS "merchantName",t.source_id AS "sourceId",s.name AS "sourceName",t.destination_id AS "destinationId",d.name AS "destinationName",t.status,t.version,t.issue_open AS "issueOpen",t.weight_kg AS "weightKg",t.courier_id AS "courierId",c.name AS "courierName",t.hold_expires_at AS "holdExpiresAt",t.assignment_expires_at AS "assignmentExpiresAt",t.created_at AS "createdAt" FROM inventory_transfers t JOIN merchants m ON m.id=t.merchant_id JOIN sites s ON s.id=t.source_id JOIN sites d ON d.id=t.destination_id LEFT JOIN couriers c ON c.id=t.courier_id`;
const lines = async (tx: Transaction, id: string) =>
  (
    await tx.query<Line>(
      'SELECT * FROM inventory_transfer_lines WHERE transfer_id=$1 ORDER BY product_id',
      [id],
    )
  ).rows;
async function event(
  tx: Transaction,
  id: string,
  action: string,
  a: Pick<Account, 'id' | 'name'>,
  reason: string,
  details: unknown = {},
) {
  await tx.query(
    'INSERT INTO inventory_transfer_events(id,transfer_id,action,actor_id,actor_name,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), id, action, a.id, a.name, reason, JSON.stringify(details)],
  );
}
async function stockChange(
  tx: Transaction,
  id: string,
  line: Line,
  kind: string,
  actor: string,
  reason: string,
  onHand: number,
  reserved: number,
  destination = false,
  quantity = line.quantity,
  quarantine = 0,
) {
  const siteId = destination ? line.destination_id : line.source_id;
  const r = await tx.query(
    'UPDATE inventory_stock SET on_hand=on_hand+$4,reserved=reserved+$5,quarantine=quarantine+$6,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3 RETURNING product_id',
    [line.merchant_id, siteId, line.product_id, onHand, reserved, quarantine],
  );
  assert(r.rows.length, 409, 'INVENTORY_INCONSISTENT', 'رصيد النقل مفقود؛ يلزم التحقيق');
  await movement(
    tx,
    {
      merchant_id: line.merchant_id,
      site_id: siteId,
      product_id: line.product_id,
      quantity,
      state: 'transfer',
    },
    null,
    kind,
    actor,
    reason,
    id,
  );
}
async function consistent(tx: Transaction, line: Line, destination = false) {
  const report = await reconcileInventory(
    tx,
    line.merchant_id,
    destination ? line.destination_id : line.source_id,
    line.product_id,
  );
  const row = report.rows[0];
  assert(
    row?.matched,
    409,
    'INVENTORY_INCONSISTENT',
    'رصيد النقل لا يطابق السجل أو الالتزامات؛ راجع المطابقة',
  );
  return row;
}
async function validateTransfer(tx: Transaction, id: string, status: string, ls: Line[]) {
  const resolution = (
    await tx.query<{
      product_id: string;
      lost: number;
      damaged: number;
      restocked: number;
      discarded: number;
    }>(
      `SELECT product_id,COALESCE(SUM(quantity) FILTER(WHERE kind='transfer_loss'),0)::integer lost,COALESCE(SUM(quantity) FILTER(WHERE kind='transfer_receive_damaged'),0)::integer damaged,COALESCE(SUM(quantity) FILTER(WHERE kind='transfer_restock'),0)::integer restocked,COALESCE(SUM(quantity) FILTER(WHERE kind='transfer_discard'),0)::integer discarded FROM inventory_movements WHERE transfer_id=$1 GROUP BY product_id`,
      [id],
    )
  ).rows;
  const ledger = (
    await tx.query<{
      product_id: string;
      reserved: number;
      sent: number;
      cancelled: number;
      received: number;
      lost: number;
      damaged: number;
      restocked: number;
      discarded: number;
      unknown: number;
    }>(
      `SELECT m.product_id,
    COALESCE(SUM(m.quantity) FILTER(WHERE kind='transfer_reserve' AND site_id=t.source_id),0)::double precision reserved,
    COALESCE(SUM(m.quantity) FILTER(WHERE kind='transfer_send' AND site_id=t.source_id),0)::double precision sent,
    COALESCE(SUM(m.quantity) FILTER(WHERE kind='transfer_cancel' AND site_id=t.source_id),0)::double precision cancelled,
    COALESCE(SUM(m.quantity) FILTER(WHERE kind IN ('transfer_receive','transfer_receive_damaged') AND site_id=t.destination_id),0)::double precision received,
    COUNT(*) FILTER(WHERE kind NOT IN ('transfer_reserve','transfer_send','transfer_cancel','transfer_receive','transfer_receive_damaged','transfer_loss','transfer_restock','transfer_discard') OR m.merchant_id<>t.merchant_id OR (kind IN ('transfer_receive','transfer_receive_damaged','transfer_restock','transfer_discard') AND site_id<>t.destination_id) OR (kind IN ('transfer_reserve','transfer_send','transfer_cancel','transfer_loss') AND site_id<>t.source_id))::integer unknown
    FROM inventory_movements m JOIN inventory_transfers t ON t.id=m.transfer_id WHERE m.transfer_id=$1 GROUP BY m.product_id`,
      [id],
    )
  ).rows;
  const sent = ['released', 'in_transit', 'received', 'resolved'].includes(status);
  assert(
    ledger.length === ls.length &&
      ls.length > 0 &&
      ls.every((line) => {
        const row = ledger.find((r) => r.product_id === line.product_id);
        const r = resolution.find((r) => r.product_id === line.product_id);
        return (
          row &&
          !row.unknown &&
          row.reserved === line.quantity &&
          row.sent === (sent ? line.quantity : 0) &&
          row.cancelled === (status === 'cancelled' ? line.quantity : 0) &&
          row.received === line.received &&
          r &&
          r.lost === line.lost &&
          r.damaged === line.damaged &&
          r.restocked === line.restocked &&
          r.discarded === line.discarded &&
          (sent || !(line.lost || line.damaged)) &&
          (sent || line.received === 0) &&
          (status !== 'released' || (line.received === 0 && line.lost === 0)) &&
          (status !== 'received' ||
            (line.received === line.quantity && !line.lost && !line.damaged)) &&
          (status !== 'resolved' || line.received + line.lost === line.quantity)
        );
      }),
    409,
    'INVENTORY_INCONSISTENT',
    'سجل عهدة النقل لا يطابق كميات المهمة؛ يلزم التحقيق قبل إجراء جديد',
  );
}
export async function expireTransfers(tx: Transaction, now: number) {
  const rows = (
    await tx.query<{ id: string; status: string; hold_expires_at: string }>(
      "SELECT id,status,hold_expires_at FROM inventory_transfers WHERE status IN ('reserved','assigned','accepted') AND (hold_expires_at<=$1 OR (status='assigned' AND assignment_expires_at<=$1)) ORDER BY hold_expires_at,id LIMIT 100",
      [new Date(now).toISOString()],
    )
  ).rows;
  for (const row of rows) {
    await validateTransfer(tx, row.id, row.status, await lines(tx, row.id));
    const expired = new Date(row.hold_expires_at).getTime() <= now;
    if (expired)
      for (const line of await lines(tx, row.id))
        await stockChange(
          tx,
          row.id,
          line,
          'transfer_cancel',
          'عامل متابعة النقل',
          'انتهاء حجز النقل قبل انتقال العهدة',
          0,
          -line.quantity,
        );
    await tx.query(
      'UPDATE inventory_transfers SET status=$2,courier_id=NULL,assignment_expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
      [row.id, expired ? 'cancelled' : 'reserved'],
    );
    await event(
      tx,
      row.id,
      expired ? 'hold_expired' : 'assignment_expired',
      { id: 'worker', name: 'عامل متابعة النقل' },
      expired ? 'انتهاء حجز 24 ساعة قبل التسليم' : 'انتهاء مهلة قبول 5 دقائق؛ عاد النقل للحجز',
    );
  }
  return rows.length;
}
export function registerTransfers(
  app: FastifyInstance,
  db: Database,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
) {
  const access = (req: FastifyRequest) => {
    const a = account(req);
    assert(
      a.role !== 'pickup',
      403,
      'FORBIDDEN',
      'نقل المخزون متاح للعمليات والمتجر والمندوب المكلف',
    );
    return a;
  };
  const read = (a: Account, r: Row) =>
    assert(
      a.role === 'operator' ||
        (a.role === 'merchant' && a.merchantId === r.merchantId) ||
        (a.role === 'courier' && a.courierId === r.courierId),
      404,
      'NOT_FOUND',
      'مهمة النقل غير موجودة',
    );
  const manage = (a: Account) =>
    assert(
      ['operator', 'merchant'].includes(a.role),
      403,
      'FORBIDDEN',
      'هذا الإقرار للعمليات أو المتجر المالك',
    );
  const requestKey = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  async function load(tx: Transaction, id: string) {
    const r = (await tx.query<Row>(select + ' WHERE t.id=$1', [id])).rows[0];
    assert(r, 404, 'NOT_FOUND', 'مهمة النقل غير موجودة');
    return r;
  }
  app.get('/api/inventory/transfers', async (req) => {
    const a = access(req);
    return write(async (tx) => {
      const scope = `WHERE ($1='operator' OR ($1='merchant' AND t.merchant_id=$2) OR ($1='courier' AND t.courier_id=$3))`;
      const params = [a.role, a.merchantId, a.courierId];
      const summary = (
        await tx.query<{ total: number; active: number; pendingInspection: number }>(
          `SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status NOT IN ('received','resolved','cancelled'))::integer active,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM inventory_transfer_lines l WHERE l.transfer_id=t.id AND l.damaged>l.restocked+l.discarded))::integer AS "pendingInspection" FROM inventory_transfers t ${scope}`,
          params,
        )
      ).rows[0];
      const rows = (
        await tx.query<Row>(
          select +
            ` ${scope} ORDER BY (t.status NOT IN ('received','resolved','cancelled') OR EXISTS(SELECT 1 FROM inventory_transfer_lines l WHERE l.transfer_id=t.id AND l.damaged>l.restocked+l.discarded)) DESC,t.updated_at DESC,t.id LIMIT 50`,
          params,
        )
      ).rows;
      const allLines = (
        await tx.query<{
          transferId: string;
          productId: string;
          quantity: number;
          received: number;
          lost: number;
          damaged: number;
          restocked: number;
          discarded: number;
        }>(
          'SELECT transfer_id AS "transferId",product_id AS "productId",quantity,received,lost,damaged,restocked,discarded FROM inventory_transfer_lines WHERE transfer_id=ANY($1::uuid[]) ORDER BY product_id',
          [rows.map((r) => r.id)],
        )
      ).rows;
      return {
        ...summary,
        rows: rows.map((r) => ({ ...r, lines: allLines.filter((l) => l.transferId === r.id) })),
      };
    });
  });
  app.get('/api/inventory/transfers/:id', async (req) => {
    const a = access(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    return write(async (tx) => {
      const row = await load(tx, id);
      read(a, row);
      const history = (
        await tx.query(
          'SELECT id,action,actor_name AS "actorName",reason,details,created_at AS "createdAt" FROM inventory_transfer_events WHERE transfer_id=$1 ORDER BY created_at DESC,id LIMIT 30',
          [id],
        )
      ).rows;
      return {
        transfer: {
          ...row,
          lines: (await lines(tx, id)).map((l) => ({
            productId: l.product_id,
            quantity: l.quantity,
            received: l.received,
            lost: l.lost,
            damaged: l.damaged,
            restocked: l.restocked,
            discarded: l.discarded,
          })),
        },
        history,
      };
    });
  });
  app.post('/api/inventory/transfers', async (req) => {
    const a = access(req);
    manage(a);
    const body = z
      .object({
        merchantId: z.string().min(1).max(40),
        sourceId: z.string().min(1).max(40),
        destinationId: z.string().min(1).max(40),
        items: z
          .array(
            z
              .object({
                productId: z.string(),
                quantity: z.number().int().min(1).max(10000),
                sourceVersion: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1)
          .max(6),
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    assert(
      a.role === 'operator' || a.merchantId === body.merchantId,
      404,
      'NOT_FOUND',
      'موقع النقل غير موجود',
    );
    return write((tx) =>
      idempotent(tx, `${a.id}:transfer:create`, requestKey(req), body, async () => {
        assert(body.sourceId !== body.destinationId, 422, 'SAME_SITE', 'اختر وجهة تختلف عن المصدر');
        assert(
          new Set(body.items.map((i) => i.productId)).size === body.items.length,
          422,
          'DUPLICATE_PRODUCT',
          'المنتج مكرر',
        );
        const sites = (
          await tx.query<{ city: string }>(
            "SELECT city FROM sites WHERE id=ANY($1::text[]) AND merchant_id=$2 AND archived_at IS NULL AND kind IN ('store','warehouse')",
            [[body.sourceId, body.destinationId], body.merchantId],
          )
        ).rows;
        assert(
          sites.length === 2 && sites.every((s) => s.city === 'دمشق'),
          422,
          'INVALID_TRANSFER_SITES',
          'النقل الحالي بين موقعين في دمشق للمتجر نفسه',
        );
        let weight = 0;
        for (const item of body.items) {
          const p = catalog.find((p) => p.id === item.productId);
          assert(p, 422, 'INVALID_PRODUCT', 'منتج النقل غير معروف');
          weight += p.weightKg * item.quantity;
        }
        weight = Math.round(weight * 1000) / 1000;
        assert(
          weight > 0 && weight <= 50,
          422,
          'TRANSFER_WEIGHT',
          'حمولة مهمة النقل يجب ألا تتجاوز 50 كغ',
        );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO inventory_transfers(id,merchant_id,source_id,destination_id,status,weight_kg,hold_expires_at) VALUES($1,$2,$3,$4,'reserved',$5,$6)",
          [
            id,
            body.merchantId,
            body.sourceId,
            body.destinationId,
            weight,
            new Date(clock() + 24 * 60 * 60_000).toISOString(),
          ],
        );
        for (const item of body.items) {
          const line = {
            merchant_id: body.merchantId,
            source_id: body.sourceId,
            destination_id: body.destinationId,
            product_id: item.productId,
            quantity: item.quantity,
            received: 0,
            lost: 0,
            damaged: 0,
            restocked: 0,
            discarded: 0,
          };
          const source = await consistent(tx, line);
          await consistent(tx, line, true);
          assert(
            source.version === item.sourceVersion,
            409,
            'VERSION_CONFLICT',
            'تغير رصيد المصدر؛ راجع الكميات قبل الحجز',
          );
          assert(
            source.onHand! - source.reserved! - source.quarantine! >= item.quantity,
            409,
            'OUT_OF_STOCK',
            'كمية المصدر المتاحة لا تكفي للنقل',
          );
          await tx.query(
            'INSERT INTO inventory_transfer_lines(transfer_id,merchant_id,source_id,destination_id,product_id,quantity) VALUES($1,$2,$3,$4,$5,$6)',
            [id, body.merchantId, body.sourceId, body.destinationId, item.productId, item.quantity],
          );
          await stockChange(
            tx,
            id,
            line,
            'transfer_reserve',
            a.name,
            body.reason,
            0,
            item.quantity,
          );
        }
        await event(tx, id, 'created', a, body.reason, body);
        return { id, version: 1, status: 'reserved' };
      }),
    );
  });
  app.post('/api/inventory/transfers/:id/actions', async (req) => {
    const a = access(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const common = {
      expectedVersion: z.number().int().positive(),
      reason: z.string().trim().min(3).max(240),
    };
    const body = z
      .discriminatedUnion('action', [
        z
          .object({
            ...common,
            action: z.literal('resolve_issue'),
            reference: z.string().trim().min(3).max(120),
            items: z
              .array(
                z
                  .object({
                    productId: z.string(),
                    lost: z.number().int().min(0).max(10000),
                    damaged: z.number().int().min(0).max(10000),
                  })
                  .strict(),
              )
              .min(1)
              .max(6),
          })
          .strict(),
        z
          .object({
            ...common,
            action: z.literal('inspect_damage'),
            items: z
              .array(
                z
                  .object({
                    productId: z.string(),
                    restocked: z.number().int().min(0).max(10000),
                    discarded: z.number().int().min(0).max(10000),
                  })
                  .strict(),
              )
              .min(1)
              .max(6),
          })
          .strict(),
        z
          .object({ ...common, action: z.literal('assign'), courierId: z.string().min(1).max(40) })
          .strict(),
        z
          .object({
            ...common,
            action: z.literal('receive'),
            items: z
              .array(
                z
                  .object({ productId: z.string(), quantity: z.number().int().min(1).max(10000) })
                  .strict(),
              )
              .min(1)
              .max(6),
          })
          .strict(),
        z
          .object({
            ...common,
            action: z.enum([
              'accept',
              'decline',
              'unassign',
              'release',
              'pickup',
              'cancel',
              'report_issue',
            ]),
          })
          .strict(),
      ])
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:transfer:${id}`, requestKey(req), body, async () => {
        const row = await load(tx, id);
        read(a, row);
        assert(
          row.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت مهمة النقل؛ حدّثها وراجع الإجراء',
        );
        const ls = await lines(tx, id);
        await validateTransfer(tx, id, row.status, ls);
        let status: TransferStatus = row.status,
          courier = row.courierId,
          deadline = row.assignmentExpiresAt,
          issue = row.issueOpen;
        if (['reserved', 'assigned', 'accepted'].includes(row.status))
          assert(
            new Date(row.holdExpiresAt).getTime() > clock(),
            409,
            'TRANSFER_HOLD_EXPIRED',
            'انتهت مهلة حجز النقل؛ ينتظر تحرير العامل',
          );
        if (body.action === 'assign') {
          assert(a.role === 'operator', 403, 'FORBIDDEN', 'إسناد النقل للعمليات');
          assert(row.status === 'reserved', 409, 'INVALID_STATE', 'النقل غير جاهز للإسناد');
          const c = (
            await tx.query<{ available: boolean; capacity_kg: number }>(
              'SELECT available,capacity_kg FROM couriers WHERE id=$1',
              [body.courierId],
            )
          ).rows[0];
          assert(c?.available, 409, 'COURIER_UNAVAILABLE', 'المندوب غير متاح');
          assert(
            (await courierCapacity(tx, body.courierId)) + row.weightKg <= c.capacity_kg,
            409,
            'CAPACITY_EXCEEDED',
            'حمولة النقل تتجاوز السعة المتبقية للمندوب',
          );
          courier = body.courierId;
          status = 'assigned';
          deadline = new Date(clock() + 5 * 60_000).toISOString();
        } else if (
          body.action === 'accept' ||
          body.action === 'decline' ||
          body.action === 'pickup'
        ) {
          assert(
            a.role === 'courier' && a.courierId === row.courierId,
            403,
            'FORBIDDEN',
            'هذا الإقرار للمندوب المكلف',
          );
          if (body.action === 'pickup') {
            assert(
              row.status === 'released',
              409,
              'INVALID_STATE',
              'يجب أن يؤكد المصدر تسليم عهدة النقل أولًا',
            );
            status = 'in_transit';
          } else {
            assert(row.status === 'assigned', 409, 'INVALID_STATE', 'المهمة لا تنتظر قبولًا');
            assert(
              deadline && new Date(deadline).getTime() > clock(),
              409,
              'ASSIGNMENT_EXPIRED',
              'انتهت مهلة قبول النقل',
            );
            status = body.action === 'accept' ? 'accepted' : 'reserved';
            if (body.action === 'decline') courier = null;
            deadline = null;
          }
        } else if (body.action === 'resolve_issue' || body.action === 'inspect_damage') {
          if (body.action === 'resolve_issue') {
            assert(a.role === 'operator', 403, 'FORBIDDEN', 'اعتماد الفقد والتلف للعمليات فقط');
            assert(
              row.status === 'in_transit' && row.issueOpen,
              409,
              'INVALID_STATE',
              'يلزم إقرار عهدة المندوب وتسجيل التعثر قبل تسويته',
            );
          } else {
            manage(a);
            assert(
              ['in_transit', 'resolved'].includes(row.status),
              409,
              'INVALID_STATE',
              'الفحص بعد استلام تلف النقل في الوجهة',
            );
          }
          assert(
            new Set(body.items.map((i) => i.productId)).size === body.items.length,
            422,
            'DUPLICATE_PRODUCT',
            'المنتج مكرر',
          );
          for (const item of body.items) {
            const line = ls.find((l) => l.product_id === item.productId);
            assert(line, 422, 'INVALID_PRODUCT', 'المنتج غير موجود في النقل');
            if ('lost' in item) {
              assert(
                item.lost + item.damaged > 0 &&
                  item.lost + item.damaged <= line.quantity - line.received - line.lost,
                409,
                'RESOLUTION_QUANTITY',
                'الفقد والتلف يجب أن يكونا ضمن القطع المتبقية في العهدة',
              );
              if (item.damaged) {
                await consistent(tx, line, true);
                await stockChange(
                  tx,
                  id,
                  line,
                  'transfer_receive_damaged',
                  a.name,
                  body.reason,
                  item.damaged,
                  0,
                  true,
                  item.damaged,
                  item.damaged,
                );
              }
              if (item.lost)
                await movement(
                  tx,
                  {
                    merchant_id: line.merchant_id,
                    site_id: line.source_id,
                    product_id: line.product_id,
                    quantity: item.lost,
                    state: 'transfer',
                  },
                  null,
                  'transfer_loss',
                  a.name,
                  body.reason,
                  id,
                );
              await tx.query(
                'UPDATE inventory_transfer_lines SET received=received+$3,damaged=damaged+$3,lost=lost+$4 WHERE transfer_id=$1 AND product_id=$2',
                [id, item.productId, item.damaged, item.lost],
              );
              line.received += item.damaged;
              line.damaged += item.damaged;
              line.lost += item.lost;
            } else {
              const qty = item.restocked + item.discarded;
              assert(
                qty > 0 && qty <= line.damaged - line.restocked - line.discarded,
                409,
                'INSPECTION_QUANTITY',
                'الفحص يتجاوز تلف النقل المتبقي في العزل',
              );
              await consistent(tx, line, true);
              if (item.restocked)
                await stockChange(
                  tx,
                  id,
                  line,
                  'transfer_restock',
                  a.name,
                  body.reason,
                  0,
                  0,
                  true,
                  item.restocked,
                  -item.restocked,
                );
              if (item.discarded)
                await stockChange(
                  tx,
                  id,
                  line,
                  'transfer_discard',
                  a.name,
                  body.reason,
                  -item.discarded,
                  0,
                  true,
                  item.discarded,
                  -item.discarded,
                );
              await tx.query(
                'UPDATE inventory_transfer_lines SET restocked=restocked+$3,discarded=discarded+$4 WHERE transfer_id=$1 AND product_id=$2',
                [id, item.productId, item.restocked, item.discarded],
              );
              line.restocked += item.restocked;
              line.discarded += item.discarded;
            }
          }
          status = ls.every((l) => l.received + l.lost === l.quantity) ? 'resolved' : 'in_transit';
          issue = status === 'in_transit';
        } else if (body.action === 'report_issue') {
          assert(
            ['released', 'in_transit'].includes(row.status),
            409,
            'INVALID_STATE',
            'سجل التعثر بعد انتقال عهدة المصدر',
          );
          issue = true;
        } else if (body.action === 'unassign') {
          assert(a.role === 'operator', 403, 'FORBIDDEN', 'تحرير الإسناد للعمليات');
          assert(
            ['assigned', 'accepted'].includes(row.status),
            409,
            'INVALID_STATE',
            'لا يمكن تحرير الإسناد بعد انتقال العهدة',
          );
          status = 'reserved';
          courier = null;
          deadline = null;
        } else if (body.action === 'release') {
          manage(a);
          assert(
            row.status === 'accepted',
            409,
            'INVALID_STATE',
            'يلزم قبول المندوب قبل تسليم عهدة النقل',
          );
          for (const line of ls) {
            await consistent(tx, line);
            await stockChange(
              tx,
              id,
              line,
              'transfer_send',
              a.name,
              body.reason,
              -line.quantity,
              -line.quantity,
            );
          }
          status = 'released';
        } else if (body.action === 'cancel') {
          manage(a);
          assert(
            ['reserved', 'assigned', 'accepted'].includes(row.status),
            409,
            'INVALID_STATE',
            'لا يمكن إلغاء بضاعة خرجت من المصدر',
          );
          for (const line of ls) {
            await consistent(tx, line);
            await stockChange(
              tx,
              id,
              line,
              'transfer_cancel',
              a.name,
              body.reason,
              0,
              -line.quantity,
            );
          }
          status = 'cancelled';
          deadline = null;
        } else if (body.action === 'receive') {
          manage(a);
          assert(
            row.status === 'in_transit',
            409,
            'INVALID_STATE',
            'يلزم إقرار المندوب باستلام عهدته قبل الاستلام في الوجهة',
          );
          assert(
            new Set(body.items.map((i) => i.productId)).size === body.items.length,
            422,
            'DUPLICATE_PRODUCT',
            'المنتج مكرر في الاستلام',
          );
          for (const item of body.items) {
            const line = ls.find((l) => l.product_id === item.productId);
            assert(line, 422, 'INVALID_PRODUCT', 'المنتج غير موجود في النقل');
            assert(
              item.quantity <= line.quantity - line.received - line.lost,
              409,
              'RECEIVE_EXCEEDS_REMAINING',
              'المستلم يتجاوز الكمية المتبقية في عهدة النقل',
            );
            await consistent(tx, line, true);
            await stockChange(
              tx,
              id,
              line,
              'transfer_receive',
              a.name,
              body.reason,
              item.quantity,
              0,
              true,
              item.quantity,
            );
            await tx.query(
              'UPDATE inventory_transfer_lines SET received=received+$3 WHERE transfer_id=$1 AND product_id=$2',
              [id, item.productId, item.quantity],
            );
            line.received += item.quantity;
          }
          status = ls.every((l) => l.received + l.lost === l.quantity)
            ? ls.some((l) => l.lost || l.damaged)
              ? 'resolved'
              : 'received'
            : 'in_transit';
          issue = status === 'in_transit';
        }
        await tx.query(
          'UPDATE inventory_transfers SET status=$2,courier_id=$3,assignment_expires_at=$4,issue_open=$5,version=version+1,updated_at=now() WHERE id=$1',
          [id, status, courier, deadline, issue],
        );
        await event(tx, id, body.action, a, body.reason, body);
        return { id, status, version: row.version + 1 };
      }),
    );
  });
}
