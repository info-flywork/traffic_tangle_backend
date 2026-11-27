'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { z } = require('zod');
const { setup } = require('./helpers');
const { defineModule } = require('../src/core/route');
const { modules } = require('../src/modules');
const { AppError } = require('../src/core/errors');

// Her çağrıda yeni kayıt "oluşturan" uç — tekrar çalışırsa sayaç artar
let created = 0;
let failNext = false;
const notes = defineModule('notes_probe', '/notes-probe', [
  {
    method: 'post',
    path: '',
    summary: 'not oluştur',
    auth: 'required',
    request: { body: z.object({ text: z.string() }).strict() },
    response: z.object({ id: z.number(), text: z.string() }),
    async handler({ body }) {
      if (failNext) {
        failNext = false;
        throw new AppError(503, 'UNAVAILABLE', 'geçici');
      }
      created += 1;
      return { id: created, text: body.text };
    },
  },
]);

/** @type {Awaited<ReturnType<typeof setup>>} */
let t;
before(async () => {
  t = await setup({ modules: [...modules, notes] });
});
after(() => t.close());

const post = (key, text, token = 'test:idem-a') =>
  t.request('POST', '/notes-probe', { token, body: { text }, headers: key ? { 'Idempotency-Key': key } : {} });

test('aynı anahtar ikinci kez: iş yeniden yapılmaz, ilk yanıt aynen döner', async () => {
  created = 0;
  const first = await post('k-1', 'merhaba');
  const again = await post('k-1', 'merhaba');
  assert.equal(first.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(created, 1, 'çift kayıt yok');
});

test('aynı anahtar farklı içerikle → 422; anahtarsız istek her seferinde işlenir', async () => {
  created = 0;
  await post('k-2', 'bir');
  const reused = await post('k-2', 'iki');
  assert.equal(reused.status, 422);
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
  await post(null, 'x');
  await post(null, 'x');
  assert.equal(created, 3);
});

test('başarısız istek kaydedilmez: aynı anahtarla yeniden denenebilir', async () => {
  created = 0;
  failNext = true;
  const failed = await post('k-3', 'tekrar');
  assert.equal(failed.status, 503);
  const retried = await post('k-3', 'tekrar');
  assert.equal(retried.status, 200);
  assert.equal(created, 1);
});

test('anahtar kullanıcıya özel: başka kullanıcı aynı anahtarı kullanabilir', async () => {
  created = 0;
  await post('k-4', 'a', 'test:idem-a');
  const other = await post('k-4', 'a', 'test:idem-b');
  assert.equal(other.headers.get('idempotent-replayed'), null);
  assert.equal(created, 2);
});

test('Server-Timing: veritabanı süresi + sorgu sayısı ve toplam süre', async () => {
  const r = await post('k-5', 'zaman');
  const st = r.headers.get('server-timing') ?? '';
  assert.match(st, /db;dur=[\d.]+;desc="\d+ sorgu"/);
  assert.match(st, /app;dur=[\d.]+/);
});

test('eşzamanlı yük: 10 istek aynı anda — süre ve sorgu sayısı ölçülür (BE-24 concurrency)', async () => {
  const r = await t.perf('GET', '/health', { runs: 30, concurrency: 10 });
  assert.ok(r.p95 < 300, `p95 ${r.p95} ms`);
  assert.ok(r.maxQueries <= 2);
});
