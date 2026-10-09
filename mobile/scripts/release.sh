#!/usr/bin/env bash
# Выпуск новой версии мобильного приложения через релиз GitHub.
#
#   ./scripts/release.sh 0.8.0 "Что нового: плавные переходы, обновление из приложения"
#
# Что делает:
#   1. ставит версию в app.json (и versionCode для Android — из номера версии);
#   2. собирает APK в Docker с ограничением памяти и ядер (ПК не виснет);
#   3. кладёт копию в ../../builds/;
#   4. публикует выпуск в ветку `releases` репозитория по git (SSH-ключ
#      разработчика) — без ключа к API GitHub и без браузера.
#
# Телефоны узнают о выпуске от сервера (`GET /mobile/update`), сервер читает
# `latest.json` из ветки `releases` (репозиторий публичный, ключ не нужен).
set -euo pipefail
# APK собирается под эту версию API; серверу ключ GitHub не нужен (репозиторий публичный).

VERSION="${1:?укажите версию, например 0.8.0}"
NOTES="${2:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "версия: три числа через точку" >&2; exit 1; }

REPO="${GITHUB_RELEASES_REPO:-soka8imokenp/metall_app}"
API_URL="${RELEASE_API_URL:-http://192.168.1.165:4001/api/v1}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/../../builds/MetallAsia-$VERSION-arm64.apk"


cd "$HERE"

echo "→ версия $VERSION"
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  const j = JSON.parse(fs.readFileSync("app.json", "utf8"));
  const [a, b, c] = v.split(".").map(Number);
  j.expo.version = v;
  j.expo.android = { ...j.expo.android, versionCode: a * 10000 + b * 100 + c };
  fs.writeFileSync("app.json", JSON.stringify(j, null, 2) + "\n");
' "$VERSION"

echo "→ android-проект"
EXPO_PUBLIC_API_URL="$API_URL" CI=1 npx expo prebuild --platform android --no-install >/dev/null
# Сборка в контейнере с ограничением: на ПК 8 ГБ памяти.
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m/; s/^reactNativeArchitectures=.*/reactNativeArchitectures=arm64-v8a/; s/^org.gradle.parallel=true/org.gradle.parallel=false/' android/gradle.properties
grep -q "kotlin.daemon.jvmargs" android/gradle.properties || printf '\nkotlin.daemon.jvmargs=-Xmx1g\norg.gradle.workers.max=3\nkotlin.compiler.execution.strategy=in-process\n' >> android/gradle.properties

echo "→ сборка APK (несколько минут)"
docker build -q -t metall-apk-builder scripts/android-build >/dev/null
U="$(id -u):$(id -g)"
nice -n 15 docker run --rm --cpuset-cpus 0-5 --memory 4g --memory-swap 4g \
  -v "$HERE":/app -v metall-gradle-cache:/root/.gradle \
  -e EXPO_PUBLIC_API_URL="$API_URL" -e NODE_ENV=production -e CMAKE_BUILD_PARALLEL_LEVEL=4 \
  -w /app/android metall-apk-builder \
  bash -c "./gradlew assembleRelease --no-daemon --max-workers=3 -x lint -x test -q; rc=\$?; chown -R $U /app/android; exit \$rc"

mkdir -p "$(dirname "$OUT")"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "→ APK: $OUT ($(du -h "$OUT" | cut -f1))"

echo "→ публикация в ветку releases ($REPO, по git/SSH)"
# Ветка переписывается целиком: в ней только последний выпуск — latest.json
# и APK. Старые APK в истории не копятся, репозиторий не разрастается.
PUB="$(mktemp -d)"
trap 'rm -rf "$PUB"' EXIT
FILE="MetallAsia-$VERSION.apk"
cp "$OUT" "$PUB/$FILE"
node -e '
  const fs = require("fs");
  const [v, notes, file, size] = process.argv.slice(1);
  fs.writeFileSync(process.argv[5] + "/latest.json", JSON.stringify({
    version: v, notes, file, size: Number(size), publishedAt: new Date().toISOString(),
  }, null, 2) + "\n");
' "$VERSION" "$NOTES" "$FILE" "$(stat -c %s "$OUT")" "$PUB"
(
  cd "$PUB"
  git init -q -b releases
  git add -A
  git -c user.name="$(git -C "$HERE" config user.name || echo release)" -c user.email="$(git -C "$HERE" config user.email || echo release@localhost)" \
    commit -q -m "Выпуск $VERSION"
  git push -q -f "git@github.com:$REPO.git" releases:releases
)
echo "✓ готово: выпуск $VERSION опубликован, телефоны увидят его в течение 5 минут"
