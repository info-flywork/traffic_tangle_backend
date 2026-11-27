'use strict';

// Saf kural testleri: sabitler uygulamanın GameConfig'iyle aynı, kırpma ve ödül kuralları.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { GAME_CONFIG } = require('../src/modules/game/game_config');
const { clipResult, levelRewards, spendPrice } = require('../src/modules/game/game_rules');

test('sabitler: uygulamanın game_config.dart değerleriyle aynı (dosya varsa)', () => {
  const dart = path.resolve(__dirname, '../../project/lib/domain/game/game_config.dart');
  if (!fs.existsSync(dart)) return;
  const src = fs.readFileSync(dart, 'utf8');
  const pairs = {
    levelCount: 'LEVEL_COUNT', worldCount: 'WORLD_COUNT', levelsPerWorld: 'LEVELS_PER_WORLD', startCoins: 'START_COINS',
    levelReward: 'LEVEL_REWARD', worldReward: 'WORLD_REWARD', finaleReward: 'FINALE_REWARD', starsPerLevel: 'STARS_PER_LEVEL',
    hintPrice: 'HINT_PRICE', freeHintUntilLevel: 'FREE_HINT_UNTIL_LEVEL', colorBoxPrice: 'COLOR_BOX_PRICE',
    extraTimePrice: 'EXTRA_TIME_PRICE', extraMovesPrice: 'EXTRA_MOVES_PRICE', startFreezeTime: 'START_FREEZE_TIME',
    startMagicWand: 'START_MAGIC_WAND', boosterPerWorld: 'BOOSTER_PER_WORLD',
  };
  for (const [dartName, key] of Object.entries(pairs)) {
    const m = src.match(new RegExp(`static const int ${dartName} = (\\d+);`));
    assert.ok(m, `${dartName} dart'ta yok`);
    assert.equal(GAME_CONFIG[key], Number(m[1]), key);
  }
});

test('clipResult: sınırlar', () => {
  assert.deepEqual(clipResult({ moves_used: 10, duration_ms: 30_000 }), { moves: 10, durationMs: 30_000, flagged: false });
  assert.equal(clipResult({ moves_used: 1, duration_ms: 1499 }).flagged, true);
  assert.equal(clipResult({ moves_used: 1, duration_ms: 1500 }).flagged, false);
  // 6 hamle/sn: 10 sn → 60 + 2 = 62 hamleye kadar
  assert.equal(clipResult({ moves_used: 62, duration_ms: 10_000 }).flagged, false);
  assert.equal(clipResult({ moves_used: 63, duration_ms: 10_000 }).flagged, true);
  const big = clipResult({ moves_used: 100_000, duration_ms: 86_400_000 });
  assert.equal(big.moves, 999);
  assert.equal(big.durationMs, 3_600_000);
});

test('levelRewards: tekrar, dünya sonu, final, flagged', () => {
  const r = (levelNumber, firstClear, flagged = false) => levelRewards({ levelNumber, firstClear, flagged });
  assert.deepEqual(r(9, false), { coins: 50, worldBonus: 0, finaleBonus: 0, total: 50, stars: 0, boosters: 0, kind: 'level' });
  assert.equal(r(9, true).stars, 1);
  const w = r(20, true);
  assert.equal(w.total, 550);
  assert.equal(w.boosters, 1);
  assert.equal(w.kind, 'world');
  assert.equal(r(20, false).total, 50);
  assert.equal(r(20, false).boosters, 0);
  const f = r(200, true);
  assert.equal(f.total, 1050);
  assert.equal(f.boosters, 1);
  assert.equal(f.kind, 'finale');
  const flagged = r(20, true, true);
  assert.equal(flagged.total, 0);
  assert.equal(flagged.stars, 1);
  assert.equal(flagged.boosters, 1);
});

test('spendPrice: ipucu B01–B03 ücretsiz, premium ipucu ücretsiz, diğerleri sabit', () => {
  assert.equal(spendPrice('hint', 3, false), 0);
  assert.equal(spendPrice('hint', 4, false), 100);
  assert.equal(spendPrice('hint', 4, true), 0);
  assert.equal(spendPrice('color_box', 1, true), 150);
  assert.equal(spendPrice('extra_time', 1, false), 100);
  assert.equal(spendPrice('extra_moves', 1, false), 100);
});
