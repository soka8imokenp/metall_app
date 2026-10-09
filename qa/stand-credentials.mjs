/**
 * Чем прогоны входят на живой стенд.
 *
 * До 06.10 каждый прогон решал это сам: один входил `admin`/`admin`, другой
 * читал пароль `director` из файла секрета. Оба пути сломались в один день —
 * заказчик потребовал вход по ролям, и у всех девяти человеческих учёток
 * поднялся признак «пароль временный»: сервер отвечает `PASSWORD_CHANGE_REQUIRED`
 * на любой маршрут, а первый живой вход человека меняет пароль под прогонами.
 *
 * Поэтому у прогонов своя служебная учётка — `qa_stand`, роль `admin` во всех
 * компаниях, признак не поднят, человеку не выдаётся. Заводит её
 * `backend/scripts/rbac-stand-accounts.ts --qa-password-file <файл>`, и тот же
 * скрипт её не выключает (`SERVICE_LOGINS`).
 *
 * Логин и пароль — только из файлов секрета, правами `600`, по одному значению
 * в каждом. В коде прогонов пароля нет и в вывод он не попадает.
 *
 *   ~/.local/state/openclaw/secrets/metall-asia-stand-qa-login
 *   ~/.local/state/openclaw/secrets/metall-asia-stand-qa-password
 *
 * Переменные `STAND_LOGIN` и `STAND_PASSWORD` перебивают файлы — этим входят
 * конкретной ролью, когда прогон про роли, а не про данные.
 */
import fs from 'node:fs';
import path from 'node:path';

const SECRETS = path.join(process.env.HOME ?? '', '.local/state/openclaw/secrets');

const read = (name) => {
  const file = path.join(SECRETS, name);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(
      `нет файла секрета ${file}. Служебную учётку прогонов заводит ` +
        'backend/scripts/rbac-stand-accounts.ts --qa-password-file <файл>, ' +
        'см. docs/08-STAND-DEPLOY.md',
    );
  }
};

/** Логин служебной учётки прогонов. */
export const standLogin = () => process.env.STAND_LOGIN ?? read('metall-asia-stand-qa-login');

/** Её пароль. Значение не печатать. */
export const standPassword = () => process.env.STAND_PASSWORD ?? read('metall-asia-stand-qa-password');
