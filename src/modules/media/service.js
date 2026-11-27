'use strict';

const { randomUUID } = require('node:crypto');
const Busboy = require('busboy');
// sharp CJS'de fonksiyonun kendisini verir; tip tanımı ESM varsayılan dışa aktarımı
const sharp = /** @type {typeof import('sharp').default} */ (/** @type {any} */ (require('sharp')));
const { encode } = require('blurhash');
const { AppError, notFound } = require('../../core/errors');
const { onUserPurge } = require('../auth/account');

/** Görsel türleri — dosya içeriğinden doğrulanır (uzantıya / Content-Type'a güvenilmez) */
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'gif', 'avif']);
/** Uygulamanın kendi klasörlemesi: <prefix>/<kind>/<yıl>/<ay>/<id>-<boyut>.webp */
const KINDS = /^[a-z][a-z0-9_-]{1,31}$/;
const SIZES = { full: 1080, thumb: 320 };

/**
 * Görsel yükleme hattı (skill: media-pipeline): multipart akışı → içerikten tür doğrulama → EXIF yönü uygulanır ve
 * meta veri (konum) silinir → 1080 px + 320 px küçük resim, WebP → CDN (uygulamanın klasörü) → blurhash yer tutucu.
 * @param {import('../../container').Container} deps
 */
function createService(deps) {
  const { db, storage, config } = deps;
  const maxBytes = config.MEDIA_MAX_MB * 1024 * 1024;

  /** @param {import('express').Request} req @returns {Promise<{ file: Buffer, kind: string }>} */
  function readUpload(req) {
    return new Promise((ok, bad) => {
      let bb;
      try {
        bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 5 } });
      } catch {
        return bad(new AppError(415, 'UNSUPPORTED_MEDIA', 'multipart/form-data bekleniyor (alan: file)'));
      }
      let kind = 'images';
      /** @type {Buffer[]} */
      const chunks = [];
      let tooBig = false;
      let gotFile = false;
      bb.on('field', (name, value) => { if (name === 'kind') kind = value; });
      bb.on('file', (name, stream) => {
        if (name !== 'file') return stream.resume();
        gotFile = true;
        stream.on('data', (c) => chunks.push(c));
        stream.on('limit', () => { tooBig = true; });
      });
      bb.on('error', bad);
      bb.on('close', () => {
        if (tooBig) return bad(new AppError(413, 'FILE_TOO_LARGE', `Dosya en fazla ${config.MEDIA_MAX_MB} MB olabilir`));
        if (!gotFile) return bad(new AppError(422, 'FILE_REQUIRED', '"file" alanında dosya yok'));
        if (!KINDS.test(kind)) return bad(new AppError(422, 'BAD_KIND', 'kind: küçük harf, rakam, - _ (ör. avatars)'));
        ok({ file: Buffer.concat(chunks), kind });
      });
      req.pipe(bb);
    });
  }

  /** @param {Buffer} input */
  async function process(input) {
    const meta = await sharp(input, { failOn: 'error' }).metadata().catch(() => null);
    if (!meta?.format || !IMAGE_FORMATS.has(meta.format)) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA', 'Yalnızca görsel (JPEG, PNG, WebP, HEIC, GIF, AVIF)');
    }
    // rotate(): EXIF yönünü uygular; WebP çıktısı meta veriyi (konum dahil) taşımaz
    const base = sharp(input, { failOn: 'error' }).rotate();
    const full = await base.clone().resize({ width: SIZES.full, height: SIZES.full, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const thumb = await base.clone().resize({ width: SIZES.thumb, height: SIZES.thumb, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 }).toBuffer();
    const tiny = await base.clone().resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const blurhash = encode(new Uint8ClampedArray(tiny.data), tiny.info.width, tiny.info.height, 4, 3);
    return { full: full.data, width: full.info.width, height: full.info.height, thumb, blurhash };
  }

  /** @param {{ path_full: string, path_thumb: string }} row */
  const publicOf = (row) => ({ url: storage.url(row.path_full), thumb_url: storage.url(row.path_thumb) });

  const service = {
    /**
     * @param {import('../auth/repository').UserRow} user @param {import('express').Request} req
     */
    async upload(user, req) {
      const { file, kind } = await readUpload(req);
      const img = await process(file);
      const id = randomUUID();
      const now = new Date();
      const dir = `${kind}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const paths = { full: `${dir}/${id}-${SIZES.full}.webp`, thumb: `${dir}/${id}-${SIZES.thumb}.webp` };
      await Promise.all([storage.put(paths.full, img.full, 'image/webp'), storage.put(paths.thumb, img.thumb, 'image/webp')]);
      await db.run(
        `INSERT INTO media (id, user_id, kind, path_full, path_thumb, width, height, blurhash, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, user.id, kind, paths.full, paths.thumb, img.width, img.height, img.blurhash, img.full.length],
      );
      return { id, ...publicOf({ path_full: paths.full, path_thumb: paths.thumb }), width: img.width, height: img.height,
        blurhash: img.blurhash };
    },

    /** @param {import('../auth/repository').UserRow} user @param {string} id */
    async remove(user, id) {
      const row = await db.one('SELECT path_full, path_thumb FROM media WHERE id = ? AND user_id = ?', [id, user.id]);
      if (!row) throw notFound('Medya bulunamadı');
      await db.run('DELETE FROM media WHERE id = ?', [id]);
      await Promise.all([storage.remove(row.path_full), storage.remove(row.path_thumb)]).catch((err) =>
        deps.logger.warn('media_remove_failed', { id, err: String(err) }));
      return { deleted: true };
    },

    /** Başka modüller: kullanıcının yüklediği medya mı? (ör. profil fotoğrafı olarak kaydederken) */
    async owned(user, id) {
      const row = await db.one('SELECT id, path_full, path_thumb, width, height, blurhash FROM media WHERE id = ? AND user_id = ?',
        [id, user.id]);
      return row ? { id: row.id, ...publicOf(row), width: row.width, height: row.height, blurhash: row.blurhash } : null;
    },
  };
  return service;
}

// Hesap kalıcı silinince CDN'deki dosyaları da sil (satırlar cascade ile gider)
onUserPurge(async (user, deps) => {
  const rows = await deps.db.query('SELECT path_full, path_thumb FROM media WHERE user_id = ?', [user.id]);
  for (const r of rows) await Promise.all([deps.storage.remove(r.path_full), deps.storage.remove(r.path_thumb)]);
});

module.exports = { createService };
