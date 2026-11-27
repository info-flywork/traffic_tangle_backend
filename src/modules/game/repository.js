'use strict';

const BUILDING_COLS = `b.id, b.name, b.short_name, b.world_number, b.idx, b.total_in_world, b.required_stars,
  b.image, b.renewed_image, b.renew_reward`;
const PLAYER_COLS = `user_id, coins, stars, highest_unlocked_level, last_played_level, freeze_time_count,
  magic_wand_count, tutorial_seen, finale_shown`;

/**
 * Yalnızca SQL (players, level_completions, game_results, currency_ledger, game_worlds, buildings, building_renewals).
 * Kullanıcıya ait her sorgu user_id ile filtrelenir; değerler parametreli (?). `exec` verilirse (transaction
 * bağlantısı) sorgu onun üzerinde çalışır.
 * @param {import('../../config/db').Db} db
 */
function createGameRepository(db) {
  return {
    /** @param {string} userId @param {any} [exec] */
    findPlayer(userId, exec) {
      return db.one(`SELECT ${PLAYER_COLS} FROM players WHERE user_id = ?`, [userId], exec);
    },

    /** Oyuncu satırını kilitler (ekonomi değişikliklerinin ilk adımı). @param {string} userId @param {any} conn */
    lockPlayer(userId, conn) {
      return db.one(`SELECT ${PLAYER_COLS} FROM players WHERE user_id = ? FOR UPDATE`, [userId], conn);
    },

    /** Yeni oyuncu satırı (varsayılanlarla). true = bu çağrı oluşturdu. @param {string} userId @param {any} conn */
    async insertPlayer(userId, conn) {
      const r = await db.run('INSERT IGNORE INTO players (user_id) VALUES (?)', [userId], conn);
      return r.affectedRows === 1;
    },

    /** @param {string} userId @param {any} [exec] */
    async completedLevels(userId, exec) {
      const rows = await db.query('SELECT level_number FROM level_completions WHERE user_id = ? ORDER BY level_number', [userId], exec);
      return rows.map((r) => r.level_number);
    },

    /** @param {string} userId @param {any} [exec] */
    async renewedIds(userId, exec) {
      const rows = await db.query(
        `SELECT b.id FROM building_renewals r JOIN buildings b ON b.id = r.building_id
         WHERE r.user_id = ? ORDER BY b.sort_order`,
        [userId],
        exec,
      );
      return rows.map((r) => r.id);
    },

    /** Bina kataloğu (100 satır, sabit tohum) — sıra: sort_order. Servis önbelleğe alır. */
    catalog() {
      return db.query(`SELECT ${BUILDING_COLS} FROM buildings b ORDER BY b.sort_order`);
    },

    /** @param {number} number */
    async worldName(number) {
      const w = await db.one('SELECT name FROM game_worlds WHERE number = ?', [number]);
      return w?.name ?? null;
    },

    /** İlk bitiş mi? (affectedRows 1 = yeni satır, 2 = güncelleme). @param {string} userId @param {number} level @param {number} moves @param {any} conn */
    async upsertCompletion(userId, level, moves, conn) {
      const r = await db.run(
        `INSERT INTO level_completions (user_id, level_number, best_moves) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE plays = plays + 1, best_moves = LEAST(best_moves, VALUES(best_moves)),
           last_completed_at = CURRENT_TIMESTAMP(3)`,
        [userId, level, moves],
        conn,
      );
      return r.affectedRows === 1;
    },

    /**
     * Bölüm bitiş değişiklikleri (satır kilitli; sayaçlar artımlı).
     * @param {string} userId @param {{ coins: number, stars: number, boosters: number, unlock: number, last: number }} d @param {any} conn
     */
    applyLevelComplete(userId, d, conn) {
      return db.run(
        `UPDATE players SET coins = coins + ?, stars = stars + ?, freeze_time_count = freeze_time_count + ?,
           magic_wand_count = magic_wand_count + ?, highest_unlocked_level = GREATEST(highest_unlocked_level, ?),
           last_played_level = ?, games_completed = games_completed + 1 WHERE user_id = ?`,
        [d.coins, d.stars, d.boosters, d.boosters, d.unlock, d.last, userId],
        conn,
      );
    },

    /** Koşullu harcama: bakiye yetmezse etkilenen satır 0. @param {string} userId @param {number} price @param {any} conn */
    async debitCoins(userId, price, conn) {
      const r = await db.run('UPDATE players SET coins = coins - ? WHERE user_id = ? AND coins >= ?', [price, userId, price], conn);
      return r.affectedRows === 1;
    },

    /** Koşullu yıldız harcama: yetmezse etkilenen satır 0. @param {string} userId @param {number} cost @param {any} conn */
    async debitStars(userId, cost, conn) {
      const r = await db.run('UPDATE players SET stars = stars - ? WHERE user_id = ? AND stars >= ?', [cost, userId, cost], conn);
      return r.affectedRows === 1;
    },

    /** @param {string} userId @param {number} amount @param {any} conn */
    creditCoins(userId, amount, conn) {
      return db.run('UPDATE players SET coins = coins + ? WHERE user_id = ?', [amount, userId], conn);
    },

    /** Stok düşer (0'ın altına inmez). @param {string} userId @param {'freeze_time' | 'magic_wand'} type @param {any} conn */
    async debitBooster(userId, type, conn) {
      const col = type === 'freeze_time' ? 'freeze_time_count' : 'magic_wand_count'; // sabit listeden
      const r = await db.run(`UPDATE players SET ${col} = ${col} - 1 WHERE user_id = ? AND ${col} > 0`, [userId], conn);
      return r.affectedRows === 1;
    },

    /** @param {string} userId @param {Record<string, number | boolean>} set @param {any} conn */
    updateFlags(userId, set, conn) {
      const cols = Object.keys(set).filter((k) => ['last_played_level', 'tutorial_seen', 'finale_shown'].includes(k));
      if (!cols.length) return Promise.resolve();
      return db.run(`UPDATE players SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ?`,
        [...cols.map((c) => set[c]), userId], conn);
    },

    /** @param {string} userId @param {number} level @param {any} conn */
    hasCompleted(userId, level, conn) {
      return db.one('SELECT 1 AS ok FROM level_completions WHERE user_id = ? AND level_number = ?', [userId, level], conn);
    },

    /** @param {string} userId @param {string} buildingId @param {number} reward @param {any} conn */
    async insertRenewal(userId, buildingId, reward, conn) {
      const r = await db.run('INSERT IGNORE INTO building_renewals (user_id, building_id, reward) VALUES (?, ?, ?)', [userId, buildingId, reward], conn);
      return r.affectedRows === 1;
    },

    /** Defter satırları tek INSERT ile: [currency, delta, balance_after, reason, ref] @param {string} userId @param {any[][]} rows @param {any} conn */
    insertLedger(userId, rows, conn) {
      if (!rows.length) return Promise.resolve();
      return db.run('INSERT INTO currency_ledger (user_id, currency, delta, balance_after, reason, ref) VALUES ?',
        [rows.map((r) => [userId, ...r])], conn);
    },

    /** @param {string} userId @param {any} r @param {any} conn */
    insertResult(userId, r, conn) {
      return db.run(
        `INSERT INTO game_results (user_id, level_number, reported_moves, reported_duration_ms, moves_used, duration_ms,
           first_clear, flagged, coins_awarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, r.level, r.reportedMoves, r.reportedDurationMs, r.moves, r.durationMs, r.first ? 1 : 0, r.flagged ? 1 : 0, r.coins],
        conn,
      );
    },
  };
}

module.exports = { createGameRepository };
