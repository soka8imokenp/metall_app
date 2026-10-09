import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import type { AppModule } from '../context/AppContext';

/**
 * Подхватить находку из общего окна поиска.
 *
 * Раздел вызывает это один раз и передаёт, куда положить строку. Хук сам
 * проверяет, что находка адресована этому разделу (и, если указана вкладка, —
 * этой вкладке), и применяет её ровно один раз.
 *
 * Строку, а не идентификатор записи, намеренно: у разделов нет общего способа
 * открыть карточку по uid, а строка поиска есть у каждого списка. Выдача
 * сузится до одной-двух записей, и человек попадает туда же, но без восьми
 * разных способов открыть карточку.
 */
export function useSearchJump(
  module: AppModule,
  apply: (query: string) => void,
  view?: string,
): void {
  const { searchJump } = useApp();
  /**
   * Одну находку применяем ровно один раз. Гасить её в общем состоянии нельзя:
   * на раздел подписано несколько экранов (в CRM — клиенты и сделки), и первый
   * же подписчик оставил бы остальных ни с чем. А без защиты эффект вернул бы
   * строку обратно при каждой перерисовке и затёр бы то, что человек напечатал
   * после перехода.
   */
  const applied = useRef<unknown>(null);
  useEffect(() => {
    if (!searchJump || searchJump.module !== module) return;
    if (view !== undefined && searchJump.view !== view) return;
    if (applied.current === searchJump) return;
    applied.current = searchJump;
    apply(searchJump.query);
    // `apply` приходит стрелкой с места вызова и меняется каждую перерисовку;
    // ставить её в зависимости значит звать эффект без конца.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchJump, module, view]);
}
