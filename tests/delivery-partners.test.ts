import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

test('partner directory creates executable couriers and points, guards affiliation and freezes settlement owner', async () => {
  const db = await openDatabase('memory://');
  const { app } = buildApp(db, {
    applicationKey: 'partners-test',
    webhookKey: 'partners-test',
    demoMode: true,
  });
  async function session(id: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: id },
    });
    assert.equal(r.statusCode, 200);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  try {
    const ops = await session('ops'),
      merchant = await session('merchant-a');
    async function command(
      url: string,
      payload: Record<string, unknown>,
      cookie = ops,
      method: 'POST' | 'PATCH' = 'POST',
      requestKey = randomUUID(),
    ) {
      return app.inject({
        method,
        url,
        headers: { cookie, 'idempotency-key': requestKey },
        payload,
      });
    }
    const officeBody = {
      name: 'مكتب اختبار',
      address: 'موقع محدد على الخريطة، دمشق',
      location: { latitude: 33.514, longitude: 36.28 },
    };
    assert.equal((await command('/api/network/companies', officeBody, merchant)).statusCode, 403);
    assert.equal(
      (await command('/api/network/companies', { ...officeBody, location: null })).statusCode,
      422,
    );
    const officeKey = randomUUID();
    const office = await command('/api/network/companies', officeBody, ops, 'POST', officeKey);
    assert.equal(office.statusCode, 200);
    const companyId = office.json().id;
    assert.equal(
      (await command('/api/network/companies', officeBody, ops, 'POST', officeKey)).json().id,
      companyId,
    );
    const courierBody = {
      name: 'مندوب الاختبار',
      vehicle: 'دراجة نارية',
      capacityKg: 15,
      available: true,
      companyId,
    };
    assert.equal(
      (await command('/api/network/couriers', { ...courierBody, companyId: 'missing' })).statusCode,
      422,
    );
    const result = await command('/api/network/couriers', courierBody);
    assert.equal(result.statusCode, 200);
    const courierId = result.json().id;
    const courierCookie = await session(courierId);
    assert.equal(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: courierCookie } })).json()
        .account.courierId,
      courierId,
    );
    const point = await command('/api/network/pickup-sites', {
      ...officeBody,
      capacityKg: 100,
      enabled: true,
      reason: 'إضافة نقطة اختبار',
    });
    assert.equal(point.statusCode, 200);
    const pointCookie = await session(point.json().id);
    assert.equal(
      (await app.inject({ url: '/api/bootstrap', headers: { cookie: pointCookie } })).json().account
        .role,
      'pickup',
    );
    await db.query("UPDATE shipments SET courier_id=$1 WHERE reference='SHP-1002'", [courierId]);
    const changed = await command(
      '/api/network/couriers/' + courierId,
      { ...courierBody, companyId: null, expectedVersion: 1 },
      ops,
      'PATCH',
    );
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().code, 'ACTIVE_COURIER_AFFILIATION');
    assert.equal(
      (
        await command(
          '/api/network/couriers/' + courierId,
          { ...courierBody, capacityKg: 1, expectedVersion: 1 },
          ops,
          'PATCH',
        )
      ).statusCode,
      409,
    );
    const shipment = (
      await db.query<{ id: string; version: number }>(
        "SELECT id,version FROM shipments WHERE reference='SHP-1002'",
      )
    ).rows[0];
    const delivered = await command(
      '/api/shipments/' + shipment.id + '/actions',
      { action: 'deliver', expectedVersion: shipment.version },
      courierCookie,
    );
    assert.equal(delivered.statusCode, 200, delivered.body);
    assert.equal(delivered.json().deliveryPayee.companyId, companyId);
    assert.equal(
      (
        await command(
          '/api/network/couriers/' + courierId,
          { ...courierBody, companyId: null, expectedVersion: 1 },
          ops,
          'PATCH',
        )
      ).statusCode,
      200,
    );
    const frozen = (
      await app.inject({ url: '/api/shipments/' + shipment.id, headers: { cookie: ops } })
    ).json();
    assert.equal(frozen.shipment.deliveryPayee.companyId, companyId);
    assert.equal(
      (
        await command(
          '/api/network/couriers/' + courierId,
          { ...courierBody, expectedVersion: 1 },
          ops,
          'PATCH',
        )
      ).statusCode,
      409,
    );
    const bootstrap = (
      await app.inject({ url: '/api/bootstrap', headers: { cookie: ops } })
    ).json();
    assert.equal(bootstrap.deliveryCompanies.length, 1);
    assert.equal(
      bootstrap.couriers.find((c: { id: string }) => c.id === courierId).companyId,
      null,
    );
    assert.ok(
      (await app.inject({ url: '/api/network/audit', headers: { cookie: ops } }))
        .json()
        .audit.some((e: { action: string }) => e.action === 'couriers.created'),
    );
  } finally {
    await app.close();
    await db.close();
  }
});
