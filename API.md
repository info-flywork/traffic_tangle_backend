# Traffic Tangle API

Adres: https://traffictangle.fly-work.com · PM2 portu: 3101

## Modüller

- **game** — Traffic Tangle oyuncu ilerlemesi ve ekonomisi: coin / yıldız / güçlendirici stoğu sunucuda yetkili, bölüm bitirme (kırpma + ham değer), coin harcama, güçlendirici kullanma, bina yenileme, açılış ucu. Kullanıcı = cihaz (AUTH_MODE=device, /auth/device hazır).

## İstemcide (backend yok)

- Yarım kalan bölüm (SavedGame, resume_board) — cihazda (SharedPrefManager). Kimlik = cihaz, tahta başka cihaza taşınmaz; uygulama her arka plana geçişte yazar, sunucuya göndermek yalnızca trafik olurdu.
- Ses / müzik / titreşim ayarları (GameSettings) — cihazda; başka kullanıcıya görünmez, cihaza özgü.
- Bölüm verisi (assets/levels/levels.json, 200 bölüm) ve dünya / bina görselleri — uygulamada; çözücü / ipucu cihazda anında.
- Oyun içi süre, hamle, tahta durumu — motor (lib/domain/game); sunucuya yalnızca bitiş sonucu gider.
- Bildirimler — spec.push = local; sunucu push göndermez (oyun backend'i, OneSignal yok).
- Çevrimdışı oyun: ilerleme önce yerelde güncellenir (iyimser), değişiklik istekleri Idempotency-Key ile kuyruğa yazılır, ağ gelince sırayla gönderilir; her cevaptaki progress yerel kaydın üstüne yazılır (sunucu yetkili).

## Uçlar

| Yöntem | Yol | Giriş | Açıklama |
|---|---|---|---|
| GET | `/health` | — | Uygulama ve veritabanı ayakta mı (izleme / PM2 kontrolü) |
| POST | `/auth/sync` | — | Firebase girişinden sonra çağrılır: kullanıcıyı oluşturur / günceller (silme bekleme süresindeyse geri getirir) |
| GET | `/account` | 🔒 | Giriş yapmış kullanıcı |
| PATCH | `/account` | 🔒 | Kullanıcı bilgilerini güncelle |
| DELETE | `/account` | 🔒 | Hesabı sil (geri alınamaz; bekleme süresi ayarlıysa o süre içinde tekrar girişle iptal edilir) |
| POST | `/auth/device` | — | Cihaz kimliğiyle anonim giriş (yoksa hesap açılır; aynı cihaz aynı hesap) |
| POST | `/auth/refresh` | — | Refresh token ile yeni erişim token’ı (rotasyon: eski refresh iptal edilir) |
| GET | `/me/entitlements` | 🔒 | Aktif abonelikler (premium durumu sunucudan) |
| POST | `/billing/sync` | 🔒 | Satın almadan hemen sonra çağrılır: durum RevenueCat'ten doğrulanıp yazılır (istemcinin söylediğine güvenilmez) |
| POST | `/billing/revenuecat/webhook` | — | RevenueCat webhook (Authorization: REVENUECAT_WEBHOOK_AUTH) |
| POST | `/media` | 🔒 | Görsel yükle (multipart: file, kind?) — 1080 px + 320 px WebP, CDN adresleri, blurhash |
| DELETE | `/media/{id}` | 🔒 | Yüklediğim görseli sil (CDN dahil) |
| GET | `/jobs/{id}` | 🔒 | Uzun işin durumu: aşama, ilerleme, tahmini süre, sonuç |
| GET | `/me/bootstrap` | 🔒 | Açılış verisi: ilerleme, sıradaki bina, premium |
| GET | `/me/progress` | 🔒 | Oyuncu ilerlemesi (bakiye, açık bölümler, yenilenen binalar) |
| PATCH | `/me/progress` | 🔒 | Son oynanan bölüm ve tek yönlü bayraklar |
| POST | `/levels/{number}/complete` | 🔒 | Bölümü bitir: kırpma, ödül, ilerleme |
| POST | `/wallet/spend` | 🔒 | Coin harca (ipucu, renk kutusu, +süre, +hamle); fiyat sunucuda |
| POST | `/boosters/{type}/use` | 🔒 | Güçlendiriciyi stoktan kullan |
| GET | `/city/next-building` | 🔒 | Sıradaki yenilenecek bina (yoksa null) |
| POST | `/buildings/{id}/renew` | 🔒 | Binayı yenile, ödülü ver |

Ayrıntılı şema: `openapi.json` · kurulum: `README.md`
