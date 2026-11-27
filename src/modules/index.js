'use strict';

/**
 * Tüm modüller. Yeni modül: src/modules/<ad>/routes.js (defineModule) → `npm run register` (bu dosyaya dokunma).
 * Sıra önemli değil; yollar çakışmamalı (testler kontrol eder).
 * @type {import('../core/route').Module[]}
 */
const modules = [
  require('./health/routes'),
  require('./auth/routes'),
  // cihaz girişi (oyunlar): yalnızca AUTH_MODE=device projelerinde (src/config/auth_mode.js)
  ...(require('../config/auth_mode').AUTH_MODE === 'device' ? [require('./auth/device_routes')] : []),
  require('./billing/routes'),
  require('./media/routes'),
  require('./tasks/routes'),
  // uygulama modülleri: scripts/register.js üretir (npm run register)
  ...require('./app.generated').modules,
];

module.exports = { modules };
