'use strict';

const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const mysql = require('mysql2/promise');

/**
 * İstek başına sorgu ölçümü (performans kuralları — docs/BACKEND_ARCHITECTURE.md BE-24…): app.js her isteği
 * `db.track` içinde çalıştırır; sorgu sayısı ve süresi istek bittiğinde okunur (testler N+1'i ve yavaş ucu yakalar).
 * @typedef {{ queries: number, ms: number, slowest: number }} QueryStats
 */
const als = new AsyncLocalStorage();
/** Son isteklerin ölçümleri (istek kimliğine göre; erişim logu ve testler okur) */
const recent = new Map();
const SLOW_MS = 200;
/**
 * @typedef {import('mysql2/promise').PoolConnection | import('mysql2/promise').Pool} Executor
 * @typedef {{
 *   pool: import('mysql2/promise').Pool,
 *   query: <T = any>(sql: string, params?: unknown[], exec?: Executor) => Promise<T[]>,
 *   one: <T = any>(sql: string, params?: unknown[], exec?: Executor) => Promise<T | null>,
 *   run: (sql: string, params?: unknown[], exec?: Executor) => Promise<{ affectedRows: number, insertId: number }>,
 *   tx: <T>(fn: (conn: import('mysql2/promise').PoolConnection) => Promise<T>) => Promise<T>,
 *   health: () => Promise<{ ok: boolean, latencyMs: number, error?: string }>,
 *   close: () => Promise<void>,
 *   track: (id: string, fn: () => unknown) => unknown,
 *   statsOf: (id: string) => QueryStats | undefined,
 * }} Db
 */

/**
 * MySQL bağlantı havuzu. Tüm SQL parametreli yazılır (`?`); değer asla metne eklenmez.
 * `pool.query` istemci tarafında güvenli kaçış yapar (LIMIT ? dahil her yerde çalışır).
 * Saatler UTC tutulur ve okunur.
 * @param {{ DB_HOST: string, DB_PORT: number, DB_NAME: string, DB_USER: string, DB_PASSWORD: string, DB_CONNECTION_LIMIT: number, NODE_ENV?: string }} config
 * @returns {Db}
 */
function createDb(config, { onSlow = /** @type {(sql: string, ms: number) => void} */ (() => {}) } = {}) {
  // F2F_SQL_CAPTURE=<dosya>: testlerdeki her SELECT'in planı (EXPLAIN) yazılır → scripts/explain.js denetler
  const capture = process.env.F2F_SQL_CAPTURE;
  const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    connectionLimit: config.DB_CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: 100,
    enableKeepAlive: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    supportBigNumbers: true,
    // JSON sütunları nesne olarak gelsin
    typeCast(field, next) {
      if (field.type === 'JSON') {
        const raw = field.string('utf8');
        return raw == null ? null : JSON.parse(raw);
      }
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v == null ? null : v === '1';
      }
      return next();
    },
  });
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });

  /** Her sorgu buradan geçer: sayaç, yavaş sorgu bildirimi, EXPLAIN kaydı */
  async function exec_(sql, params, exec) {
    const started = performance.now();
    try {
      return await exec.query(sql, params);
    } finally {
      const ms = performance.now() - started;
      const st = als.getStore();
      if (st) {
        st.queries += 1;
        st.ms += ms;
        st.slowest = Math.max(st.slowest, ms);
      }
      if (ms > SLOW_MS) onSlow(sql.replace(/\s+/g, ' ').slice(0, 300), Math.round(ms));
      // Planı anında ve BEKLEYEREK al (yalnızca kayıt modunda — perf testi): testler her dosyada tabloları sıfırladığı
      // için sonradan EXPLAIN gerçeği göstermez; beklemezsek kapanan havuzla son planlar kaybolur
      if (capture && /^\s*SELECT\b/i.test(sql) && !/information_schema/i.test(sql)) await explain(sql, params, exec);
    }
  }

  async function explain(sql, params, exec) {
    try {
      const [plan] = await exec.query(`EXPLAIN FORMAT=TRADITIONAL ${sql}`, params);
      fs.appendFileSync(/** @type {string} */ (capture), `${JSON.stringify({ sql: sql.replace(/\s+/g, ' ').trim(),
        plan: /** @type {any[]} */ (plan).map((p) => ({ table: p.table, type: p.type, key: p.key, rows: Number(p.rows ?? 0),
          extra: p.Extra ?? '' })) })}\n`);
    } catch { /* EXPLAIN edilemeyen sorgu (ör. kilitli bağlantı) — denetim dışı */ }
  }

  /** @type {Db['query']} */
  async function query(sql, params = [], exec = pool) {
    const [rows] = await exec_(sql, params, exec);
    return /** @type {any} */ (rows);
  }

  /** @type {Db['one']} */
  async function one(sql, params = [], exec = pool) {
    const rows = await query(sql, params, exec);
    return rows[0] ?? null;
  }

  /** @type {Db['run']} */
  async function run(sql, params = [], exec = pool) {
    const [result] = await exec_(sql, params, exec);
    const r = /** @type {any} */ (result);
    return { affectedRows: r.affectedRows ?? 0, insertId: r.insertId ?? 0 };
  }

  /** @type {Db['tx']} */
  async function tx(fn) {
    // Eşzamanlı istekler InnoDB'de kilitlenebilir (ER_LOCK_DEADLOCK): MySQL kurbanı geri alır → kısa bekleyip yeniden dene.
    // fn yan etkisini yalnızca conn üzerinden yapmalı (dış servis çağrısı işlem dışında) — geri alınan deneme iz bırakmaz.
    for (let attempt = 0; ; attempt += 1) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        if (/** @type {any} */ (err)?.code !== 'ER_LOCK_DEADLOCK' || attempt >= 4) throw err;
      } finally {
        conn.release();
      }
      await new Promise((ok) => setTimeout(ok, 10 + Math.random() * 40 * (attempt + 1)));
    }
  }

  async function health() {
    const started = Date.now();
    try {
      await pool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: /** @type {Error} */ (err).message };
    }
  }

  /** @type {Db['track']} */
  function track(id, fn) {
    const st = { queries: 0, ms: 0, slowest: 0 };
    recent.set(id, st);
    if (recent.size > 500) recent.delete(recent.keys().next().value);
    return als.run(st, fn);
  }

  return { pool, query, one, run, tx, health, track, statsOf: (id) => recent.get(id), close: () => pool.end() };
}

/** MySQL tekil anahtar ihlali mi? (ör. aynı kullanıcı adı) */
function isDuplicate(err) {
  return Boolean(err && /** @type {any} */ (err).code === 'ER_DUP_ENTRY');
}

module.exports = { createDb, isDuplicate };
