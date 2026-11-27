'use strict';

// Uzun işler (BE-29): kuyruk → hemen başlar → aşama / ilerleme → sonuç; hata mesajı; sahiplik; çöken işin kurtarılması.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { setup } = require('./helpers');
const { defineTask } = require('../src/modules/tasks/service');
const { AppError } = require('../src/core/errors');

/** @type {Awaited<ReturnType<typeof setup>>} */
let t;
/** @type {(v?: unknown) => void} */
let release = () => {};
defineTask('test.report', async ({ input, stage }) => {
  await stage('reading', 20);
  await new Promise((r) => { release = r; });
  await stage('writing', 80);
  return { pages: input.pages };
});
defineTask('test.bad-input', async () => { throw new AppError(422, 'BAD', 'CV okunamadı'); });
defineTask('test.crash', async () => { throw new Error('gizli iç ayrıntı'); });

before(async () => { t = await setup(); });
after(() => t.close());

const userOf = async (uid) => {
  await t.request('GET', '/account', { token: `test:${uid}` });
  return t.deps.db.one('SELECT id FROM users WHERE firebase_uid = ?', [uid]);
};
const until = async (fn) => { for (let i = 0; i < 100; i += 1) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('zaman aşımı'); };

test('iş hemen başlar, aşama / ilerleme görünür, bitince sonuç döner', async () => {
  const user = await userOf('tk1');
  const { task_id, status } = await t.deps.tasks.enqueue(user, 'test.report', { pages: 3 }, { etaS: 20 });
  assert.equal(status, 'queued');
  const mid = await until(async () => {
    const r = (await t.request('GET', `/jobs/${task_id}`, { token: 'test:tk1' })).body.data;
    return r.stage === 'reading' ? r : null;
  });
  assert.deepEqual([mid.status, mid.progress, mid.eta_s], ['running', 20, 20]);
  release();
  const done = await until(async () => {
    const r = (await t.request('GET', `/jobs/${task_id}`, { token: 'test:tk1' })).body.data;
    return r.status === 'done' ? r : null;
  });
  assert.deepEqual([done.progress, done.result], [100, { pages: 3 }]);
  assert.equal((await t.request('GET', `/jobs/${task_id}`, { token: 'test:stranger' })).status, 404);
});

test('kullanıcıya gösterilecek hata aynen, beklenmeyen hata genel mesajla', async () => {
  const user = await userOf('tk2');
  const a = await t.deps.tasks.enqueue(user, 'test.bad-input', {});
  const b = await t.deps.tasks.enqueue(user, 'test.crash', {});
  const get = (id) => t.request('GET', `/jobs/${id}`, { token: 'test:tk2' }).then((r) => r.body.data);
  const fa = await until(async () => { const r = await get(a.task_id); return r.status === 'failed' ? r : null; });
  const fb = await until(async () => { const r = await get(b.task_id); return r.status === 'failed' ? r : null; });
  assert.equal(fa.error, 'CV okunamadı');
  assert.equal(fb.error, 'İşlem tamamlanamadı, tekrar dene');
});

test('süreç çökünce kuyrukta kalan iş worker tarafından çalıştırılır', async () => {
  const user = await userOf('tk3');
  const id = '00000000-0000-4000-8000-000000000003';
  await t.deps.db.run(`INSERT INTO tasks (id, user_id, kind, input, updated_at) VALUES (?, ?, 'test.report', '{"pages":1}',
    UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE)`, [id, user.id]);
  const recovering = t.deps.tasks.recover();
  await until(async () => (await t.deps.db.one('SELECT stage FROM tasks WHERE id = ?', [id]))?.stage === 'reading');
  release();
  await recovering;
  assert.equal((await t.deps.db.one('SELECT status FROM tasks WHERE id = ?', [id])).status, 'done');
});
