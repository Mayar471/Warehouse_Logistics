import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Account } from '../shared/contracts.js';
import type { DispatchPreview } from '../shared/dispatch.js';
import { distanceKm } from '../shared/customer-locations.js';
import type { Transaction } from './db.js';
import { dispatchCell, dispatchCover, dispatchResolution } from './spatial-index.js';
import { DispatchRouting, type RoutingProvider } from './routing.js';
import {
  applyAction,
  assert,
  canonical,
  courierWorkloads,
  idempotent,
  loadShipment,
  transactionGate,
} from './domain.js';

export const dispatchPolicy = {
  version: 'local-v2',
  freshnessMs: 5 * 60_000,
  maxAccuracy: 200,
  radiusKm: 30,
} as const;
export async function prepareDispatch(tx: Transaction, id: string, now: number) {
  const s = await loadShipment(tx, id);
  const siteId = s.status === 'pickup_expired' ? s.custody_site_id : s.origin_id;
  const site = (
    await tx.query<{ latitude: number | null; longitude: number | null; city: string }>(
      'SELECT latitude,longitude,city FROM sites WHERE id=$1 AND archived_at IS NULL',
      [siteId],
    )
  ).rows[0];
  const blocked = !['ready', 'pickup_expired'].includes(s.status)
    ? 'الشحنة ليست جاهزة للإسناد'
    : !site || site.city !== 'دمشق'
      ? 'الترشيح المحلي متاح داخل دمشق فقط'
      : site.latitude === null || site.longitude === null
        ? 'حدد موقع استلام الطرد من شبكة الشركاء أولًا'
        : null;
  const candidates: DispatchPreview['candidates'] = [];
  const points = new Map<string, { latitude: number; longitude: number }>();
  const cover = blocked
    ? null
    : dispatchCover(
        { latitude: site!.latitude!, longitude: site!.longitude! },
        dispatchPolicy.radiusKm,
      );
  const spatial = {
    index: cover ? ('h3' as const) : ('exhaustive' as const),
    resolution: dispatchResolution,
    cells: cover?.length ?? 0,
    scannedCouriers: 0,
    totalCouriers: 0,
  };
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  if (!blocked) {
    const rows = (
      await tx.query<{
        id: string;
        name: string;
        available: boolean;
        capacity_kg: number;
        latitude: number | null;
        longitude: number | null;
        accuracy: number | null;
        measured_at: string | null;
      }>(
        'SELECT c.id,c.name,c.available,c.capacity_kg,l.latitude,l.longitude,l.accuracy,l.measured_at FROM couriers c LEFT JOIN dispatch_locations l ON l.courier_id=c.id WHERE c.archived_at IS NULL AND ($1::text[] IS NULL OR l.h3_cell IS NULL OR l.h3_cell=ANY($1)) ORDER BY c.id',
        [cover],
      )
    ).rows;
    spatial.scannedCouriers = rows.length;
    spatial.totalCouriers = (
      await tx.query<{ n: number }>(
        'SELECT COUNT(*)::integer n FROM couriers WHERE archived_at IS NULL',
      )
    ).rows[0].n;
    const workloads = await courierWorkloads(
      tx,
      rows.map((c) => c.id),
    );
    for (const c of rows) {
      if (!c.available) {
        exclude('غير متاح');
        continue;
      }
      const used = workloads.get(c.id)?.kg ?? 0;
      if (used + s.weight_kg > c.capacity_kg) {
        exclude('السعة لا تكفي');
        continue;
      }
      const measured = c.measured_at ? new Date(c.measured_at).getTime() : NaN;
      if (
        c.latitude === null ||
        c.longitude === null ||
        !Number.isFinite(measured) ||
        measured > now + 30_000 ||
        now - measured >= dispatchPolicy.freshnessMs ||
        c.accuracy === null ||
        c.accuracy > dispatchPolicy.maxAccuracy
      ) {
        exclude('موقع غير متاح أو غير حديث');
        continue;
      }
      const km = distanceKm(
        { latitude: site!.latitude!, longitude: site!.longitude! },
        { latitude: c.latitude, longitude: c.longitude },
      );
      if (km > dispatchPolicy.radiusKm) {
        exclude('خارج نطاق الترشيح المحلي (٣٠ كم)');
        continue;
      }
      candidates.push({
        id: c.id,
        name: c.name,
        freeKg: c.capacity_kg - used,
        utilization: used / c.capacity_kg,
        jobs: workloads.get(c.id)?.jobs ?? 0,
        distanceKm: km,
        measuredAt: new Date(measured).toISOString(),
      });
      points.set(c.id, { latitude: c.latitude, longitude: c.longitude });
    }
    candidates.sort(
      (a, b) =>
        (s.priority === 'urgent' ? a.distanceKm - b.distanceKm : 0) ||
        a.utilization - b.utilization ||
        a.jobs - b.jobs ||
        a.distanceKm - b.distanceKm ||
        a.id.localeCompare(b.id),
    );
  }
  const result = {
    shipmentVersion: s.version,
    priority: s.priority,
    method: 'straight-line' as const,
    policy: dispatchPolicy.version,
    candidates,
    excluded,
    blocked,
    spatial,
  };
  const token = createHash('sha256')
    .update(canonical({ ...result, site }))
    .digest('hex');
  return {
    preview: { ...result, token },
    points,
    origin:
      site && site.latitude !== null && site.longitude !== null
        ? { latitude: site.latitude, longitude: site.longitude }
        : null,
  };
}
export async function dispatchPreview(
  tx: Transaction,
  id: string,
  now: number,
): Promise<DispatchPreview> {
  return (await prepareDispatch(tx, id, now)).preview;
}

export function registerDispatch(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
  provider?: RoutingProvider,
) {
  const routing = new DispatchRouting(provider, clock);
  const courier = (req: FastifyRequest) => {
    const a = account(req);
    assert(a.role === 'courier' && a.courierId, 403, 'FORBIDDEN', 'هذا الإجراء للمندوب فقط');
    return a;
  };
  const operator = (req: FastifyRequest) => {
    const a = account(req);
    assert(a.role === 'operator', 403, 'FORBIDDEN', 'الترشيح لإدارة العمليات فقط');
    return a;
  };
  app.get('/api/dispatch/location', async (req) => {
    const a = courier(req);
    return write(async (tx) => {
      await tx.query('DELETE FROM dispatch_locations WHERE measured_at<=$1', [
        new Date(clock() - dispatchPolicy.freshnessMs).toISOString(),
      ]);
      const row = (
        await tx.query<{ measured_at: string }>(
          'SELECT measured_at FROM dispatch_locations WHERE courier_id=$1',
          [a.courierId],
        )
      ).rows[0];
      return {
        active: !!row,
        routingProvider: provider?.id ?? null,
        expiresAt: row
          ? new Date(new Date(row.measured_at).getTime() + dispatchPolicy.freshnessMs).toISOString()
          : null,
      };
    });
  });
  app.post('/api/dispatch/location', async (req) => {
    const a = courier(req);
    const b = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('revoke') }).strict(),
        z
          .object({
            action: z.literal('share'),
            consent: z.literal(true),
            latitude: z.number().finite().min(-85).max(85),
            longitude: z.number().finite().min(-180).max(180),
            accuracy: z.number().finite().min(0).max(dispatchPolicy.maxAccuracy),
            measuredAt: z.string().datetime(),
          })
          .strict(),
      ])
      .parse(req.body);
    return write(async (tx) => {
      if (b.action === 'revoke') {
        await tx.query('DELETE FROM dispatch_locations WHERE courier_id=$1', [a.courierId]);
        return { active: false, expiresAt: null };
      }
      const now = clock(),
        measured = Date.parse(b.measuredAt);
      assert(
        measured <= now + 30_000 && measured >= now - 60_000,
        422,
        'STALE_LOCATION',
        'أعد تحديد موقعك الحالي؛ القياس قديم أو توقيت الجهاز غير صحيح',
      );
      const c = (
        await tx.query(
          'SELECT id FROM couriers WHERE id=$1 AND archived_at IS NULL AND available',
          [a.courierId],
        )
      ).rows[0];
      assert(c, 409, 'COURIER_UNAVAILABLE', 'فعّل توفر المندوب قبل مشاركة موقعه للترشيح');
      const old = (
        await tx.query<{ measured_at: string }>(
          'SELECT measured_at FROM dispatch_locations WHERE courier_id=$1',
          [a.courierId],
        )
      ).rows[0];
      assert(
        !old || measured > new Date(old.measured_at).getTime(),
        409,
        'OLD_LOCATION',
        'وصل قياس أحدث؛ حدّث الحالة',
      );
      await tx.query(
        'INSERT INTO dispatch_locations(courier_id,latitude,longitude,accuracy,measured_at,received_at,h3_cell) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(courier_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy=EXCLUDED.accuracy,measured_at=EXCLUDED.measured_at,received_at=EXCLUDED.received_at,h3_cell=EXCLUDED.h3_cell',
        [
          a.courierId,
          b.latitude,
          b.longitude,
          b.accuracy,
          b.measuredAt,
          new Date(now).toISOString(),
          dispatchCell(b),
        ],
      );
      return {
        active: true,
        expiresAt: new Date(measured + dispatchPolicy.freshnessMs).toISOString(),
      };
    });
  });
  app.get('/api/shipments/:id/dispatch', async (req) => {
    operator(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const prepared = await write((tx) => prepareDispatch(tx, id, clock()));
    return routing.preview(id, prepared);
  });
  app.post('/api/shipments/:id/dispatch', async (req) => {
    const a = operator(req),
      id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
    const b = z
      .object({
        expectedVersion: z.number().int().positive(),
        token: z.string().regex(/^[a-f0-9]{64}$/),
        courierId: z.string().min(1).max(80),
      })
      .strict()
      .parse(req.body);
    const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
    return write((tx) =>
      idempotent(tx, `${a.id}:${id}:dispatch`, key, b, async () => {
        const current = await dispatchPreview(tx, id, clock());
        const preview = routing.confirm(id, b.token, current);
        assert(
          preview.shipmentVersion === b.expectedVersion,
          409,
          'DISPATCH_CHANGED',
          'تغيرت بيانات الترشيح؛ حدّث القائمة وراجع الاختيار',
        );
        assert(
          !preview.blocked && preview.candidates[0]?.id === b.courierId,
          409,
          'NO_CANDIDATE',
          'لا يوجد مندوب مؤهل مطابق للترشيح الحالي',
        );
        const s = await loadShipment(tx, id);
        const c = preview.candidates[0];
        const decision = `ترشيح ${dispatchPolicy.version} للطلب ${s.priority === 'urgent' ? 'المستعجل' : 'العادي'}؛ ${preview.method === 'road' ? `زمن طريق مقدر ${Math.ceil(c.durationSeconds! / 60)} دقيقة عبر ${preview.routing!.provider}؛ لا يشمل الانتظار أو الازدحام الحي` : `مسافة مستقيمة ${c.distanceKm.toFixed(2)} كم؛ ليس تقدير زمن وصول`}`;
        return applyAction(
          tx,
          a,
          id,
          s.status === 'pickup_expired' ? 'assign_return' : 'assign',
          b.expectedVersion,
          b.courierId,
          undefined,
          clock(),
          undefined,
          undefined,
          undefined,
          decision,
        );
      }),
    );
  });
}
