import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import staticFiles from '@fastify/static';

const host = process.env.HOST ?? '127.0.0.1';
if (host !== '127.0.0.1')
  throw new Error(
    'The demonstration server must bind to 127.0.0.1. Production authentication is not implemented.',
  );
if ((process.env.APP_MODE ?? 'demo') !== 'demo')
  throw new Error('Only isolated demo mode is available in this slice.');
const port = Number(process.env.PORT ?? 3001);
await mkdir('.local', { recursive: true });
let secrets: { applicationKey: string; webhookKey: string };
try {
  secrets = JSON.parse(await readFile('.local/secrets.json', 'utf8'));
} catch {
  secrets = {
    applicationKey: randomBytes(32).toString('hex'),
    webhookKey: randomBytes(32).toString('hex'),
  };
  await writeFile('.local/secrets.json', JSON.stringify(secrets), { mode: 0o600 });
}
const db = await openDatabase(process.env.DATA_DIR ?? '.local/postgres');
const { app, flushOutbox, sweepAssignments } = buildApp(db, {
  ...secrets,
  demoMode: true,
  logger: true,
  receiverUrl: `http://127.0.0.1:${port}/api/demo-commerce/webhook`,
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
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
