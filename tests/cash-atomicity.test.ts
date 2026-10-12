import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashFixture } from './helpers/cash.js';
test('later ledger, audit and outbox failures roll back proof, shipment, stock and money; database rejects unbalanced entries', async () => {
  const f = await cashFixture();
  try {
    const { code } = await f.route();
    const stock = await f.stock();
    await f.db.exec(
      "CREATE FUNCTION reject_cash_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$; CREATE TRIGGER reject_cash_event BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION reject_cash_event();",
    );
    const key = crypto.randomUUID();
    assert.equal((await f.deliver(code, undefined, key)).statusCode, 500);
    assert.equal((await f.row()).status, 'pending');
    assert.deepEqual(await f.stock(), stock);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 0);
    assert.equal(
      (await f.db.query<{ consumed_at: string | null }>('SELECT consumed_at FROM delivery_proofs'))
        .rows[0].consumed_at,
      null,
    );
    await f.db.exec('DROP TRIGGER reject_cash_event ON cash_events');
    await f.db.exec(
      "CREATE FUNCTION reject_cash_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$; CREATE TRIGGER reject_cash_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_cash_outbox();",
    );
    assert.equal((await f.deliver(code)).statusCode, 500);
    assert.equal((await f.row()).status, 'pending');
    await f.db.exec('DROP TRIGGER reject_cash_outbox ON outbox');
    assert.equal((await f.deliver(code, undefined, key)).statusCode, 200);
    const row = await f.row();
    await f.db.exec(
      'CREATE TRIGGER reject_cash_event BEFORE INSERT ON cash_events FOR EACH ROW EXECUTE FUNCTION reject_cash_event()',
    );
    const receiveKey = crypto.randomUUID();
    assert.equal(
      (await f.receipt(row, 'receive', row.totalMinor, 'ops', receiveKey)).statusCode,
      500,
    );
    assert.equal((await f.view()).json().receivedMinor, 0);
    assert.equal((await f.db.query('SELECT * FROM cash_journals')).rows.length, 1);
    await f.db.exec('DROP TRIGGER reject_cash_event ON cash_events');
    assert.equal(
      (await f.receipt(row, 'receive', row.totalMinor, 'ops', receiveKey)).statusCode,
      200,
    );
    const extraQuote = await f.post(
      '/api/storefront/checkouts',
      {
        items: [{ productId: 'bag', quantity: 1 }],
        paymentMode: 'cod',
        recipientName: 'عميل توازن',
        district: 'الروضة',
        address: 'عنوان مستقل لاختبار القيد',
      },
      'shop',
    );
    const extraShipment = (await f.order(extraQuote.json().id)).json().shipment;
    await assert.rejects(
      f.db.transaction(async (tx) => {
        const q = await tx.query<{ id: string }>(
          'INSERT INTO cash_journals(id,shipment_id,kind,currency,amount_minor) VALUES(gen_random_uuid(),$1,$2,$3,100) RETURNING id',
          [extraShipment.id, 'collection', 'SYP'],
        );
        await tx.query('INSERT INTO cash_postings VALUES($1,$2,100)', [q.rows[0].id, 'invalid']);
        await tx.query('UPDATE cash_journals SET sealed=true WHERE id=$1', [q.rows[0].id]);
      }),
      /Unbalanced cash journal/,
    );
  } finally {
    await f.close();
  }
});
