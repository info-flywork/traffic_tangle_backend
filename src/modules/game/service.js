'use strict';

const { conflict, notFound } = require('../../core/errors');
const { createGameRepository } = require('./repository');
const { GAME_CONFIG: C } = require('./game_config');
const { clipResult, levelRewards, spendPrice } = require('./game_rules');

const BOOSTER_TYPES = ['freeze_time', 'magic_wand'];

/** Bina satırı → cevap (sütun `idx` cevapta `index`) @param {any} b @param {boolean} [renewed] */
const toBuilding = (b, renewed = false) => ({
  id: b.id,
  name: b.name,
  short_name: b.short_name,
  world_number: b.world_number,
  index: b.idx,
  total_in_world: b.total_in_world,
  required_stars: b.required_stars,
  image: b.image,
  renewed_image: b.renewed_image,
  renew_reward: b.renew_reward,
  is_renewed: renewed,
});

/** @param {string} raw :number parametresi → 1..200 tam sayı, değilse 404 */
function parseLevel(raw) {
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= C.LEVEL_COUNT)) throw notFound('Bölüm bulunamadı');
  return n;
}

/**
 * Traffic Tangle oyuncu ilerlemesi ve ekonomisi: coin / yıldız / güçlendirici stoğu sunucuda yetkili, bölüm bitirme
 * (kırpma + ham değer), coin harcama, güçlendirici kullanma, bina yenileme, açılış ucu. Kullanıcı = cihaz.
 * Her ekonomi değişikliği tek transaction'da: players FOR UPDATE + defter (currency_ledger).
 * register.js `deps.game` olarak kaydeder.
 * @param {import('../../container').Container} deps
 */
function createService(deps) {
  const { db } = deps;
  const repo = createGameRepository(db);

  /**
   * Oyuncu satırını kilitleyip döner; yoksa varsayılanlarla oluşturur ve başlangıç bakiyesini deftere yazar.
   * @param {string} userId @param {any} conn
   */
  async function lockOrCreate(userId, conn) {
    let row = await repo.lockPlayer(userId, conn);
    if (row) return row;
    if (await repo.insertPlayer(userId, conn)) {
      await repo.insertLedger(userId, [
        ['coins', C.START_COINS, C.START_COINS, 'start_balance', null],
        ['freeze_time', C.START_FREEZE_TIME, C.START_FREEZE_TIME, 'start_stock', null],
        ['magic_wand', C.START_MAGIC_WAND, C.START_MAGIC_WAND, 'start_stock', null],
      ], conn);
    }
    row = await repo.lockPlayer(userId, conn);
    return row;
  }

  /** Kilitsiz okuma yolu: satır yoksa bir kez oluşturur. @param {string} userId */
  async function readPlayer(userId) {
    return (await repo.findPlayer(userId)) ?? db.tx((conn) => lockOrCreate(userId, conn));
  }

  /**
   * PlayerProgress: players + level_completions (PK öneki) + building_renewals JOIN buildings — 3 sorgu.
   * @param {string} userId @param {any} [player] hazır satır @param {any} [exec]
   */
  async function loadProgress(userId, player, exec) {
    const [p, completed, renewed] = await Promise.all([
      player ?? repo.findPlayer(userId, exec),
      repo.completedLevels(userId, exec),
      repo.renewedIds(userId, exec),
    ]);
    return {
      coins: p.coins,
      stars: p.stars,
      completed_levels: completed,
      highest_unlocked_level: p.highest_unlocked_level,
      last_played_level: p.last_played_level,
      freeze_time_count: p.freeze_time_count,
      magic_wand_count: p.magic_wand_count,
      tutorial_seen: Boolean(p.tutorial_seen),
      finale_shown: Boolean(p.finale_shown),
      renewed_building_ids: renewed,
    };
  }

  /** Bina kataloğu: sabit veri, sunucu içi önbellekte (sıra: sort_order) */
  const catalog = () => deps.cache.wrap('game:buildings', 300, () => repo.catalog(), ['game:buildings']);

  /** Sıradaki yenilenmemiş bina (katalogda ilk) @param {any[]} cat @param {string[]} renewedIds */
  const firstUnrenewed = (cat, renewedIds) => {
    const done = new Set(renewedIds);
    return cat.find((b) => !done.has(b.id)) ?? null;
  };

  /** @param {any} player @param {number} level */
  function assertUnlocked(player, level) {
    if (level > player.highest_unlocked_level) throw conflict('Bu bölüm henüz açılmadı', 'LEVEL_LOCKED');
  }

  return {
    /** GET /me/bootstrap — ilerleme + sıradaki bina + premium (açılışta tek istek).
     * @param {any} user @param {any} input */
    async getMeBootstrap(user, input) {
      void input;
      const player = await readPlayer(user.id);
      const [progress, cat, premium] = await Promise.all([
        loadProgress(user.id, player),
        catalog(),
        deps.entitlements.isActive(user.id, 'premium'),
      ]);
      const next = firstUnrenewed(cat, progress.renewed_building_ids);
      return { progress, next_building: next ? toBuilding(next) : null, premium, server_time: new Date().toISOString() };
    },

    /** GET /me/progress — bootstrap'ın progress alanıyla aynı şekil.
     * @param {any} user @param {any} input */
    async listMeProgress(user, input) {
      void input;
      return loadProgress(user.id, await readPlayer(user.id));
    },

    /** PATCH /me/progress — son oynanan bölüm ve tek yönlü bayraklar (coin / yıldız / stok değişmez).
     * @param {any} user @param {any} input */
    async updateMeProgress(user, input) {
      return db.tx(async (conn) => {
        const player = await lockOrCreate(user.id, conn);
        /** @type {Record<string, number | boolean>} */
        const set = {};
        if (input.last_played_level !== undefined) {
          if (input.last_played_level > player.highest_unlocked_level) throw conflict('Bu bölüm henüz açılmadı', 'LEVEL_LOCKED');
          set.last_played_level = input.last_played_level;
        }
        if (input.tutorial_seen) set.tutorial_seen = true;
        if (input.finale_shown) {
          if (!(await repo.hasCompleted(user.id, C.LEVEL_COUNT, conn))) {
            throw conflict('Final bölümü henüz bitmedi', 'FINALE_NOT_REACHED');
          }
          set.finale_shown = true;
        }
        await repo.updateFlags(user.id, set, conn);
        return loadProgress(user.id, null, conn);
      });
    },

    /** POST /levels/:number/complete — kırpma → ödül → ilerleme; tek transaction.
     * @param {any} user @param {any} input */
    async createLevelsComplete(user, input) {
      const level = parseLevel(input.number);
      const out = await db.tx(async (conn) => {
        const player = await lockOrCreate(user.id, conn);
        assertUnlocked(player, level);
        const clip = clipResult(input);
        const first = await repo.upsertCompletion(user.id, level, clip.moves, conn);
        const rw = levelRewards({ levelNumber: level, firstClear: first, flagged: clip.flagged });
        const next = Math.min(level + 1, C.LEVEL_COUNT);
        await repo.applyLevelComplete(user.id, { coins: rw.total, stars: rw.stars, boosters: rw.boosters, unlock: next, last: next }, conn);

        // Defter: coin ödülleri artan bakiyeyle, dünya bitişinde iki güçlendirici stoğu
        const ref = `level:${level}`;
        let balance = player.coins;
        /** @type {any[][]} */
        const ledger = [];
        for (const [amount, reason] of /** @type {const} */ ([[rw.coins, 'level_reward'], [rw.worldBonus, 'world_reward'], [rw.finaleBonus, 'finale_reward']])) {
          if (amount > 0) {
            balance += amount;
            ledger.push(['coins', amount, balance, reason, ref]);
          }
        }
        if (rw.boosters > 0) {
          ledger.push(['freeze_time', rw.boosters, player.freeze_time_count + rw.boosters, 'world_booster', ref]);
          ledger.push(['magic_wand', rw.boosters, player.magic_wand_count + rw.boosters, 'world_booster', ref]);
        }
        await repo.insertLedger(user.id, ledger, conn);
        await repo.insertResult(user.id, {
          level, reportedMoves: input.moves_used, reportedDurationMs: input.duration_ms, moves: clip.moves,
          durationMs: clip.durationMs, first, flagged: clip.flagged, coins: rw.total,
        }, conn);

        const stars = player.stars + rw.stars;
        const progress = await loadProgress(user.id, null, conn);
        const nextBuilding = firstUnrenewed(await catalog(), progress.renewed_building_ids);
        return {
          rw, clip, stars, progress,
          buildingReady: Boolean(nextBuilding && stars >= nextBuilding.required_stars),
          balance: progress.coins,
        };
      });
      const nextWorldName = out.rw.kind === 'world' ? await repo.worldName(level / C.LEVELS_PER_WORLD + 1) : null;
      return {
        result: {
          level_number: level,
          moves_used: out.clip.moves,
          coins_earned: out.rw.coins,
          stars_earned: out.rw.stars,
          world_bonus: out.rw.worldBonus,
          finale_bonus: out.rw.finaleBonus,
          coin_balance: out.balance,
          kind: out.rw.kind,
          next_world_name: nextWorldName,
          building_ready: out.buildingReady,
        },
        progress: out.progress,
      };
    },

    /** POST /wallet/spend — fiyat sunucuda; yetmezse 409 ve hiçbir şey değişmez.
     * @param {any} user @param {any} input */
    async createWalletSpend(user, input) {
      // Premium sorgusu yalnızca fiyatı etkileyebilecek durumda (kilit tutulmadan önce)
      const premium = input.reason === 'hint' && input.level_number > C.FREE_HINT_UNTIL_LEVEL
        ? await deps.entitlements.isActive(user.id, 'premium')
        : false;
      const price = spendPrice(input.reason, input.level_number, premium);
      return db.tx(async (conn) => {
        const player = await lockOrCreate(user.id, conn);
        assertUnlocked(player, input.level_number);
        if (price > 0) {
          if (!(await repo.debitCoins(user.id, price, conn))) {
            throw conflict('Yetersiz coin', 'INSUFFICIENT_COINS', [{ price, coins: player.coins }]);
          }
          await repo.insertLedger(user.id, [['coins', -price, player.coins - price, input.reason, `level:${input.level_number}`]], conn);
        }
        return { spent: price, progress: await loadProgress(user.id, null, conn) };
      });
    },

    /** POST /boosters/:type/use — stoktan düşer, deftere yazar.
     * @param {any} user @param {any} input */
    async createBoostersUse(user, input) {
      if (!BOOSTER_TYPES.includes(input.type)) throw notFound('Güçlendirici bulunamadı');
      const type = /** @type {'freeze_time' | 'magic_wand'} */ (input.type);
      return db.tx(async (conn) => {
        const player = await lockOrCreate(user.id, conn);
        assertUnlocked(player, input.level_number);
        if (!(await repo.debitBooster(user.id, type, conn))) throw conflict('Stok yok', 'OUT_OF_STOCK');
        const left = (type === 'freeze_time' ? player.freeze_time_count : player.magic_wand_count) - 1;
        await repo.insertLedger(user.id, [[type, -1, left, 'booster_use', `level:${input.level_number}`]], conn);
        return { progress: await loadProgress(user.id, null, conn) };
      });
    },

    /** GET /city/next-building — sıradaki yenilenmemiş bina; hepsi yenilendiyse null.
     * @param {any} user @param {any} input */
    async getCityNextBuilding(user, input) {
      void input;
      const [cat, renewed] = await Promise.all([catalog(), repo.renewedIds(user.id)]);
      const next = firstUnrenewed(cat, renewed);
      return { building: next ? toBuilding(next) : null };
    },

    /** POST /buildings/:id/renew — sırayla; bina yıldızı (required_stars) harcanır; zaten yenilenmişse ödül 0 (çift ödül yok).
     * @param {any} user @param {any} input */
    async createBuildingsRenew(user, input) {
      const building = (await catalog()).find((b) => b.id === input.id);
      if (!building) throw notFound('Bina bulunamadı');
      return db.tx(async (conn) => {
        const player = await lockOrCreate(user.id, conn);
        const renewed = await repo.renewedIds(user.id, conn);
        if (renewed.includes(building.id)) {
          return { building: toBuilding(building, true), reward: 0, progress: await loadProgress(user.id, player, conn) };
        }
        const next = firstUnrenewed(await catalog(), renewed);
        if (!next || next.id !== building.id) throw conflict('Önce sıradaki binayı yenile', 'BUILDING_LOCKED');
        if (player.stars < building.required_stars) {
          throw conflict('Yeterli yıldız yok', 'STARS_MISSING', [{ required: building.required_stars, current: player.stars }]);
        }
        const cost = building.required_stars;
        if (!(await repo.debitStars(user.id, cost, conn))) {
          throw conflict('Yeterli yıldız yok', 'STARS_MISSING', [{ required: cost, current: player.stars }]);
        }
        await repo.insertRenewal(user.id, building.id, building.renew_reward, conn);
        await repo.creditCoins(user.id, building.renew_reward, conn);
        const ref = `building:${building.id}`;
        await repo.insertLedger(user.id, [
          ['stars', -cost, player.stars - cost, 'building_renew', ref],
          ['coins', building.renew_reward, player.coins + building.renew_reward, 'building_renew', ref],
        ], conn);
        return { building: toBuilding(building, true), reward: building.renew_reward, progress: await loadProgress(user.id, null, conn) };
      });
    },
  };
}

module.exports = { createService };
