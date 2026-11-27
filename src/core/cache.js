'use strict';

/**
 * Süreç içi önbellek (LRU + TTL + etiket) — PM2 tek süreç çalıştığı için yeterli; çok sürece geçilirse aynı arayüzle
 * Redis'e taşınır. Yalnızca herkese açık / nadiren değişen veri için (kategoriler, SSS, ayarlar, herkese açık
 * profil kartı — kısa TTL). Kullanıcıya özel listeler önbelleğe ALINMAZ (istemci zaten önbellekliyor; doğruluk riski).
 *
 *   const cats = await deps.cache.wrap('categories', 300, () => repo.categories(), ['categories']);
 *   await repo.addCategory(...); deps.cache.invalidate('categories');   // etiketle hepsi
 *
 * @typedef {{ value: unknown, exp: number, tags: string[] }} Entry
 */
function createCache({ max = 1000, now = () => Date.now() } = {}) {
  /** @type {Map<string, Entry>} */
  const map = new Map();
  /** @type {Map<string, Promise<unknown>>} aynı anahtar için eşzamanlı yüklemeler tek yüklemeye iner */
  const inflight = new Map();

  /** @param {string} key */
  function get(key) {
    const e = map.get(key);
    if (!e) return undefined;
    if (e.exp <= now()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key); // LRU: en son kullanılan sona
    map.set(key, e);
    return e.value;
  }

  /** @param {string} key @param {unknown} value @param {number} ttlSec @param {string[]} [tags] */
  function set(key, value, ttlSec, tags = []) {
    map.delete(key);
    map.set(key, { value, exp: now() + ttlSec * 1000, tags: [key, ...tags] });
    while (map.size > max) map.delete(map.keys().next().value);
  }

  /**
   * @template T
   * @param {string} key @param {number} ttlSec @param {() => Promise<T>} load @param {string[]} [tags]
   * @returns {Promise<T>}
   */
  async function wrap(key, ttlSec, load, tags = []) {
    const hit = get(key);
    if (hit !== undefined) return /** @type {T} */ (hit);
    const running = inflight.get(key);
    if (running) return /** @type {Promise<T>} */ (running);
    const p = load().then((v) => {
      set(key, v, ttlSec, tags);
      return v;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** Anahtar ya da etiket — değişiklikten sonra çağrılır */
  function invalidate(tag) {
    for (const [k, e] of map) if (e.tags.includes(tag)) map.delete(k);
  }

  return { get, set, wrap, invalidate, clear: () => map.clear(), size: () => map.size };
}

module.exports = { createCache };
