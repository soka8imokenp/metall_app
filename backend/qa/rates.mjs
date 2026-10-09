/**
 * Живой источник курсов: ЦБ РУз.
 *
 * Прогон в наборе тестов в сеть не ходит — он проверяет разбор и правила на
 * подменённом ответе. Этот прогон делает обратное: берёт настоящий ответ банка,
 * разбирает его тем же кодом и сверяет с тем, что лежит в базе. Запускать
 * руками, когда нужно убедиться, что сайт банка отвечает и формат не поменялся.
 *
 *   node qa/rates.mjs            # база разработки
 *   APP_DATABASE_URL=... node qa/rates.mjs
 */
import 'dotenv/config';
import { Client } from 'pg';
import { CBU_URL, parseCbu } from '../dist/refs/rates.service.js';

const res = await fetch(CBU_URL, { signal: AbortSignal.timeout(10_000) });
if (!res.ok) {
  console.error(`ЦБ РУз ответил ${res.status}`);
  process.exit(1);
}
const rows = parseCbu(await res.json());
console.log(`ЦБ РУз (${CBU_URL}): курсов ${rows.length}, дата ${rows[0].rateDate}`);
for (const code of ['USD', 'EUR', 'RUB', 'KZT']) {
  const r = rows.find((x) => x.code === code);
  console.log(`  ${code}: ${r ? r.rate.toFixed(4) : 'не публикуется'}`);
}

const db = new Client({ connectionString: process.env.APP_DATABASE_URL });
await db.connect();
const stored = await db.query(
  `SELECT c.code, r.rate::text AS rate, r.rate_date::text AS day, r.source,
          to_char(r.created_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM HH24:MI') AS saved
     FROM currency c
     LEFT JOIN LATERAL (
       SELECT * FROM currency_rate rr WHERE rr.currency_id = c.id
        ORDER BY rr.rate_date DESC LIMIT 1) r ON true
    ORDER BY c.code`,
);
console.log('\nВ базе:');
for (const r of stored.rows) {
  const bank = rows.find((x) => x.code === r.code);
  const same = bank && r.rate && Math.abs(Number(r.rate) - bank.rate) < 0.01;
  console.log(
    `  ${r.code}: ${r.rate ?? 'курса нет'} на ${r.day ?? '—'} (${r.source ?? '—'}, записан ${r.saved ?? '—'})` +
      (bank ? (same ? ' — совпадает с банком' : ` — у банка ${bank.rate.toFixed(4)}`) : ''),
  );
}
await db.end();
