'use strict';

const { createHash } = require('node:crypto');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');
const { AppError, unprocessable, forbidden } = require('./errors');

/**
 * Bildirimsel rota tanımı — her uç bir nesne. Express rotası, girdi doğrulama, kimlik, premium kilidi,
 * hız sınırı, yanıt şeması kontrolü, OpenAPI belgesi ve sözleşme testleri bu TEK tanımdan üretilir.
 *
 * @typedef {'none' | 'optional' | 'required'} AuthMode
 *
 * @typedef {{
 *   body?: z.ZodType,
 *   query?: z.ZodType,
 *   params?: z.ZodType,
 * }} RequestSchemas
 *
 * @typedef {{
 *   body: any, query: any, params: any,
 *   user: import('../modules/auth/repository').UserRow | null,
 *   req: import('express').Request,
 *   res: import('express').Response,
 *   deps: import('../container').Container,
 *   log: import('./logger').Logger,
 * }} Ctx
 *
 * @typedef {{
 *   method: 'get' | 'post' | 'put' | 'patch' | 'delete',
 *   path: string,
 *   summary: string,
 *   auth: AuthMode,
 *   request?: RequestSchemas,
 *   response?: z.ZodType,
 *   status?: number,
 *   premium?: boolean | string,
 *   rateLimit?: { windowMs: number, max: number },
 *   raw?: boolean,
 *   tags?: string[],
 *   handler: (ctx: Ctx) => Promise<unknown>,
 * }} RouteDef
 *
 * @typedef {{ name: string, prefix: string, routes: RouteDef[] }} Module
 */

/**
 * @param {string} name modül adı (OpenAPI etiketi)
 * @param {string} prefix ör. "/cvs" (boş olabilir)
 * @param {RouteDef[]} routes
 * @returns {Module}
 */
function defineModule(name, prefix, routes) {
  return { name, prefix, routes };
}

/**
 * Değeri şemanın şekline indirger: nesnede yalnızca şemadaki anahtarlar kalır (iç içe, listelerde de). Şema
 * doğrulaması başarısız olsa bile (canlı) tanımsız alan istemciye gitmez.
 * @param {any} schema @param {any} value @returns {any}
 */
function stripTo(schema, value) {
  if (value === null || value === undefined || !schema) return value;
  const def = schema._zod?.def ?? schema.def ?? {};
  switch (def.type) {
    case 'optional': case 'nullable': case 'default': case 'catch': case 'readonly': case 'nonoptional':
      return stripTo(def.innerType, value);
    case 'pipe':
      return stripTo(def.out ?? def.in, value);
    case 'array':
      return Array.isArray(value) ? value.map((v) => stripTo(def.element, v)) : value;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return value;
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, sub] of Object.entries(def.shape ?? {})) if (k in value) out[k] = stripTo(sub, value[k]);
      return out;
    }
    case 'union':
      return value; // hangi dalın kastedildiği belirsiz — union cevaplarda alanları sen sınırla
    default:
      return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && def.type !== 'record'
        && def.type !== 'any' && def.type !== 'unknown' ? {} : value;
  }
}

/** Express yolu (/:id) → OpenAPI yolu ({id}) */
const toOpenApiPath = (p) => p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

/**
 * @param {z.ZodError} err
 */
function issuesOf(err) {
  return err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
}

/**
 * Modülü Express router'a çevirir.
 * @param {Module} mod
 * @param {import('../container').Container} deps
 */
function buildRouter(mod, deps) {
  const router = express.Router();
  const strictResponses = deps.config.NODE_ENV !== 'production';
  for (const def of mod.routes) {
    /** @type {import('express').RequestHandler[]} */
    const chain = [];
    if (def.rateLimit) {
      chain.push(
        rateLimit({
          windowMs: def.rateLimit.windowMs,
          limit: def.rateLimit.max,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
          // Giriş yapmış kullanıcıya göre; değilse IP
          keyGenerator: (req) => /** @type {any} */ (req).user?.id || ipKeyGenerator(req.ip || '0.0.0.0'),
          handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Çok fazla istek, biraz sonra tekrar dene')),
        }),
      );
    }
    if (def.auth !== 'none') chain.unshift(def.auth === 'required' ? deps.auth.required : deps.auth.optional);
    if (def.premium) {
      const entitlement = typeof def.premium === 'string' ? def.premium : null;
      chain.push(async (req, _res, next) => {
        const user = /** @type {any} */ (req).user;
        const ok = user && (await deps.entitlements.isActive(user.id, entitlement));
        next(ok ? undefined : forbidden('Bu özellik premium üyelere açık', 'PREMIUM_REQUIRED'));
      });
    }
    chain.push(async (req, res) => {
      /** @type {{ body?: any, query?: any, params?: any }} */
      const parsed = {};
      const problems = [];
      for (const part of /** @type {const} */ (['params', 'query', 'body'])) {
        const schema = def.request?.[part];
        if (!schema) {
          parsed[part] = req[part];
          continue;
        }
        const r = schema.safeParse(req[part] ?? {});
        if (r.success) parsed[part] = r.data;
        else problems.push(...issuesOf(r.error));
      }
      // Tüm alan hataları tek yanıtta (form tek seferde işaretlenebilsin)
      if (problems.length) throw unprocessable('Gönderilen bilgilerde hata var', problems);
      const user = /** @type {any} */ (req).user ?? null;
      const log = deps.logger.child({ reqId: /** @type {any} */ (req).id, route: `${def.method.toUpperCase()} ${mod.prefix}${def.path}` });
      const idem = await idempotencyBegin(def, req, res, parsed, user, deps);
      if (idem === 'replayed') return;
      let data;
      try {
        data = await def.handler({ body: parsed.body, query: parsed.query, params: parsed.params, user, req, res, deps, log });
      } catch (err) {
        // başarısız iş kaydedilmez: istemci aynı anahtarla yeniden deneyebilir
        if (idem) await deps.db.run('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', [idem.userId, idem.key]);
        throw err;
      }
      if (def.raw) return; // yanıtı işleyici kendi yazdı (ör. dosya, yönlendirme)
      let out = data ?? null;
      if (def.response) {
        const r = def.response.safeParse(out);
        if (!r.success) {
          // Sözleşme ihlali: geliştirme / testte hata, canlıda yalnızca log (kullanıcı etkilenmesin) — ama ham veri
          // GİTMEZ: şemada tanımlı olmayan her alan ayıklanır (user_id, firebase_uid gibi alanlar sızmaz — OWASP API3)
          log.error('response_contract_violation', { issues: issuesOf(r.error) });
          if (strictResponses) throw new AppError(500, 'RESPONSE_CONTRACT', 'Yanıt sözleşmeye uymuyor', issuesOf(r.error));
          out = stripTo(def.response, out);
        } else out = r.data;
      }
      const status = def.status ?? 200;
      const payload = { status: 'success', message: 'ok', data: out };
      if (idem) {
        await deps.db.run('UPDATE idempotency_keys SET status_code = ?, response = ? WHERE user_id = ? AND idem_key = ?',
          [status, JSON.stringify(payload), idem.userId, idem.key]);
      }
      setServerTiming(req, res, deps, user);
      res.status(status).json(payload);
    });
    router[def.method](def.path, ...chain);
  }
  return router;
}

/**
 * `Idempotency-Key` (skill mobile-api-contract): değişiklik ucunda, kimlikli kullanıcıda. Aynı kullanıcı + anahtar
 * daha önce başarıyla işlendiyse ilk yanıt aynen döner (`Idempotent-Replayed: true`) — çevrimdışı kuyruk / zayıf ağda
 * yeniden deneme çift kayıt yapmaz. Aynı anahtar farklı istekle → 422; ilki hâlâ işleniyorsa → 409.
 * @returns {Promise<null | 'replayed' | { userId: string, key: string }>}
 */
async function idempotencyBegin(def, req, res, parsed, user, deps) {
  const raw = req.headers['idempotency-key'];
  if (def.method === 'get' || !raw || !user) return null;
  const key = String(raw).slice(0, 64);
  const hash = createHash('sha256')
    .update(`${def.method} ${req.originalUrl.split('?')[0]} ${JSON.stringify(parsed.body ?? null)}`)
    .digest('hex');
  const prev = await deps.db.one(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = ? AND idem_key = ?',
    [user.id, key],
  );
  if (prev) {
    if (prev.request_hash !== hash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Bu istek anahtarı başka bir istek için kullanılmış');
    }
    if (prev.status_code == null) throw new AppError(409, 'REQUEST_IN_PROGRESS', 'Aynı istek hâlâ işleniyor');
    res.setHeader('Idempotent-Replayed', 'true');
    const body = typeof prev.response === 'string' ? JSON.parse(prev.response) : prev.response;
    res.status(prev.status_code).json(body);
    return 'replayed';
  }
  try {
    await deps.db.run('INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES (?, ?, ?)', [user.id, key, hash]);
  } catch (err) {
    // aynı anda iki kopya: ikincisi bekletilmez
    if (/** @type {any} */ (err)?.code === 'ER_DUP_ENTRY') {
      throw new AppError(409, 'REQUEST_IN_PROGRESS', 'Aynı istek hâlâ işleniyor');
    }
    throw err;
  }
  return { userId: user.id, key };
}

/**
 * `Server-Timing: db;dur=12.3;desc="4 sorgu", app;dur=31.0` — istemci (TimingInterceptor) hangi ucun neden yavaş
 * olduğunu görür. Altyapı ayrıntısı sızmasın diye canlıda yalnızca kimlikli isteklerde.
 */
function setServerTiming(req, res, deps, user) {
  if (deps.config.NODE_ENV === 'production' && !user) return;
  const parts = [];
  const st = deps.db.statsOf?.(/** @type {any} */ (req).id);
  if (st) parts.push(`db;dur=${st.ms.toFixed(1)};desc="${st.queries} sorgu"`);
  const started = /** @type {any} */ (req).startedAt;
  if (started) parts.push(`app;dur=${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}`);
  if (parts.length) res.setHeader('Server-Timing', parts.join(', '));
}

module.exports = { defineModule, buildRouter, toOpenApiPath, issuesOf, stripTo };
