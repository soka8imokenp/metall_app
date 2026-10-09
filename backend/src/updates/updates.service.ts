import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
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
  assetId: number;
  assetName: string;
}

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
        this.cache = { at: Date.now(), release: null };
        return null;
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
        ? { version, notes: (json.body ?? '').slice(0, 4000), publishedAt: json.published_at, size: apk.size, assetId: apk.id, assetName: apk.name }
        : null;
      this.cache = { at: Date.now(), release };
      return release;
    } catch (e) {
      this.log.warn(`релизы GitHub: ${(e as Error).message}`);
      // Прошлое удачное знание лучше, чем ничего: GitHub мог моргнуть.
      return this.cache?.release ?? null;
    }
  }

  /**
   * Сам APK потоком. GitHub отвечает переадресацией на подписанную ссылку
   * хранилища; ключ туда не уходит (fetch не переносит заголовок
   * авторизации на чужой адрес).
   */
  async download(): Promise<{ release: Release; body: ReadableStream<Uint8Array> }> {
    const release = await this.latest();
    if (!release) throw new NotFoundException(say('Обновлений нет', 'Yangilanish yo‘q'));
    const res = await fetch(`https://api.github.com/repos/${this.repo}/releases/assets/${release.assetId}`, {
      headers: this.headers('application/octet-stream'),
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw new ServiceUnavailableException(say('Не удалось получить файл обновления', 'Yangilanish faylini olib bo‘lmadi'));
    }
    return { release, body: res.body };
  }
}
