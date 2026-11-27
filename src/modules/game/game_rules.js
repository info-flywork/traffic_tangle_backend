'use strict';

const { GAME_CONFIG: C } = require('./game_config');

/**
 * Bölüm sonucunu kırpar (hile koruması). Ham değer ayrıca saklanır; ödül kırpılmış sonuca göre verilir.
 * @param {{ moves_used: number, duration_ms: number }} r
 * @returns {{ moves: number, durationMs: number, flagged: boolean }}
 */
function clipResult({ moves_used: movesUsed, duration_ms: durationMs }) {
  const moves = Math.min(movesUsed, C.MAX_MOVES);
  const duration = Math.min(durationMs, C.MAX_DURATION_MS);
  const flagged = duration < C.MIN_LEVEL_MS || moves > Math.floor((duration / 1000) * C.MAX_MOVES_PER_SEC) + 2;
  return { moves, durationMs: duration, flagged };
}

/**
 * Bölüm bitiş ödülü (kırpılmış sonuçtan). `coins` yalnızca bölüm ödülü; bonuslar ayrı, `total` toplam.
 * Şüpheli (flagged) sonuçta coin 0 ama yıldız verilir — ilerleme hiç tıkanmasın.
 * @param {{ levelNumber: number, firstClear: boolean, flagged: boolean }} r
 */
function levelRewards({ levelNumber, firstClear, flagged }) {
  const worldEnd = levelNumber % C.LEVELS_PER_WORLD === 0;
  const finale = firstClear && levelNumber === C.LEVEL_COUNT;
  const world = firstClear && worldEnd && !finale;
  const coins = flagged ? 0 : C.LEVEL_REWARD;
  const worldBonus = world && !flagged ? C.WORLD_REWARD : 0;
  const finaleBonus = finale && !flagged ? C.FINALE_REWARD : 0;
  /** @type {'level' | 'world' | 'finale'} */
  const kind = finale ? 'finale' : world ? 'world' : 'level';
  return {
    coins,
    worldBonus,
    finaleBonus,
    total: coins + worldBonus + finaleBonus,
    stars: firstClear ? C.STARS_PER_LEVEL : 0,
    boosters: firstClear && worldEnd ? C.BOOSTER_PER_WORLD : 0,
    kind,
  };
}

/**
 * Harcama fiyatı (sunucuda; istemci fiyat göndermez).
 * @param {'hint' | 'color_box' | 'extra_time' | 'extra_moves'} reason
 * @param {number} levelNumber
 * @param {boolean} premium
 */
function spendPrice(reason, levelNumber, premium) {
  switch (reason) {
    case 'hint':
      if (levelNumber <= C.FREE_HINT_UNTIL_LEVEL) return 0;
      if (premium && C.PREMIUM_FREE_HINT) return 0;
      return C.HINT_PRICE;
    case 'color_box': return C.COLOR_BOX_PRICE;
    case 'extra_time': return C.EXTRA_TIME_PRICE;
    default: return C.EXTRA_MOVES_PRICE;
  }
}

module.exports = { clipResult, levelRewards, spendPrice };
