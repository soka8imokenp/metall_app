import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Хранилище байтов вложения.
 *
 * Отдельный интерфейс с одной реализацией — не запас на будущее, а граница:
 * дальше него ни сервис, ни контроллер не знают, лежит файл на диске, в S3 или
 * в MinIO. Переезд в объектное хранилище, когда оно появится, будет вторым
 * классом здесь и ни одной правкой в бизнес-логике.
 */
export interface FileStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/**
 * Ключ строит сервер, но проверяем его всё равно: ключ приходит из базы, а в
 * базу однажды попадёт строка из скрипта или чужой ветви кода. `..` в ключе —
 * это чтение любого файла, до которого дотягивается процесс.
 */
const KEY_RE = /^[0-9]+\/[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/;

export const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Файлы на диске, корень задаётся `ATTACHMENTS_DIR`. */
export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Недопустимый ключ вложения: ${key}`);
    const path = resolve(join(this.root, key));
    // Проверка остаётся даже при совпавшем KEY_RE: регулярное выражение можно
    // однажды ослабить, а это условие говорит ровно то, что нужно — файл внутри
    // корня хранилища.
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('Ключ вложения выводит за корень хранилища');
    }
    return path;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    // 'wx' — если файл с таким ключом уже есть, это ошибка, а не перезапись:
    // ключ уникален в базе, и совпадение означает потерянный чужой файл.
    await writeFile(path, bytes, { flag: 'wx', mode: 0o640 });
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

export const defaultStorageRoot = (): string =>
  process.env.ATTACHMENTS_DIR ?? join(process.cwd(), 'var', 'attachments');
