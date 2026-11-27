'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { AppError } = require('./errors');

/**
 * Cihaz girişi (AUTH_MODE=device — oyunlar): uygulama ilk açılışta cihazına özel rastgele bir kimlik üretir,
 * POST /auth/device ile gönderir → kısa ömürlü erişim token'ı (HS256 JWT, JWT_SECRET) + uzun ömürlü refresh
 * token'ı. Refresh her kullanımda değişir (rotasyon; eskisi iptal). Veritabanında refresh'in yalnızca sha256'sı durur.
 * Kullanıcı satırı Firebase'deki gibi `users.firebase_uid` = "device:<sha256(cihaz kimliği)>" ile tutulur: kimlik
 * ara katmanı, hesap silme, premium — şablonun geri kalanı değişmeden çalışır.
 */

const sha256 = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const b64 = (/** @type {string | Buffer} */ v) => Buffer.from(v).toString('base64url');

/** Doğrulayıcının "token geçersiz" (401) hatası — core/auth.js isInvalidTokenError tanır. */
function invalid(message, code = 'auth/invalid-id-token') {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {string} secret
 * @param {string} sub
 * @param {number} ttlSec
 * @param {() => number} [now]
 */
function signAccessToken(secret, sub, ttlSec, now = Date.now) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now() / 1000);
  const payload = b64(JSON.stringify({ sub, typ: 'access', iat, exp: iat + ttlSec }));
  const sig = b64(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/**
 * @param {string} secret
 * @param {string} token
 * @param {() => number} [now]
 * @returns {{ sub: string, exp: number, iat: number, typ: string }}
 */
function verifyAccessToken(secret, token, now = Date.now) {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('token biçimi');
  const [h, p, s] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw invalid('token imzası');
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw invalid('token içeriği');
  }
  if (header?.alg !== 'HS256' || payload?.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    throw invalid('token alanları');
  }
  if (payload.exp * 1000 <= now()) throw invalid('token süresi doldu', 'auth/id-token-expired');
  return payload;
}

/**
 * core/auth.js TokenVerifier: erişim token'ı → kimlik. JWT_SECRET yoksa altyapı hatası (503), token kötüyse 401.
 * @param {string} secret
 * @param {() => number} [now]
 * @returns {import('./auth').TokenVerifier}
 */
function deviceVerifier(secret, now = Date.now) {
  return {
    async verify(token) {
      if (!secret) throw new Error('JWT_SECRET boş — cihaz girişi doğrulanamaz');
      const p = verifyAccessToken(secret, token, now);
      return { uid: p.sub, exp: p.exp, firebase: { sign_in_provider: 'device' } };
    },
  };
}

/**
 * @param {{
 *   db: import('../config/db').Db,
 *   users: import('../modules/auth/repository').UserRepository,
 *   config: { JWT_SECRET: string, ACCESS_TOKEN_TTL_SEC: number, REFRESH_TOKEN_TTL_DAYS: number },
 *   now?: () => number,
 * }} deps
 */
function createDeviceAuth({ db, users, config, now = Date.now }) {
  const access = (/** @type {string} */ uid) => signAccessToken(config.JWT_SECRET, uid, config.ACCESS_TOKEN_TTL_SEC, now);
  const deleted = () => new AppError(401, 'ACCOUNT_DELETED', 'Bu hesap silindi');

  /**
   * @param {string} userId
   * @param {import('mysql2/promise').PoolConnection} [conn]
   */
  async function issueRefresh(userId, conn) {
    const token = randomBytes(48).toString('base64url');
    const expires = new Date(now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const r = await db.run('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [userId, sha256(token), expires], conn);
    return { token, id: r.insertId };
  }

  return {
    /**
     * Cihaz kimliğiyle giriş: hesap yoksa açılır (aynı cihaz = aynı hesap). Silinmiş hesap bekleme süresindeyse geri gelir.
     * @param {{ device_id: string }} body
     */
    async login({ device_id: deviceId }) {
      if (!config.JWT_SECRET) throw new AppError(503, 'AUTH_UNAVAILABLE', 'Giriş servisi yapılandırılmamış');
      const uid = `device:${sha256(deviceId)}`;
      const { user, created } = await users.syncFromToken({ uid, exp: 0, firebase: { sign_in_provider: 'device' } });
      if (user.deleted_at) throw deleted();
      // Biriken eski oturumlar (süresi dolmuş / bir haftadan eski iptal edilmiş)
      await db.run(`DELETE FROM refresh_tokens WHERE user_id = ? AND (expires_at < UTC_TIMESTAMP(3)
                      OR revoked_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY)`, [user.id]);
      const refresh = await issueRefresh(user.id);
      return { access_token: access(uid), refresh_token: refresh.token, expires_in: config.ACCESS_TOKEN_TTL_SEC, user, created };
    },

    /**
     * Rotasyon: eski refresh iptal, yenisi verilir. Geçersiz / iptal / süresi dolmuş → 401 (uygulama yeniden
     * /auth/device ile girer — aynı cihaz aynı hesaba döner).
     * @param {string} token
     */
    async refresh(token) {
      if (!config.JWT_SECRET) throw new AppError(503, 'AUTH_UNAVAILABLE', 'Giriş servisi yapılandırılmamış');
      return db.tx(async (conn) => {
        const row = await db.one(
          `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at, u.firebase_uid, u.deleted_at
             FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
            WHERE rt.token_hash = ? FOR UPDATE`, [sha256(token)], conn);
        if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= now()) {
          throw new AppError(401, 'INVALID_TOKEN', 'Oturumun süresi doldu, tekrar giriş yap');
        }
        if (row.deleted_at) throw deleted();
        const next = await issueRefresh(row.user_id, conn);
        await db.run('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3), replaced_by_id = ? WHERE id = ?', [next.id, row.id], conn);
        return { access_token: access(row.firebase_uid), refresh_token: next.token, expires_in: config.ACCESS_TOKEN_TTL_SEC };
      });
    },
  };
}

module.exports = { signAccessToken, verifyAccessToken, deviceVerifier, createDeviceAuth };
