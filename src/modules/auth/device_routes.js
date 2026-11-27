'use strict';

const { z } = require('zod');
const { defineModule } = require('../../core/route');
const { UserPublic, toUserPublic } = require('./schemas');

/**
 * Cihaz girişi uçları (yalnızca AUTH_MODE=device — oyunlar; modules/index.js ekler). Akış:
 *   ilk açılış  → POST /auth/device {device_id} → access + refresh (cihazda güvenli depoda)
 *   her istek   → Authorization: Bearer <access>
 *   401         → POST /auth/refresh {refresh_token} → yeni çift; o da 401 ise yeniden /auth/device (aynı hesap)
 * Ardından uygulama POST /auth/sync çağırabilir (Firebase'li projelerle aynı oturum akışı).
 */
const Tokens = {
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int(),
};

module.exports = defineModule('device-auth', '', [
  {
    method: 'post',
    path: '/auth/device',
    summary: 'Cihaz kimliğiyle anonim giriş (yoksa hesap açılır; aynı cihaz aynı hesap)',
    auth: 'none',
    rateLimit: { windowMs: 60_000, max: 20 },
    request: {
      body: z.object({
        // Uygulamanın ilk açılışta ürettiği rastgele kimlik (güvenli depoda saklanır) — donanım kimliği değil
        device_id: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
        platform: z.enum(['ios', 'android']).optional(),
        app_version: z.string().max(32).optional(),
      }),
    },
    response: z.object({ ...Tokens, user: UserPublic, created: z.boolean() }),
    async handler({ body, deps }) {
      const r = await deps.deviceAuth.login(body);
      return { ...r, user: toUserPublic(r.user) };
    },
  },
  {
    method: 'post',
    path: '/auth/refresh',
    summary: 'Refresh token ile yeni erişim token’ı (rotasyon: eski refresh iptal edilir)',
    auth: 'none',
    rateLimit: { windowMs: 60_000, max: 60 },
    request: { body: z.object({ refresh_token: z.string().min(20).max(200) }) },
    response: z.object(Tokens),
    async handler({ body, deps }) {
      return deps.deviceAuth.refresh(body.refresh_token);
    },
  },
]);
