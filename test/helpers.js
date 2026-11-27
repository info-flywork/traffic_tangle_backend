'use strict';

/**
 * Test ortamı: gerçek MySQL (TEST_DB_*), sahte Firebase / RevenueCat / OneSignal.
 * Her test dosyası setup() ile temiz veritabanı alır (tablolar silinir, migration'lar baştan uygulanır).
 *
 * Token biçimi (sahte doğrulayıcı): "test:<uid>" ya da "test:<uid>:<email>"
 *   "expired" → 401 (token geçersiz), "down" → 503 (Firebase'e ulaşılamıyor)
 */
const path = require('node:path');
const mysql = require('mysql2/promise');

process.env.ENV_FILE = process.env.ENV_FILE || path.resolve(__dirname, '../.env.test');
const { loadConfig } = require('../src/config/env');
const { createContainer } = require('../src/container');
const { createApp } = require('../src/app');
const { modules: allModules } = require('../src/modules');
const { migrate } = require('../src/db/migrate');
const { createLogger } = require('../src/core/logger');

const db = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3306),
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD || '',
  database: process.env.TEST_DB_NAME || 'app_test',
};

async function resetDatabase() {
  const conn = await mysql.createConnection({ ...db, multipleStatements: true });
  try {
    const [rows] = await conn.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
      [db.database],
    );
    const tables = /** @type {any[]} */ (rows).map((r) => r.t ?? r.TABLE_NAME);
    if (tables.length) {
      await conn.query(`SET FOREIGN_KEY_CHECKS = 0; DROP TABLE ${tables.map((t) => mysql.escapeId(t)).join(', ')}; SET FOREIGN_KEY_CHECKS = 1;`);
    }
  } finally {
    await conn.end();
  }
  await migrate(db, { log: () => {} });
}

/** Sahte Firebase doğrulayıcı */
const fakeVerifier = {
  /** @param {string} token */
  async verify(token) {
    if (token === 'expired') throw Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
    if (token === 'down') throw Object.assign(new Error('network'), { code: 'app/network-error' });
    const [kind, uid, email] = token.split(':');
    if (kind !== 'test' || !uid) throw Object.assign(new Error('bad'), { code: 'auth/argument-error' });
    return {
      uid,
      email,
      email_verified: Boolean(email),
      exp: Math.floor(Date.now() / 1000) + 3600,
      firebase: { sign_in_provider: email ? 'google.com' : 'phone' },
    };
  },
};

/**
 * @param {{ overrides?: Record<string, any>, modules?: any[], config?: Record<string, string> }} [opts]
 */
async function setup({ overrides = {}, modules = allModules, config: extraConfig = {} } = {}) {
  await resetDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.database,
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    REVENUECAT_WEBHOOK_AUTH: 'rc-test-secret',
    RATE_LIMIT_PER_MINUTE: '10000',
    ...extraConfig,
  });
  const calls = { firebaseDeleted: [], pushes: [], rcDeleted: [], osDeleted: [] };
  const deps = createContainer(config, {
    logger: createLogger({ level: 'error', write: () => {} }),
    verifier: fakeVerifier,
    firebaseUsers: { delete: async (uid) => void calls.firebaseDeleted.push(uid) },
    revenueCat: { enabled: false, getSubscriber: async () => ({ entitlements: {}, non_subscriptions: {} }), deleteSubscriber: async (id) => void calls.rcDeleted.push(id) },
    oneSignal: {
      enabled: true,
      send: async (msg) => {
        calls.pushes.push(msg);
        return { delivered: true };
      },
      deleteUser: async (id) => void calls.osDeleted.push(id),
    },
    ...overrides,
  });
  const app = createApp(deps, modules);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;

  /**
   * @param {string} method
   * @param {string} url
   * @param {{ token?: string, body?: unknown, headers?: Record<string, string> }} [opts]
   */
  async function request(method, url, { token, body, headers = {} } = {}) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch { /* JSON değil */ }
    const st = deps.db.statsOf?.(res.headers.get('x-request-id') ?? '');
    return { status: res.status, body: json, headers: res.headers, bytes: Buffer.byteLength(text),
      queries: st?.queries ?? 0, dbMs: st?.ms ?? 0 };
  }

  /**
   * Uç performansı (BE-24): aynı isteği `runs` kez atar → p50 / p95 süre, en çok sorgu sayısı, cevap boyutu.
   *   const p = await t.perf('GET', '/notes', { token });  assert.ok(p.p95 <= 120 && p.maxQueries <= 5);
   * @param {string} method @param {string} url
   * @param {{ token?: string, body?: unknown, runs?: number, concurrency?: number }} [opts]
   */
  async function perf(method, url, { token, body, runs = 20, concurrency = 1 } = {}) {
    const times = [];
    let maxQueries = 0;
    let bytes = 0;
    // concurrency > 1: aynı anda bu kadar istek (havuz / olay döngüsü yük altında — mobilde ekran açılışları üst üste gelir)
    const one = async () => {
      const started = performance.now();
      const r = await request(method, url, { token, body });
      times.push(performance.now() - started);
      if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
      maxQueries = Math.max(maxQueries, r.queries);
      bytes = Math.max(bytes, r.bytes);
    };
    for (let i = 0; i < runs; i += concurrency) {
      await Promise.all(Array.from({ length: Math.min(concurrency, runs - i) }, one));
    }
    times.sort((a, b) => a - b);
    const at = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
    return { p50: at(0.5), p95: at(0.95), maxQueries, bytes };
  }

  /**
   * Gerçekçi hacim (BE-24): tabloya toplu satır (500'lük INSERT'lerle). `row(i)` sütun → değer nesnesi döner.
   *   await t.seedRows('notes', 2000, (i) => ({ id: randomUUID(), user_id: uid, title: `Not ${i}`, … }));
   * @param {string} table @param {number} n @param {(i: number) => Record<string, unknown>} row
   */
  async function seedRows(table, n, row) {
    for (let start = 0; start < n; start += 500) {
      const rows = Array.from({ length: Math.min(500, n - start) }, (_, k) => row(start + k));
      const cols = Object.keys(rows[0]);
      await deps.db.run(`INSERT INTO ${mysql.escapeId(table)} (${cols.map((c) => mysql.escapeId(c)).join(', ')}) VALUES ?`,
        [rows.map((r) => cols.map((c) => r[c]))]);
    }
    await deps.db.run(`ANALYZE TABLE ${mysql.escapeId(table)}`); // optimizer istatistikleri: EXPLAIN gerçeği yansıtsın
  }

  return {
    deps,
    calls,
    base,
    request,
    perf,
    seedRows,
    async close() {
      await new Promise((r) => server.close(r));
      await deps.db.close();
    },
  };
}

module.exports = { setup, fakeVerifier, testDb: db };
