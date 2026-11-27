'use strict';

// ÜRETİLDİ: scripts/register.js (npm run register) — elle düzenleme; modül klasörüne dosya ekle.

/** @type {import('../core/route').Module[]} */
const modules = [
  require('./game/routes'),
];

/** @param {import('../container').Container} c */
function registerServices(c) {
  c.game = require('./game/service').createService(c);
}

/** @type {import('../jobs').Job[]} */
const jobs = [
];

/** @type {Record<string, Record<string, { title: string, body: string }>>} */
const templates = Object.assign({}, {});

const products = {
  entitlements: [],
  consumables: Object.assign({}, {}),
};

/** @type {((user: any, deps: any) => Promise<void>)[]} */
const purgeHooks = [];

module.exports = { modules, registerServices, jobs, templates, products, purgeHooks };
