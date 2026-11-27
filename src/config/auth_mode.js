'use strict';

/**
 * Uygulamanın giriş türü (kodun özelliği, sunucu ayarı değil — Flutter tarafı da buna göre kurulur):
 * - 'firebase': Firebase Auth ID token'ı (Google / Apple / e-posta / telefon / misafir)
 * - 'device'  : cihaz kimliğiyle anonim giriş, kendi JWT'miz (oyunlar — Firebase / servis hesabı gerekmez)
 * f2f backend iskeleti oyun projelerinde bunu 'device' yazar. .env'deki AUTH_MODE (testler) bunu ezer.
 * @type {{ AUTH_MODE: 'firebase' | 'device' }}
 */
module.exports = { AUTH_MODE: 'device' };
