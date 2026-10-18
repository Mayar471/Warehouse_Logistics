import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assert, idempotent, transactionGate } from './domain.js';
import { pickupOpening, type PickupSchedule } from '../shared/pickup-hours.js';
import type { Transaction } from './db.js';
import {
  districts,
  distanceKm,
  type Coordinates,
  type PickupOption,
} from '../shared/customer-locations.js';
export const coordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-85).max(85),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();
export const pickupOptionsSql = `SELECT s.id,s.name,s.address,s.latitude,s.longitude,s.pickup_schedule AS "pickupSchedule",COALESCE(r.count,0)::integer AS "ratingCount",r.rating FROM sites s LEFT JOIN (SELECT subject_id,COUNT(*) count,ROUND(AVG(score)::numeric,1)::double precision rating FROM service_ratings WHERE kind='pickup' GROUP BY subject_id) r ON r.subject_id=s.id WHERE s.archived_at IS NULL AND s.kind='pickup' AND s.pickup_enabled AND s.city='دمشق'`;
export async function pickupOptions(tx: Transaction, now: number, located = false) {
  const rows = (
    await tx.query<PickupOption & { pickupSchedule: PickupSchedule }>(
      pickupOptionsSql +
        (located ? ' AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL' : '') +
        ' ORDER BY s.name,s.id',
    )
  ).rows;
  return rows.map(({ pickupSchedule, ...p }) => ({
    ...p,
    openingStatus: pickupOpening(pickupSchedule, now),
  }));
}
export function registerCustomerLocations(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  owner: (req: FastifyRequest) => string,
  clock: () => number = Date.now,
) {
  const key = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  app.get('/api/storefront/addresses', async (req) => {
    const who = owner(req);
    return write(async (tx) => ({
      addresses: (
        await tx.query(
          'SELECT id,label,name,district,details,latitude,longitude,version FROM customer_addresses WHERE owner_hash=$1 ORDER BY label,name,id',
          [who],
        )
      ).rows,
    }));
  });
  app.post('/api/storefront/addresses', async (req) => {
    const who = owner(req),
      k = key(req),
      body = z
        .object({
          id: z.string().uuid().optional(),
          expectedVersion: z.number().int().positive().optional(),
          label: z.enum(['home', 'work', 'custom']),
          name: z.string().trim().min(2).max(60),
          district: z.enum(districts),
          details: z.string().trim().max(130),
          ...coordinatesSchema.shape,
        })
        .strict()
        .parse(req.body);
    assert(!body.id || body.expectedVersion, 422, 'VERSION_REQUIRED', 'حدّث العنوان قبل تعديله');
    return write((tx) =>
      idempotent(tx, `customer:${who}:address`, k, body, async () => {
        let id = body.id;
        if (id) {
          const old = (
            await tx.query<{ version: number }>(
              'SELECT version FROM customer_addresses WHERE id=$1 AND owner_hash=$2',
              [id, who],
            )
          ).rows[0];
          assert(old, 404, 'ADDRESS_NOT_FOUND', 'العنوان غير موجود');
          assert(
            old.version === body.expectedVersion,
            409,
            'VERSION_CONFLICT',
            'تغير العنوان؛ حدّث القائمة',
          );
        } else {
          assert(
            (
              await tx.query<{ count: number }>(
                'SELECT COUNT(*)::integer count FROM customer_addresses WHERE owner_hash=$1',
                [who],
              )
            ).rows[0].count < 10,
            409,
            'ADDRESS_LIMIT',
            'يمكن حفظ حتى 10 عناوين',
          );
          id = randomUUID();
        }
        if (body.label !== 'custom')
          assert(
            !(
              await tx.query(
                'SELECT id FROM customer_addresses WHERE owner_hash=$1 AND label=$2 AND id<>$3',
                [who, body.label, id],
              )
            ).rows.length,
            409,
            'ADDRESS_EXISTS',
            'عنوان البيت أو العمل محفوظ؛ اختره لتعديله',
          );
        if (body.id)
          await tx.query(
            'UPDATE customer_addresses SET label=$1,name=$2,district=$3,details=$4,latitude=$5,longitude=$6,version=version+1 WHERE id=$7 AND owner_hash=$8',
            [
              body.label,
              body.name,
              body.district,
              body.details,
              body.latitude,
              body.longitude,
              id,
              who,
            ],
          );
        else
          await tx.query(
            'INSERT INTO customer_addresses(id,owner_hash,label,name,district,details,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              id,
              who,
              body.label,
              body.name,
              body.district,
              body.details,
              body.latitude,
              body.longitude,
            ],
          );
        return (
          await tx.query(
            'SELECT id,label,name,district,details,latitude,longitude,version FROM customer_addresses WHERE id=$1 AND owner_hash=$2',
            [id, who],
          )
        ).rows[0];
      }),
    );
  });
  app.delete('/api/storefront/addresses/:id', async (req) => {
    const who = owner(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const body = z
      .object({ expectedVersion: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return write(async (tx) => {
      const result = await tx.query(
        'DELETE FROM customer_addresses WHERE id=$1 AND owner_hash=$2 AND version=$3 RETURNING id',
        [id, who, body.expectedVersion],
      );
      assert(result.rows.length, 409, 'ADDRESS_CHANGED', 'العنوان غير موجود أو تغير؛ حدّث القائمة');
      return { ok: true };
    });
  });
  app.post('/api/storefront/pickup-sites/nearest', async (req) => {
    const who = owner(req),
      body = z
        .union([coordinatesSchema, z.object({ addressId: z.string().uuid() }).strict()])
        .parse(req.body);
    return write(async (tx) => {
      let point: Coordinates;
      if ('addressId' in body) {
        const saved = (
          await tx.query<Coordinates>(
            'SELECT latitude,longitude FROM customer_addresses WHERE id=$1 AND owner_hash=$2',
            [body.addressId, who],
          )
        ).rows[0];
        assert(saved, 404, 'ADDRESS_NOT_FOUND', 'العنوان غير موجود');
        point = saved;
      } else point = body;
      const rows = (await pickupOptions(tx, clock(), true)).filter((p) => p.openingStatus.openNow);
      return {
        sites: rows
          .map((p) => ({
            ...p,
            distanceKm: distanceKm(point, { latitude: p.latitude!, longitude: p.longitude! }),
          }))
          .sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id))
          .slice(0, 5),
        distanceMethod: 'straight-line',
        locatedCount: rows.length,
      };
    });
  });
  app.post('/api/storefront/orders/:id/ratings', async (req) => {
    const who = owner(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      k = key(req),
      body = z
        .object({
          kind: z.enum(['courier', 'pickup']),
          score: z.number().int().min(1).max(5),
          comment: z.string().trim().max(500).default(''),
        })
        .strict()
        .parse(req.body);
    return write((tx) =>
      idempotent(tx, `customer:${who}:rating:${id}`, k, body, async () => {
        const s = (
          await tx.query<{
            status: string;
            courier_id: string | null;
            pickup_site_id: string | null;
          }>(
            'SELECT s.status,COALESCE(d.courier_id,CASE WHEN s.pickup_site_id IS NULL THEN s.courier_id ELSE NULL END) courier_id,s.pickup_site_id FROM shipments s JOIN storefront_checkouts c ON c.shipment_id=s.id LEFT JOIN delivery_service_subjects d ON d.shipment_id=s.id WHERE s.id=$1 AND c.owner_hash=$2',
            [id, who],
          )
        ).rows[0];
        assert(s, 404, 'ORDER_NOT_FOUND', 'الطلب غير موجود');
        assert(
          s.status === 'delivered',
          409,
          'NOT_DELIVERED',
          'التقييم متاح بعد تأكيد استلام الطلب',
        );
        const subject = body.kind === 'courier' ? s.courier_id : s.pickup_site_id;
        assert(subject, 422, 'NOT_APPLICABLE', 'هذا الطلب لا يتضمن الخدمة المختارة');
        assert(
          !(
            await tx.query('SELECT id FROM service_ratings WHERE shipment_id=$1 AND kind=$2', [
              id,
              body.kind,
            ])
          ).rows.length,
          409,
          'ALREADY_RATED',
          'تم تقييم هذه الخدمة لهذا الطلب',
        );
        await tx.query(
          'INSERT INTO service_ratings(id,owner_hash,shipment_id,kind,subject_id,score,comment) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), who, id, body.kind, subject, body.score, body.comment],
        );
        return { ...body };
      }),
    );
  });
}
