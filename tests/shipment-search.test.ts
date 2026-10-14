import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/inventory.js';
test('shipment search covers older records, full totals, pages, and role isolation', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 110; i++)
      await f.db.query(
        `INSERT INTO shipments(id,reference,application_id,external_reference,merchant_id,recipient_name,destination,origin_id,weight_kg,status,fee_minor,currency,tracking_token,created_at,updated_at) VALUES($1,$2,'search-test',$2,'merchant-a','عميل البحث','الروضة، دمشق','site-a',1,'ready',100,'SYP',$3,$4,$4)`,
        [
          crypto.randomUUID(),
          'SEARCH-' + i,
          crypto.randomUUID(),
          new Date(Date.now() + i * 1000).toISOString(),
        ],
      );
    const snapshot = (await f.get('/api/bootstrap')).json();
    assert.equal(snapshot.stats.total, 116);
    assert.equal(snapshot.shipments.length, 100);
    const first = (await f.get('/api/shipments')).json();
    assert.equal(first.rows.length, 25);
    assert.equal(first.total, 116);
    const next = (await f.get('/api/shipments?page=1')).json();
    assert.equal(next.rows.length, 25);
    assert.notEqual(first.rows[0].id, next.rows[0].id);
    const old = (await f.get('/api/shipments?search=SHP-1005')).json();
    assert.equal(old.total, 1);
    assert.equal(old.rows[0].reference, 'SHP-1005');
    const foreign = (await f.get('/api/shipments?search=SHP-1005', 'merchant-a')).json();
    assert.equal(foreign.total, 0);
    const attention = (await f.get('/api/shipments?filter=attention')).json();
    assert.equal(attention.total, 1);
    assert.equal((await f.get('/api/shipments?page=-1')).statusCode, 422);
    assert.equal((await f.get('/api/shipments?filter=unknown')).statusCode, 422);
  } finally {
    await f.close();
  }
});
