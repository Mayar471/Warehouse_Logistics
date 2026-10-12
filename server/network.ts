import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import { assert, idempotent, transactionGate } from './domain.js';

export function registerNetwork(
  app: FastifyInstance,
  db: PGlite,
  write: ReturnType<typeof transactionGate>,
  operator: (req: FastifyRequest) => Account,
) {
  const fields = {
    name: z.string().trim().min(3).max(80),
    address: z.string().trim().min(5).max(130),
    capacityKg: z.number().finite().min(1).max(10000),
    enabled: z.boolean(),
    reason: z.string().trim().min(3).max(240),
  };
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  app.get('/api/network/audit', async (req) => {
    operator(req);
    return {
      audit: (
        await db.query(
          'SELECT id,site_id AS "siteId",actor_name AS "actorName",action,reason,details,created_at AS "createdAt" FROM network_audit ORDER BY created_at DESC,id LIMIT 20',
        )
      ).rows,
    };
  });
  app.post('/api/network/pickup-sites', async (req) => {
    const a = operator(req);
    const body = z.object(fields).strict().parse(req.body);
    const requestKey = key(req);
    return write((tx) =>
      idempotent(tx, `${a.id}:network:create`, requestKey, body, async () => {
        const count = (
          await tx.query<{ count: number }>(
            "SELECT COUNT(*)::integer count FROM sites WHERE kind='pickup'",
          )
        ).rows[0].count;
        assert(count < 100, 409, 'SITE_LIMIT', 'حد العرض المحلي هو 100 نقطة استلام');
        const id = 'point-' + randomBytes(8).toString('hex');
        await tx.query(
          "INSERT INTO sites(id,name,city,address,kind,merchant_id,pickup_enabled,pickup_capacity_kg) VALUES($1,$2,'دمشق',$3,'pickup',NULL,$4,$5)",
          [id, body.name, body.address, body.enabled, body.capacityKg],
        );
        await tx.query(
          'INSERT INTO network_audit(id,site_id,actor_name,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            id,
            a.name,
            'created',
            body.reason,
            JSON.stringify({ after: { ...body, version: 1 } }),
          ],
        );
        return { id, version: 1 };
      }),
    );
  });
  app.patch('/api/network/pickup-sites/:id', async (req) => {
    const a = operator(req);
    const id = z
      .string()
      .min(1)
      .max(40)
      .parse((req.params as { id: string }).id);
    const body = z
      .object({ ...fields, expectedVersion: z.number().int().positive() })
      .strict()
      .parse(req.body);
    const requestKey = key(req);
    return write((tx) =>
      idempotent(tx, `${a.id}:network:${id}`, requestKey, body, async () => {
        const site = (
          await tx.query<{
            name: string;
            address: string;
            version: number;
            pickup_capacity_kg: number;
            pickup_enabled: boolean;
          }>("SELECT * FROM sites WHERE id=$1 AND kind='pickup'", [id])
        ).rows[0];
        assert(site, 404, 'NOT_FOUND', 'نقطة الاستلام غير موجودة');
        assert(
          site.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت إعدادات النقطة؛ حدّث البيانات وأعد المحاولة',
        );
        const active = (
          await tx.query<{ kg: number; count: number }>(
            "SELECT COALESCE(SUM(weight_kg),0)::real kg,COUNT(*)::integer count FROM shipments WHERE pickup_site_id=$1 AND status NOT IN ('delivered','returned','cancelled') AND NOT(status='returning' AND custody_site_id IS NULL)",
            [id],
          )
        ).rows[0];
        assert(
          body.capacityKg >= active.kg,
          409,
          'CAPACITY_BELOW_RESERVED',
          'لا يمكن تخفيض السعة دون الوزن المحجوز حاليًا',
        );
        assert(
          body.address === site.address || active.count === 0,
          409,
          'ACTIVE_SITE_ADDRESS',
          'لا يمكن تغيير عنوان نقطة لها طرود نشطة أو طلبات في الطريق',
        );
        await tx.query(
          'UPDATE sites SET name=$2,address=$3,pickup_capacity_kg=$4,pickup_enabled=$5,version=version+1 WHERE id=$1',
          [id, body.name, body.address, body.capacityKg, body.enabled],
        );
        await tx.query(
          'INSERT INTO network_audit(id,site_id,actor_name,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            id,
            a.name,
            'updated',
            body.reason,
            JSON.stringify({
              before: {
                name: site.name,
                address: site.address,
                capacityKg: site.pickup_capacity_kg,
                enabled: site.pickup_enabled,
                version: site.version,
              },
              after: { ...body, version: site.version + 1 },
            }),
          ],
        );
        return { id, version: site.version + 1 };
      }),
    );
  });
}
