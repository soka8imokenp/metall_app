#!/usr/bin/env bash
# Выпуск новой версии мобильного приложения через релиз GitHub.
#
#   ./scripts/release.sh 0.8.0 "Что нового: плавные переходы, обновление из приложения"
#
# Что делает:
#   1. ставит версию в app.json (и versionCode для Android — из номера версии);
#   2. собирает APK в Docker с ограничением памяти и ядер (ПК не виснет);
#   3. кладёт копию в ../../builds/;
#   4. создаёт релиз v<версия> в репозитории и прикладывает к нему APK.
#
# Телефоны узнают о релизе от сервера (`GET /mobile/update`), сервер — от GitHub.
#
# Ключ GitHub (Contents: Read and write) в файле $GITHUB_TOKEN_FILE — тогда
# релиз создаётся и APK загружается сам. Без ключа скрипт собирает APK и
# пишет, как выложить его на сайте. Репозиторий публичный — серверу, чтобы
# видеть релизы, ключ не нужен.
set -euo pipefail
# APK собирается под эту версию API; серверу ключ GitHub не нужен (репозиторий публичный).

VERSION="${1:?укажите версию, например 0.8.0}"
NOTES="${2:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "версия: три числа через точку" >&2; exit 1; }

REPO="${GITHUB_RELEASES_REPO:-soka8imokenp/metall_app}"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.local/state/openclaw/secrets/github-metall-app-token}"
API_URL="${RELEASE_API_URL:-http://192.168.1.165:4001/api/v1}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/../../builds/MetallAsia-$VERSION-arm64.apk"

# Без ключа скрипт только собирает APK, а релиз создаётся руками на сайте.
TOKEN=""
[ -r "$TOKEN_FILE" ] && TOKEN="$(cat "$TOKEN_FILE")"

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
grep -q "kotlin.daemon.jvmargs" android/gradle.properties || printf '\nkotlin.daemon.jvmargs=-Xmx1g\norg.gradle.workers.max=2\nkotlin.compiler.execution.strategy=in-process\n' >> android/gradle.properties

echo "→ сборка APK (несколько минут)"
docker build -q -t metall-apk-builder scripts/android-build >/dev/null
U="$(id -u):$(id -g)"
nice -n 15 docker run --rm --cpuset-cpus 0-2 --memory 4g --memory-swap 4g \
  -v "$HERE":/app -v metall-gradle-cache:/root/.gradle \
  -e EXPO_PUBLIC_API_URL="$API_URL" -e NODE_ENV=production -e CMAKE_BUILD_PARALLEL_LEVEL=2 \
  -w /app/android metall-apk-builder \
  bash -c "./gradlew assembleRelease --no-daemon --max-workers=2 -x lint -x test -q; rc=\$?; chown -R $U /app/android; exit \$rc"

mkdir -p "$(dirname "$OUT")"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "→ APK: $OUT ($(du -h "$OUT" | cut -f1))"

if [ -z "$TOKEN" ]; then
  cat <<MSG
✓ APK собран. Ключа GitHub нет — создайте релиз на сайте:
  1. https://github.com/$REPO/releases/new
  2. Tag: v$VERSION  (Create new tag)
  3. Описание — что нового (его увидят в окне обновления)
  4. Перетащите файл: $OUT
  5. Publish release
Телефоны увидят обновление в течение 5 минут.
MSG
  exit 0
fi

echo "→ релиз v$VERSION в $REPO"
BODY="$(node -e 'console.log(JSON.stringify({tag_name: "v" + process.argv[1], name: "METALL ASIA " + process.argv[1], body: process.argv[2] || "", draft: false, prerelease: false}))' "$VERSION" "$NOTES")"
RELEASE="$(curl -sS -f -X POST "https://api.github.com/repos/$REPO/releases" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -d "$BODY")"
RID="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$RELEASE")"

curl -sS -f -X POST "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=MetallAsia-$VERSION.apk" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary @"$OUT" >/dev/null

echo "✓ готово: телефоны увидят обновление $VERSION в течение 5 минут"
