import { ConflictException, Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service.js';
import { periodKey, renderNumber } from './numbering.js';
import { say } from '../common/say.js';

/**
 * Выдача номера документа (ТЗ 7.3).
 *
 * Номер выдаётся одним запросом `INSERT ... ON CONFLICT DO UPDATE RETURNING`.
 * Это не украшение: читать счётчик, прибавлять единицу и записывать обратно
 * тремя действиями — значит выдать двум одновременным созданиям один номер.
 * `ON CONFLICT DO UPDATE` берёт блокировку строки счётчика, и второй запрос
 * ждёт первого. Проверка на это есть в `documents-numbering.e2e.spec.ts`:
 * пять одновременных выдач дают пять разных номеров.
 *
 * Вызывать только внутри транзакции создания документа: откатилась вставка —
 * откатился и счётчик, дырки в нумерации не остаётся.
 */
@Injectable()
export class NumberingService {
  /**
   * Занять следующий номер.
   *
   * Если собранный номер уже занят — такое возможно после правки маски, —
   * счётчик двигается дальше, а не падает. Предел на попытки есть: молча
   * крутиться, пока не найдётся дырка, хуже, чем сказать вслух.
   */
  async issue(
    tx: Tx,
    type: { id: bigint; companyId: bigint; code: string; mask: string; scope: 'company' | 'company_period' },
    company: { code: string },
    date: Date,
  ): Promise<string> {
    const key = periodKey(type.mask, type.scope, date);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await tx.$queryRawUnsafe<{ last_number: number }[]>(
        `INSERT INTO document_counter (company_id, document_type_id, period_key, last_number)
              VALUES ($1, $2, $3, 1)
         ON CONFLICT (company_id, document_type_id, period_key)
         DO UPDATE SET last_number = document_counter.last_number + 1
           RETURNING last_number`,
        type.companyId,
        type.id,
        key,
      );
      const seq = Number(rows[0]!.last_number);
      const number = renderNumber(type.mask, seq, {
        date,
        typeCode: type.code,
        companyCode: company.code,
      });

      const taken = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM document
          WHERE company_id = $1 AND document_type_id = $2 AND number = $3`,
        type.companyId,
        type.id,
        number,
      );
      if (Number(taken[0]?.n ?? 0) === 0) return number;
    }

    throw new ConflictException(say(
      'Не удалось подобрать свободный номер: двадцать подряд уже заняты. ' +
        'Скорее всего, маска после правки повторяет уже выданные номера', 'Bo‘sh raqam topilmadi: ketma-ket yigirmasi band. ' + 'Ehtimol, tahrirdan keyin maska allaqachon berilgan raqamlarni takrorlaydi'));
  }

  /** Каким будет следующий номер, не занимая его. Для показа в справочнике. */
  async peek(
    tx: Tx,
    type: { id: bigint; companyId: bigint; code: string; mask: string; scope: 'company' | 'company_period' },
    company: { code: string },
    date: Date,
  ): Promise<string> {
    const key = periodKey(type.mask, type.scope, date);
    const rows = await tx.$queryRawUnsafe<{ last_number: number }[]>(
      `SELECT last_number FROM document_counter
        WHERE company_id = $1 AND document_type_id = $2 AND period_key = $3`,
      type.companyId,
      type.id,
      key,
    );
    const seq = Number(rows[0]?.last_number ?? 0) + 1;
    return renderNumber(type.mask, seq, {
      date,
      typeCode: type.code,
      companyCode: company.code,
    });
  }
}
