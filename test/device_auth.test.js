'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { setup } = require('./helpers');
const { modules } = require('../src/modules');
const { signAccessToken, verifyAccessToken, deviceVerifier } = require('../src/core/device_auth');

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const DEVICE = 'dev_0123456789abcdef0123';

/** @type {Awaited<ReturnType<typeof setup>>} */
let t;
before(async () => {
  const has = modules.some((m) => m.name === 'device-auth');
  t = await setup({
    modules: has ? modules : [...modules, require('../src/modules/auth/device_routes')],
    config: { AUTH_MODE: 'device', JWT_SECRET: SECRET },
    overrides: { verifier: deviceVerifier(SECRET) },
  });
});
after(() => t.close());

test('JWT: imza, süre ve tür doğrulanır', () => {
  const now = () => 1_700_000_000_000;
  const tok = signAccessToken(SECRET, 'device:abc', 60, now);
  assert.equal(verifyAccessToken(SECRET, tok, now).sub, 'device:abc');
  assert.throws(() => verifyAccessToken('baska-anahtar-0123456789-0123456789', tok, now), { code: 'auth/invalid-id-token' });
  assert.throws(() => verifyAccessToken(SECRET, tok, () => now() + 61_000), { code: 'auth/id-token-expired' });
  const [h, , s] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'device:x', typ: 'access', exp: 9e9 })).toString('base64url');
  assert.throws(() => verifyAccessToken(SECRET, `${h}.${forged}.${s}`, now), { code: 'auth/invalid-id-token' });
});

test('/auth/device: aynı cihaz aynı hesap; token ile korumalı uç çalışır', async () => {
  const a = await t.request('POST', '/auth/device', { body: { device_id: DEVICE, platform: 'ios' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.data.created, true);
  assert.equal(a.body.data.user.auth_provider, 'device');
  const b = await t.request('POST', '/auth/device', { body: { device_id: DEVICE } });
  assert.equal(b.body.data.created, false);
  assert.equal(b.body.data.user.id, a.body.data.user.id);
  const me = await t.request('GET', '/account', { token: b.body.data.access_token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.id, a.body.data.user.id);
  const sync = await t.request('POST', '/auth/sync', { token: b.body.data.access_token });
  assert.equal(sync.body.data.user.id, a.body.data.user.id);
});

test('/auth/device: kısa / geçersiz cihaz kimliği reddedilir; kötü token 401', async () => {
  assert.equal((await t.request('POST', '/auth/device', { body: { device_id: 'kisa' } })).status, 422);
  assert.equal((await t.request('POST', '/auth/device', { body: { device_id: 'x'.repeat(20) + ' ; DROP' } })).status, 422);
  assert.equal((await t.request('GET', '/account', { token: 'a.b.c' })).status, 401);
});

test('/auth/refresh: rotasyon — yeni çift çalışır, eski refresh ikinci kez kullanılamaz', async () => {
  const login = await t.request('POST', '/auth/device', { body: { device_id: `${DEVICE}_r` } });
  const old = login.body.data.refresh_token;
  const r1 = await t.request('POST', '/auth/refresh', { body: { refresh_token: old } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.data.refresh_token, old);
  assert.equal((await t.request('GET', '/account', { token: r1.body.data.access_token })).status, 200);
  const again = await t.request('POST', '/auth/refresh', { body: { refresh_token: old } });
  assert.equal(again.status, 401);
  assert.equal(again.body.code, 'INVALID_TOKEN');
  const rows = await t.deps.db.query('SELECT token_hash FROM refresh_tokens');
  assert.ok(rows.every((x) => x.token_hash !== old), 'refresh düz metin saklanmaz');
});
