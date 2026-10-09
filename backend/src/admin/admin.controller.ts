import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdminUsersService } from './users.service.js';
import { AdminRolesService } from './roles.service.js';
import { AdminJournalService } from './journal.service.js';
import { TelegramLinkService } from './telegram-link.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';

const LOCALES = ['ru', 'uz'] as const;
const SCOPES = ['all', 'own', 'department', 'warehouse'] as const;

/** Логин набирают руками и называют голосом: только латиница, цифры, точка и подчёркивание. */
const LOGIN_RE = /^[a-z][a-z0-9._-]{2,31}$/;
/** Код роли попадает в настройку системы, поэтому правила те же, но без точки. */
const ROLE_CODE_RE = /^[a-z][a-z0-9_]{2,31}$/;

class UidParams {
  @IsUUID()
  uid!: string;
}

class CodeParams {
  @Matches(ROLE_CODE_RE, { message: 'Код роли: латиница, цифры и подчёркивание' })
  code!: string;
}

class AssignmentDto {
  @Matches(ROLE_CODE_RE)
  roleCode!: string;

  @IsUUID()
  companyUid!: string;

  @IsOptional()
  @IsUUID()
  departmentUid?: string;

  @IsOptional()
  @IsUUID()
  warehouseUid?: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: (typeof SCOPES)[number];
}

class UsersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsBooleanString()
  includeInactive?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}

class CreateUserBody {
  @Matches(LOGIN_RE, {
    message: 'Логин: со строчной латинской буквы, затем латиница, цифры, точка, дефис или _',
  })
  login!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments!: AssignmentDto[];
}

class PatchUserBody {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class PasswordBody {
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;
}

class RolesBody {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments!: AssignmentDto[];
}

class CreateRoleBody {
  @Matches(ROLE_CODE_RE, { message: 'Код роли: латиница, цифры и подчёркивание' })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameRu!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameUz!: string;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions!: string[];
}

class PatchRoleBody {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameRu?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nameUz?: string;
}

class PermissionsBody {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions!: string[];
}

class AuditQuery {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  action?: string;

  @IsOptional()
  @IsUUID()
  userUid?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}

class LoginsQuery {
  @IsOptional()
  @IsBooleanString()
  onlyFailed?: string;

  @IsOptional()
  @IsUUID()
  userUid?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Администрирование: люди, роли, журналы (ТЗ 3.3, 3.4).
 *
 * Права разделены по смыслу, а не по экрану: `admin.users` — кто работает в
 * системе и что он здесь делал, `admin.roles` — что вообще можно делать.
 * Матрицу прав правит тот, кто отвечает за правила доступа, а принять нового
 * кладовщика может и тот, кому правила менять незачем.
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly roles: AdminRolesService,
    private readonly journal: AdminJournalService,
    private readonly telegram: TelegramLinkService,
  ) {}

  @Get('users')
  @RequirePermissions('admin.users')
  listUsers(@Query() q: UsersQuery) {
    return this.users.list({
      search: q.search,
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
      includeInactive: q.includeInactive !== 'false',
    });
  }

  @Post('users')
  @RequirePermissions('admin.users')
  createUser(@Body() body: CreateUserBody) {
    return this.users.create(body);
  }

  @Patch('users/:uid')
  @RequirePermissions('admin.users')
  patchUser(@Param() p: UidParams, @Body() body: PatchUserBody) {
    return this.users.update(p.uid, body);
  }

  @Post('users/:uid/password')
  @RequirePermissions('admin.users')
  setPassword(@Param() p: UidParams, @Body() body: PasswordBody) {
    return this.users.setPassword(p.uid, body.password);
  }

  @Post('users/:uid/unlock')
  @RequirePermissions('admin.users')
  unlock(@Param() p: UidParams) {
    return this.users.unlock(p.uid);
  }

  /**
   * Код привязки Telegram. Он в ответе — и больше нигде: в базе лежит хеш, в
   * журнале только факт выдачи и срок. Поэтому маршрут POST, а не GET: его
   * нельзя ни повторить из истории браузера, ни закешировать.
   */
  @Post('users/:uid/telegram/code')
  @RequirePermissions('admin.users')
  telegramCode(@Param() params: UidParams) {
    return this.telegram.issueCode(params.uid);
  }

  @Delete('users/:uid/telegram')
  @RequirePermissions('admin.users')
  telegramUnlink(@Param() params: UidParams) {
    return this.telegram.unlink(params.uid);
  }

  @Put('users/:uid/roles')
  @RequirePermissions('admin.users')
  setRoles(@Param() p: UidParams, @Body() body: RolesBody) {
    return this.users.setRoles(p.uid, body.assignments);
  }

  @Get('permissions')
  @RequirePermissions('admin.users')
  permissions() {
    return this.roles.permissions();
  }

  @Get('roles')
  @RequirePermissions('admin.users')
  listRoles() {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermissions('admin.roles')
  createRole(@Body() body: CreateRoleBody) {
    return this.roles.create(body);
  }

  @Patch('roles/:code')
  @RequirePermissions('admin.roles')
  patchRole(@Param() p: CodeParams, @Body() body: PatchRoleBody) {
    return this.roles.update(p.code, body);
  }

  @Put('roles/:code/permissions')
  @RequirePermissions('admin.roles')
  setRolePermissions(@Param() p: CodeParams, @Body() body: PermissionsBody) {
    return this.roles.setPermissions(p.code, body.permissions);
  }

  @Delete('roles/:code')
  @RequirePermissions('admin.roles')
  removeRole(@Param() p: CodeParams) {
    return this.roles.remove(p.code);
  }

  @Get('audit')
  @RequirePermissions('admin.users')
  audit(@Query() q: AuditQuery) {
    return this.journal.audit({
      entityType: q.entityType,
      action: q.action,
      userUid: q.userUid,
      from: q.from,
      to: q.to,
      search: q.search,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }

  @Get('audit/facets')
  @RequirePermissions('admin.users')
  auditFacets() {
    return this.journal.auditFacets();
  }

  @Get('logins')
  @RequirePermissions('admin.users')
  logins(@Query() q: LoginsQuery) {
    return this.journal.logins({
      onlyFailed: q.onlyFailed === 'true',
      userUid: q.userUid,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
}
