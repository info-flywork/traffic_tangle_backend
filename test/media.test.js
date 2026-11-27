'use strict';

// Medya hattı (şablon): yükle → doğrula → 1080 + 320 WebP → CDN (uygulamanın klasörü) → blurhash; sil; hesap silinince temizlik.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const sharp = /** @type {any} */ (require('sharp'));
const { setup } = require('./helpers');

/** @type {Awaited<ReturnType<typeof setup>>} */
let t;
before(async () => {
  t = await setup({ config: { MEDIA_DRIVER: 'memory', MEDIA_PREFIX: 'demo-app', MEDIA_PUBLIC_URL: 'https://cdn.test', MEDIA_MAX_MB: '2' } });
});
after(() => t.close());

/** @param {Buffer} file @param {string} token @param {Record<string, string>} [fields] */
async function upload(file, token, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)]), 'x');
  const res = await fetch(`${t.base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const photo = () => sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 200, g: 80, b: 40 } } })
  .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'konum-sızıntısı-testi' } } }).toBuffer();

test('görsel yüklenir: uygulamanın klasöründe 1080 + 320 WebP, CDN adresleri, blurhash', async () => {
  const r = await upload(await photo(), 'test:m1', { kind: 'avatars' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body.data;
  assert.match(m.url, /^https:\/\/cdn\.test\/demo-app\/avatars\/\d{4}\/\d{2}\/[0-9a-f-]+-1080\.webp$/);
  assert.match(m.thumb_url, /-320\.webp$/);
  assert.equal(m.width, 1080);
  assert.equal(m.height, 720);
  assert.ok(m.blurhash && m.blurhash.length >= 6);
  const files = t.deps.storage.files;
  const thumb = files.get(m.thumb_url.replace('https://cdn.test/', ''));
  const meta = await sharp(thumb).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 320 && meta.height <= 320);
  assert.equal(meta.exif, undefined, 'EXIF (konum) silinmiş olmalı');
});

test('görsel olmayan dosya 415, büyük dosya 413, dosyasız 422, kimliksiz 401', async () => {
  assert.equal((await upload(Buffer.from('%PDF-1.4 sahte'), 'test:m2')).status, 415);
  assert.equal((await upload(Buffer.alloc(3 * 1024 * 1024, 1), 'test:m2')).status, 413);
  const form = new FormData();
  form.append('kind', 'avatars');
  const noFile = await fetch(`${t.base}/media`, { method: 'POST', headers: { Authorization: 'Bearer test:m2' }, body: form });
  assert.equal(noFile.status, 422);
  assert.equal((await fetch(`${t.base}/media`, { method: 'POST' })).status, 401);
});

test('silme: başkası 404; sahibi silince CDN dosyaları da gider', async () => {
  const m = (await upload(await photo(), 'test:owner')).body.data;
  assert.equal((await t.request('DELETE', `/media/${m.id}`, { token: 'test:intruder' })).status, 404);
  const before = t.deps.storage.files.size;
  assert.equal((await t.request('DELETE', `/media/${m.id}`, { token: 'test:owner' })).status, 200);
  assert.equal(t.deps.storage.files.size, before - 2);
});

test('hesap kalıcı silinince kullanıcının CDN dosyaları da silinir', async () => {
  await upload(await photo(), 'test:gone');
  const { id } = await t.deps.db.one('SELECT id FROM users WHERE firebase_uid = ?', ['gone']);
  const mine = [...t.deps.storage.files.keys()].length;
  assert.ok(mine >= 2);
  await t.request('DELETE', '/account', { token: 'test:gone' });
  await t.deps.account.purgeDue();
  assert.equal(await t.deps.db.one('SELECT id FROM media WHERE user_id = ?', [id]), null);
  assert.equal(t.deps.storage.files.size, mine - 2);
});
