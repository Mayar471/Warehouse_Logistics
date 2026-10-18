import test from 'node:test';
import assert from 'node:assert/strict';
import { cellToBoundary } from 'h3-js';
import { dispatchCell, dispatchCover } from '../server/spatial-index.js';
import { fixture } from './helpers/inventory.js';

test('H3 cover contains spherical radius samples including cell boundaries; unsupported wrap falls back to exhaustive', () => {
  const origins = [
    { latitude: 33.51, longitude: 36.29 },
    { latitude: 0, longitude: 0 },
    { latitude: 65, longitude: 15 },
    ...cellToBoundary(dispatchCell({ latitude: 33.51, longitude: 36.29 })).map(
      ([latitude, longitude]) => ({ latitude, longitude }),
    ),
  ];
  let compared = 0;
  for (const origin of origins) {
    const cells = dispatchCover(origin, 30);
    assert.ok(cells);
    const cover = new Set(cells),
      lat = (origin.latitude * Math.PI) / 180,
      lon = (origin.longitude * Math.PI) / 180;
    for (const km of [0, 1, 5, 29.999, 30])
      for (let bearing = 0; bearing < 360; bearing += 3) {
        const angle = km / 6371,
          az = (bearing * Math.PI) / 180;
        const latitude = Math.asin(
          Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(az),
        );
        const longitude =
          lon +
          Math.atan2(
            Math.sin(az) * Math.sin(angle) * Math.cos(lat),
            Math.cos(angle) - Math.sin(lat) * Math.sin(latitude),
          );
        assert.ok(
          cover.has(
            dispatchCell({
              latitude: (latitude * 180) / Math.PI,
              longitude: (longitude * 180) / Math.PI,
            }),
          ),
          `Missing boundary sample ${JSON.stringify(origin)}, ${km}, ${bearing}`,
        );
        compared++;
      }
  }
  assert.equal(dispatchCover({ latitude: 0, longitude: 179.99 }, 30), null);
  assert.equal(dispatchCover({ latitude: 89.99, longitude: 0 }, 30), null);
  console.log(`Compared ${compared} geographic samples without a missing radius candidate`);
});

test('restored dispatch stores H3 with consented fix and skips indexed distant couriers', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.setNow(now);
    await f.db.query("UPDATE sites SET latitude=33.51,longitude=36.29 WHERE id='site-a'");
    const share = await f.post(
      '/api/dispatch/location',
      {
        action: 'share',
        consent: true,
        latitude: 33.52,
        longitude: 36.29,
        accuracy: 15,
        measuredAt: new Date(now).toISOString(),
      },
      'courier-b',
    );
    assert.equal(share.statusCode, 200, share.body);
    const cell = (
      await f.db.query<{ h3_cell: string }>(
        "SELECT h3_cell FROM dispatch_locations WHERE courier_id='courier-b'",
      )
    ).rows[0].h3_cell;
    assert.equal(cell, dispatchCell({ latitude: 33.52, longitude: 36.29 }));
    await f.db.query(
      "INSERT INTO couriers(id,name,vehicle,capacity_kg,available) SELECT 'remote-'||g,'مندوب اختبار بعيد','دراجة',10,true FROM generate_series(1,500) g",
    );
    await f.db.query(
      "INSERT INTO dispatch_locations(courier_id,latitude,longitude,accuracy,measured_at,received_at,h3_cell) SELECT 'remote-'||g,35,37,15,$1,$1,$2 FROM generate_series(1,500) g",
      [new Date(now).toISOString(), dispatchCell({ latitude: 35, longitude: 37 })],
    );
    const s = (await f.order((await f.checkout()).id)).json().shipment;
    const r = await f.get(`/api/shipments/${s.id}/dispatch`);
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json();
    assert.equal(p.spatial.index, 'h3');
    assert.equal(p.spatial.totalCouriers, 503);
    assert.equal(p.spatial.scannedCouriers, 3);
    assert.equal(p.candidates[0].id, 'courier-b');
    assert.equal(p.routing.state, 'disabled');
  } finally {
    await f.close();
  }
});
