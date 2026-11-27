-- game modülü (blok 100): oyuncu ilerlemesi + ekonomi. Kullanıcı = cihaz; bakiye sunucuda yetkili.
CREATE TABLE players (
  user_id CHAR(36) NOT NULL PRIMARY KEY,
  coins INT UNSIGNED NOT NULL DEFAULT 300,
  stars SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  highest_unlocked_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  last_played_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  freeze_time_count SMALLINT UNSIGNED NOT NULL DEFAULT 2,
  magic_wand_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  tutorial_seen TINYINT(1) NOT NULL DEFAULT 0,
  finale_shown TINYINT(1) NOT NULL DEFAULT 0,
  games_completed INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_players_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- completed_levels: PK öneki (user_id) ile okunur, en çok 200 satır
CREATE TABLE level_completions (
  user_id CHAR(36) NOT NULL,
  level_number SMALLINT UNSIGNED NOT NULL,
  best_moves SMALLINT UNSIGNED NOT NULL,
  plays INT UNSIGNED NOT NULL DEFAULT 1,
  first_completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, level_number),
  CONSTRAINT fk_level_completions_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Her bölüm bitişi: ham (reported_*) + kırpılmış değer + flagged (analiz / hile tespiti)
CREATE TABLE game_results (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  level_number SMALLINT UNSIGNED NOT NULL,
  reported_moves INT UNSIGNED NOT NULL,
  reported_duration_ms INT UNSIGNED NOT NULL,
  moves_used SMALLINT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED NOT NULL,
  first_clear TINYINT(1) NOT NULL,
  flagged TINYINT(1) NOT NULL DEFAULT 0,
  coins_awarded INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_game_results_user (user_id, created_at),
  CONSTRAINT fk_game_results_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Para / stok defteri: bakiye değişikliğinin tamamı, aynı transaction'da
CREATE TABLE currency_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  currency ENUM('coins','freeze_time','magic_wand') NOT NULL,
  delta INT NOT NULL,
  balance_after INT UNSIGNED NOT NULL,
  reason ENUM('start_balance','start_stock','level_reward','world_reward','finale_reward','world_booster','building_renew','hint','color_box','extra_time','extra_moves','booster_use') NOT NULL,
  ref VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_currency_ledger_user (user_id, created_at),
  CONSTRAINT fk_currency_ledger_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE game_worlds (
  number TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  first_level SMALLINT UNSIGNED NOT NULL,
  level_count TINYINT UNSIGNED NOT NULL DEFAULT 20
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- idx: JSON'daki `index` (ayrılmış kelime)
CREATE TABLE buildings (
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  sort_order SMALLINT UNSIGNED NOT NULL,
  world_number TINYINT UNSIGNED NOT NULL,
  idx TINYINT UNSIGNED NOT NULL,
  total_in_world TINYINT UNSIGNED NOT NULL DEFAULT 10,
  name VARCHAR(80) NOT NULL,
  short_name VARCHAR(40) NOT NULL,
  required_stars SMALLINT UNSIGNED NOT NULL,
  image VARCHAR(64) NOT NULL,
  renewed_image VARCHAR(64) NOT NULL,
  renew_reward INT UNSIGNED NOT NULL DEFAULT 200,
  UNIQUE KEY uq_buildings_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PK çift yenilemeyi imkânsız kılar
CREATE TABLE building_renewals (
  user_id CHAR(36) NOT NULL,
  building_id VARCHAR(32) NOT NULL,
  reward INT UNSIGNED NOT NULL,
  renewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, building_id),
  KEY ix_building_renewals_building (building_id),
  CONSTRAINT fk_building_renewals_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_building_renewals_building_id FOREIGN KEY (building_id) REFERENCES buildings (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
