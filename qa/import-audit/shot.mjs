import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = '/tmp/ma-fe/metall-asia-main/dist';
const OUT = '/tmp/ma-fe/shots';
fs.mkdirSync(OUT, { recursive: true });

const app = express();
app.use(express.static(ROOT));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
const server = await new Promise((resolve) => {
  const s = app.listen(4321, '127.0.0.1', () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

const MODULES = ['dashboard', 'sales', 'warehouse', 'production', 'finance', 'documents', 'crm', 'admin'];
const errors = [];

async function shoot(width, height, theme, tasks) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${width}/${theme}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`[${width}/${theme}] PAGEERROR ${e.message.slice(0, 200)}`));
  await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
  await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await tasks(page, ctx);
  await ctx.close();
}

// navigate by clicking sidebar nav items is fragile; use React state via exposed clicks on nav buttons by title text
const NAV_RU = {
  dashboard: 'Дашборд', sales: 'Продажи', warehouse: 'Склад', production: 'Производство',
  finance: 'Финансы', documents: 'Документы', crm: 'CRM', admin: 'Настройки',
};

for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
  for (const theme of ['light', 'dark']) {
    await shoot(w, h, theme, async (page) => {
      for (const mod of MODULES) {
        const label = NAV_RU[mod];
        const btn = page.locator('button', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
        if (await btn.count()) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        // measure horizontal overflow
        const ov = await page.evaluate(() => {
          const de = document.documentElement;
          const main = document.querySelector('main');
          return {
            docOverflow: de.scrollWidth - de.clientWidth,
            mainOverflow: main ? main.scrollWidth - main.clientWidth : null,
          };
        });
        fs.appendFileSync(`${OUT}/overflow.txt`, `${tag}/${theme}/${mod}: doc=${ov.docOverflow} main=${ov.mainOverflow}\n`);
        await page.screenshot({ path: `${OUT}/${tag}-${theme}-${mod}.png`, fullPage: false });
      }
    });
  }
}

// collapsed sidebar, 1440 light, dashboard
await shoot(1440, 900, 'light', async (page) => {
  const toggle = page.locator('button[aria-label], button').filter({ hasNotText: /./ }).first();
  await toggle.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/1440-light-dashboard-collapsed.png` });
});

fs.writeFileSync(`${OUT}/console-errors.txt`, errors.join('\n') || 'none');
await browser.close();
server.close();
console.log('DONE. errors:', errors.length);
