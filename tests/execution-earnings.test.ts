import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
for (const company of [false, true])
  test(`execution earnings freeze ${company ? 'office' : 'independent'} percentage at assignment and remain distinct from collected goods`, async () => {
    const f = await cashFixture(company);
    try {
      let companyId: string | null = null;
      if (company) {
        const office = await f.post('/api/network/companies', {
          name: 'مكتب الأجور',
          address: 'عنوان المكتب، دمشق',
          location: { latitude: 33.51, longitude: 36.27 },
          rateBps: 6000,
        });
        assert.equal(office.statusCode, 200);
        companyId = office.json().id;
      }
      // Isolated fixture affiliation before the tested execution; no user data is touched.
      await f.db.query("UPDATE couriers SET company_id=$1,rate_bps=3333 WHERE id='courier-b'", [
        companyId,
      ]);
      const { code } = await f.route();
      await f.db.query(
        company
          ? 'UPDATE delivery_companies SET rate_bps=7500 WHERE id=$1'
          : 'UPDATE couriers SET rate_bps=7500 WHERE id=$1',
        [companyId ?? 'courier-b'],
      );
      const requestKey = crypto.randomUUID();
      const completed = await f.deliver(code, undefined, requestKey);
      assert.equal(completed.statusCode, 200, completed.body);
      assert.equal((await f.deliver(code, undefined, requestKey)).statusCode, 200);
      const result = (await f.get('/api/execution-earnings')).json();
      assert.equal(result.rows.length, 1);
      const earning = result.rows[0],
        bps = company ? 6000 : 3333;
      assert.equal(earning.rateBps, bps);
      assert.equal(earning.companyId, companyId);
      assert.equal(
        earning.amountMinor,
        Number((BigInt(f.shipment().feeMinor) * BigInt(bps) + 5000n) / 10000n),
      );
      assert.equal(result.groups[0].amountMinor, earning.amountMinor);
      assert.equal((await f.row()).totalMinor, f.shipment().collection.totalMinor);
      assert.equal((await f.get('/api/execution-earnings', 'merchant-a')).statusCode, 403);
      assert.equal(
        (await f.get('/api/execution-earnings', 'courier-b')).json().rows.length,
        company ? 0 : 1,
      );
      await assert.rejects(
        f.db.query('UPDATE execution_earnings SET amount_minor=0 WHERE shipment_id=$1', [
          f.shipment().id,
        ]),
      );
    } finally {
      await f.close();
    }
  });
test('missing partner agreement creates an explicitly unconfigured earning instead of inventing a rate', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route();
    assert.equal((await f.deliver(code)).statusCode, 200);
    const row = (await f.get('/api/execution-earnings')).json().rows[0];
    assert.equal(row.rateBps, null);
    assert.equal(row.amountMinor, null);
  } finally {
    await f.close();
  }
});
