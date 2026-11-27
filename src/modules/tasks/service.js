'use strict';

const { randomUUID } = require('node:crypto');
const { notFound } = require('../../core/errors');

/**
 * Uzun işler (BE-29, skill: long-running-jobs). Modül kendi iş türünü tanımlar:
 *
 *   // modules/cvs/service.js
 *   const { defineTask } = require('../tasks/service');
 *   defineTask('cv.analyze', async ({ input, user, stage, deps }) => {
 *     await stage('reading', 10);          // uygulama aşama adını kendi dilinde gösterir
 *     const text = await readCv(input.cvId);
 *     await stage('analyzing', 40);
 *     const report = await deps.ai.analyze(text);   // dış servis — transaction dışında
 *     await stage('saving', 90);
 *     return { report_id: await save(report) };      // GET /jobs/:id → result
 *   });
 *   // route: POST /cvs/analyze → 202
 *   handler: ({ user, body, deps }) => deps.tasks.enqueue(user, 'cv.analyze', { cvId: body.cv_id }, { etaS: 25 }),
 *
 * İş kuyruğa yazılır ve AYNI süreçte hemen başlar (bekleme yok); worker yalnızca takılan / çöken işleri kurtarır.
 * Kullanıcıya gösterilecek hata `AppError` mesajıdır; beklenmeyen hata genel mesajla saklanır (log'da ayrıntı).
 *
 * @typedef {{ input: any, user: { id: string }, stage: (name: string, progress: number) => Promise<void>,
 *   deps: import('../../container').Container }} TaskCtx
 */

/** @type {Map<string, (ctx: TaskCtx) => Promise<unknown>>} */
const handlers = new Map();

/** @param {string} kind @param {(ctx: TaskCtx) => Promise<unknown>} fn */
function defineTask(kind, fn) {
  handlers.set(kind, fn);
}

const MAX_ATTEMPTS = 3;

/** @param {import('../../container').Container} deps */
function createService(deps) {
  const { db, logger } = deps;

  /** @param {any} row */
  const publicOf = (row) => ({
    id: row.id, kind: row.kind, status: row.status, stage: row.stage, progress: row.progress, eta_s: row.eta_s,
    result: row.result ?? null, error: row.error ?? null,
  });

  /** @param {string} id */
  async function run(id) {
    const claimed = await db.run(
      "UPDATE tasks SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [id]);
    if (!claimed.affectedRows) return; // başka süreç aldı
    const row = await db.one('SELECT id, user_id, kind, input FROM tasks WHERE id = ?', [id]);
    const fn = handlers.get(row.kind);
    try {
      if (!fn) throw new Error(`tanımsız iş türü: ${row.kind}`);
      const stage = async (name, progress) => {
        await db.run('UPDATE tasks SET stage = ?, progress = ? WHERE id = ?',
          [String(name).slice(0, 64), Math.max(0, Math.min(99, Math.round(progress))), id]);
      };
      const result = await fn({ input: row.input, user: { id: row.user_id }, stage, deps });
      await db.run("UPDATE tasks SET status = 'done', progress = 100, result = ? WHERE id = ?",
        [JSON.stringify(result ?? null), id]);
    } catch (err) {
      const e = /** @type {any} */ (err);
      logger.error('task_failed', { id, kind: row.kind, err: String(e?.message ?? e) });
      const message = e?.status && e.status < 500 ? String(e.message).slice(0, 500) : 'İşlem tamamlanamadı, tekrar dene';
      await db.run("UPDATE tasks SET status = 'failed', error = ? WHERE id = ?", [message, id]);
    }
  }

  return {
    /**
     * @param {{ id: string }} user @param {string} kind @param {unknown} input @param {{ etaS?: number }} [opts]
     * @returns {Promise<{ task_id: string, status: string, eta_s: number | null }>}
     */
    async enqueue(user, kind, input, { etaS } = {}) {
      if (!handlers.has(kind)) throw new Error(`tanımsız iş türü: ${kind} (defineTask)`);
      const id = randomUUID();
      await db.run('INSERT INTO tasks (id, user_id, kind, input, eta_s) VALUES (?, ?, ?, ?, ?)',
        [id, user.id, kind, JSON.stringify(input ?? null), etaS ?? null]);
      setImmediate(() => void run(id).catch((err) => logger.error('task_run_failed', { id, err: String(err) })));
      return { task_id: id, status: 'queued', eta_s: etaS ?? null };
    },

    /** @param {{ id: string }} user @param {string} id */
    async get(user, id) {
      const row = await db.one(
        'SELECT id, kind, status, stage, progress, eta_s, result, error FROM tasks WHERE id = ? AND user_id = ?', [id, user.id]);
      if (!row) throw notFound('İş bulunamadı');
      return publicOf(row);
    },

    run,

    /** Worker: süreç çökünce kalan işler (kuyrukta > 30 sn ya da 10 dk'dır güncellenmeyen) yeniden çalışır. */
    async recover() {
      await db.run(
        `UPDATE tasks SET status = 'queued' WHERE status = 'running' AND attempts < ? AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`,
        [MAX_ATTEMPTS]);
      await db.run(
        `UPDATE tasks SET status = 'failed', error = 'İşlem tamamlanamadı, tekrar dene'
         WHERE status IN ('queued', 'running') AND attempts >= ? AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`,
        [MAX_ATTEMPTS]);
      const stale = await db.query(
        "SELECT id FROM tasks WHERE status = 'queued' AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 30 SECOND LIMIT 20");
      for (const t of stale) await run(t.id);
      return { recovered: stale.length };
    },
  };
}

module.exports = { createService, defineTask };
