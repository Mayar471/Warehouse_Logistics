import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import type { Account } from '../shared/contracts.js';
import { z } from 'zod';
import { assert, idempotent, transactionGate } from './domain.js';

export function registerPartnerRemoval(
  app: FastifyInstance,
  db: Database,
  write: ReturnType<typeof transactionGate>,
  operator: (req: FastifyRequest) => Account,
  onRemoved: (kind: string, id: string, merchantId: string | null) => void,
) {
  for (const kind of ['sites', 'couriers'] as const)
    app.delete('/api/network/' + kind + '/:id', async (req) => {
      const actor = operator(req),
        id = z
          .string()
          .min(1)
          .max(40)
          .parse((req.params as { id: string }).id);
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(req.body);
      const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
      const result = await write((tx) =>
        idempotent(tx, `${actor.id}:network:remove:${kind}:${id}`, key, body, async () => {
          const row = (
            await tx.query<{
              version: number;
              archived_at: string | null;
              merchant_id?: string;
              kind?: string;
            }>(`SELECT * FROM ${kind} WHERE id=$1`, [id])
          ).rows[0];
          assert(row, 404, 'NOT_FOUND', 'الشريك غير موجود');
          assert(!row.archived_at, 409, 'ALREADY_ARCHIVED', 'الشريك أُزيل من الشبكة');
          assert(
            row.version === body.expectedVersion,
            409,
            'VERSION_CONFLICT',
            'تغيرت البيانات؛ حدّث الشبكة قبل الإزالة',
          );
          if (kind === 'sites')
            assert(
              ['pickup', 'store'].includes(row.kind!),
              422,
              'INVALID_SITE_KIND',
              'هذا المسار لإزالة نقطة استلام أو موقع متجر',
            );
          if (kind === 'couriers')
            assert(
              !(
                await tx.query(
                  'SELECT shipment_id FROM execution_earnings WHERE courier_id=$1 AND company_id IS NULL AND (amount_minor IS NULL OR amount_minor>0)',
                  [id],
                )
              ).rows.length,
              409,
              'PARTNER_EARNINGS_PENDING',
              'توجد أجور تنفيذ مستقلة تحتاج تسوية قبل الإزالة',
            );
          const activeShipments = await tx.query(
            `SELECT id FROM shipments WHERE ${kind === 'couriers' ? 'courier_id=$1' : '(origin_id=$1 OR pickup_site_id=$1 OR custody_site_id=$1)'} AND status NOT IN ('delivered','returned','cancelled')`,
            [id],
          );
          const activeReturns = await tx.query(
            `SELECT r.id FROM commercial_returns r JOIN shipments s ON s.id=r.shipment_id WHERE ${kind === 'couriers' ? 'r.courier_id=$1' : 's.origin_id=$1'} AND r.status NOT IN ('received','rejected','cancelled')`,
            [id],
          );
          const transfers = await tx.query(
            `SELECT id FROM inventory_transfers WHERE ${kind === 'couriers' ? 'courier_id=$1' : '(source_id=$1 OR destination_id=$1)'} AND status NOT IN ('received','cancelled','expired')`,
            [id],
          );
          assert(
            !activeShipments.rows.length && !activeReturns.rows.length && !transfers.rows.length,
            409,
            'ACTIVE_PARTNER_WORK',
            'لا يمكن الإزالة قبل إكمال الشحنات والمرتجعات ومهام النقل النشطة',
          );
          const cash = await tx.query(
            `SELECT o.shipment_id FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id WHERE (o.collector_id=$1 OR ($2::text IS NOT NULL AND s.merchant_id=$2)) AND (o.status='collected' OR o.issue_open)`,
            [id, row.merchant_id ?? null],
          );
          assert(
            !cash.rows.length,
            409,
            'PARTNER_CASH_PENDING',
            'توجد عهدة نقدية أو فروق تحتاج تسوية قبل الإزالة',
          );
          const cashReturns = await tx.query(
            "SELECT id FROM cash_remittance_returns WHERE collector_id=$1 AND (status IN ('requested','released') OR issue_open)",
            [id],
          );
          assert(
            !cashReturns.rows.length,
            409,
            'PARTNER_CASH_PENDING',
            'توجد إعادة عهدة نقدية غير مكتملة',
          );
          if (kind === 'sites') {
            assert(
              !(
                await tx.query(
                  'SELECT product_id FROM inventory_stock WHERE site_id=$1 AND on_hand>0',
                  [id],
                )
              ).rows.length,
              409,
              'PARTNER_STOCK_PENDING',
              'يوجد مخزون في الموقع؛ انقله أو سوّه قبل الإزالة',
            );
            assert(
              !(
                await tx.query(
                  "SELECT product_id FROM inventory_reservations WHERE site_id=$1 AND state IN ('reserved','prepared','quarantined')",
                  [id],
                )
              ).rows.length,
              409,
              'PARTNER_STOCK_PENDING',
              'توجد قطع محجوزة أو معزولة للفحص',
            );
            if (row.merchant_id) {
              const payments = await tx.query(
                "SELECT id FROM cash_payouts WHERE merchant_id=$1 AND (status IN ('reserved','released') OR issue_open) UNION ALL SELECT f.id FROM customer_refunds f JOIN shipments s ON s.id=f.shipment_id WHERE s.merchant_id=$1 AND (f.status IN ('requested','reserved','released') OR f.issue_open)",
                [row.merchant_id],
              );
              assert(
                !payments.rows.length,
                409,
                'PARTNER_CASH_PENDING',
                'توجد مستحقات أو مبالغ رد غير مكتملة للمتجر',
              );
            }
          }
          await tx.query(
            `UPDATE ${kind} SET archived_at=now(),version=version+1,${kind === 'couriers' ? 'available=false' : 'pickup_enabled=false'} WHERE id=$1`,
            [id],
          );
          await tx.query(
            'INSERT INTO partner_audit(id,entity_id,actor_name,action,details) VALUES($1,$2,$3,$4,$5)',
            [
              randomUUID(),
              id,
              actor.name,
              kind + '.archived',
              JSON.stringify({ before: row, mode: 'archive' }),
            ],
          );
          return {
            id,
            archived: true,
            merchantId: row.merchant_id ?? null,
            version: row.version + 1,
          };
        }),
      );
      onRemoved(kind, id, result.merchantId);
      return result;
    });
}
