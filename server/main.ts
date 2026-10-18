import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import staticFiles from '@fastify/static';
import { osrmProvider } from './routing.js';
import type { Database } from './database.js';

const mode = process.env.APP_MODE ?? 'demo';
const hosted = mode === 'hosted-demo';
if (!['demo', 'hosted-demo'].includes(mode)) throw new Error('Unsupported APP_MODE');
function required(name: string, minimum = 1) {
  const value = process.env[name];
  if (!value || value.length < minimum) throw new Error(`Missing or invalid ${name}`);
  return value;
}
const publicOrigin = hosted ? required('PUBLIC_ORIGIN') : undefined;
if (
  publicOrigin &&
  (new URL(publicOrigin).protocol !== 'https:' || new URL(publicOrigin).origin !== publicOrigin)
)
  throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash or path.');

const host = hosted ? '0.0.0.0' : (process.env.HOST ?? '127.0.0.1');
if (!hosted && host !== '127.0.0.1')
  throw new Error(
    'The demonstration server must bind to 127.0.0.1. Production authentication is not implemented.',
  );
const port = Number(process.env.PORT ?? 3001);
let secrets: { applicationKey: string; webhookKey: string };
if (hosted) {
  secrets = {
    applicationKey: required('APPLICATION_KEY', 32),
    webhookKey: required('WEBHOOK_KEY', 32),
  };
  required('DEMO_ACCESS_PASSWORD', 20);
  required('DATABASE_URL');
} else {
  await mkdir('.local', { recursive: true });
  try {
    secrets = JSON.parse(await readFile('.local/secrets.json', 'utf8'));
  } catch {
    secrets = {
      applicationKey: randomBytes(32).toString('hex'),
      webhookKey: randomBytes(32).toString('hex'),
    };
    await writeFile('.local/secrets.json', JSON.stringify(secrets), { mode: 0o600 });
  }
}
let db: Database;
try {
  db = hosted
    ? await (await import('./postgres.js')).openPostgresDatabase(required('DATABASE_URL'))
    : await openDatabase(process.env.DATA_DIR ?? '.local/postgres');
} catch (error) {
  // SQL/driver error text can contain credentials or row data. Report only a code.
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'DATABASE_INIT_FAILED';
  console.error(`Database initialization failed (${code}). Check private connection settings.`);
  process.exit(1);
}
const { app, flushOutbox, sweepAssignments } = buildApp(db, {
  ...secrets,
  demoMode: true,
  hostedDemo: hosted
    ? {
        origin: publicOrigin!,
        password: required('DEMO_ACCESS_PASSWORD'),
        signingKey: secrets.applicationKey,
      }
    : undefined,
  routingProvider: process.env.OSRM_BASE_URL
    ? osrmProvider(process.env.OSRM_BASE_URL, process.env.OSRM_PROVIDER_NAME ?? 'OSRM driving')
    : undefined,
  logger: true,
  receiverUrl: `http://127.0.0.1:${port}/api/demo-commerce/webhook`,
  allowedOrigins: publicOrigin
    ? [publicOrigin]
    : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  transport: hosted
    ? async (raw, headers) => {
        const result = await app.inject({
          method: 'POST',
          url: '/api/demo-commerce/webhook',
          headers: { ...headers, 'x-demo-internal': secrets.applicationKey },
          payload: raw,
        });
        return result.statusCode;
      }
    : undefined,
});
if (hosted || process.env.SERVE_WEB === 'true') {
  await app.register(staticFiles, {
    root: resolve('dist'),
    index: 'index.html',
    cacheControl: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ message: 'المسار غير موجود' });
    return reply.sendFile('index.html');
  });
}
await app.listen({ host, port });
let workerRunning = false;
const timer = setInterval(
  () => {
    if (workerRunning) return;
    workerRunning = true;
    void (async () => {
      try {
        await flushOutbox().catch(() => app.log.error('Outbox worker failed'));
        await sweepAssignments().catch(() => app.log.error('Assignment worker failed'));
      } finally {
        workerRunning = false;
      }
    })();
  },
  hosted ? 5000 : 2000,
);
timer.unref();
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await app.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
