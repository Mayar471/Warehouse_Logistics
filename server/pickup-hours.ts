import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account } from '../shared/contracts.js';
import {
  defaultPickupSchedule,
  pickupOpening,
  type PickupSchedule,
} from '../shared/pickup-hours.js';
import type { Transaction } from './db.js';
import { assert, idempotent, transactionGate } from './domain.js';
const start = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/);
const intervals = z
  .array(z.object({ start, end }).strict())
  .max(2)
  .superRefine((rows, ctx) => {
    let last = '';
    for (const [i, row] of rows.entries()) {
      if (row.start >= row.end || row.start < last)
        ctx.addIssue({
          code: 'custom',
          message: 'الفترات مرتبة وغير متداخلة وتنتهي بعد البداية',
          path: [i],
        });
      last = row.end;
    }
  });
const date = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'تاريخ غير صالح');
export const pickupScheduleSchema = z
  .object({
    mode: z.enum(['always', 'weekly']),
    days: z.array(z.object({ day: z.number().int().min(0).max(6), intervals }).strict()).max(7),
    exceptions: z
      .array(z.object({ date, intervals, reason: z.string().trim().min(3).max(160) }).strict())
      .max(90),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.days.map((d) => d.day)).size !== s.days.length ||
      new Set(s.exceptions.map((e) => e.date)).size !== s.exceptions.length ||
      (s.mode === 'weekly' && s.days.length !== 7) ||
      (s.mode === 'always' && s.days.length !== 0)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'حدد الأيام السبعة دون تكرار، أو دوامًا مستمرًا دون أيام. الاستثناءات لا تتكرر.',
      });
  });
export async function requirePickupOpen(tx: Transaction, id: string, now: number, newOrder = true) {
  const point = (
    await tx.query<{
      pickup_enabled: boolean;
      archived_at: string | null;
      pickup_schedule: PickupSchedule;
    }>(
      "SELECT pickup_enabled,archived_at,pickup_schedule FROM sites WHERE id=$1 AND kind='pickup'",
      [id],
    )
  ).rows[0];
  assert(
    point && !point.archived_at && (!newOrder || point.pickup_enabled),
    422,
    'INVALID_PICKUP_SITE',
    'نقطة الاستلام غير متاحة',
  );
  const status = pickupOpening(point.pickup_schedule, now);
  assert(status.openNow, 409, 'PICKUP_CLOSED', status.label + '؛ اختر نقطة أخرى أو انتظر فتحها');
  return status;
}
export function registerPickupHours(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (r: FastifyRequest) => Account,
  clock: () => number,
) {
  const access = (req: FastifyRequest, id: string, edit = false) => {
    const a = account(req);
    assert(
      a.role === 'operator' || (!edit && a.role === 'pickup' && a.pickupSiteId === id),
      403,
      'FORBIDDEN',
      'الدوام لإدارة العمليات وموظف النقطة المعنية فقط',
    );
    return a;
  };
  const idOf = (req: FastifyRequest) =>
    z
      .string()
      .min(1)
      .max(40)
      .parse((req.params as { id: string }).id);
  app.get('/api/network/pickup-sites/:id/hours', async (req) => {
    const id = idOf(req);
    access(req, id);
    return write(async (tx) => {
      const p = (
        await tx.query<{ version: number; pickup_schedule: PickupSchedule }>(
          "SELECT version,pickup_schedule FROM sites WHERE id=$1 AND kind='pickup' AND archived_at IS NULL",
          [id],
        )
      ).rows[0];
      assert(p, 404, 'NOT_FOUND', 'النقطة غير موجودة');
      return {
        id,
        version: p.version,
        schedule: p.pickup_schedule ?? defaultPickupSchedule(),
        status: pickupOpening(p.pickup_schedule, clock()),
      };
    });
  });
  app.put('/api/network/pickup-sites/:id/hours', async (req) => {
    const id = idOf(req),
      a = access(req, id, true),
      key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    const b = z
      .object({
        expectedVersion: z.number().int().positive(),
        schedule: pickupScheduleSchema,
        reason: z.string().trim().min(3).max(240),
      })
      .strict()
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:pickup-hours:${id}`, key, b, async () => {
        const old = (
          await tx.query<{ version: number; pickup_schedule: PickupSchedule }>(
            "SELECT version,pickup_schedule FROM sites WHERE id=$1 AND kind='pickup' AND archived_at IS NULL",
            [id],
          )
        ).rows[0];
        assert(old, 404, 'NOT_FOUND', 'النقطة غير موجودة');
        assert(
          old.version === b.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت بيانات النقطة؛ حدّث الدوام قبل الحفظ',
        );
        await tx.query('UPDATE sites SET pickup_schedule=$2,version=version+1 WHERE id=$1', [
          id,
          JSON.stringify(b.schedule),
        ]);
        await tx.query(
          'INSERT INTO network_audit(id,site_id,actor_name,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            id,
            a.name,
            'hours_updated',
            b.reason,
            JSON.stringify({
              before: old.pickup_schedule,
              after: b.schedule,
              version: old.version + 1,
            }),
          ],
        );
        return {
          id,
          version: old.version + 1,
          schedule: b.schedule,
          status: pickupOpening(b.schedule, clock()),
        };
      }),
    );
  });
}
