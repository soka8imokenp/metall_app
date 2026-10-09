import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Позиция для выпадающей панели, нарисованной поверх страницы.
 *
 * Зачем вообще выносить панель из своего блока: и форма операции, и карточка
 * живут в колонке с `overflow-y-auto`. Абсолютно спозиционированный список
 * такой блок обрезает по своему краю — человек видит две строки вместо
 * двенадцати и вторую полосу прокрутки внутри первой.
 *
 * Координаты считаются от окна (`position: fixed`), поэтому панель не зависит
 * от прокрутки предков. Обратная сторона: при прокрутке она уезжает от своего
 * поля, и за этим следит уже вызывающий — он закрывает список по `scroll`.
 */
export function useAnchoredMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuHeight: number,
  menuWidth?: number,
  /**
   * Нижняя граница ширины. Поле бывает узким — в форме операции счёт и
   * корреспондент стоят в два столбца, — и список по ширине поля обрезал бы
   * «Расчёты с поставщиками» до «Расчёты с по…». Выбирают по названию, так что
   * список имеет право быть шире своего поля.
   */
  minWidth = 0,
) {
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', top: -9999, left: -9999 });

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Шире экрана панель не делаем ни при каком minWidth: на 360 это был бы
      // список, уезжающий за правый край.
      const width = Math.min(Math.max(menuWidth ?? r.width, minWidth), window.innerWidth - 16);
      const gap = 6;

      // Снизу места нет — раскрываем вверх. Иначе список упрётся в нижний край
      // окна и покажет половину строк, хотя выше свободно.
      const below = window.innerHeight - r.bottom - gap;
      const above = r.top - gap;
      const up = below < Math.min(menuHeight, 160) && above > below;

      // Вправо панель тоже может не поместиться: на 360 поле шириной во весь
      // экран, а календарь фиксированной ширины шире поля.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));

      setStyle({
        position: 'fixed',
        left,
        width,
        maxHeight: Math.max(120, (up ? above : below) - 4),
        ...(up ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
      });
    };

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchorRef, menuHeight, menuWidth, minWidth]);

  return { style };
}
