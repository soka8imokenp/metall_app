import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { say } from '../common/say.js';

/**
 * Обновления мобильного приложения из релизов GitHub.
 *
 * Репозиторий приватный, а ключ доступа к нему не должен попасть в APK: его
 * вытаскивают из файла за минуту, и с ним уходит весь код. Поэтому GitHub
 * читает сервер — своим ключом из файла (`GITHUB_TOKEN_FILE`), — а телефон
 * спрашивает и скачивает обновление у сервера. Наружу уходит только номер
 * версии, описание и сам APK.
 *
 * Релиз — обычный релиз GitHub: тег `v0.8.0`, к нему приложен файл `*.apk`.
 * Последний неархивный релиз и есть «актуальная версия».
 *
 * Переменные: `GITHUB_RELEASES_REPO` (`владелец/репозиторий`) и
 * `GITHUB_TOKEN_FILE` (путь к файлу с ключом, права 600; ключу хватает права
 * читать содержимое репозитория). Не заданы — обновлений просто нет.
 */

export interface Release {
  version: string;
  notes: string;
  publishedAt: string;
  size: number;
  /** Откуда качать: вложение релиза GitHub или файл в ветке `releases`. */
  assetId: number | null;
  assetName: string;
  rawUrl: string | null;
}

/** Ветка с последним выпуском: `latest.json` и сам APK (см. mobile/scripts/release.sh). */
export const RELEASES_BRANCH = 'releases';

/** Как часто спрашиваем GitHub: телефоны проверяют при каждом запуске, GitHub — раз в 5 минут. */
const CACHE_MS = 5 * 60_000;

@Injectable()
export class UpdatesService {
  private readonly log = new Logger('updates');
  private cache: { at: number; release: Release | null } | null = null;

  private get repo(): string | null {
    const r = process.env.GITHUB_RELEASES_REPO?.trim();
    return r && /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
  }

  private token(): string | null {
    const path = process.env.GITHUB_TOKEN_FILE;
    if (!path) return null;
    try {
      return readFileSync(path, 'utf8').trim() || null;
    } catch {
      this.log.warn(`не читается GITHUB_TOKEN_FILE (${path})`);
      return null;
    }
  }

  private headers(accept: string): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'metall-asia-api' };
    const t = this.token();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  get configured(): boolean {
    return this.repo !== null;
  }

  /** Последний релиз с APK. Ошибка GitHub не роняет запуск приложения: «обновлений нет». */
  async latest(): Promise<Release | null> {
    if (!this.repo) return null;
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.release;
    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: this.headers('application/vnd.github+json'),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) {
        // Релизов GitHub нет — смотрим ветку выпусков, её пишет скрипт по git.
        const branch = await this.fromBranch();
        this.cache = { at: Date.now(), release: branch };
        if (branch) void this.prefetch(branch);
        return branch;
      }
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const json = (await res.json()) as {
        tag_name: string;
        body: string | null;
        published_at: string;
        assets: { id: number; name: string; size: number }[];
      };
      const apk = json.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
      const version = json.tag_name.replace(/^v/i, '');
      const release = apk && /^\d+\.\d+\.\d+$/.test(version)
        ? { version, notes: (json.body ?? '').slice(0, 4000), publishedAt: json.published_at, size: apk.size, assetId: apk.id, assetName: apk.name, rawUrl: null }
        : null;
      this.cache = { at: Date.now(), release };
      if (release) void this.prefetch(release);
      return release;
    } catch (e) {
      this.log.warn(`релизы GitHub: ${(e as Error).message}`);
      // Прошлое удачное знание лучше, чем ничего: GitHub мог моргнуть.
      return this.cache?.release ?? null;
    }
  }

  /**
   * Выпуск из ветки `releases`: скрипт кладёт туда `latest.json` и APK и
   * отправляет по git (SSH-ключом разработчика), без ключа к API GitHub.
   * Ветка каждый раз переписывается целиком — в ней только последний выпуск,
   * репозиторий не разрастается от старых APK.
   */
  private async fromBranch(): Promise<Release | null> {
    const base = `https://raw.githubusercontent.com/${this.repo}/${RELEASES_BRANCH}`;
    // Описание выпуска — через API, а не через raw: CDN raw держит у себя ответ
    // «не найдено» минутами, и свежий выпуск был бы не виден. Сам APK — через
    // raw, у API ограничение на размер файла.
    const res = await fetch(`https://api.github.com/repos/${this.repo}/contents/latest.json?ref=${RELEASES_BRANCH}`, {
      headers: this.headers('application/vnd.github.raw+json'),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ветка выпусков: ${res.status}`);
    const m = (await res.json()) as { version?: string; notes?: string; publishedAt?: string; size?: number; file?: string };
    if (!m.version || !/^\d+\.\d+\.\d+$/.test(m.version) || !m.file || !/^[\w.-]+\.apk$/.test(m.file)) return null;
    return {
      version: m.version,
      notes: (m.notes ?? '').slice(0, 4000),
      publishedAt: m.publishedAt ?? '',
      size: Number(m.size ?? 0),
      assetId: null,
      assetName: m.file,
      rawUrl: `${base}/${m.file}`,
    };
  }

  // --- копия APK на сервере ------------------------------------------------

  /**
   * APK держим у себя: GitHub отдаёт 60 МБ минуту-полторы, а телефон в цеху
   * не должен столько ждать при каждом обновлении. Сервер качает новый выпуск
   * сам, как только его увидел, и дальше раздаёт по локальной сети.
   */
  private get dir(): string {
    return process.env.UPDATES_DIR || join(process.cwd(), 'var', 'updates');
  }

  private fileOf(release: Release): string {
    return join(this.dir, `MetallAsia-${release.version}.apk`);
  }

  /** Готова ли копия: файл есть и размер совпадает с объявленным. */
  cached(release: Release): string | null {
    const f = this.fileOf(release);
    try {
      return existsSync(f) && statSync(f).size === release.size ? f : null;
    } catch {
      return null;
    }
  }

  private fetching = new Set<string>();

  async prefetch(release: Release): Promise<void> {
    // в прогонах тестов ничего на диск не качаем
    if (process.env.VITEST || this.cached(release) || this.fetching.has(release.version)) return;
    this.fetching.add(release.version);
    const final = this.fileOf(release);
    const part = `${final}.part`;
    try {
      mkdirSync(this.dir, { recursive: true });
      const res = await fetch(this.urlOf(release), { headers: this.headers('application/octet-stream'), redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
      if (statSync(part).size !== release.size) throw new Error('размер не совпал');
      renameSync(part, final);
      this.log.log(`выпуск ${release.version} скачан на сервер`);
    } catch (e) {
      this.log.warn(`копия выпуска ${release.version}: ${(e as Error).message}`);
      try { unlinkSync(part); } catch { /* нечего убирать */ }
    } finally {
      this.fetching.delete(release.version);
    }
  }

  private urlOf(release: Release): string {
    return release.rawUrl ?? `https://api.github.com/repos/${this.repo}/releases/assets/${release.assetId}`;
  }

  /**
   * Сам APK потоком. GitHub отвечает переадресацией на подписанную ссылку
   * хранилища; ключ туда не уходит (fetch не переносит заголовок
   * авторизации на чужой адрес).
   */
  async download(): Promise<{ release: Release; body: NodeJS.ReadableStream }> {
    const release = await this.latest();
    if (!release) throw new NotFoundException(say('Обновлений нет', 'Yangilanish yo‘q'));
    const local = this.cached(release);
    if (local) return { release, body: createReadStream(local) };
    // Копии ещё нет (выпуск только что вышел) — отдаём прямо с GitHub.
    const res = await fetch(this.urlOf(release), {
      headers: this.headers('application/octet-stream'),
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw new ServiceUnavailableException(say('Не удалось получить файл обновления', 'Yangilanish faylini olib bo‘lmadi'));
    }
    return { release, body: Readable.fromWeb(res.body as any) };
  }
}
