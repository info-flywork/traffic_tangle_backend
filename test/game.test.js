'use strict';

// Sözleşme (mock yok → şekil uygulamanın modellerinden), kimlik, ekonomi, kilitler, bina sırası, sahiplik, performans.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { setup } = require('./helpers');

/** @type {Awaited<ReturnType<typeof setup>>} */
let t;
before(async () => {
  t = await setup();
});
after(() => t.close());

/** Mock JSON'daki her alan yanıtta aynı tipte var mı (Flutter modeli bunu okur) */
function assertShape(actual, mock, where = 'data') {
  if (mock === null || mock === undefined) return;
  if (Array.isArray(mock)) {
    assert.ok(Array.isArray(actual), `${where} liste olmalı`);
    if (mock.length && actual.length) assertShape(actual[0], mock[0], `${where}[0]`);
    return;
  }
  if (typeof mock === 'object') {
    for (const k of Object.keys(mock)) {
      assert.ok(actual && k in actual, `${where}.${k} yanıtta yok`);
      assertShape(actual[k], mock[k], `${where}.${k}`);
    }
    return;
  }
  if (actual !== null) assert.equal(typeof actual, typeof mock, `${where} tipi`);
}

const PROGRESS = {
  coins: 0, stars: 0, completed_levels: [1], highest_unlocked_level: 1, last_played_level: 1, freeze_time_count: 0,
  magic_wand_count: 0, tutorial_seen: false, finale_shown: false, renewed_building_ids: ['a'],
};
const BUILDING = {
  id: 'a', name: 'a', short_name: 'a', world_number: 1, index: 1, total_in_world: 10, required_stars: 2, image: 'a',
  renewed_image: 'a', renew_reward: 200, is_renewed: false,
};
const RESULT = {
  level_number: 1, moves_used: 1, coins_earned: 50, stars_earned: 1, world_bonus: 0, finale_bonus: 0, coin_balance: 1,
  kind: 'level', next_world_name: null, building_ready: false,
};

let seq = 0;
/** Yeni kullanıcı: token + veritabanı kimliği (ilk istekle oluşur) */
async function newUser() {
  const uid = `u${Date.now()}${seq++}`;
  const token = `test:${uid}`;
  const r = await t.request('GET', '/me/progress', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await t.deps.db.one('SELECT id FROM users WHERE firebase_uid = ?', [uid]);
  return { token, id: row.id, uid };
}
const get = (u, url) => t.request('GET', url, { token: u.token });
const post = (u, url, body = {}, headers = {}) => t.request('POST', url, { token: u.token, body, headers });
/** @type {(u: any, n: number | string, body?: Record<string, unknown>, headers?: Record<string, string>) => Promise<any>} */
const complete = (u, n, body = { moves_used: 10, duration_ms: 30_000 }, headers = {}) => post(u, `/levels/${n}/complete`, body, headers);
const player = (u) => t.deps.db.one('SELECT * FROM players WHERE user_id = ?', [u.id]);
const setPlayer = (u, set) =>
  t.deps.db.run(`UPDATE players SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`, [...Object.values(set), u.id]);

test('GET /me/bootstrap kimlik ister', async () => {
  assert.equal((await t.request('GET', '/me/bootstrap')).status, 401);
});

test('GET /me/bootstrap sözleşmeye uyar; yeni oyuncu 300 coin / 2 dondur / 1 çubuk', async () => {
  const r = await t.request('GET', '/me/bootstrap', { token: 'test:boot' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assertShape(d, { progress: PROGRESS, next_building: BUILDING, premium: false, server_time: '' });
  assert.equal(d.progress.coins, 300);
  assert.equal(d.progress.freeze_time_count, 2);
  assert.equal(d.progress.magic_wand_count, 1);
  assert.deepEqual(d.progress.completed_levels, []);
  assert.equal(d.progress.highest_unlocked_level, 1);
  assert.equal(d.next_building.id, 'town1_fountain');
  assert.equal(d.next_building.is_renewed, false);
  assert.equal(d.next_building.index, 1);
  assert.equal(d.premium, false);
  assert.ok(!Number.isNaN(Date.parse(d.server_time)));
  assert.equal('user_id' in d.progress, false);
});

test('GET /me/progress kimlik ister', async () => {
  assert.equal((await t.request('GET', '/me/progress')).status, 401);
});

test('GET /me/progress sözleşmeye uyar', async () => {
  const r = await t.request('GET', '/me/progress', { token: 'test:prog' });
  assert.equal(r.status, 200);
  assertShape(r.body.data, PROGRESS);
  assert.equal(r.body.data.coins, 300);
});

test('PATCH /me/progress kimlik ister', async () => {
  assert.equal((await t.request('PATCH', '/me/progress')).status, 401);
});

test('PATCH /me/progress: bayraklar tek yönlü, kilitli bölüm 409, doğrulama 422', async () => {
  const u = await newUser();
  const patch = (body) => t.request('PATCH', '/me/progress', { token: u.token, body });
  const ok = await patch({ tutorial_seen: true });
  assert.equal(ok.status, 200);
  assertShape(ok.body.data, PROGRESS);
  assert.equal(ok.body.data.tutorial_seen, true);
  for (const bad of [{}, { tutorial_seen: false }, { finale_shown: false }, { last_played_level: 0 }, { last_played_level: 201 },
    { coins: 9999 }, { stars: 5 }, { freeze_time_count: 9 }, { user_id: 'x' }]) {
    assert.equal((await patch(bad)).status, 422, JSON.stringify(bad));
  }
  const locked = await patch({ last_played_level: 5 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'LEVEL_LOCKED');
  assert.equal((await patch({ finale_shown: true })).body.code, 'FINALE_NOT_REACHED');
  await complete(u, 1);
  assert.equal((await patch({ last_played_level: 1 })).body.data.last_played_level, 1);
  // 200. bölüm bitmişse finale_shown kabul edilir
  await setPlayer(u, { highest_unlocked_level: 200 });
  assert.equal((await complete(u, 200)).status, 200);
  assert.equal((await patch({ finale_shown: true })).body.data.finale_shown, true);
});

test('POST /levels/:number/complete kimlik ister', async () => {
  assert.equal((await t.request('POST', '/levels/1/complete')).status, 401);
});

test('POST /levels/:number/complete: sözleşme, ilk bitiş ve tekrar', async () => {
  const u = await newUser();
  const r = await complete(u, 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assertShape(r.body.data, { result: RESULT, progress: PROGRESS });
  const { result, progress } = r.body.data;
  assert.equal(result.coins_earned, 50);
  assert.equal(result.stars_earned, 1);
  assert.equal(result.coin_balance, 350);
  assert.equal(result.kind, 'level');
  assert.equal(result.next_world_name, null);
  assert.equal(progress.coins, 350);
  assert.equal(progress.stars, 1);
  assert.deepEqual(progress.completed_levels, [1]);
  assert.equal(progress.highest_unlocked_level, 2);
  assert.equal(progress.last_played_level, 2);
  // tekrar oynama: 50 coin, 0 yıldız
  const again = (await complete(u, 1, { moves_used: 5, duration_ms: 20_000 })).body.data;
  assert.equal(again.result.coins_earned, 50);
  assert.equal(again.result.stars_earned, 0);
  assert.equal(again.progress.stars, 1);
  assert.equal(again.progress.coins, 400);
  const row = await t.deps.db.one('SELECT best_moves, plays FROM level_completions WHERE user_id = ? AND level_number = 1', [u.id]);
  assert.deepEqual({ best: row.best_moves, plays: row.plays }, { best: 5, plays: 2 });
});

test('POST /levels/:number/complete: doğrulama, 404, kilit', async () => {
  const u = await newUser();
  for (const n of ['0', '201', 'abc', '1.5', '-1']) assert.equal((await complete(u, n)).status, 404, n);
  for (const bad of [{}, { moves_used: 1 }, { moves_used: -1, duration_ms: 5000 }, { moves_used: 1, duration_ms: 5000, coins: 99 },
    { moves_used: 1, duration_ms: 5000, user_id: 'x' }, { moves_used: 1.5, duration_ms: 5000 }, { moves_used: 100001, duration_ms: 5000 }]) {
    assert.equal((await complete(u, 1, bad)).status, 422, JSON.stringify(bad));
  }
  const locked = await complete(u, 2);
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'LEVEL_LOCKED');
  assert.equal((await player(u)).coins, 300);
});

test('POST /levels/:number/complete: çok hızlı sonuç kırpılır — coin 0, yıldız 1; ham değer saklanır', async () => {
  const u = await newUser();
  const r = (await complete(u, 1, { moves_used: 500, duration_ms: 1000 })).body.data;
  assert.equal(r.result.coins_earned, 0);
  assert.equal(r.result.stars_earned, 1);
  assert.equal(r.progress.coins, 300);
  assert.equal(r.progress.highest_unlocked_level, 2);
  const g = await t.deps.db.one('SELECT * FROM game_results WHERE user_id = ?', [u.id]);
  assert.equal(g.reported_moves, 500);
  assert.equal(g.reported_duration_ms, 1000);
  assert.equal(g.flagged, true);
  assert.equal(g.coins_awarded, 0);
  // çok uzun süre / çok hamle kırpılır
  const big = (await complete(u, 2, { moves_used: 90000, duration_ms: 86_000_000 })).body.data;
  assert.equal(big.result.moves_used, 999);
  const g2 = await t.deps.db.one('SELECT * FROM game_results WHERE user_id = ? AND level_number = 2', [u.id]);
  assert.equal(g2.reported_moves, 90000);
  assert.equal(g2.duration_ms, 3_600_000);
});

test('POST /levels/:number/complete: dünya sonu (20) ve final (200)', async () => {
  const u = await newUser();
  await setPlayer(u, { highest_unlocked_level: 20 });
  const w = (await complete(u, 20)).body.data;
  assert.equal(w.result.kind, 'world');
  assert.equal(w.result.coins_earned, 50);
  assert.equal(w.result.world_bonus, 500);
  assert.equal(w.result.coin_balance, 850);
  assert.equal(w.result.next_world_name, 'Liman Kasabası');
  assert.equal(w.progress.freeze_time_count, 3);
  assert.equal(w.progress.magic_wand_count, 2);
  assert.equal(w.progress.highest_unlocked_level, 21);
  // tekrarında bonus ve stok yok
  const again = (await complete(u, 20)).body.data;
  assert.equal(again.result.world_bonus, 0);
  assert.equal(again.result.kind, 'level');
  assert.equal(again.progress.freeze_time_count, 3);

  await setPlayer(u, { highest_unlocked_level: 200 });
  const f = (await complete(u, 200)).body.data;
  assert.equal(f.result.kind, 'finale');
  assert.equal(f.result.finale_bonus, 1000);
  assert.equal(f.result.world_bonus, 0);
  assert.equal(f.result.next_world_name, null);
  assert.equal(f.progress.highest_unlocked_level, 200);
  assert.equal(f.progress.last_played_level, 200);
  assert.equal(f.progress.freeze_time_count, 4);
});

test('POST /levels/:number/complete: building_ready yıldız eşiğine göre', async () => {
  const u = await newUser();
  assert.equal((await complete(u, 1)).body.data.result.building_ready, false); // 1★ < 30★
  await setPlayer(u, { stars: 29 });
  assert.equal((await complete(u, 2)).body.data.result.building_ready, true); // 30★ ≥ 30★
});

test('Idempotency: aynı anahtarla iki kez bölüm bitişi → bakiye bir kez artar, yanıt aynı', async () => {
  const u = await newUser();
  const h = { 'Idempotency-Key': randomUUID() };
  const a = await complete(u, 1, undefined, h);
  const b = await complete(u, 1, undefined, h);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(b.body.data, a.body.data);
  assert.equal((await player(u)).coins, 350);
  const plays = await t.deps.db.one('SELECT plays FROM level_completions WHERE user_id = ? AND level_number = 1', [u.id]);
  assert.equal(plays.plays, 1);
});

test('POST /wallet/spend kimlik ister', async () => {
  assert.equal((await t.request('POST', '/wallet/spend')).status, 401);
});

test('POST /wallet/spend: fiyat sunucuda; ücretsiz ipucu deftere yazılmaz', async () => {
  const u = await newUser();
  const free = await post(u, '/wallet/spend', { reason: 'hint', level_number: 1 });
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assertShape(free.body.data, { spent: 0, progress: PROGRESS });
  assert.equal(free.body.data.spent, 0);
  assert.equal(free.body.data.progress.coins, 300);
  assert.equal((await t.deps.db.one("SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'hint'", [u.id])).n, 0);

  await setPlayer(u, { highest_unlocked_level: 10, coins: 1000 });
  for (const [reason, price] of /** @type {[string, number][]} */ ([['hint', 100], ['color_box', 150], ['extra_time', 100], ['extra_moves', 100]])) {
    const before = (await player(u)).coins;
    const r = await post(u, '/wallet/spend', { reason, level_number: 5 });
    assert.equal(r.body.data.spent, price, reason);
    assert.equal(r.body.data.progress.coins, before - price);
  }
  const led = await t.deps.db.one("SELECT delta, balance_after, ref FROM currency_ledger WHERE user_id = ? AND reason = 'color_box'", [u.id]);
  assert.equal(led.delta, -150);
  assert.equal(led.ref, 'level:5');
});

test('POST /wallet/spend: yetersiz coin 409 (details) ve bakiye değişmez; doğrulama; kilit', async () => {
  const u = await newUser();
  await setPlayer(u, { highest_unlocked_level: 10, coins: 90 });
  const r = await post(u, '/wallet/spend', { reason: 'hint', level_number: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INSUFFICIENT_COINS');
  assert.deepEqual(r.body.errors, [{ price: 100, coins: 90 }]);
  assert.equal((await player(u)).coins, 90);
  assert.equal((await post(u, '/wallet/spend', { reason: 'hint', level_number: 50 })).body.code, 'LEVEL_LOCKED');
  for (const bad of [{ reason: 'nope', level_number: 1 }, { reason: 'hint' }, { reason: 'hint', level_number: 1, price: 0 },
    { reason: 'hint', level_number: 201 }, { reason: 'hint', level_number: 1, coins: 5 }]) {
    assert.equal((await post(u, '/wallet/spend', bad)).status, 422, JSON.stringify(bad));
  }
});

test('POST /wallet/spend: premium ipucu ücretsiz', async () => {
  const u = await newUser();
  await setPlayer(u, { highest_unlocked_level: 10 });
  await t.deps.db.run("INSERT INTO entitlements (user_id, entitlement, product_id, store, expires_at) VALUES (?, 'premium', 'p', 'test', NULL)", [u.id]);
  const r = await post(u, '/wallet/spend', { reason: 'hint', level_number: 5 });
  assert.equal(r.body.data.spent, 0);
  assert.equal(r.body.data.progress.coins, 300);
  assert.equal((await get(u, '/me/bootstrap')).body.data.premium, true);
});

test('POST /wallet/spend: eşzamanlı iki harcama bakiyeyi negatife düşürmez', async () => {
  const u = await newUser();
  await setPlayer(u, { highest_unlocked_level: 10, coins: 100 });
  const rs = await Promise.all([post(u, '/wallet/spend', { reason: 'hint', level_number: 5 }), post(u, '/wallet/spend', { reason: 'hint', level_number: 5 })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await player(u)).coins, 0);
});

test('Idempotency: aynı anahtarla iki harcama tek kez düşer', async () => {
  const u = await newUser();
  await setPlayer(u, { highest_unlocked_level: 10 });
  const h = { 'Idempotency-Key': randomUUID() };
  await post(u, '/wallet/spend', { reason: 'color_box', level_number: 5 }, h);
  const b = await post(u, '/wallet/spend', { reason: 'color_box', level_number: 5 }, h);
  assert.equal(b.status, 200);
  assert.equal((await player(u)).coins, 150);
});

test('POST /boosters/:type/use kimlik ister', async () => {
  assert.equal((await t.request('POST', '/boosters/freeze_time/use')).status, 401);
});

test('POST /boosters/:type/use: stoktan düşer, stok 0 → 409, bilinmeyen tür 404', async () => {
  const u = await newUser();
  const use = (type, level = 1) => post(u, `/boosters/${type}/use`, { level_number: level });
  const r = await use('freeze_time');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assertShape(r.body.data, { progress: PROGRESS });
  assert.equal(r.body.data.progress.freeze_time_count, 1);
  assert.equal((await use('freeze_time')).body.data.progress.freeze_time_count, 0);
  const out = await use('freeze_time');
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'OUT_OF_STOCK');
  assert.equal((await use('magic_wand')).body.data.progress.magic_wand_count, 0);
  assert.equal((await use('magic_wand')).body.code, 'OUT_OF_STOCK');
  assert.equal((await use('bomb')).status, 404);
  assert.equal((await use('magic_wand', 9)).body.code, 'LEVEL_LOCKED');
  assert.equal((await post(u, '/boosters/magic_wand/use', { level_number: 1, count: 5 })).status, 422);
  const led = await t.deps.db.one("SELECT delta, balance_after FROM currency_ledger WHERE user_id = ? AND currency = 'freeze_time' AND reason = 'booster_use' ORDER BY id LIMIT 1", [u.id]);
  assert.deepEqual({ d: led.delta, b: led.balance_after }, { d: -1, b: 1 });
});

test('GET /city/next-building kimlik ister', async () => {
  assert.equal((await t.request('GET', '/city/next-building')).status, 401);
});

test('GET /city/next-building: sıradaki bina; hepsi yenilenince null', async () => {
  const u = await newUser();
  const r = await get(u, '/city/next-building');
  assert.equal(r.status, 200);
  assertShape(r.body.data.building, BUILDING);
  assert.equal(r.body.data.building.id, 'town1_fountain');
  await t.deps.db.run('INSERT INTO building_renewals (user_id, building_id, reward) SELECT ?, id, 200 FROM buildings WHERE sort_order <= 2', [u.id]);
  assert.equal((await get(u, '/city/next-building')).body.data.building.id, 'town1_library');
  await t.deps.db.run('INSERT IGNORE INTO building_renewals (user_id, building_id, reward) SELECT ?, id, 200 FROM buildings', [u.id]);
  const none = await get(u, '/city/next-building');
  assert.equal(none.status, 200);
  assert.equal(none.body.data.building, null);
  assert.equal((await get(u, '/me/bootstrap')).body.data.next_building, null);
});

test('POST /buildings/:id/renew kimlik ister', async () => {
  assert.equal((await t.request('POST', '/buildings/town1_fountain/renew')).status, 401);
});

test('POST /buildings/:id/renew: sıra, yıldız eşiği, ödül, ikinci kez ödül yok', async () => {
  const u = await newUser();
  const renew = (id) => post(u, `/buildings/${id}/renew`, {});
  assert.equal((await renew('yok_boyle_bina')).status, 404);
  // sıra dışı
  const locked = await renew('town1_market');
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'BUILDING_LOCKED');
  // eşik altı
  const missing = await renew('town1_fountain');
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'STARS_MISSING');
  assert.deepEqual(missing.body.errors, [{ required: 30, current: 0 }]);
  await setPlayer(u, { stars: 32 });
  const ok = await renew('town1_fountain');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assertShape(ok.body.data, { building: BUILDING, reward: 200, progress: PROGRESS });
  assert.equal(ok.body.data.building.is_renewed, true);
  assert.equal(ok.body.data.reward, 200);
  assert.equal(ok.body.data.progress.coins, 500);
  assert.equal(ok.body.data.progress.stars, 2); // 32 - 30 harcandı
  assert.deepEqual(ok.body.data.progress.renewed_building_ids, ['town1_fountain']);
  // ikinci kez: 200, ödül 0, değişiklik yok
  const dup = await renew('town1_fountain');
  assert.equal(dup.status, 200);
  assert.equal(dup.body.data.reward, 0);
  assert.equal(dup.body.data.progress.coins, 500);
  assert.equal((await get(u, '/city/next-building')).body.data.building.id, 'town1_market');
  const led = await t.deps.db.one("SELECT delta, ref FROM currency_ledger WHERE user_id = ? AND reason = 'building_renew' AND currency = 'coins'", [u.id]);
  assert.deepEqual({ d: led.delta, r: led.ref }, { d: 200, r: 'building:town1_fountain' });
});

test('Sahiplik: A\'nın ilerlemesi B\'de görünmez; izinsiz alanlar 422', async () => {
  const a = await newUser();
  const b = await newUser();
  await complete(a, 1);
  await setPlayer(a, { stars: 7, coins: 4242 });
  const pb = (await get(b, '/me/bootstrap')).body.data.progress;
  assert.equal(pb.coins, 300);
  assert.equal(pb.stars, 0);
  assert.deepEqual(pb.completed_levels, []);
  // B, A'nın bölümünü bitirmiş sayılmaz (kendi kilidi)
  assert.equal((await complete(b, 2)).status, 409);
  assert.equal((await t.request('PATCH', '/me/progress', { token: b.token, body: { coins: 99999 } })).status, 422);
  assert.equal((await post(b, '/buildings/town1_fountain/renew', { user_id: a.id })).status, 422);
  assert.equal((await get(a, '/me/progress')).body.data.coins, 4242);
});

test('Defter: SUM(delta) = players.coins (tüm akışlardan sonra)', async () => {
  const u = await newUser();
  await complete(u, 1);
  await complete(u, 2);
  await complete(u, 1, { moves_used: 400, duration_ms: 1000 }); // flagged
  await setPlayer(u, { highest_unlocked_level: 20, stars: 30 });
  await complete(u, 20);
  await post(u, '/wallet/spend', { reason: 'color_box', level_number: 5 });
  await post(u, '/buildings/town1_fountain/renew', {});
  await post(u, '/boosters/freeze_time/use', { level_number: 1 });
  const sum = await t.deps.db.one("SELECT SUM(delta) AS s FROM currency_ledger WHERE user_id = ? AND currency = 'coins'", [u.id]);
  const p = await player(u);
  // setPlayer ile doğrudan yazılan stars deftere girmez (yalnızca coin toplanır)
  assert.equal(Number(sum.s), p.coins);
  const ft = await t.deps.db.one("SELECT SUM(delta) AS s FROM currency_ledger WHERE user_id = ? AND currency = 'freeze_time'", [u.id]);
  assert.equal(Number(ft.s), p.freeze_time_count);
});

test('performans: açılış ve ilerleme uçları (çok kullanıcılı veri)', async () => {
  await t.request('GET', '/me/progress', { token: 'test:perf' });
  const { id } = await t.deps.db.one('SELECT id FROM users WHERE firebase_uid = ?', ['perf']);
  // başka kullanıcılar: 15 × 200 bölüm bitişi + 15 × 40 bina yenileme
  const others = Array.from({ length: 15 }, () => randomUUID());
  await t.seedRows('users', others.length, (i) => ({ id: others[i], firebase_uid: `perf-other-${i}` }));
  await t.seedRows('players', others.length, (i) => ({ user_id: others[i] }));
  await t.seedRows('level_completions', others.length * 200, (i) => ({ user_id: others[Math.floor(i / 200)], level_number: (i % 200) + 1, best_moves: 10 }));
  await t.deps.db.run('INSERT INTO building_renewals (user_id, building_id, reward) SELECT ?, id, 200 FROM buildings WHERE sort_order <= 40', [others[0]]);
  // perf kullanıcısı: 200 bölüm + 60 bina
  await t.seedRows('level_completions', 200, (i) => ({ user_id: id, level_number: i + 1, best_moves: 10 }));
  await t.deps.db.run('INSERT INTO building_renewals (user_id, building_id, reward) SELECT ?, id, 200 FROM buildings WHERE sort_order <= 60', [id]);
  for (const url of ['/me/bootstrap', '/me/progress', '/city/next-building']) {
    const p = await t.perf('GET', url, { token: 'test:perf' });
    assert.ok(p.p95 <= 120, `${url} p95 ${p.p95}`);
    assert.ok(p.maxQueries <= 5, `${url} ${p.maxQueries} sorgu`);
    assert.ok(p.bytes <= 60_000, `${url} ${p.bytes} bayt`);
  }
});
