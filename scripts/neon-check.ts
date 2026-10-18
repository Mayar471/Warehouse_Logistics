/** Safe integration probes against the dedicated synthetic presentation database.
 * Usage: node --env-file=.local/hosting.env --import tsx scripts/neon-check.ts
 * Never prints connection strings, passwords, SQL parameters, or provider error text.
 */
import assert from 'node:assert/strict';
import { openPostgresDatabase } from '../server/postgres.js';
import { buildApp } from '../server/app.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = await openPostgresDatabase(url);
try {
  const version = await db.query<{ version: number }>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  assert.equal(version.rows[0].version, 31);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('CREATE TEMP TABLE hosting_rollback_probe(value integer) ON COMMIT DROP');
      await tx.query('INSERT INTO hosting_rollback_probe VALUES(1)');
      throw new Error('intentional rollback');
    }),
    /intentional rollback/,
  );
  assert.equal(
    (
      await db.query<{ probe: string | null }>(
        "SELECT to_regclass('pg_temp.hosting_rollback_probe') AS probe",
      )
    ).rows[0].probe,
    null,
  );
  const before = (await db.query<{ count: number }>('SELECT count(*) AS count FROM shipments'))
    .rows[0].count;
  const other = await openPostgresDatabase(url);
  try {
    assert.equal(
      (await other.query<{ count: number }>('SELECT count(*) AS count FROM shipments')).rows[0]
        .count,
      before,
    );
    const order: string[] = [];
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = db.transaction(async () => {
      order.push('first-start');
      entered();
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push('first-end');
    });
    await ready;
    const second = other.transaction(async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  } finally {
    await other.close();
  }
  const { app } = buildApp(db, {
    applicationKey: 'neon-integration-check-only',
    webhookKey: 'neon-integration-check-only',
    demoMode: true,
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload: { accountId: 'ops' },
    });
    assert.equal(login.statusCode, 200);
    const session = login.cookies[0];
    const headers = { cookie: `${session.name}=${session.value}` };
    for (const path of [
      '/api/health',
      '/api/bootstrap',
      '/api/notifications',
      '/api/execution-earnings',
      '/api/partner-payments',
      '/api/disputes',
    ]) {
      const response = await app.inject({ url: path, headers });
      assert.equal(response.statusCode, 200, path);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/storefront/session' })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
  console.log(
    'PASS: Neon migrations, rollback, restart seed, cross-connection serialization and API reads',
  );
} finally {
  await db.close();
}
