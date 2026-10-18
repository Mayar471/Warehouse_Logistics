import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface HostedDemo {
  origin: string;
  password: string;
  signingKey: string;
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const loginPage = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>الشبكة اللوجستية — دخول العرض</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3edf5;color:#302039;font:17px system-ui;padding:24px}.card{width:min(100%,440px);padding:36px;background:#fff;border:1px solid #e4d8eb;border-radius:24px;box-shadow:0 20px 70px #31203b12}h1{font-size:25px}p{line-height:1.9;color:#705c78}input,button{width:100%;padding:15px;margin-top:14px;border-radius:12px;font:inherit}input{border:1px solid #d8c5df}button{border:0;color:white;background:#782451;cursor:pointer}label{display:block;margin-top:22px}</style><main class="card"><h1>الشبكة اللوجستية</h1><p>مساحة عرض خاصة لتجربة المنصة ببيانات تجريبية.</p><form method="post" action="/demo-access"><label for="password">رمز دخول العرض</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button>دخول المنصة</button></form></main></html>`;

/** Private presentation gate, NOT production identity or per-user authentication. */
export function registerHostedDemo(app: FastifyInstance, settings: HostedDemo) {
  const origin = new URL(settings.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== settings.origin ||
    settings.password.length < 20
  )
    throw new Error('Hosted demo requires an HTTPS origin and a strong access password.');
  const sign = (value: string) =>
    createHmac('sha256', settings.signingKey).update(value).digest('hex');
  const cookieName = '__Host-demo_access';
  const attempts = new Map<string, { count: number; until: number }>();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    reply.header('X-Robots-Tag', 'noindex, nofollow').header('Cache-Control', 'no-store');
    if (path === '/api/health') return;
    // Server-only calls between BFF, integration routes, and the demo webhook.
    if (equal(String(req.headers['x-demo-internal'] ?? ''), settings.signingKey)) return;
    const cookie = req.cookies[cookieName] ?? '';
    const parts = cookie.split('.');
    const payload = parts.slice(0, 2).join('.');
    const valid =
      parts.length === 3 &&
      Number(parts[0]) > Date.now() &&
      Number(parts[0]) <= Date.now() + 8 * 60 * 60_000 &&
      equal(parts[2], sign(payload));
    if (path === '/demo-access') return;
    if (valid) return;
    if (path.startsWith('/api/'))
      return reply
        .code(401)
        .send({ code: 'DEMO_ACCESS_REQUIRED', message: 'سجّل دخول العرض أولاً' });
    return reply.redirect('/demo-access');
  });
  app.get('/demo-access', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(loginPage),
  );
  app.post('/demo-access', async (req, reply) => {
    if (req.headers.origin !== settings.origin) return reply.code(403).send('مصدر الطلب غير مقبول');
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.ip;
    const attempt = attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 10 || attempts.size >= 2000)
      return reply.code(429).send('انتظر قليلاً قبل إعادة المحاولة');
    attempt.count++;
    attempts.set(key, attempt);
    const password = (req.body as { password?: unknown })?.password;
    if (typeof password !== 'string' || !equal(password, settings.password))
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(loginPage.replace('<form ', '<p role="alert">رمز الدخول غير صحيح</p><form '));
    attempts.delete(key);
    const payload = `${now + 8 * 60 * 60_000}.${randomBytes(16).toString('hex')}`;
    reply.setCookie(cookieName, `${payload}.${sign(payload)}`, {
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    return reply.redirect('/');
  });
}
