import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import staticFiles from '@fastify/static';
import { osrmProvider } from './routing.js';

const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
const appMode = process.env.APP_MODE ?? 'demo';
const host = process.env.HOST ?? (isProduction ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT ?? 3001);

console.log(`Starting in ${isProduction ? 'production' : 'development'} mode on ${host}:${port}`);
console.log('Environment check:');
console.log(`- NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`- HOST: ${process.env.HOST}`);
console.log(`- PORT: ${process.env.PORT}`);
console.log(`- APP_MODE: ${process.env.APP_MODE}`);
console.log(`- SERVE_WEB: ${process.env.SERVE_WEB}`);
console.log(`- DATABASE_URL present: ${!!process.env.DATABASE_URL}`);

// For production deployment, use environment variables for secrets
let secrets: { applicationKey: string; webhookKey: string };
if (isProduction) {
  secrets = {
    applicationKey: process.env.APPLICATION_KEY || randomBytes(32).toString('hex'),
    webhookKey: process.env.WEBHOOK_KEY || randomBytes(32).toString('hex'),
  };
  console.log('Using environment secrets');
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
  console.log('Using local secrets');
}

// Use external PostgreSQL in production, embedded PGlite for local demo
const dbUrl = isProduction ? process.env.DATABASE_URL : (process.env.DATA_DIR ?? '.local/postgres');
console.log(`Database URL present: ${!!dbUrl}`);
console.log('Opening database...');
const db = await openDatabase(dbUrl);
console.log('Database opened successfully');
try {
  console.log('Building app...');
  const { app, flushOutbox, sweepAssignments } = buildApp(db, {
    ...secrets,
    demoMode: appMode === 'demo',
    routingProvider: process.env.OSRM_BASE_URL
      ? osrmProvider(process.env.OSRM_BASE_URL, process.env.OSRM_PROVIDER_NAME ?? 'OSRM driving')
      : undefined,
    logger: true,
    receiverUrl: process.env.RECEIVER_URL || (isProduction ? `${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_SERVICE_NAME || 'localhost'}:${port}/api/demo-commerce/webhook` : `http://127.0.0.1:${port}/api/demo-commerce/webhook`),
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  });
  console.log('App built successfully');

  if (process.env.SERVE_WEB === 'true') {
    console.log('Registering static files...');
    await app.register(staticFiles, {
      root: resolve('dist'),
      index: 'index.html',
      cacheControl: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ message: 'المسار غير موجود' });
      return reply.sendFile('index.html');
    });
    console.log('Static files registered');
  }

  console.log(`Starting server on ${host}:${port}...`);
  await app.listen({ host, port });
  console.log(`Server listening on ${host}:${port}`);

  console.log('Starting background workers...');
  const timer = setInterval(() => {
    void flushOutbox().catch((error) => app.log.error({ err: error }, 'Outbox worker failed'));
    void sweepAssignments().catch(() => app.log.error('Assignment worker failed'));
  }, 2000);
  timer.unref();
  console.log('Background workers started');

  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    console.log('Shutting down...');
    clearInterval(timer);
    await app.close();
    await db.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) {
  console.error('Failed to start server:', error);
  console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
  process.exit(1);
}
