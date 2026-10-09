/**
 * Файлы демонстрационных вложений. Только для сида: на стенде нужны настоящие
 * png и pdf, которые браузер откроет, а не заглушки с расширением.
 *
 * Собираются в коде, а не лежат в репозитории двоичными файлами: картинка на
 * 64×64 — это тридцать строк арифметики, а бинарь в git живёт вечно и растёт
 * с каждой правкой.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Квадратная картинка: фон плюс наклонная полоса. Не фотография, но и не
 * однопиксельная пустышка — на экране видно, что показывается именно снимок,
 * а размер остаётся в сотнях байт.
 */
export function demoPng(size: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0; // фильтр строки
    p += 1;
    for (let x = 0; x < size; x += 1) {
      const stripe = (x + y) % 18 < 6;
      const k = stripe ? 0.65 : 1;
      raw[p] = Math.round(rgb[0] * k);
      raw[p + 1] = Math.round(rgb[1] * k);
      raw[p + 2] = Math.round(rgb[2] * k);
      p += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Однострочный pdf. Текст латиницей сознательно: кириллица в pdf требует
 * вложенного шрифта, а демонстрационному сертификату хватает того, что файл
 * открывается просмотрщиком как настоящий.
 */
export function demoPdf(line: string): Buffer {
  const text = line.replace(/[()\\]/g, '');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // поток текста, соберём ниже
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 60 760 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
