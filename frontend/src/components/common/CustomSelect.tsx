import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search, X } from 'lucide-react';
import { useAnchoredMenu } from './useAnchoredMenu';

/**
 * Приведение к виду, по которому сравнивают.
 *
 * Типоразмер на экране пишут знаком умножения — «1020×10», — а набирают с
 * клавиатуры латинской «x» или русской «х»: знака × на раскладке нет. Без
 * сведения этих трёх знаков к одному поиск по размеру не находит ничего, и
 * это первое, что человек в таком списке набирает.
 */
const norm = (s: string) => s.toLowerCase().replace(/[×х]/g, 'x').replace(/ё/g, 'е');

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  sublabel?: string;
  badge?: string;
}

interface CustomSelectProps<T extends string = string> {
  value: T;
  onChange: (val: T) => void;
  options: CustomSelectOption<T>[];
  className?: string;
  size?: 'sm' | 'md';
  /**
   * Список рисуется поверх страницы, а не внутри своего блока.
   *
   * Нужно там, где селект стоит в прокручиваемой панели: `overflow-y-auto`
   * обрезает всё, что вылезло за её край, и раскрытый список превращается в
   * две видимые строки с собственной полосой прокрутки внутри чужой.
   */
  portal?: boolean;
  /** Подпись для доступности: рядом с полем стоит `span`, а не `label`. */
  ariaLabel?: string;
  /**
   * Поиск внутри раскрытого списка и названия целиком, без обрезки.
   *
   * Включается там, где список длинный, а строки в нём похожи: номенклатура
   * труб — это триста позиций, различающихся последними знаками названия
   * («…, 09Г2С, ГОСТ 20295-85» против «…, 17Г1с-у, ГОСТ 20295-85»). Обрезанная
   * строка отличает такую позицию от соседней ровно тем куском, который и
   * обрезан, — выбрать по ней нельзя.
   *
   * Остальным спискам это не нужно: семь типов операции или четыре склада
   * ищутся глазами быстрее, чем набирается запрос, а лишнее поле ввода там
   * только мешает.
   */
  searchable?: boolean;
  /** Подсказка в поле поиска. Переводы живут у вызывающего. */
  searchPlaceholder?: string;
  /** Что написать, когда поиск не нашёл ничего. */
  searchEmptyText?: string;
  /**
   * Отдельное окно посреди страницы вместо списка, пришитого к полю.
   *
   * Список, привязанный к полю, ограничен местом под ним: на узком экране это
   * полтора пункта, в прокручиваемой панели — он ещё и уезжает вместе с ней,
   * а длинное название приходится переносить в три строки на малой ширине.
   * Окно по центру свободно от поля: ширину и высоту ему задаёт экран, а не
   * соседняя разметка. Включается там, где выбирают из сотен похожих строк.
   *
   * По умолчанию совпадает с `searchable`: окно нужно ровно тем спискам, в
   * которых уже понадобился поиск. Короткому списку окно — лишний заслон.
   */
  modal?: boolean;
  /** Заголовок окна. Без него берётся `ariaLabel`. */
  modalTitle?: string;
  /** Подпись кнопки закрытия окна. */
  closeLabel?: string;
}

export function CustomSelect<T extends string = string>({
  value,
  onChange,
  options,
  className = '',
  size = 'sm',
  portal = false,
  ariaLabel,
  searchable = false,
  searchPlaceholder = 'поиск',
  searchEmptyText = 'ничего не нашлось',
  modal,
  modalTitle,
  closeLabel = 'Закрыть',
}: CustomSelectProps<T>) {
  const asModal = modal ?? searchable;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Панель с поиском шире обычной: в ней название показано целиком, а оно
  // длиной в строку. Высоту тоже просим больше — иначе под поле поиска уйдёт
  // половина списка.
  // Окну по центру место считать не надо: его держит экран. Поэтому замер
  // позиции у поля включаем только для списка, пришитого к полю, — иначе он
  // зря слушает прокрутку и перерисовывает окно.
  const anchor = useAnchoredMenu(
    isOpen && portal && !asModal,
    triggerRef,
    searchable ? 320 : 224,
    undefined,
    searchable ? 420 : 240,
  );

  // Запрос живёт только внутри раскрытой панели: открыл заново — список
  // целиком. Иначе человек возвращается к полю и видит три позиции из трёхсот,
  // не помня, что сам же их отфильтровал.
  useEffect(() => {
    if (!isOpen) setQuery('');
    else if (searchable) {
      // Фокус после отрисовки: до неё поля ещё нет в документе.
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen, searchable]);

  const shown = useMemo(() => {
    if (!searchable) return options;
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return options;
    // Слова ищем все и в любом порядке, по названию, коду и единице: «114
    // 09г2с» должно находить позицию так же, как «09г2с 114».
    return options.filter((opt) => {
      const hay = norm(`${opt.label} ${opt.sublabel ?? ''} ${opt.badge ?? ''}`);
      return words.every((w) => hay.includes(w));
    });
  }, [options, query, searchable]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        containerRef.current?.contains(target) || menuRef.current?.contains(target);
      if (!inside) setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    // Панель поверх страницы не едет вместе с полем: место ей посчитали один
    // раз. Прокрутили — закрываем, иначе список повиснет посреди экрана.
    //
    // Но первые полсекунды прокрутку не слушаем. На узком экране поле часто
    // стоит ниже сгиба, браузер доводит его до видимой области уже после
    // нажатия — и этот доводочный скролл захлопывал список ровно в момент
    // открытия. Со стороны это выглядело так, будто поле не нажимается.
    //
    // Прокрутку внутри самого списка не считаем: длинный список прокручивается
    // сам, и на узком экране до нижних строк иначе не добраться - список
    // закрывался от первого же движения по нему.
    const openedAt = Date.now();
    const close = (e: Event) => {
      if (Date.now() - openedAt < 500) return;
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setIsOpen(false);
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
      // Окно по центру от прокрутки не закрываем: оно ни к чему не пришито и
      // никуда не уедет, а страница под ним всё равно не прокручивается.
      if (portal && !asModal) window.addEventListener('scroll', close, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [isOpen, portal, asModal]);

  // Пока окно открыто, страница под ним не ездит. Без этого колесо мыши над
  // затемнением прокручивает список операций позади, и, закрыв окно, человек
  // оказывается в другом месте страницы.
  useEffect(() => {
    if (!isOpen || !asModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen, asModal]);

  const selected = options.find((opt) => opt.value === value) || options[0];

  const heightCls = size === 'sm' ? 'h-8 text-xs' : 'h-9 text-xs';

  const searchInput = searchable && (
    <div className="relative">
      <Search
        size={13}
        className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
      />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter по первой найденной: типовой путь здесь — набрать размер и
          // согласиться, не трогая мышь.
          if (e.key === 'Enter' && shown.length) {
            e.preventDefault();
            onChange(shown[0].value);
            setIsOpen(false);
          }
        }}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        className={`w-full ${asModal ? 'h-8' : 'h-7'} pl-7 pr-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-hidden focus:border-zinc-400 dark:focus:border-zinc-500`}
      />
    </div>
  );

  // Поле поиска не уезжает вместе со списком: прокрутка идёт в строках, а
  // шапка стоит. Иначе, пролистав до середины трёхсот строк, запрос уже не
  // поправить — надо прокручивать обратно наверх.
  const search =
    searchable && (
      <div className="sticky top-0 z-10 -m-1 mb-1 p-1.5 bg-white dark:bg-[#18181b] border-b border-zinc-100 dark:border-zinc-800">
        {searchInput}
      </div>
    );

  const rows = (
    <>
          {searchable && shown.length === 0 && (
            <div className="px-2.5 py-3 text-center text-[11px] text-zinc-400">
              {searchEmptyText}
            </div>
          )}
          {shown.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                // Контейнер объявлен listbox, значит строки обязаны быть
                // option: иначе скринридер читает пустой список, а выбранное
                // значение не озвучивается вовсе.
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                className={`w-full flex ${searchable ? 'items-start' : 'items-center'} justify-between px-2.5 py-1.5 rounded-md text-left transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 font-medium'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                }`}
              >
                {/* В списке с поиском название показано целиком и переносится
                    по словам: у номенклатуры позицию от соседней отличает как
                    раз хвост названия, и обрезка делает выбор наугад. В
                    остальных списках строки короткие — там обрезка уместна,
                    она держит высоту панели. */}
                <div className={`mr-2 min-w-0 ${searchable ? '' : 'truncate'}`}>
                  <div
                    data-full-name
                    className={`font-medium ${searchable ? 'whitespace-normal break-words' : 'truncate'}`}
                  >
                    {opt.label}
                  </div>
                  {opt.sublabel && (
                    <div
                      className={`text-[10px] text-zinc-400 font-normal font-mono ${
                        searchable ? 'whitespace-normal break-all' : 'truncate'
                      }`}
                    >
                      {opt.sublabel}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {opt.badge && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 font-mono">
                      {opt.badge}
                    </span>
                  )}
                  {isSelected && (
                    <Check size={13} className="shrink-0 text-zinc-900 dark:text-zinc-100" />
                  )}
                </div>
              </button>
            );
          })}
    </>
  );

  const menu = (
    <div
      ref={menuRef}
      role="listbox"
      style={portal ? anchor.style : undefined}
      className={
        portal
          ? 'z-[70] max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-1 shadow-xl text-xs'
          : 'absolute left-0 right-0 top-full mt-1 z-50 max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-1 shadow-xl text-xs'
      }
    >
      {search}
      {rows}
    </div>
  );

  // Окно посреди страницы. Затемнение занимает весь экран и центрирует окно
  // само — через flex, а не подогнанными отступами: иначе окно сползает на
  // любой другой высоте экрана.
  const dialog = (
    <div
      data-select-overlay
      // Нажатие по затемнению закрывает окно. Обработчик стоит на самом
      // затемнении, а не на всём документе: так нажатие внутри окна сюда
      // просто не доходит.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setIsOpen(false);
      }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/45 dark:bg-black/60"
    >
      <div
        ref={menuRef}
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle || ariaLabel}
        // Высота — доля экрана, а не число пикселей: на 360 и на 1440 под
        // окно остаётся разное место, а список всё равно прокручивается сам.
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] shadow-2xl text-xs overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800">
          <div className="min-w-0 truncate text-[13px] font-medium text-zinc-950 dark:text-zinc-50">
            {modalTitle || ariaLabel}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setIsOpen(false)}
            className="shrink-0 p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>
        {searchable && <div className="px-3 pt-2.5 pb-1">{searchInput}</div>}
        {/* Прокручивается только список, шапка с поиском стоит. */}
        <div role="listbox" className="flex-1 overflow-y-auto p-1.5">
          {rows}
        </div>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        // В самом поле название всё равно обрезано по ширине колонки: место
        // там одна строка. Полное — в подсказке и в раскрытой панели.
        title={selected?.label || undefined}
        aria-haspopup={asModal ? 'dialog' : 'listbox'}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className={`w-full ${heightCls} flex items-center justify-between px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-950 dark:text-zinc-50 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors cursor-pointer text-left focus:outline-hidden shadow-2xs`}
      >
        <span className="truncate pr-1 font-normal">{selected?.label || ''}</span>
        <ChevronDown
          size={14}
          className={`text-zinc-400 shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-zinc-700 dark:text-zinc-200' : ''
          }`}
        />
      </button>

      {/* Окно всегда рисуется в конце документа: внутри своей разметки его
          обрезал бы любой родитель с `overflow`, а затемнение растянулось бы
          по панели, а не по экрану. */}
      {isOpen &&
        (asModal
          ? createPortal(dialog, document.body)
          : portal
            ? createPortal(menu, document.body)
            : menu)}
    </div>
  );
}
