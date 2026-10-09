#!/usr/bin/env bash
# Выкатка на стенд https://metall-asia.cloudplus.uz — одной командой и с проверкой.
#
# Зачем скрипт, а не список шагов в документе: выкатка руками уже один раз
# разошлась с тем, что видел заказчик, и разбираться пришлось задним числом.
# Здесь порядок зафиксирован, а главное — выкатка сама себя проверяет снаружи,
# с публичного адреса: версия, которую отдаёт домен, сверяется с той, что
# только что собрана. Не совпало — скрипт падает, и выкатка не считается
# состоявшейся.
#
# Что НЕ делает: не трогает прод, не правит базу, не перезапускает туннель и
# бота. Это отдельные решения, они требуют слова человека.
#
# Запуск: dev/scripts/deploy-stand.sh
set -euo pipefail

DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${STAND_URL:-https://metall-asia.cloudplus.uz}"

say() { printf '\n== %s\n' "$1"; }

say "ветка и несохранённое"
cd "$DEV"
git -C "$DEV" rev-parse --abbrev-ref HEAD
if [[ -n "$(git -C "$DEV" status --porcelain)" ]]; then
  # Иначе в сборку уедет то, чего нет ни в одном коммите, и повторить
  # выкатку будет нечем.
  echo "в дереве есть незакоммиченное — сначала коммит, потом выкатка" >&2
  git -C "$DEV" status --short >&2
  exit 1
fi

say "сборка бэкенда"
(cd "$DEV/backend" && npm run build >/dev/null)

say "миграции базы стенда"
# Миграции идут под владельцем схемы, а не под ролью приложения. Роль
# приложения (APP_DATABASE_URL в окружении службы) правами на схему и на базу
# не обладает намеренно: с ней работает RLS. Первая же выкатка по ней упала на
# CREATE EXTENSION и оставила миграцию недоведённой.
#
# Адрес владельца собирается из .env разработки подменой имени базы — так же,
# как описано в docs/08-STAND-DEPLOY.md. Отдельного файла с ним нет, и заводить
# второй экземпляр тех же данных незачем.
STAND_OWNER_DB="$(cd "$DEV/backend" && node -e '
  const fs = require("fs");
  const url = fs.readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/"/g, "");
  const u = new URL(url);
  u.pathname = "/metall_asia_stand";
  process.stdout.write(u.toString());
')"
(cd "$DEV/backend" && DATABASE_URL="$STAND_OWNER_DB" npx prisma migrate deploy)

say "сборка фронта"
(cd "$DEV/frontend" && npm run build:stand >/dev/null)
VERSION="$(node -e 'process.stdout.write(require("'"$DEV"'/frontend/dist/version.json").version)')"
echo "версия сборки: $VERSION"

say "перезапуск служб стенда"
systemctl --user restart metall-asia-stand-api.service
# Статику nginx читает с диска по каждому запросу, но конфиг мог поменяться.
systemctl --user restart metall-asia-stand-web.service
systemctl --user --no-pager --lines=0 status \
  metall-asia-stand-api.service metall-asia-stand-web.service | grep -E 'Active:'

say "проверка снаружи: $URL"
for i in $(seq 1 30); do
  REMOTE="$(curl -fsS --max-time 10 "$URL/version.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version)}catch{}})' \
    || true)"
  [[ "$REMOTE" == "$VERSION" ]] && break
  sleep 2
done

if [[ "${REMOTE:-}" != "$VERSION" ]]; then
  echo "домен отдаёт версию «${REMOTE:-нет ответа}», а собрана «$VERSION» — выкатка не дошла" >&2
  exit 1
fi
echo "домен отдаёт ту же версию: $VERSION"

# Совпадения версии мало: version.json мог обновиться, а страница — приехать
# из чужого кеша. Сверяем саму страницу побайтово с той, что лежит на диске.
say "страница снаружи совпадает с собранной"
DISK="$(md5sum "$DEV/frontend/dist/index.html" | cut -d" " -f1)"
WIRE="$(curl -fsS --max-time 15 "$URL/?nocache=$RANDOM" | md5sum | cut -d" " -f1)"
if [[ "$DISK" != "$WIRE" ]]; then
  echo "страница снаружи ($WIRE) не та, что собрана ($DISK) — её кто-то кеширует" >&2
  exit 1
fi
echo "совпадает: $DISK"

# Заголовки важны не меньше самой сборки: закешированный version.json молча
# выключил бы оповещение об обновлении, а закешированная страница увела бы
# человека на прежнюю сборку.
say "заголовки кеширования"
curl -sSI --max-time 10 "$URL/version.json" | grep -iE '^(HTTP/|cache-control)'
curl -sSI --max-time 10 "$URL/index.html" | grep -iE '^(HTTP/|cache-control)'

printf '\nВЫКАТКА СОСТОЯЛАСЬ: %s, версия %s\n' "$URL" "$VERSION"
