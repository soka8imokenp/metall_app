// Поверх app.json: файл Firebase подключается, только когда он лежит рядом.
// Без него Android-сборка тоже собирается — просто без push.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const gs = path.join(__dirname, 'google-services.json');
  return {
    ...config,
    android: { ...config.android, ...(fs.existsSync(gs) ? { googleServicesFile: './google-services.json' } : {}) },
  };
};
