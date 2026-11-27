'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');

/**
 * Firebase Admin: yalnızca kimlik doğrulama (ID token) ve hesap silmede Firebase kullanıcısını silmek için.
 * FIREBASE_SERVICE_ACCOUNT: servis hesabı JSON dosyasının yolu ya da base64 JSON. Boşsa null döner
 * (testler sahte doğrulayıcı kullanır; canlıda server.js boş değeri kabul etmez). FIREBASE_AUTH_EMULATOR_HOST
 * verilirse (yalnızca uçtan uca test) servis hesabı olmadan yerel Auth emulator'üne bağlanır.
 * @param {{ FIREBASE_SERVICE_ACCOUNT: string, FIREBASE_PROJECT_ID: string, NODE_ENV?: string }} config
 * @returns {import('firebase-admin/app').App | null}
 */
function createFirebaseApp(config) {
  // Uçtan uca testler: Firebase Auth emulator (yerelde, sahte kullanıcılar). Canlıda asla — açılış reddedilir.
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator) {
    if (config.NODE_ENV === 'production') throw new Error('FIREBASE_AUTH_EMULATOR_HOST canlıda kullanılamaz');
    return getApps()[0] ?? initializeApp({ projectId: config.FIREBASE_PROJECT_ID || 'demo-f2f' });
  }
  const raw = config.FIREBASE_SERVICE_ACCOUNT.trim();
  if (!raw) return null;
  const existing = getApps()[0];
  if (existing) return existing;
  let json;
  if (raw.startsWith('{')) json = JSON.parse(raw);
  else if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 200) json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  else json = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), raw), 'utf8'));
  return initializeApp({
    credential: cert(json),
    projectId: config.FIREBASE_PROJECT_ID || json.project_id,
  });
}

module.exports = { createFirebaseApp };
