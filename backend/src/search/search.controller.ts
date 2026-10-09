import { Controller, Get, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SearchService } from './search.service.js';

/**
 * Маршрут без `@RequirePermissions`: право проверяется у каждой группы
 * отдельно, внутри сервиса. Общее право на маршрут здесь было бы неверным с
 * любой стороны — слишком узкое закрыло бы поиск половине ролей, слишком
 * широкое выдало бы контрагентов рабочему цеха.
 */
class SearchQuery {
  /**
   * Нижняя граница — два знака. По одному знаку выдача бессмысленна (найдётся
   * почти всё), а база читает все перечисленные таблицы целиком.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  q!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(@Query() query: SearchQuery) {
    return this.search.search(query.q, query.limit ?? 5);
  }
}
