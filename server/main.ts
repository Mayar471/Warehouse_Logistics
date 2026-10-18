import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import staticFiles from '@fastify/static';
import { osrmProvider } from './routing.js';

const isProduction = process.env.NODE_ENV === 'production';
const appMode = process.env.APP_MODE ?? 'demo';
const host = process.env.HOST ?? (isProduction ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT ?? 3001);

// For production deployment, use environment variables for secrets
let secrets: { applicationKey: string; webhookKey: string };
if (isProduction) {
  secrets = {
    applicationKey: process.env.APPLICATION_KEY || randomBytes(32).toString('hex'),
    webhookKey: process.env.WEBHOOK_KEY || randomBytes(32).toString('hex'),
  };
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

// Use external PostgreSQL in production, embedded PGlite for local demo
const db = await openDatabase(
  isProduction ? process.env.DATABASE_URL : (process.env.DATA_DIR ?? '.local/postgres')
);
const { app, flushOutbox, sweepAssignments } = buildApp(db, {
  ...secrets,
  demoMode: appMode === 'demo',
  routingProvider: process.env.OSRM_BASE_URL
    ? osrmProvider(process.env.OSRM_BASE_URL, process.env.OSRM_PROVIDER_NAME ?? 'OSRM driving')
    : undefined,
  logger: true,
  receiverUrl: process.env.RECEIVER_URL || `http://127.0.0.1:${port}/api/demo-commerce/webhook`,
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
});
if (process.env.SERVE_WEB === 'true') {
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
const timer = setInterval(() => {
  void flushOutbox().catch((error) => app.log.error({ err: error }, 'Outbox worker failed'));
  void sweepAssignments().catch(() => app.log.error('Assignment worker failed'));
}, 2000);
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
