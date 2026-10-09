import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { BackupService } from './backup.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';
import { currentContext } from '../common/request-context.js';

class UidParams {
  @IsUUID()
  uid!: string;
}

/**
 * Копии базы в «Настройках».
 *
 * Право — существующее `admin.users`: его держит только роль `admin`
 * (см. `prisma/rbac.ts`). Новых прав и роли под бэкап не завожу — правка RBAC
 * задачей не поручена, а список копий и так открыт ровно тем, кому открыт сам
 * раздел «Настройки».
 *
 * **Восстановления кнопкой здесь нет, и это решение, а не недоделка.**
 * HTTP-ручка, которая зовёт `pg_restore --clean` по живой базе, — это кнопка
 * «стереть все данные», доступная по сети. Подтверждение в окне от неё не
 * спасает: от угнанной сессии администратора и от чужой руки на его ноутбуке
 * спасает только отсутствие такой ручки. Восстановление делается на сервере
 * руками, по точной команде из статьи справки «Бэкап базы», и проверяется
 * скриптом `scripts/backup-verify.ts`, который разворачивает копию во
 * временную базу и сверяет число записей.
 */
@Controller('admin/backups')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  @RequirePermissions('admin.users')
  async list() {
    return { settings: this.backup.settings(), rows: await this.backup.list() };
  }

  @Post()
  @RequirePermissions('admin.users')
  run() {
    return this.backup.run('manual', currentContext()?.userId ?? null);
  }

  /**
   * Скачивание копии. `@Res()` без passthrough — как в выдаче вложений:
   * иначе конверт-перехватчик обернёт байты в JSON, и файл не сохранится.
   */
  @Get(':uid/file')
  @RequirePermissions('admin.users')
  async file(@Param() params: UidParams, @Res() res: Response) {
    const { fileName, full, size } = await this.backup.file(params.uid);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // Копия базы — это вся база: ни в общий кэш, ни в чужой прокси.
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    createReadStream(full).pipe(res);
  }
}
