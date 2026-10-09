/**
 * Одноразовый перевод учёток стенда на вход по ролям (требование Отабека от
 * 06.10). Пересев стенда для этого не годится: он сотрёт демо-данные, которые
 * там набиты руками и показываются заказчику.
 *
 * Что делает:
 *   1. Проверяет, что роль `owner` в базе есть (её ставит миграция
 *      `20261006220000_owner_role`). Нет — останавливается: назначать нечего.
 *   2. Заводит или правит девять учёток из демо-профиля
 *      (`prisma/seed-profiles.ts`, один список на сид и на этот скрипт):
 *      пароль по умолчанию, признак «пароль временный», роль и компании по
 *      новой схеме, блокировки сняты.
 *   3. Выключает все остальные учётки — «то, что сейчас в людях, можешь
 *      убирать». Выключает, а не удаляет: на пользователе висят записи
 *      журнала, документы и ответственность в заказах, и удаление их уронит.
 *
 * `admin` по умолчанию не трогается: подняв ему признак, легко запереть стенд за
 * паролем, которого никто не записал. Заказчик 06.10 потребовал обратного —
 * «логин admin, пароль admin123» по общему правилу, — поэтому на стенде скрипт
 * запускают с `--admin-too`, и админ получает те же правила, что все.
 *
 * Прогоны QA после этого админом не входят: за ним обязательная смена пароля, и
 * первый же живой вход человека меняет пароль под ними. Им служебная учётка —
 * `SERVICE_LOGINS` ниже: её скрипт не выключает, пароля ей не меняет.
 *
 * По умолчанию скрипт ничего не пишет и показывает план. Запуск:
 *   cd backend
 *   DATABASE_URL="<владельческий адрес базы стенда>" npx tsx scripts/rbac-stand-accounts.ts
 *   DATABASE_URL="…" npx tsx scripts/rbac-stand-accounts.ts --apply
 *
 * Ключи: `--admin-too` — админа по общему правилу; `--qa-password-file <файл>` —
 * завести или обновить служебную учётку прогонов паролем из файла секрета;
 * `--force` — согласиться работать по базе с другим именем.
 *
 * Адрес владельца для стенда собирается так же, как в `scripts/deploy-stand.sh`:
 * адрес разработки с подменой имени базы на `metall_asia_stand`.
 */
import fs from 'node:fs';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import { demoProfile } from '../prisma/seed-profiles.js';
import { defaultPasswordFor } from '../src/common/default-password.js';

const APPLY = process.argv.includes('--apply');
const ADMIN_TOO = process.argv.includes('--admin-too');
const FORCE = process.argv.includes('--force');
/** Имя базы стенда. По чужой базе скрипт без `--force` не пойдёт. */
const STAND_DB = 'metall_asia_stand';
const ROUNDS = 10;

/**
 * Служебные учётки, которыми на стенд ходят прогоны QA. Скрипт их не выключает
 * и пароля им не меняет: пароль лежит в секрете на машине разработки
 * (`~/.local/state/openclaw/secrets/metall-asia-stand-qa-*`), признак
 * «пароль временный» у них снят — иначе прогон после первого входа запрёт сам
 * себя. Человеку эти учётки не выдаются.
 */
const SERVICE_LOGINS = ['qa_stand'];

const say = (text: string) => console.log(text);

/** Значение ключа вида `--qa-password-file <путь>`. */
const pick = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан: нужен владельческий адрес базы стенда');

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const dbName = (await db.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n;
    if (dbName !== STAND_DB && !FORCE) {
      throw new Error(
        `база «${dbName}», а скрипт писался под «${STAND_DB}». ` +
          'Если это сознательно — добавь --force.',
      );
    }
    say(`база: ${dbName}${APPLY ? '' : '  (показываю план, ничего не пишу)'}`);

    // 1. Роль `owner` обязана быть в базе: права берутся из неё, а не из кода.
    const owner = await db.query<{ perms: string }>(
      `SELECT count(rp.permission_id)::text AS perms
         FROM role r
         LEFT JOIN role_permission rp ON rp.role_id = r.id
        WHERE r.code = 'owner' AND r.company_id IS NULL
        GROUP BY r.id`,
    );
    if (owner.rowCount === 0) {
      throw new Error(
        'роли `owner` в базе нет — сначала миграции (`npx prisma migrate deploy`), потом этот скрипт',
      );
    }
    say(`роль owner на месте, прав у неё: ${owner.rows[0].perms}`);

    const companies = await db.query<{ id: string; code: string }>(
      `SELECT id::text, code FROM company`,
    );
    const companyId = new Map(companies.rows.map((c) => [c.code, c.id]));

    const wanted = demoProfile.users;
    const logins = wanted.map((u) => u.login);

    for (const u of wanted) {
      const missing = u.companies.filter((c) => !companyId.has(c));
      if (missing.length) throw new Error(`в базе нет компаний: ${missing.join(', ')}`);

      const found = await db.query<{ id: string }>(
        `SELECT id::text FROM user_account WHERE login = $1`,
        [u.login],
      );
      const exists = found.rowCount! > 0;
      // Админа по умолчанию не трогаем вовсе — пароль и признак оставляем как
      // есть, иначе стенд запрётся за паролем, которого никто не записал.
      const touchPassword = u.login !== 'admin' || ADMIN_TOO;

      say(
        `${exists ? 'правлю' : 'завожу'} ${u.login}: роль ${u.role}, ` +
          `компании ${u.companies.join('+')}` +
          (touchPassword ? ', пароль по умолчанию и признак временного' : ', пароль не трогаю'),
      );
      if (!APPLY) continue;

      const hash = touchPassword ? await bcrypt.hash(u.password ?? defaultPasswordFor(u.login), ROUNDS) : null;
      let id: string;
      if (exists) {
        id = found.rows[0].id;
        await db.query(
          `UPDATE user_account
              SET full_name = $2,
                  is_active = true,
                  failed_login_count = 0,
                  locked_until = NULL,
                  password_hash = COALESCE($3, password_hash),
                  must_change_password = CASE WHEN $3 IS NULL THEN must_change_password ELSE true END
            WHERE id = $1`,
          [id, u.fullName, hash],
        );
      } else {
        const made = await db.query<{ id: string }>(
          `INSERT INTO user_account (uid, login, full_name, email, phone, password_hash, must_change_password)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
           RETURNING id::text`,
          [u.login, u.fullName, u.email, u.phone, hash],
        );
        id = made.rows[0].id;
      }

      // Назначения переписываем целиком: учётка могла носить старую роль, и
      // права сложились бы объединением новой со старой.
      await db.query(`DELETE FROM user_role_assignment WHERE user_id = $1`, [id]);
      for (const code of u.companies) {
        await db.query(
          `INSERT INTO user_role_assignment (user_id, role_id, company_id)
           SELECT $1, r.id, $3::bigint FROM role r WHERE r.code = $2 AND r.company_id IS NULL`,
          [id, u.role, companyId.get(code)],
        );
      }
    }

    // 2.5. Служебная учётка прогонов. Пароль — только из файла секрета: в коде
    //      и в выводе его нет. Признак «пароль временный» ей не поднимаем
    //      сознательно — это не человек, менять пароль некому.
    const qaFile = pick('--qa-password-file') ?? process.env.QA_SERVICE_PASSWORD_FILE;
    const [qaLogin] = SERVICE_LOGINS;
    if (qaFile) {
      const qaPassword = fs.readFileSync(qaFile, 'utf8').trim();
      if (qaPassword.length < 12) {
        throw new Error(`пароль служебной учётки в ${qaFile} короче 12 знаков`);
      }
      say(`служебная учётка ${qaLogin}: пароль из файла, роль admin во всех компаниях`);
      if (APPLY) {
        const hash = await bcrypt.hash(qaPassword, ROUNDS);
        const made = await db.query<{ id: string }>(
          `INSERT INTO user_account (uid, login, full_name, password_hash, must_change_password)
           VALUES (gen_random_uuid(), $1, $2, $3, false)
           ON CONFLICT (login) DO UPDATE
             SET password_hash = $3,
                 must_change_password = false,
                 is_active = true,
                 failed_login_count = 0,
                 locked_until = NULL
           RETURNING id::text`,
          [qaLogin, 'Служебная учётная запись прогонов QA', hash],
        );
        const qaId = made.rows[0].id;
        await db.query(`DELETE FROM user_role_assignment WHERE user_id = $1`, [qaId]);
        for (const c of companies.rows) {
          await db.query(
            `INSERT INTO user_role_assignment (user_id, role_id, company_id)
             SELECT $1, r.id, $2::bigint FROM role r WHERE r.code = 'admin' AND r.company_id IS NULL`,
            [qaId, c.id],
          );
        }
      }
    } else {
      const has = await db.query(`SELECT 1 FROM user_account WHERE login = $1`, [qaLogin]);
      say(
        has.rowCount
          ? `служебная учётка ${qaLogin} на месте, пароль не трогаю`
          : `служебной учётки ${qaLogin} нет: передай --qa-password-file <файл секрета>, иначе прогоны QA на стенд не войдут`,
      );
    }

    // 3. Остальные учётки выключаем. Служебные — не «остальные».
    const keep = [...logins, ...SERVICE_LOGINS];
    const others = await db.query<{ login: string }>(
      `SELECT login FROM user_account WHERE is_active = true AND NOT (login = ANY($1::text[]))`,
      [keep],
    );
    if (others.rowCount === 0) {
      say('лишних действующих учёток нет');
    } else {
      say(`выключаю прежние учётки (${others.rowCount}): ${others.rows.map((r) => r.login).join(', ')}`);
      if (APPLY) {
        await db.query(
          `UPDATE user_account SET is_active = false WHERE NOT (login = ANY($1::text[]))`,
          [keep],
        );
      }
    }

    if (!APPLY) {
      say('\nничего не записано. Повтори с --apply, чтобы применить.');
      return;
    }

    // Печатаем то, что получилось, из базы — не то, что собирались сделать.
    const final = await db.query<{
      login: string;
      role: string;
      companies: string;
      flag: boolean;
    }>(
      `SELECT u.login,
              coalesce(string_agg(DISTINCT r.code, ','), '—') AS role,
              coalesce(string_agg(DISTINCT c.code, '+'), '—') AS companies,
              u.must_change_password AS flag
         FROM user_account u
         LEFT JOIN user_role_assignment a ON a.user_id = u.id
         LEFT JOIN role r ON r.id = a.role_id
         LEFT JOIN company c ON c.id = a.company_id
        WHERE u.is_active = true
        GROUP BY u.id
        ORDER BY u.login`,
    );
    say('\nдействующие учётки стенда:');
    for (const r of final.rows) {
      say(`  ${r.login} → ${r.role} [${r.companies}]${r.flag ? ' · пароль временный' : ''}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
