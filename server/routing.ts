import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Coordinates } from '../shared/customer-locations.js';
import type { DispatchPreview } from '../shared/dispatch.js';
import { assert, canonical } from './domain.js';

export interface RouteCost {
  durationSeconds: number;
  roadDistanceKm: number;
}
export interface RoutingProvider {
  id: string;
  table(origin: Coordinates, couriers: Coordinates[]): Promise<(RouteCost | null)[]>;
}
const cost = z
  .object({
    durationSeconds: z.number().finite().nonnegative().max(86400),
    roadDistanceKm: z.number().finite().nonnegative().max(2000),
  })
  .strict()
  .nullable();
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

// Explicit server configuration only. Never accept a provider URL from a browser request.
export function osrmProvider(baseUrl: string, providerId = 'OSRM driving'): RoutingProvider {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid OSRM base URL');
  if (!providerId.trim() || providerId.length > 80)
    throw new Error('Invalid routing provider name');
  return {
    id: providerId,
    async table(origin, couriers) {
      const coordinates = [...couriers, origin]
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');
      const url = new URL(`${base.toString().replace(/\/$/, '')}/table/v1/driving/${coordinates}`);
      url.searchParams.set('sources', couriers.map((_, i) => i).join(';'));
      url.searchParams.set('destinations', String(couriers.length));
      url.searchParams.set('annotations', 'duration,distance');
      // No fallback_speed: an unreachable route must remain unreachable.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || !response.body) throw new Error('Routing unavailable');
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 256_000) throw new Error('Routing response too large');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const matrix = z
        .object({
          code: z.literal('Ok'),
          durations: z
            .array(z.array(z.number().finite().nonnegative().nullable()).length(1))
            .length(couriers.length),
          distances: z
            .array(z.array(z.number().finite().nonnegative().nullable()).length(1))
            .length(couriers.length),
          fallback_speed_cells: z.array(z.unknown()).max(0).optional(),
        })
        .parse(data);
      return matrix.durations.map((row, i) => {
        if (row[0] === null && matrix.distances[i][0] === null) return null;
        if (row[0] === null || matrix.distances[i][0] === null)
          throw new Error('Inconsistent route');
        return cost.parse({
          durationSeconds: row[0],
          roadDistanceKm: matrix.distances[i][0]! / 1000,
        });
      });
    },
  };
}

type Prepared = {
  preview: DispatchPreview;
  points: Map<string, Coordinates>;
  origin: Coordinates | null;
};
type Matrix = { costs: (RouteCost | null)[]; expiresAt: number };
export class DispatchRouting {
  private matrices = new Map<string, Matrix>();
  private pending = new Map<string, Promise<Matrix>>();
  private snapshots = new Map<
    string,
    { id: string; base: string; expiresAt: number; preview: DispatchPreview }
  >();
  private failures = 0;
  private retryAfter = 0;
  constructor(
    private provider: RoutingProvider | undefined,
    private clock: () => number,
  ) {}
  private async matrix(origin: Coordinates, points: Coordinates[]) {
    const key = digest({ provider: this.provider!.id, origin, points });
    const cached = this.matrices.get(key);
    if (cached && cached.expiresAt > this.clock()) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= 2 || this.clock() < this.retryAfter) throw new Error('Routing busy');
    const operation = Promise.resolve().then(() => this.provider!.table(origin, points));
    const request = (async () => {
      // Bound even injected/custom providers that do not implement cancellation.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const costs = z
          .array(cost)
          .length(points.length)
          .parse(
            await Promise.race([
            operation,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Routing timeout')), 3000);
              }),
            ]),
          );
        const result = { costs, expiresAt: this.clock() + 60_000 };
        if (this.matrices.size >= 128) this.matrices.delete(this.matrices.keys().next().value!);
        this.matrices.set(key, result);
        this.failures = 0;
        return result;
      } catch (e) {
        if (++this.failures >= 3) this.retryAfter = this.clock() + 30_000;
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
        // A non-cooperative provider must not free a slot while its I/O is still running.
        void operation.finally(() => this.pending.delete(key)).catch(() => {});
      }
    })();
    this.pending.set(key, request);
    return request;
  }
  async preview(id: string, prepared: Prepared): Promise<DispatchPreview> {
    const base = prepared.preview;
    let preview: DispatchPreview = { ...base, candidates: base.candidates.map((c) => ({ ...c })) };
    let expiresAt = this.clock() + 60_000;
    let state: 'disabled' | 'available' | 'unavailable' = 'disabled',
      evaluated = 0,
      unreachable = 0;
    let note = 'خدمة الطرق غير مفعلة؛ الترتيب بالمسافة المستقيمة التقريبية.';
    if (this.provider && !base.blocked && base.candidates.length && prepared.origin) {
      const shortlist = base.candidates.slice(0, 10);
      try {
        const matrix = await this.matrix(
          prepared.origin,
          shortlist.map((c) => prepared.points.get(c.id)!),
        );
        state = 'available';
        evaluated = shortlist.length;
        expiresAt = matrix.expiresAt;
        const routed = shortlist.flatMap((c, i) => {
          const value = matrix.costs[i];
          if (!value) {
            unreachable++;
            return [];
          }
          return [{ ...c, ...value }];
        });
        routed.sort(
          (a, b) =>
            (base.priority === 'urgent' ? a.durationSeconds - b.durationSeconds : 0) ||
            a.utilization - b.utilization ||
            a.jobs - b.jobs ||
            a.durationSeconds - b.durationSeconds ||
            a.id.localeCompare(b.id),
        );
        preview = {
          ...preview,
          method: 'road',
          candidates: routed,
          blocked: routed.length
            ? null
            : 'لا يوجد طريق صالح ضمن المرشحين المفحوصين؛ راجع القائمة أو الإسناد اليدوي',
        };
        note =
          'زمن طريق مقدر بنموذج قيادة سيارة من موقع المندوب إلى الاستلام؛ لا يشمل تجهيز الطرد أو المهام السابقة أو الازدحام الحي، وليس خاصًا بنوع مركبته. قورنت قائمة أولية من عشرة مرشحين كحد أقصى؛ ليس ضمانًا للأسرع في الشبكة كلها.';
      } catch {
        state = 'unavailable';
        note = 'تعذرت خدمة الطرق؛ عاد الترتيب إلى المسافة المستقيمة التقريبية، دون عرض زمن وصول.';
      }
    }
    // A snapshot cannot outlive the consented fixes on which it was based.
    for (const c of preview.candidates)
      expiresAt = Math.min(expiresAt, Date.parse(c.measuredAt) + 5 * 60_000);
    preview.routing = {
      state,
      provider: this.provider?.id ?? null,
      evaluated,
      notEvaluated: state === 'available' ? base.candidates.length - evaluated : 0,
      unreachable,
      expiresAt: new Date(expiresAt).toISOString(),
      note,
    };
    preview.token = digest({ id, base: base.token, preview, expiresAt });
    for (const [key, value] of this.snapshots)
      if (value.expiresAt <= this.clock()) this.snapshots.delete(key);
    if (this.snapshots.size >= 1000) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(preview.token, { id, base: base.token, expiresAt, preview });
    return preview;
  }
  confirm(id: string, token: string, current: DispatchPreview) {
    const stored = this.snapshots.get(token);
    assert(
      stored &&
        stored.id === id &&
        stored.expiresAt > this.clock() &&
        stored.base === current.token,
      409,
      'DISPATCH_CHANGED',
      'انتهت المعاينة أو تغيرت بيانات الترشيح؛ حدّث القائمة وراجع الاختيار',
    );
    return stored.preview;
  }
}
