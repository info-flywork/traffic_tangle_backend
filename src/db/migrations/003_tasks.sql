-- Uzun işler (şablon — BE-29): yapay zekâ, PDF, rapor gibi 3 sn'den uzun işler istek içinde beklenmez.
-- POST … → 202 { task_id } ; GET /jobs/:id → { status, stage, progress, eta_s, result }.
CREATE TABLE tasks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  status ENUM('queued', 'running', 'done', 'failed') NOT NULL DEFAULT 'queued',
  stage VARCHAR(64) NULL,
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  eta_s INT NULL,
  input JSON NULL,
  result JSON NULL,
  error VARCHAR(500) NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_tasks_user (user_id, created_at),
  KEY ix_tasks_recover (status, updated_at),
  CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
