import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from './db.js';
import type { Account } from '../shared/contracts.js';
import type { LocationView } from '../shared/location.js';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { assert, canonical, idempotent, loadShipment, mayRead, transactionGate } from './domain.js';
import { revokeSharing } from './location-storage.js';
type Sharing = {
  session_id: string;
  courier_id: string;
  active: boolean;
  customer_allowed: boolean;
  expires_at: string;
  sequence: number;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  measured_at: string | null;
  received_at: string | null;
  fingerprint: string | null;
};
const sharing = async (tx: Transaction, id: string) =>
  (await tx.query<Sharing>('SELECT * FROM location_sharing WHERE shipment_id=$1', [id])).rows[0];
export async function locationView(
  tx: Transaction,
  id: string,
  now: number,
  a: Account | null,
): Promise<LocationView> {
  const row = await loadShipment(tx, id);
  const own = a?.role === 'courier' && a.courierId === row.courier_id;
  const canShare = !!own && row.status === 'in_transit' && row.assignment_accepted;
  const base = { serverTime: new Date(now).toISOString(), canShare, session: null, point: null };
  if (row.status !== 'in_transit' || !row.courier_id || !row.assignment_accepted)
    return { ...base, state: 'unavailable' };
  const s = await sharing(tx, id);
  if (
    !s?.active ||
    s.courier_id !== row.courier_id ||
    new Date(s.expires_at).getTime() <= now ||
    (!a && !s.customer_allowed)
  )
    return { ...base, state: 'off' };
  const session =
    own || a?.role === 'operator'
      ? { id: s.session_id, expiresAt: s.expires_at, nextSequence: s.sequence + 1 }
      : null;
  if (s.latitude === null || s.measured_at === null || s.received_at === null)
    return { ...base, session, state: 'waiting' };
  const validUntil = Math.min(
    new Date(s.expires_at).getTime(),
    new Date(s.measured_at).getTime() + 120_000,
  );
  if (validUntil <= now) return { ...base, session, state: 'stale' };
  return {
    ...base,
    session,
    state: 'live',
    point: {
      latitude: s.latitude,
      longitude: s.longitude!,
      accuracy: s.accuracy!,
      measuredAt: s.measured_at,
      receivedAt: s.received_at,
      validUntil: new Date(validUntil).toISOString(),
    },
  };
}
export function registerLocation(
  app: FastifyInstance,
  write: ReturnType<typeof transactionGate>,
  account: (req: FastifyRequest) => Account,
  clock: () => number,
) {
  const idOf = (req: FastifyRequest) =>
    z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
  const keyOf = (req: FastifyRequest) =>
    z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  app.get('/api/shipments/:id/location', async (req) => {
    const a = account(req),
      id = idOf(req);
    return write(async (tx) => {
      const row = await loadShipment(tx, id);
      assert(a.role !== 'pickup' && mayRead(a, row), 404, 'NOT_FOUND', 'الشحنة غير موجودة');
      return locationView(tx, id, clock(), a);
    });
  });
  app.post('/api/shipments/:id/location/sharing', async (req) => {
    const a = account(req),
      id = idOf(req);
    const body = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('start'),
            expectedVersion: z.number().int().positive(),
            consent: z.literal(true),
            customerAllowed: z.boolean(),
          })
          .strict(),
        z
          .object({
            action: z.literal('stop'),
            sessionId: z.string().uuid(),
            reason: z.string().trim().min(3).max(120),
          })
          .strict(),
      ])
      .parse(req.body);
    return write((tx) =>
      idempotent(tx, `${a.id}:location:${id}`, keyOf(req), body, async () => {
        const row = await loadShipment(tx, id);
        assert(a.role !== 'pickup' && mayRead(a, row), 404, 'NOT_FOUND', 'الشحنة غير موجودة');
        if (body.action === 'stop') {
          assert(
            a.role === 'operator' || (a.role === 'courier' && a.courierId === row.courier_id),
            403,
            'FORBIDDEN',
            'إيقاف المشاركة للمندوب المكلف أو العمليات',
          );
          const s = await sharing(tx, id);
          assert(
            s?.session_id === body.sessionId,
            409,
            'SHARING_CHANGED',
            'تغيرت جلسة المشاركة؛ حدّث العرض',
          );
          await revokeSharing(tx, id, a.id, body.reason);
          return { stopped: true };
        }
        assert(
          a.role === 'courier' && a.courierId === row.courier_id,
          403,
          'FORBIDDEN',
          'بدء المشاركة للمندوب المكلف فقط',
        );
        assert(
          row.version === body.expectedVersion,
          409,
          'VERSION_CONFLICT',
          'تغيرت الشحنة؛ حدّثها قبل المشاركة',
        );
        assert(
          row.status === 'in_transit' && row.assignment_accepted,
          409,
          'LOCATION_UNAVAILABLE',
          'المشاركة خلال التوصيل فقط، بعد استلام العهدة وبدء الرحلة',
        );
        const s = await sharing(tx, id);
        assert(
          !s?.active || new Date(s.expires_at).getTime() <= clock(),
          409,
          'ALREADY_SHARING',
          'المشاركة مفعّلة؛ استأنف إرسال موقعك أو أوقفها أولًا',
        );
        const sessionId = randomUUID(),
          expiresAt = new Date(clock() + 30 * 60_000).toISOString();
        await tx.query(
          `INSERT INTO location_sharing(shipment_id,session_id,courier_id,active,customer_allowed,expires_at) VALUES($1,$2,$3,true,$4,$5) ON CONFLICT(shipment_id) DO UPDATE SET session_id=$2,courier_id=$3,active=true,customer_allowed=$4,expires_at=$5,sequence=0,latitude=NULL,longitude=NULL,accuracy=NULL,measured_at=NULL,received_at=NULL,fingerprint=NULL`,
          [id, sessionId, row.courier_id, body.customerAllowed, expiresAt],
        );
        await tx.query(
          'INSERT INTO location_audit(id,shipment_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            id,
            a.id,
            'started',
            body.customerAllowed
              ? 'موافقة مشاركة للعمليات والمتجر والعميل'
              : 'موافقة مشاركة للعمليات والمتجر',
          ],
        );
        return { sessionId, expiresAt };
      }),
    );
  });
  app.post('/api/shipments/:id/location/points', async (req) => {
    const a = account(req),
      id = idOf(req);
    const b = z
      .object({
        sessionId: z.string().uuid(),
        sequence: z.number().int().min(1).max(1000000),
        latitude: z.number().finite().min(-85).max(85),
        longitude: z.number().finite().min(-180).max(180),
        accuracy: z.number().finite().min(0).max(5000),
        measuredAt: z.string().datetime(),
      })
      .strict()
      .parse(req.body);
    return write(async (tx) => {
      const row = await loadShipment(tx, id);
      assert(
        a.role === 'courier' && a.courierId === row.courier_id,
        404,
        'NOT_FOUND',
        'الشحنة غير موجودة',
      );
      const s = await sharing(tx, id),
        now = clock();
      assert(
        row.status === 'in_transit' &&
          row.assignment_accepted &&
          s?.active &&
          s.courier_id === a.courierId &&
          s.session_id === b.sessionId &&
          new Date(s.expires_at).getTime() > now,
        409,
        'SHARING_ENDED',
        'انتهت المشاركة أو تغير تكليف المهمة',
      );
      const fingerprint = createHash('sha256').update(canonical(b)).digest('hex');
      if (b.sequence === s.sequence) {
        assert(
          fingerprint === s.fingerprint,
          409,
          'POINT_CONFLICT',
          'نفس التسلسل يحمل موقعًا مختلفًا',
        );
        return { sequence: s.sequence, receivedAt: s.received_at };
      }
      assert(b.sequence > s.sequence, 409, 'POINT_OUT_OF_ORDER', 'تحديث الموقع قديم');
      const measured = new Date(b.measuredAt).getTime();
      assert(
        measured <= now + 10_000 &&
          measured > now - 120_000 &&
          (!s.measured_at || measured > new Date(s.measured_at).getTime()),
        422,
        'INVALID_LOCATION_TIME',
        'وقت الموقع قديم أو غير صحيح',
      );
      assert(
        !s.received_at || now - new Date(s.received_at).getTime() >= 5000,
        429,
        'LOCATION_RATE_LIMIT',
        'انتظر خمس ثوانٍ قبل التحديث التالي',
      );
      const receivedAt = new Date(now).toISOString();
      await tx.query(
        'UPDATE location_sharing SET sequence=$2,latitude=$3,longitude=$4,accuracy=$5,measured_at=$6,received_at=$7,fingerprint=$8 WHERE shipment_id=$1',
        [
          id,
          b.sequence,
          b.latitude,
          b.longitude,
          b.accuracy,
          b.measuredAt,
          receivedAt,
          fingerprint,
        ],
      );
      return { sequence: b.sequence, receivedAt };
    });
  });
}
