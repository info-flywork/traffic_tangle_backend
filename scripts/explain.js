'use strict';

/**
 * Sorgu planı denetimi (BE-25): `F2F_SQL_CAPTURE=<dosya> npm test` testlerdeki her SELECT'in EXPLAIN'ini yazar; bu
 * betik büyük tabloda tam tarama / dosya sıralaması / geçici tablo kullanan sorguları bulur (eksik ya da yanlış indeks).
 * Kullanım: node scripts/explain.js <capture.jsonl> [--min-rows 1000] [--json out.json]
 * Çıkış kodu 1 = bulgu var. Küçük tablolarda (< min-rows) MySQL indeksi yok sayabilir — onlar bulgu değildir; bu
 * yüzden liste uçlarının perf testleri tabloyu gerçekçi hacimle doldurur (t.seedRows).
 */
const fs = require('node:fs');

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('kullanım: node scripts/explain.js <capture.jsonl> [--min-rows 1000] [--json out.json]');
  process.exit(2);
}
const minRows = Number(args.includes('--min-rows') ? args[args.indexOf('--min-rows') + 1] : 1000);
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

/** @type {Map<string, { sql: string, problems: Set<string>, rows: number }>} */
const found = new Map();
for (const line of lines) {
  const { sql, plan } = JSON.parse(line);
  for (const p of plan) {
    if (p.rows < minRows) continue;
    const problems = [];
    if (p.type === 'ALL') problems.push(`${p.table}: tam tablo taraması (~${p.rows} satır, indeks yok)`);
    if (/Using filesort/.test(p.extra)) problems.push(`${p.table}: dosya sıralaması (ORDER BY indeksle karşılanmıyor)`);
    if (/Using temporary/.test(p.extra)) problems.push(`${p.table}: geçici tablo (GROUP BY / DISTINCT indekssiz)`);
    if (!problems.length) continue;
    const e = found.get(sql) ?? { sql, problems: new Set(), rows: 0 };
    for (const x of problems) e.problems.add(x);
    e.rows = Math.max(e.rows, p.rows);
    found.set(sql, e);
  }
}
const issues = [...found.values()].map((e) => ({ gate: 'explain', sql: e.sql.slice(0, 400), rows: e.rows,
  message: `${[...e.problems].join('; ')} — WHERE eşitlik sütunları + ORDER BY sütunları sırasıyla bileşik indeks ` +
    '(ör. KEY (user_id, deleted_at, created_at, id)); docs/BACKEND_ARCHITECTURE.md BE-25' }));
if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(issues, null, 2));
for (const i of issues) console.log(`✗ ${i.message}\n    ${i.sql}`);
console.log(`explain: ${lines.length} sorgu planı, ${issues.length} sorun`);
process.exit(issues.length ? 1 : 0);
