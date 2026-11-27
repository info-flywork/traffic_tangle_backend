'use strict';

const { z } = require('zod');
const { defineModule } = require('../../core/route');

const Media = z.object({
  id: z.string(),
  url: z.string(),
  thumb_url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  blurhash: z.string().nullable(),
});

// Görsel yükleme (şablon — skill: media-pipeline). Uygulama modülleri dönen `id`'yi kendi kaydına bağlar
// (ör. PATCH /me { avatar_media_id }) ve `deps.media.owned(user, id)` ile sahipliği doğrular.
module.exports = defineModule('media', '/media', [
  {
    method: 'post',
    path: '',
    summary: 'Görsel yükle (multipart: file, kind?) — 1080 px + 320 px WebP, CDN adresleri, blurhash',
    auth: 'required',
    status: 201,
    rateLimit: { windowMs: 60_000, max: 30 },
    response: Media,
    handler: ({ user, req, deps }) => deps.media.upload(user, req),
  },
  {
    method: 'delete',
    path: '/:id',
    summary: 'Yüklediğim görseli sil (CDN dahil)',
    auth: 'required',
    request: { params: z.object({ id: z.string().uuid() }) },
    response: z.object({ deleted: z.boolean() }),
    handler: ({ user, params, deps }) => deps.media.remove(user, params.id),
  },
]);
