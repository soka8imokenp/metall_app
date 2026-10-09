import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Преобразование DOCX в PDF (ТЗ 7.2).
 *
 * Делает LibreOffice в безголовом режиме — тем же кодом, что открывает файл у
 * человека на столе. Своего рисовальщика PDF мы не пишем: у документа есть
 * шаблон заказчика со своей вёрсткой, и «почти как в Word» здесь означает
 * поехавшую таблицу в счёте, который уже ушёл клиенту.
 *
 * Три вещи, без которых это не работает в проде:
 *
 * 1. **Свой профиль на запуск.** LibreOffice держит настройки в каталоге
 *    пользователя и при втором одновременном запуске молча присоединяется к
 *    первому процессу — конвертация тогда не происходит вовсе, а команда
 *    возвращает ноль. Профиль в своём временном каталоге снимает это.
 * 2. **Очередь.** Даже со своими профилями пять одновременных LibreOffice —
 *    это пять процессов по паре сотен мегабайт. Преобразования идут по
 *    одному; полсекунды на документ, очередь из десяти не страшна.
 * 3. **Срок.** Процесс, севший на сломанном файле, висит вечно и держит
 *    очередь. Убиваем по истечении срока и говорим об этом словами.
 */

const BIN = process.env.SOFFICE_BIN ?? 'soffice';
const TIMEOUT_MS = Number(process.env.SOFFICE_TIMEOUT_MS ?? 60_000);

export class PdfConvertError extends Error {}
export class PdfToolMissingError extends Error {}

/** Очередь: следующее преобразование начинается после предыдущего. */
let queue: Promise<unknown> = Promise.resolve();

const run = (args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      BIN,
      args,
      { cwd, timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          return reject(
            new PdfToolMissingError(
              `LibreOffice не найден (${BIN}). PDF собирается им; ` +
                'поставьте его на сервер или задайте путь переменной SOFFICE_BIN',
            ),
          );
        }
        if (e.killed) {
          return reject(
            new PdfConvertError(
              `Преобразование в PDF не уложилось в ${Math.round(TIMEOUT_MS / 1000)} с`,
            ),
          );
        }
        reject(new PdfConvertError(`LibreOffice отказался: ${String(stderr || err.message).slice(0, 300)}`));
      },
    );
  });

async function convert(docx: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'metall-pdf-'));
  try {
    const src = join(dir, 'document.docx');
    await writeFile(src, docx);
    await run(
      [
        '--headless',
        '--norestore',
        // Профиль внутри того же временного каталога: уходит вместе с ним,
        // и два запуска не видят друг друга.
        `-env:UserInstallation=file://${join(dir, 'profile')}`,
        '--convert-to',
        'pdf',
        '--outdir',
        dir,
        src,
      ],
      dir,
    );
    const out = join(dir, 'document.pdf');
    let bytes: Buffer;
    try {
      bytes = await readFile(out);
    } catch {
      // LibreOffice умеет завершиться нулём, ничего не создав.
      throw new PdfConvertError('LibreOffice завершился, но PDF не создал');
    }
    if (bytes.length === 0 || bytes.subarray(0, 4).toString() !== '%PDF') {
      throw new PdfConvertError('LibreOffice вернул файл, который не PDF');
    }
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Преобразовать DOCX в PDF. Запросы выстраиваются в очередь. */
export function docxToPdf(docx: Buffer): Promise<Buffer> {
  const next = queue.then(
    () => convert(docx),
    () => convert(docx),
  );
  // В очередь кладём хвост, который не падает: иначе одна неудача оборвала бы
  // цепочку и следующие запросы получили бы чужую ошибку.
  queue = next.catch(() => undefined);
  return next;
}
