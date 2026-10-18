import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { buildApp } from '../server/app.js';

test('hosted demo blocks anonymous APIs, validates access origin and password, and permits scoped demo journeys', async () => {
  const db = await openDatabase('memory://');
  const origin = 'https://logistics.example';
  const password = 'qa-access-password-very-long';
  const signingKey = 'qa-application-key-more-than-32-characters';
  const { app } = buildApp(db, {
    applicationKey: signingKey,
    webhookKey: signingKey,
    demoMode: true,
    hostedDemo: { origin, password, signingKey },
  });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/shop')).headers.location, '/demo-access');
    assert.equal((await app.inject('/api/demo/accounts')).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/api/demo/accounts', headers: { 'x-demo-internal': 'fake' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/demo-access',
          headers: { origin: 'https://evil.example' },
          payload: { password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/demo-access',
          headers: { origin },
          payload: { password: 'wrong' },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/demo-access',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password }).toString(),
    });
    assert.equal(login.statusCode, 302);
    const cookie = login.cookies[0];
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    const access = `${cookie.name}=${cookie.value}`;
    assert.equal(
      (await app.inject({ url: '/api/demo/accounts', headers: { cookie: access } })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/demo/accounts',
          headers: { cookie: access.slice(0, -1) + 'z' },
        })
      ).statusCode,
      401,
    );
    const session = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      headers: { host: 'logistics.example', origin, cookie: access },
      payload: { accountId: 'ops' },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.cookies[0].secure, true);
    const shop = await app.inject({
      method: 'POST',
      url: '/api/storefront/session',
      headers: { host: 'logistics.example', origin, cookie: access },
    });
    assert.equal(shop.statusCode, 200);
    assert.equal(shop.cookies[0].secure, true);
    const customerCookie = `${access}; ${shop.cookies[0].name}=${shop.cookies[0].value}`;
    assert.equal(
      (
        await app.inject({
          url: '/api/storefront/availability',
          headers: { host: 'logistics.example', cookie: customerCookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo/session',
          headers: { host: 'evil.example', origin, cookie: access },
          payload: { accountId: 'ops' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
