-- Tekrarlanan değişiklik isteği koruması (şablon — skill mobile-api-contract): istemci POST / PUT / PATCH / DELETE'e
-- `Idempotency-Key` ekler (çevrimdışı kuyruk, zayıf ağda yeniden deneme). Aynı kullanıcı + anahtar ikinci kez gelirse iş
-- yeniden yapılmaz, ilk yanıt aynen döner (çift kayıt / çift ödeme yok). 24 saat sonra silinir (worker: idempotency-purge).
CREATE TABLE idempotency_keys (
  user_id CHAR(36) NOT NULL,
  idem_key VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status_code SMALLINT NULL,
  response JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, idem_key),
  KEY ix_idempotency_created (created_at),
  CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
