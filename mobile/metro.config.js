// Metro по умолчанию берёт все ядра; при сборке APK в контейнере это душит ПК.
// METRO_MAX_WORKERS задаёт release.sh; в разработке — значение Expo.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (process.env.METRO_MAX_WORKERS) config.maxWorkers = Number(process.env.METRO_MAX_WORKERS);

module.exports = config;
