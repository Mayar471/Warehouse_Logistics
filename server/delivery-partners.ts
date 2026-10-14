import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import type { Account } from '../shared/contracts.js';
import { z } from 'zod';
import { assert, idempotent, transactionGate, courierCapacity } from './domain.js';
import { coordinatesSchema } from './customer-locations.js';

export function registerDeliveryPartners(
  app: FastifyInstance,
  db: PGlite,
  write: ReturnType<typeof transactionGate>,
  operator: (req: FastifyRequest) => Account,
) {
  const name = z.string().trim().min(3).max(80);
  const rateBps = z.number().int().min(0).max(10000).nullable().optional();
  const office = z
    .object({
      name,
      address: z.string().trim().min(5).max(130),
      location: coordinatesSchema,
      rateBps,
    })
    .strict();
  const courier = z
    .object({
      name,
      vehicle: z.enum(['دراجة نارية', 'سيارة صغيرة', 'سيارة نقل']),
      capacityKg: z.number().finite().min(1).max(1000),
      available: z.boolean(),
      companyId: z.string().min(1).max(40).nullable(),
      rateBps,
    })
    .strict();
  for (const kind of ['companies', 'couriers'] as const) {
    for (const update of [false, true]) {
      app.route({
        method: update ? 'PATCH' : 'POST',
        url: '/api/network/' + kind + (update ? '/:id' : ''),
        handler: async (req) => {
          const actor = operator(req);
          const schema = kind === 'companies' ? office : courier;
          const body = (
            update ? schema.extend({ expectedVersion: z.number().int().positive() }) : schema
          ).parse(req.body);
          const requestKey = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
          const id = update
            ? z
                .string()
                .min(1)
                .max(40)
                .parse((req.params as { id: string }).id)
            : (kind === 'companies' ? 'office-' : 'courier-') + randomBytes(8).toString('hex');
          return write((tx) =>
            idempotent(
              tx,
              `${actor.id}:network:${kind}:${update ? id : 'create'}`,
              requestKey,
              body,
              async () => {
                const table = kind === 'companies' ? 'delivery_companies' : 'couriers';
                const previous = update
                  ? (
                      await tx.query<{ version: number; company_id: string | null }>(
                        `SELECT * FROM ${table} WHERE id=$1${kind === 'couriers' ? ' AND archived_at IS NULL' : ''}`,
                        [id],
                      )
                    ).rows[0]
                  : null;
                if (update) {
                  assert(previous, 404, 'NOT_FOUND', 'الشريك غير موجود');
                  assert(
                    previous.version === ('expectedVersion' in body ? body.expectedVersion : 0),
                    409,
                    'VERSION_CONFLICT',
                    'تغيرت البيانات؛ حدّث الصفحة وأعد المحاولة',
                  );
                }
                if ('companyId' in body) {
                  if (body.companyId)
                    assert(
                      (
                        await tx.query('SELECT id FROM delivery_companies WHERE id=$1', [
                          body.companyId,
                        ])
                      ).rows.length,
                      422,
                      'INVALID_COMPANY',
                      'مكتب التوصيل غير موجود',
                    );
                  if (update) {
                    assert(
                      body.capacityKg >= (await courierCapacity(tx, id)),
                      409,
                      'CAPACITY_BELOW_RESERVED',
                      'السعة أقل من الحمولة المحجوزة',
                    );
                    if (previous!.company_id !== body.companyId) {
                      const active = await tx.query(
                        `SELECT id FROM shipments WHERE courier_id=$1 AND status NOT IN ('delivered','returned','cancelled') UNION ALL SELECT id FROM commercial_returns WHERE courier_id=$1 AND status IN ('assigned','accepted','released','in_transit')`,
                        [id],
                      );
                      assert(
                        !active.rows.length,
                        409,
                        'ACTIVE_COURIER_AFFILIATION',
                        'أكمل المهام النشطة قبل تغيير تبعية المندوب',
                      );
                    }
                  }
                  if (update)
                    await tx.query(
                      'UPDATE couriers SET name=$2,vehicle=$3,capacity_kg=$4,available=$5,company_id=$6,version=version+1 WHERE id=$1',
                      [
                        id,
                        body.name,
                        body.vehicle,
                        body.capacityKg,
                        body.available,
                        body.companyId,
                      ],
                    );
                  else
                    await tx.query(
                      'INSERT INTO couriers(id,name,vehicle,capacity_kg,available,company_id) VALUES($1,$2,$3,$4,$5,$6)',
                      [
                        id,
                        body.name,
                        body.vehicle,
                        body.capacityKg,
                        body.available,
                        body.companyId,
                      ],
                    );
                } else {
                  const values = [
                    id,
                    body.name,
                    body.address,
                    body.location.latitude,
                    body.location.longitude,
                  ];
                  if (update)
                    await tx.query(
                      'UPDATE delivery_companies SET name=$2,address=$3,latitude=$4,longitude=$5,version=version+1 WHERE id=$1',
                      values,
                    );
                  else
                    await tx.query(
                      'INSERT INTO delivery_companies(id,name,address,latitude,longitude) VALUES($1,$2,$3,$4,$5)',
                      values,
                    );
                }
                if (body.rateBps !== undefined)
                  await tx.query(`UPDATE ${table} SET rate_bps=$2 WHERE id=$1`, [id, body.rateBps]);
                await tx.query(
                  'INSERT INTO partner_audit(id,entity_id,actor_name,action,details) VALUES($1,$2,$3,$4,$5)',
                  [
                    randomUUID(),
                    id,
                    actor.name,
                    kind + (update ? '.updated' : '.created'),
                    JSON.stringify({ before: previous, after: body }),
                  ],
                );
                return { id, version: previous ? previous.version + 1 : 1 };
              },
            ),
          );
        },
      });
    }
  }
}
