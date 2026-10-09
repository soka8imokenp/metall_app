import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * Версия сборки: по ней собранный файл узнаёт, что на сервере лежит уже другой.
 *
 * Зачем вообще: имена файлов с хешем меняются при каждой сборке, но ссылается
 * на них `index.html`, а его браузер держит у себя. Пока он не переспросит
 * `index.html`, открыт будет прежний набор файлов — и выкаченные изменения
 * человек не увидит, сколько бы раз ни зашёл. Лечится не уговорами «нажмите
 * Ctrl+F5», а тем, что приложение само спрашивает сервер о версии.
 */
function buildVersion(): string {
  const sha = (() => {
    try {
      return execSync('git rev-parse --short HEAD', {encoding: 'utf8'}).trim();
    } catch {
      // Сборка вне репозитория — не повод падать, время сборки тоже отличает.
      return 'nogit';
    }
  })();
  return `${sha}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

/** Та же версия отдельным файлом рядом со сборкой — её и опрашивает приложение. */
function versionFile(version: string) {
  return {
    name: 'stand-version-file',
    closeBundle(this: {environment?: {config?: {build?: {outDir?: string}}}}) {
      const out = this.environment?.config?.build?.outDir ?? 'dist';
      fs.mkdirSync(out, {recursive: true});
      fs.writeFileSync(
        path.join(out, 'version.json'),
        `${JSON.stringify({version, builtAt: new Date().toISOString()}, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig(() => {
  const version = buildVersion();
  return {
    define: {__APP_VERSION__: JSON.stringify(version)},
    plugins: [react(), tailwindcss(), versionFile(version)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
