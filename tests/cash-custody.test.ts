import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
import { fixture } from './helpers/inventory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
test('pickup staff collects upon release to customer and retains cash after parcel custody ends', async () => {
  const f = await cashFixture(true);
  try {
    const { code } = await f.route();
    assert.equal((await f.view('courier-b')).json().total, 0);
    assert.equal((await f.view('pickup-a')).json().total, 1);
    const r = await f.deliver(code);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'delivered');
    assert.equal((await f.row()).collectorName, 'موظف نقطة الروضة');
    assert.equal((await f.view('pickup-a')).json().heldMinor, r.json().collection.totalMinor);
    assert.equal((await f.view('courier-b')).json().heldMinor, 0);
    const row = await f.row();
    assert.equal((await f.receipt(row, 'receive', row.totalMinor, 'pickup-a')).statusCode, 403);
    assert.equal((await f.receipt(row)).statusCode, 200);
    assert.equal((await f.view('pickup-a')).json().heldMinor, 0);
  } finally {
    await f.close();
  }
});
test('financial custody and immutable journals survive migration restart without backfilling old deliveries', async () => {
  const root = resolve('artifacts'),
    path = await mkdtemp(join(root, 'cash-db-'));
  const f = await cashFixture(false, path);
  try {
    const { code } = await f.route();
    await f.deliver(code);
    const id = f.shipment().id,
      total = f.shipment().collection.totalMinor;
    await f.close();
    const next = await fixture(path);
    try {
      const view = (await next.get('/api/cash')).json();
      assert.equal(view.total, 1);
      assert.equal(view.heldMinor, total);
      assert.equal(view.consistent, true);
      assert.equal(view.rows[0].shipmentId, id);
      assert.equal(
        (await next.db.query('SELECT * FROM schema_migrations WHERE version=12')).rows.length,
        1,
      );
      assert.equal((await next.db.query('SELECT * FROM cash_journals')).rows.length, 1);
    } finally {
      await next.close();
    }
  } finally {
    if (!resolve(path).startsWith(root + '\\')) throw new Error('Unexpected test path');
    await rm(path, { recursive: true, force: true });
  }
});
