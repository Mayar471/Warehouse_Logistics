import {
  Pool,
  neonConfig,
  types,
  type PoolClient,
  type QueryResultRow,
} from '@neondatabase/serverless';
import type { Database, Transaction } from './database.js';
import { initializeDatabase } from './db.js';

// All compound writes participate in this database-wide transaction lock.
// This preserves the existing serialized command contract during demo deploy overlap.
const WRITE_LOCK = 721046031;

export async function openPostgresDatabase(connectionString: string): Promise<Database> {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || !url.hostname)
    throw new Error('DATABASE_URL must be a complete PostgreSQL connection URL.');
  if (!url.hostname.endsWith('.neon.tech'))
    throw new Error('The hosted demo adapter requires Neon.');
  // WSS uses the platform TLS implementation and certificate verification. Interactive
  // transactions remain on one PostgreSQL connection; no HTTP query batching is used.
  neonConfig.webSocketConstructor = WebSocket;
  neonConfig.useSecureWebSocket = true;
  const pool = new Pool({
    connectionString: url.toString(),
    max: 3,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 20_000,
    statement_timeout: 30_000,
    application_name: 'warehouse-logistics-demo',
    types: {
      getTypeParser(oid, format) {
        if (oid === 20 && (!format || format === 'text'))
          return (value: string) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number))
              throw new Error('Database integer exceeds safe range');
            return number;
          };
        return types.getTypeParser(oid, format);
      },
    },
  });
  // Never log provider errors: their details may contain connection metadata or SQL data.
  pool.on('error', () => console.error('An idle database connection was lost.'));
  function transactionClient(client: PoolClient): Transaction {
    return {
      async query<T>(sql: string, params?: unknown[]) {
        const result = await client.query<QueryResultRow>(sql, params);
        return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
      },
    };
  }
  const db: Database = {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query<QueryResultRow>(sql, params);
      return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
        const result = await fn(transactionClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  // Every migration and seed runs atomically on ONE connection; nested seed calls
  // join this outer transaction. PgBouncer transaction pooling is supported.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const tx = transactionClient(client);
    await initializeDatabase({
      ...tx,
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: async (fn) => fn(tx),
      close: async () => {},
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
    throw error;
  }
  client.release();
  return db;
}
