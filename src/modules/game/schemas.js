'use strict';

const { z } = require('zod');
const { GAME_CONFIG: C } = require('./game_config');

// Yanıt şemaları uygulamanın modelleriyle birebir (player_progress.dart, building.dart, level_result.dart).

const PlayerProgress = z.object({
  coins: z.number().int(),
  stars: z.number().int(),
  completed_levels: z.array(z.number().int()),
  highest_unlocked_level: z.number().int(),
  last_played_level: z.number().int(),
  freeze_time_count: z.number().int(),
  magic_wand_count: z.number().int(),
  tutorial_seen: z.boolean(),
  finale_shown: z.boolean(),
  renewed_building_ids: z.array(z.string()),
});

const Building = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string(),
  world_number: z.number().int(),
  index: z.number().int(),
  total_in_world: z.number().int(),
  required_stars: z.number().int(),
  image: z.string(),
  renewed_image: z.string(),
  renew_reward: z.number().int(),
  is_renewed: z.boolean(),
});

const LevelResult = z.object({
  level_number: z.number().int(),
  moves_used: z.number().int(),
  coins_earned: z.number().int(),
  stars_earned: z.number().int(),
  world_bonus: z.number().int(),
  finale_bonus: z.number().int(),
  coin_balance: z.number().int(),
  kind: z.enum(['level', 'world', 'finale']),
  next_world_name: z.string().nullable(),
  building_ready: z.boolean(),
});

const levelNumber = z.number().int().min(1).max(C.LEVEL_COUNT);

// GET /me/bootstrap
const GetMeBootstrapResponse = z.object({
  progress: PlayerProgress,
  next_building: Building.nullable(),
  premium: z.boolean(),
  server_time: z.string(),
});

// GET /me/progress
const ListMeProgressResponse = PlayerProgress;

// PATCH /me/progress — coin / yıldız / stok bu uçtan değişmez (strict)
const UpdateMeProgressBody = z
  .object({
    last_played_level: levelNumber,
    tutorial_seen: z.literal(true),
    finale_shown: z.literal(true),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'En az bir alan gerekli' });
const UpdateMeProgressResponse = PlayerProgress;

// :number ve :type sayısal / sabit kontrolü serviste (geçersiz → 404)
const CreateLevelsCompleteParams = z.object({ number: z.string().min(1).max(10) });
const CreateLevelsCompleteBody = z
  .object({
    moves_used: z.number().int().min(0).max(100000),
    duration_ms: z.number().int().min(0).max(86400000),
  })
  .strict();
const CreateLevelsCompleteResponse = z.object({ result: LevelResult, progress: PlayerProgress });

const CreateWalletSpendBody = z
  .object({
    reason: z.enum(['hint', 'color_box', 'extra_time', 'extra_moves']),
    level_number: levelNumber,
  })
  .strict();
const CreateWalletSpendResponse = z.object({ spent: z.number().int(), progress: PlayerProgress });

const CreateBoostersUseParams = z.object({ type: z.string().min(1).max(32) });
const CreateBoostersUseBody = z.object({ level_number: levelNumber }).strict();
const CreateBoostersUseResponse = z.object({ progress: PlayerProgress });

// GET /city/next-building — hepsi yenilendiyse data: null
const GetCityNextBuildingResponse = z.object({ building: Building.nullable() });

const CreateBuildingsRenewParams = z.object({ id: z.string().min(1).max(32) });
const CreateBuildingsRenewBody = z.object({}).strict();
const CreateBuildingsRenewResponse = z.object({
  building: Building,
  reward: z.number().int(),
  progress: PlayerProgress,
});

module.exports = { GetMeBootstrapResponse, ListMeProgressResponse, UpdateMeProgressBody, UpdateMeProgressResponse, CreateLevelsCompleteParams, CreateLevelsCompleteBody, CreateLevelsCompleteResponse, CreateWalletSpendBody, CreateWalletSpendResponse, CreateBoostersUseParams, CreateBoostersUseBody, CreateBoostersUseResponse, GetCityNextBuildingResponse, CreateBuildingsRenewParams, CreateBuildingsRenewBody, CreateBuildingsRenewResponse };
