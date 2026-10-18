import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { reconcileInventory } from '../server/inventory-reconciliation.js';

// Explicit, offline local-demo maintenance. Stop the server before running this script.
if (!process.argv.includes('--apply'))
  throw new Error('Explicit --apply required; stop the local demo server first.');
const root = await realpath(resolve('.local'));
const directory = await realpath(resolve('.local/postgres'));
assert.equal(
  relative(root, directory),
  'postgres',
  'Only the workspace local demo database may be reset',
);
const keep = new Set([
  'schema_migrations',
  'merchants',
  'sites',
  'couriers',
  'delivery_companies',
  'partner_audit',
  'network_audit',
  'inventory_stock',
  'customer_addresses',
  'demo_settings',
]);
const operations = new Set([
  'dispatch_locations',
  'partner_payments',
  'partner_money_entries',
  'partner_payment_events',
  'disputes',
  'dispute_participants',
  'dispute_events',
  'execution_terms',
  'execution_earnings',
  'quotes',
  'shipments',
  'timeline',
  'idempotency',
  'outbox',
  'integration_audit',
  'received_events',
  'commerce_projection',
  'storefront_checkouts',
  'inventory_reservations',
  'inventory_movements',
  'inventory_counts',
  'inventory_transfers',
  'inventory_transfer_lines',
  'inventory_transfer_events',
  'location_sharing',
  'location_audit',
  'cash_obligations',
  'cash_journals',
  'cash_postings',
  'cash_events',
  'cash_payouts',
  'cash_payout_events',
  'cash_remittance_returns',
  'commercial_returns',
  'commercial_return_events',
  'customer_refunds',
  'customer_refund_events',
  'notification_reads',
  'service_ratings',
  'delivery_service_subjects',
  'delivery_proofs',
]);
const db = new PGlite(directory);
await db.waitReady;
try {
  const tables = (
    await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  for (const table of tables)
    assert.ok(
      keep.has(table) || operations.has(table),
      `Unclassified table ${table}; refusing reset`,
    );
  async function counts(database: PGlite) {
    const result: Record<string, number> = {};
    for (const table of tables)
      result[table] = (
        await database.query<{ count: number }>(`SELECT COUNT(*)::integer count FROM "${table}"`)
      ).rows[0].count;
    return result;
  }
  const before = await counts(db);
  const snapshot = await db.dumpDataDir('gzip');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backupFolder = resolve('.local/backups');
  await mkdir(backupFolder, { recursive: true });
  const backup = resolve(backupFolder, 'before-operations-reset-' + stamp + '.tar.gz');
  await writeFile(backup, Buffer.from(await snapshot.arrayBuffer()), { flag: 'wx' });
  const restored = new PGlite({ loadDataDir: snapshot });
  try {
    await restored.waitReady;
    assert.deepEqual(await counts(restored), before, 'Backup verification failed');
  } finally {
    await restored.close();
  }
  console.log('Backup saved and verified: ' + backup);
  const preserved: Record<string, unknown[]> = {};
  for (const table of keep)
    if (table !== 'inventory_stock')
      preserved[table] = (await db.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows;
  const stockBefore = (
    await db.query(
      'SELECT merchant_id,site_id,product_id,on_hand FROM inventory_stock ORDER BY merchant_id,site_id,product_id',
    )
  ).rows;
  await db.transaction(async (tx) => {
    await tx.exec(
      'TRUNCATE ' +
        tables
          .filter((t) => operations.has(t))
          .map((t) => '"' + t + '"')
          .join(',') +
        ' RESTART IDENTITY',
    );
    await tx.query('UPDATE inventory_stock SET reserved=0,quarantine=0,version=version+1');
    const balances = (
      await tx.query<{ merchant_id: string; site_id: string; product_id: string; on_hand: number }>(
        'SELECT merchant_id,site_id,product_id,on_hand FROM inventory_stock WHERE on_hand>0',
      )
    ).rows;
    for (const row of balances)
      await tx.query(
        "INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,kind,quantity,actor_name,reason) VALUES($1,$2,$3,$4,'opening',$5,'تنظيف التجربة','رصيد بداية جديد يحتفظ بالموجود بعد تصفير سجلات التشغيل')",
        [randomUUID(), row.merchant_id, row.site_id, row.product_id, row.on_hand],
      );
    assert.equal(
      (await reconcileInventory(tx, null)).exceptions,
      0,
      'Inventory must reconcile after reset',
    );
    for (const table of keep)
      if (table !== 'inventory_stock')
        assert.deepEqual(
          (await tx.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows,
          preserved[table],
          `${table} must be preserved`,
        );
    assert.deepEqual(
      (
        await tx.query(
          'SELECT merchant_id,site_id,product_id,on_hand FROM inventory_stock ORDER BY merchant_id,site_id,product_id',
        )
      ).rows,
      stockBefore,
    );
  });
  const after = await counts(db);
  for (const table of operations)
    if (table !== 'inventory_movements') assert.equal(after[table], 0, table);
  const report = backup.replace('.tar.gz', '.json');
  await writeFile(
    report,
    JSON.stringify(
      {
        backup,
        scope: 'local demo operations only',
        before,
        after,
        inventory: 'on-hand preserved; reservations/quarantine cleared; fresh opening balances',
        preserved: [...keep],
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      clearedShipments: before.shipments,
      clearedReturns: before.commercial_returns,
      remainingShipments: after.shipments,
      partnersPreserved: true,
      inventoryReconciled: true,
      report,
    }),
  );
} finally {
  await db.close();
}
