# METALL ASIA — мобильное приложение

Expo (React Native) + TypeScript. Пять модулей: склад, цех, финансы, документы, продажи (CRM нет).
Режим **только онлайн**: без связи показывается последнее загруженное, все кнопки изменения выключены.

## Запуск для разработки

```bash
# 1. бэкенд (см. ../backend, порт 4000) и мост для телефона
npm run proxy            # 0.0.0.0:4001 -> 127.0.0.1:4000, ещё и CORS

# 2. приложение
npm install
npx expo start --web     # браузер: http://localhost:8081, на телефоне: http://<IP-ПК>:8081
npx expo start           # QR для Expo Go (телефон и ПК в одной Wi-Fi)
```

Адрес API: `EXPO_PUBLIC_API_URL` (например `https://metall-asia.cloudplus.uz/api/v1`).
Без неё приложение ходит на `<хост-раздачи>:4001` — это мост `scripts/dev-proxy.mjs`.

Тестовый вход на локальной базе (`npm run seed` в бэкенде): `admin`, `s.radjabov` (директор),
`a.saidov` (склад), `j.tashpulatov` (мастер), `r.tursunov` (рабочий), `m.rahimova` (бухгалтер),
`d.karimov` (продажи); пароль у всех из `backend/prisma/seed-profiles.ts` (dev-профиль).

## Структура

```
src/app/            маршруты (Expo Router): (tabs)/ — вкладки, остальное — карточки
src/ui/             кит: Text, Card, Button, Sheet, TabBar, ListScreen…
src/components/     формы и блоки модулей
src/api/            клиент (Idempotency-Key, X-Company-Id), кэш, useAction
src/i18n/           RU/UZ
src/theme/          токены платформы (монохром + красный знак)
```

## Проверка

```bash
npx tsc --noEmit
npx expo export --platform android   # и ios: сборка бандла без телефона
```
