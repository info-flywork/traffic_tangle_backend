-- Medya (şablon): kullanıcının yüklediği görseller. Dosyalar CDN'de (uygulamanın klasöründe), burada yolları.
-- Hesap silinince satırlar cascade ile, CDN dosyaları media modülünün purge kancasıyla silinir.
CREATE TABLE media (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  path_full VARCHAR(255) NOT NULL,
  path_thumb VARCHAR(255) NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  blurhash VARCHAR(64) NULL,
  bytes INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_media_user (user_id, created_at),
  CONSTRAINT fk_media_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
