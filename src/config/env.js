'use strict';

const path = require('node:path');
const { z } = require('zod');
const { AUTH_MODE } = require('./auth_mode');

// .env sunucuda projenin kökünde durur (repoya girmez). Testler ENV_FILE ile başka dosya verebilir.
require('dotenv').config({
  path: process.env.ENV_FILE || path.resolve(__dirname, '../../.env'),
  quiet: true,
});

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Tüm ayarlar burada, açılışta doğrulanır: eksik ya da hatalı değer varsa uygulama hiç başlamaz
 * (çalışırken sürpriz yok). Yeni ayar = buraya bir satır + .env.example'a bir satır.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Reverse proxy (nginx) arkasında: gerçek istemci IP'si için */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  PUBLIC_BASE_URL: z.string().url().optional(),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  FIREBASE_PROJECT_ID: z.string().default(''),
  /** Servis hesabı: JSON dosya yolu ya da base64 JSON */
  FIREBASE_SERVICE_ACCOUNT: z.string().default(''),

  /** Giriş türü — varsayılanı koddan (src/config/auth_mode.js); device = cihaz girişi + kendi JWT'miz (oyunlar) */
  AUTH_MODE: z.enum(['firebase', 'device']).default(AUTH_MODE),
  /** device: erişim token'ı imza anahtarı (en az 32 karakter; panel üretir) */
  JWT_SECRET: z.string().default(''),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(180),

  /** Hesap silme: 0 = hemen (App Store / Play için önerilen), >0 = o kadar gün sonra kalıcı silinir */
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(0).default(0),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),

  REVENUECAT_WEBHOOK_AUTH: z.string().default(''),
  /** RevenueCat secret (sk_…) — satın alma doğrulama ve hesap silmede abone kaydını silme */
  REVENUECAT_SECRET_KEY: z.string().default(''),

  ONESIGNAL_APP_ID: z.string().default(''),
  ONESIGNAL_REST_API_KEY: z.string().default(''),

  /** Push / zamanlanmış işler bu süreçte çalışmasın (yalnızca worker çalıştırır) */
  WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
  OPENAPI_ENABLED: bool.default(true),

  // Medya (skill: media-pipeline): Bunny CDN — her uygulama kendi klasöründe (MEDIA_PREFIX = paket adı)
  MEDIA_DRIVER: z.enum(['bunny', 'local', 'memory']).default('local'),
  MEDIA_PREFIX: z.string().default('app'),
  MEDIA_PUBLIC_URL: z.string().default(''),
  MEDIA_MAX_MB: z.coerce.number().positive().default(10),
  BUNNY_STORAGE_ZONE: z.string().default(''),
  BUNNY_STORAGE_HOST: z.string().default('storage.bunnycdn.com'),
  BUNNY_STORAGE_PASSWORD: z.string().default(''),
});

/** @typedef {z.infer<typeof schema>} Config */

/**
 * @param {Record<string, string | undefined>} [source]
 * @returns {Readonly<Config>}
 */
function loadConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ayarlar hatalı (.env):\n${lines.join('\n')}`);
  }
  return Object.freeze(parsed.data);
}

/** @type {Readonly<Config> | null} */
let cached = null;

/** Süreç genelinde tek ayar nesnesi (ilk çağrıda doğrulanır). */
function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

/**
 * Şemada olmayan, kullanıcının "ortak anahtarlar"ından gelen ek değerler (ör. OPENAI_API_KEY).
 * @param {string} name
 * @param {string} [fallback]
 */
function extra(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

module.exports = { loadConfig, getConfig, extra, schema };
