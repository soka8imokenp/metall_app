import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// BigInt из Prisma не сериализуется JSON.stringify по умолчанию. Идентификаторы
// наружу и так уходят как uid, но версия или счётчик могут прийти bigint —
// пусть станут строкой, а не уронят ответ.
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  // Вложение приходит телом запроса как есть. Разбор JSON здесь только испортит
  // байты, поэтому на этом пути стоит сырой разбор с пределом чуть выше
  // делового (20 МиБ): пусть предел объяснит сервис понятной ошибкой, а не
  // express — обрывом соединения.
  const { raw } = await import('express');
  app.use(
    '/api/v1/attachments',
    raw({ type: () => true, limit: '21mb' }),
  );
  // Шаблон печатной формы — тоже файл телом запроса. Путь именно
  // `.../templates/upload`, без вложенных маршрутов: express монтирует по
  // префиксу, и на `/documents/templates` сырой разбор съел бы JSON у
  // сопоставления полей и публикации.
  app.use(
    '/api/v1/documents/templates/upload',
    raw({ type: () => true, limit: '6mb' }),
  );
  // Входящий вебхук: байты нужны в точности, иначе не сойдётся подпись — HMAC
  // считается по сырому тексту, а разбор и обратная сборка JSON переставят
  // пробелы и порядок ключей. Предел 2 МиБ при деловом 1 МиБ — по той же
  // причине, что у вложений: пусть откажет сервис, назвав размер, а не express
  // обрывом соединения.
  app.use('/api/v1/hooks', raw({ type: () => true, limit: '2mb' }));
  // Загружаемая таблица номенклатуры — файл телом запроса. Путь точный, без
  // вложенных маршрутов: на `/exchange` сырой разбор съел бы JSON у всех
  // остальных маршрутов обмена.
  app.use('/api/v1/exchange/items/import', raw({ type: () => true, limit: '6mb' }));

  // Приём заявок с сайта заказчика открыт любому адресу страницы, и это не
  // дыра: ответ не несёт данных, cookie не используются, а компанию определяет
  // ключ сайта. Общий список CORS_ORIGINS сюда не годится — адрес их сайта
  // меняется без нашей выкатки. Стоит до enableCors, иначе проверочный запрос
  // браузера (OPTIONS) отобьёт общий список раньше.
  app.use('/api/v1/public', (req: any, res: any, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Company-Id',
      'X-Request-Id',
      'Idempotency-Key',
      'X-Client',
      'Accept-Language',
    ],
    // Content-Disposition — не украшение: в нём имя выгруженного файла, а
    // браузер не отдаёт странице заголовки кросс-доменного ответа, пока их не
    // назвали здесь. Без него отчёт сохраняется под именем «report», и папка
    // «Загрузки» через неделю состоит из десяти одинаковых «report».
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '127.0.0.1');
  console.log(`API слушает http://127.0.0.1:${port}/api/v1`);
}

void bootstrap();
