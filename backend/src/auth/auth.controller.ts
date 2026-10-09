import { Body, Controller, Delete, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AuthService, MIN_PASSWORD } from './auth.service.js';
import { SessionsService } from './sessions.service.js';
import { AllowTempPassword, Public, RequirePermissions } from './auth.guard.js';
import { requireContext } from '../common/request-context.js';

/**
 * Телефон при входе называет себя: по `installationId` он становится
 * устройством, которое администратор видит и может отозвать.
 */
export class DeviceDto {
  @IsString()
  @MinLength(8)
  @MaxLength(80)
  installationId!: string;

  @IsIn(['android', 'ios', 'web'])
  platform!: 'android' | 'ios' | 'web';

  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(40) osVersion?: string;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  /** Адрес для push. Пустая строка — стереть. */
  @IsOptional() @IsString() @MaxLength(300) pushToken?: string;
  @IsOptional() @IsIn(['expo', 'fcm']) pushProvider?: 'expo' | 'fcm';
}

class LoginDto {
  @IsString()
  @MinLength(2)
  login!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;

  // Только непустая строка. Ограничение длины здесь отбивало 400 учётку
  // с коротким паролем, не дойдя до сверки хеша, и заодно сообщало
  // подбирающему, что длина не та. Длину задаёт тот маршрут, который пароль
  // устанавливает, — не вход. Сторож — test/dashboard.e2e.spec.ts.
  @IsString()
  @MinLength(1)
  password!: string;
}

class ResetRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  login!: string;

  /** Как с человеком связаться: телефон, почта, кабинет — что он сам напишет. */
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  contact!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class HandleResetDto {
  @IsIn(['done', 'rejected'])
  action!: 'done' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class RefreshDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken!: string;
}

class SetLocaleDto {
  @IsIn(['ru', 'uz'])
  locale!: 'ru' | 'uz';
}

class ResetUidDto {
  @IsUUID()
  uid!: string;
}

class ChangePasswordDto {
  /**
   * Текущий пароль спрашивается и при обязательной смене: иначе незапертый
   * экран с живой сессией отдаёт учётку любому, кто до него дошёл.
   */
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  /**
   * Нижняя граница — одна, и живёт она в `auth.service.ts`. Верхняя нужна от
   * того, что bcrypt считает только первые 72 байта: пароль длиннее этого
   * обрезается молча, и человек думает, что помнит его целиком.
   */
  @IsString()
  @MinLength(MIN_PASSWORD)
  @MaxLength(72)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    const client = requireContext().source === 'mobile' ? 'mobile' : 'web';
    const { token, user, profile, session, device } = await this.auth.login(dto.login, dto.password, ip, {
      client,
      userAgent,
      device: dto.device,
    });
    const companies = await this.auth.companies(profile.companyIds);

    return {
      token,
      // Имя поля по контракту (§2); `token` остаётся для веба, который его читает.
      accessToken: token,
      expiresIn: session?.expiresIn ?? null,
      // Только телефону: браузеру долгоживущий секрет в ответе не нужен.
      refreshToken: session?.refreshToken ?? undefined,
      sessionUid: session?.uid ?? null,
      device,
      user: {
        uid: user.uid,
        login: user.login,
        fullName: user.fullName,
        locale: user.locale,
      },
      companies: companies.map((c) => ({
        uid: c.uid,
        code: c.code,
        nameRu: c.nameRu,
        nameUz: c.nameUz,
      })),
      permissions: [...profile.permissions].sort(),
      // Вход с временным паролем проходит: иначе человек не смог бы его
      // сменить. Признак здесь — то, по чему интерфейс сразу открывает окно
      // «Измените пароль», не дожидаясь первого отказа на другом маршруте.
      mustChangePassword: profile.mustChangePassword,
    };
  }

  /**
   * Обновление токена телефоном (контракт §2). Маршрут открытый: токен
   * доступа к этому моменту уже истёк — для того обновление и нужно.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Ip() ip: string) {
    return this.auth.refresh(dto.refreshToken, ip);
  }

  /** Выход: текущая сессия закрывается, её токены больше не действуют. */
  @AllowTempPassword()
  @Post('logout')
  @HttpCode(200)
  async logout() {
    const ctx = requireContext();
    if (ctx.sessionUid) await this.sessions.revoke(ctx.sessionUid, ctx.userId!, 'logout', ctx.userId!);
    return { ok: true };
  }

  /** Свои активные сессии: где я сейчас вошёл. */
  @Get('sessions')
  sessionsList() {
    const ctx = requireContext();
    return this.sessions.listOwn(ctx.userId!, ctx.sessionUid);
  }

  /** Закрыть свою сессию — например, на забытом в цеху телефоне. */
  @Delete('sessions/:uid')
  async sessionRevoke(@Param() params: ResetUidDto) {
    const ctx = requireContext();
    await this.sessions.revoke(params.uid, ctx.userId!, 'self', ctx.userId!);
    return { ok: true };
  }

  /**
   * Заявка на сброс пароля — маршрут открытый: его открывают до входа.
   *
   * Ответ всегда один и тот же. «Логина нет» здесь означало бы, что любой
   * желающий может перебором собрать список действующих учёток.
   */
  @Public()
  @Post('password-reset-request')
  async requestReset(@Body() dto: ResetRequestDto) {
    await this.auth.requestPasswordReset(dto.login, dto.contact, dto.note);
    return { accepted: true };
  }

  @RequirePermissions('admin.users')
  @Get('password-reset-requests')
  async resetRequests(@Query('status') status?: string) {
    const known = ['new', 'done', 'rejected', 'all'];
    return { rows: await this.auth.passwordResetRequests(known.includes(status ?? '') ? status! : 'new') };
  }

  /**
   * Разбор заявки. `done` выдаёт временный пароль и возвращает его здесь —
   * единственный раз за всю жизнь этого пароля. Ни список заявок, ни журнал
   * его потом не покажут, и восстановить его нельзя: передать человеку должен
   * тот, кто сбросил.
   */
  @RequirePermissions('admin.users')
  @Post('password-reset-requests/:uid')
  async handleReset(@Param() params: ResetUidDto, @Body() dto: HandleResetDto) {
    const ctx = requireContext();
    const { password } = await this.auth.handlePasswordReset(
      params.uid,
      dto.action,
      ctx.userId!,
      dto.note,
    );
    return { ok: true, password };
  }

  /**
   * Своя смена пароля. Прав не требует и доступна с временным паролем — это
   * единственная дверь, которая человеку в таком состоянии и нужна.
   */
  @AllowTempPassword()
  @Post('me/password')
  async changePassword(@Body() dto: ChangePasswordDto) {
    const ctx = requireContext();
    await this.auth.changeOwnPassword(ctx.userId!, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  /**
   * Выбор языка. Прав не требует: человек выбирает язык себе, и только себе —
   * идентификатор берётся из токена, а не из тела запроса.
   */
  @Post('me/locale')
  async setLocale(@Body() dto: SetLocaleDto) {
    const ctx = requireContext();
    await this.auth.setLocale(ctx.userId!, dto.locale);
    return { ok: true };
  }

  /**
   * Свой профиль. Доступен с временным паролем: по нему страница рисует окно
   * «Измените пароль» после перезагрузки, когда ответа на вход уже нет.
   */
  @AllowTempPassword()
  @Get('me')
  async me() {
    const ctx = requireContext();
    const user = await this.auth.userById(ctx.userId!);
    const companies = await this.auth.companies(ctx.companyIds);

    return {
      user: {
        uid: user!.uid,
        login: user!.login,
        fullName: user!.fullName,
        locale: user!.locale,
      },
      companies: companies.map((c) => ({
        uid: c.uid,
        code: c.code,
        nameRu: c.nameRu,
        nameUz: c.nameUz,
      })),
      permissions: [...ctx.permissions].sort(),
      mustChangePassword: user!.mustChangePassword,
    };
  }
}
