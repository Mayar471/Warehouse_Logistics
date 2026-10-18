import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from './helpers/inventory.js';
import {
  defaultPickupSchedule,
  pickupOpening,
  type PickupSchedule,
} from '../shared/pickup-hours.js';
import { pickupScheduleSchema } from '../server/pickup-hours.js';
const at = (time: string, date = '2026-10-18') => Date.parse(`${date}T${time}:00+03:00`);
const weekly = (): PickupSchedule => ({
  mode: 'weekly',
  days: Array.from({ length: 7 }, (_, day) => ({
    day,
    intervals:
      day === 5
        ? []
        : [
            { start: '09:00', end: '12:00' },
            { start: '14:00', end: '18:00' },
          ],
  })),
  exceptions: [],
});
async function setup(path?: string) {
  const f = await fixture(path);
  f.setNow(at('09:00'));
  const hours = async () => (await f.get('/api/network/pickup-sites/pickup-a/hours')).json();
  const save = async (
    schedule: PickupSchedule,
    who = 'ops',
    key = crypto.randomUUID(),
    version?: number,
  ) =>
    f.app.inject({
      method: 'PUT',
      url: '/api/network/pickup-sites/pickup-a/hours',
      headers: { cookie: f.cookies[who], 'idempotency-key': key },
      payload: {
        schedule,
        expectedVersion: version ?? (await hours()).version,
        reason: 'تحديث دوام النقطة',
      },
    });
  const checkout = () =>
    f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        recipientName: 'عميل الدوام',
        district: 'الروضة',
        address: 'عنوان اختبار دمشق',
        pickupSiteId: 'pickup-a',
      },
      'shop',
    );
  const list = () =>
    f.app.inject({ url: '/api/storefront/pickup-sites', headers: { cookie: f.shop } });
  return { ...f, hours, save, checkout, list };
}
test('Damascus weekly hours include start, exclude end, respect breaks, holidays and local midnight', () => {
  const s = weekly();
  assert.equal(pickupOpening(s, at('08:59')).openNow, false);
  assert.equal(pickupOpening(s, at('09:00')).openNow, true);
  assert.equal(pickupOpening(s, at('12:00')).openNow, false);
  assert.equal(pickupOpening(s, at('14:00')).openNow, true);
  assert.equal(pickupOpening(s, at('18:00')).openNow, false);
  assert.equal(pickupOpening(s, at('10:00', '2026-10-23')).openNow, false);
  s.exceptions = [{ date: '2026-10-18', intervals: [], reason: 'عطلة' }];
  assert.equal(pickupOpening(s, at('10:00')).openNow, false);
  s.exceptions[0].intervals = [{ start: '00:00', end: '24:00' }];
  assert.equal(pickupOpening(s, at('23:59')).openNow, true);
  assert.equal(pickupOpening(s, Date.parse('2026-10-18T21:01:00Z')).localDate, '2026-10-19');
  assert.equal(pickupOpening(defaultPickupSchedule(), at('00:00')).openNow, true);
});
test('schedule rejects duplicate days, invalid dates, ambiguous overnight and overlapping intervals', () => {
  const s = weekly();
  assert.equal(pickupScheduleSchema.safeParse(s).success, true);
  for (const bad of [
    { ...s, days: s.days.slice(1) },
    { ...s, days: s.days.map((d) => ({ ...d, day: 0 })) },
    { ...s, days: s.days.map((d) => ({ ...d, intervals: [{ start: '18:00', end: '09:00' }] })) },
    {
      ...s,
      days: s.days.map((d) => ({
        ...d,
        intervals: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '18:00' },
        ],
      })),
    },
    { ...s, exceptions: [{ date: '2026-02-30', intervals: [], reason: 'عطلة' }] },
    {
      ...s,
      exceptions: [
        { date: '2026-10-18', intervals: [], reason: 'عطلة' },
        { date: '2026-10-18', intervals: [], reason: 'عطلة' },
      ],
    },
  ])
    assert.equal(pickupScheduleSchema.safeParse(bad).success, false);
});
test('hours are scoped, versioned, replayable and atomic with their audit record', async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.get('/api/network/pickup-sites/pickup-a/hours', 'pickup-a')).statusCode,
      200,
    );
    assert.equal(
      (await f.get('/api/network/pickup-sites/pickup-a/hours', 'merchant-a')).statusCode,
      403,
    );
    assert.equal(
      (await f.get('/api/network/pickup-sites/site-a/hours', 'pickup-a')).statusCode,
      403,
    );
    assert.equal((await f.save(weekly(), 'pickup-a')).statusCode, 403);
    const version = (await f.hours()).version,
      key = crypto.randomUUID();
    const r = await f.save(weekly(), 'ops', key, version);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await f.save(weekly(), 'ops', key, version)).statusCode, 200);
    assert.equal(
      (await f.save(weekly(), 'ops', crypto.randomUUID(), version)).json().code,
      'VERSION_CONFLICT',
    );
    await f.db.exec(
      `CREATE FUNCTION reject_hours_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='hours_updated' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_hours_audit BEFORE INSERT ON network_audit FOR EACH ROW EXECUTE FUNCTION reject_hours_audit();`,
    );
    const before = await f.hours();
    assert.equal((await f.save(defaultPickupSchedule())).statusCode, 500);
    assert.deepEqual(await f.hours(), before);
    assert.equal(
      (await f.db.query("SELECT id FROM network_audit WHERE action='hours_updated'")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('list exposes current hours without private exception details, nearest excludes closed points and checkout rejects closure', async () => {
  const f = await setup();
  try {
    await f.db.query("UPDATE sites SET latitude=33.51,longitude=36.27 WHERE id='pickup-a'");
    await f.save({
      ...weekly(),
      exceptions: [{ date: '2026-10-18', intervals: [], reason: 'سبب إداري خاص' }],
    });
    const list = (await f.list()).json().sites;
    assert.equal(list[0].openingStatus.openNow, false);
    assert.equal(JSON.stringify(list).includes('سبب إداري خاص'), false);
    assert.equal(JSON.stringify(list).includes('pickupSchedule'), false);
    const near = await f.post(
      '/api/storefront/pickup-sites/nearest',
      { latitude: 33.51, longitude: 36.27 },
      'shop',
    );
    assert.equal(near.statusCode, 200);
    assert.equal(near.json().sites.length, 0);
    assert.equal((await f.checkout()).json().code, 'PICKUP_CLOSED');
    assert.equal((await f.db.query('SELECT id FROM storefront_checkouts')).rows.length, 0);
    await f.save(weekly());
    assert.equal((await f.checkout()).statusCode, 200);
  } finally {
    await f.close();
  }
});
test('confirmation rechecks time and settings after quote and does not consume checkout or reserve inventory on closure', async () => {
  const f = await setup();
  try {
    await f.save({
      ...weekly(),
      days: weekly().days.map((d) => ({ ...d, intervals: [{ start: '09:00', end: '09:05' }] })),
    });
    const c = (await f.checkout()).json();
    f.setNow(at('09:05'));
    assert.equal((await f.order(c.id)).json().code, 'PICKUP_CLOSED');
    assert.equal((await f.stock()).reserved, 0);
    assert.equal(
      (
        await f.db.query<{ consumed: boolean }>('SELECT consumed FROM quotes WHERE id=$1', [
          c.quote.id,
        ])
      ).rows[0].consumed,
      false,
    );
    f.setNow(at('09:00'));
    await f.save(weekly());
    assert.equal((await f.order(c.id)).json().code, 'QUOTE_SITE_CHANGED');
    const next = (await f.checkout()).json();
    assert.equal((await f.order(next.id)).statusCode, 200);
    const done = (await f.order(next.id)).json();
    f.setNow(at('18:01'));
    assert.equal((await f.order(next.id)).json().shipment.id, done.shipment.id);
  } finally {
    await f.close();
  }
});
test('closed point refuses new custody without releasing courier; closing after receipt does not block customer handover', async () => {
  const f = await setup();
  try {
    const c = (await f.checkout()).json();
    let s = (await f.order(c.id)).json().shipment;
    for (const [action, who, extra] of [
      ['prepare', 'merchant-a', {}],
      ['assign', 'ops', { courierId: 'courier-b' }],
      ['accept', 'courier-b', {}],
      ['handover_origin', 'merchant-a', { courierId: 'courier-b' }],
      ['pickup', 'courier-b', {}],
      ['depart', 'courier-b', {}],
      ['arrive_pickup', 'courier-b', {}],
    ] as [string, string, Record<string, unknown>][])
      s = await f.act(s, action, who, extra);
    const closed = {
      ...defaultPickupSchedule(),
      exceptions: [{ date: '2026-10-18', intervals: [], reason: 'إغلاق استثنائي' }],
    };
    await f.save(closed);
    const before = (await f.get('/api/shipments/' + s.id)).json();
    assert.equal((await f.action(s, 'receive_pickup', 'pickup-a')).json().code, 'PICKUP_CLOSED');
    assert.deepEqual((await f.get('/api/shipments/' + s.id)).json(), before);
    await f.save(defaultPickupSchedule());
    // Manual new-order pause does not block an already committed incoming parcel during opening hours.
    await f.db.query("UPDATE sites SET pickup_enabled=false WHERE id='pickup-a'");
    s = await f.act(s, 'receive_pickup', 'pickup-a');
    await f.save(closed);
    const proof = await f.post(`/api/storefront/orders/${s.id}/delivery-code`, {}, 'shop');
    assert.equal(proof.statusCode, 200);
    s = await f.act(s, 'release_pickup', 'pickup-a', { deliveryCode: proof.json().code });
    assert.equal(s.status, 'delivered');
  } finally {
    await f.close();
  }
});
test('hours migration retains existing default and custom schedule, exceptions and version across restart', async () => {
  const path = await mkdtemp(join(resolve('artifacts'), 'pickup-hours-'));
  const f = await setup(path);
  let version = 0;
  try {
    assert.equal((await f.hours()).schedule.mode, 'always');
    await f.save(weekly());
    version = (await f.hours()).version;
    await f.db.query('DELETE FROM schema_migrations WHERE version=28');
  } finally {
    await f.close();
  }
  const next = await setup(path);
  try {
    const view = await next.hours();
    assert.equal(view.version, version);
    assert.deepEqual(view.schedule, weekly());
    assert.equal(
      (await next.db.query('SELECT version FROM schema_migrations WHERE version=28')).rows.length,
      1,
    );
  } finally {
    await next.close();
  }
});
