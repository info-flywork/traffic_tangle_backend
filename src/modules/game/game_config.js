'use strict';

/**
 * Oyun sabitleri — uygulamanın lib/domain/game/game_config.dart (GameConfig) ile BİREBİR aynı.
 * Uygulamadaki değer değişirse burası da değişir (test/game_rules.test.js sabitleri kilitler).
 */
const GAME_CONFIG = Object.freeze({
  LEVEL_COUNT: 200,
  WORLD_COUNT: 10,
  LEVELS_PER_WORLD: 20,
  START_COINS: 300,
  LEVEL_REWARD: 50,
  WORLD_REWARD: 500,
  FINALE_REWARD: 1000,
  STARS_PER_LEVEL: 1,
  HINT_PRICE: 100,
  FREE_HINT_UNTIL_LEVEL: 3,
  COLOR_BOX_PRICE: 150,
  EXTRA_TIME_PRICE: 100,
  EXTRA_MOVES_PRICE: 100,
  START_FREEZE_TIME: 2,
  START_MAGIC_WAND: 1,
  BOOSTER_PER_WORLD: 1,
  PREMIUM_FREE_HINT: true,
  // Hile koruması (sunucuya özgü)
  MIN_LEVEL_MS: 1500,
  MAX_MOVES_PER_SEC: 6,
  MAX_DURATION_MS: 3_600_000,
  MAX_MOVES: 999,
});

module.exports = { GAME_CONFIG };
