/**
 * Обновления приложения из релизов GitHub: разбор ответа и отказоустойчивость.
 * В сеть не ходим — `fetch` подменён.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdatesService } from '../src/updates/updates.service.js';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.8.0',
  body: 'Плавные переходы',
  published_at: '2026-10-09T12:00:00Z',
  assets: [
    { id: 11, name: 'notes.txt', size: 10 },
    { id: 42, name: 'MetallAsia-0.8.0.apk', size: 60_000_000 },
  ],
  ...over,
});

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_RELEASES_REPO;
});

describe('последний релиз', () => {
  it('без репозитория обновлений нет и GitHub не спрашивается', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    expect(await new UpdatesService().latest()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('берёт версию из тега и именно APK из вложений', async () => {
    process.env.GITHUB_RELEASES_REPO = 'owner/repo';
    mockFetch(200, release());
    const r = await new UpdatesService().latest();
    expect(r).toMatchObject({ version: '0.8.0', assetId: 42, size: 60_000_000, notes: 'Плавные переходы' });
  });

  it('релиз без APK или с кривым тегом — не обновление', async () => {
    process.env.GITHUB_RELEASES_REPO = 'owner/repo';
    mockFetch(200, release({ assets: [{ id: 1, name: 'a.zip', size: 1 }] }));
    expect(await new UpdatesService().latest()).toBeNull();
    vi.restoreAllMocks();
    mockFetch(200, release({ tag_name: 'nightly' }));
    expect(await new UpdatesService().latest()).toBeNull();
  });

  it('GitHub моргнул — отдаём прошлое знание, а не ошибку', async () => {
    process.env.GITHUB_RELEASES_REPO = 'owner/repo';
    const s = new UpdatesService();
    mockFetch(200, release());
    await s.latest();
    // кэш на 5 минут: состарим его, чтобы второй вызов пошёл в GitHub
    (s as any).cache.at = 0;
    vi.restoreAllMocks();
    mockFetch(502, {});
    expect((await s.latest())?.version).toBe('0.8.0');
  });

  it('нет релизов (404) — обновлений нет', async () => {
    process.env.GITHUB_RELEASES_REPO = 'owner/repo';
    mockFetch(404, { message: 'Not Found' });
    expect(await new UpdatesService().latest()).toBeNull();
  });
});
