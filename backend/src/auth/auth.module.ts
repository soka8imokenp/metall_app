import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';
import { DevicesService } from './devices.service.js';
import { DevicesController } from './devices.controller.js';

/**
 * Секрет подписи читается из файла, путь к которому лежит в JWT_SECRET_FILE.
 * Значение не попадает ни в переменные окружения процесса, ни в вывод команд,
 * ни в git — только путь.
 */
function jwtSecret(): string {
  const path = process.env.JWT_SECRET_FILE;
  if (!path) throw new Error('Не задан JWT_SECRET_FILE');
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length < 32) throw new Error('Секрет JWT короче 32 символов');
  return secret;
}

@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [AuthController, DevicesController],
  providers: [AuthService, SessionsService, DevicesService],
  exports: [AuthService, SessionsService, DevicesService],
})
export class AuthModule {}
