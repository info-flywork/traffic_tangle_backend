'use strict';

/**
 * Worker'ın çalıştırdığı işler. Her iş: ad, ne sıklıkla (everyMs) ya da günde bir kez (dailyAtUtc
 * "HH:MM"), ve run(deps). Aynı iş aynı anda iki yerde çalışmaz (MySQL kilidi).
 *
 * @typedef {{
 *   name: string,
 *   everyMs?: number,
 *   dailyAtUtc?: string,
 *   run: (deps: import('../container').Container) => Promise<unknown>,
 * }} Job
 */

/** @type {Job[]} */
const jobs = [
  { name: 'push-outbox', everyMs: 5_000, run: (deps) => deps.notifications.processOutbox() },
  { name: 'account-purge', everyMs: 10 * 60_000, run: (deps) => deps.account.purgeDue() },
  { name: 'tasks-recover', everyMs: 30_000, run: (deps) => deps.tasks.recover() },
  // Tekrarlanan istek kayıtları (Idempotency-Key) 24 saat saklanır
  {
    name: 'idempotency-purge',
    everyMs: 60 * 60_000,
    run: (deps) => deps.db.run('DELETE FROM idempotency_keys WHERE created_at < NOW(3) - INTERVAL 1 DAY'),
  },
  // uygulama işleri: modül klasöründeki jobs.js (scripts/register.js)
  ...require('../modules/app.generated').jobs,
];

module.exports = { jobs };
