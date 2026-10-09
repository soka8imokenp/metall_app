import 'reflect-metadata';
// Те же переменные, что у API: секрет подписи токенов и адрес базы лежат в
// `.env` рабочего каталога, а стенд поверх них задаёт свою базу и токен бота
// через EnvironmentFile. Заданное окружением dotenv не перетирает.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { BotModule } from './bot/bot.module.js';
import { BotService } from './bot/bot.service.js';

/**
 * Точка входа бота. HTTP здесь не поднимается: наружу бот ничего не слушает,
 * он сам ходит в Telegram длинным опросом. Поэтому `createApplicationContext`,
 * а не `create` — иначе рядом с API висел бы ещё один порт без надобности.
 *
 * Один процесс на токен: два одновременно получают от Telegram 409 и начинают
 * отбирать друг у друга обновления.
 */
// Загрузка курсов по расписанию — дело API: там она и живёт. Боту достаточно
// того, что лежит в справочнике, плюс кнопка «Обновить» на экране курса.
process.env.RATES_SCHEDULER = 'off';

async function main() {
  const app = await NestFactory.createApplicationContext(BotModule, {
    logger: ['error', 'warn', 'log'],
  });
  const bot = app.get(BotService);

  const stop = async (signal: string) => {
    new Logger('bot').log(`${signal}: останавливаюсь`);
    bot.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await bot.start();
}

void main();
