import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import { useAnchoredMenu } from './useAnchoredMenu';
import { useApp } from '../../context/AppContext';
import { monthNames, weekdayNames } from '../../lib/formatters';

interface CustomDatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  minDate?: string;
  maxDate?: string;
  placeholder?: string;
  className?: string;
  /** Календарь рисуется поверх страницы: в прокручиваемой панели его обрежет. */
  portal?: boolean;
  /** Подпись для доступности: рядом с полем стоит `span`, а не `label`. */
  ariaLabel?: string;
}

/** Ширина календаря из вёрстки (`w-72`): её же занимает панель поверх страницы. */
const CALENDAR_WIDTH = 288;



function formatDateDisplay(isoStr: string, isUz: boolean): string {
  if (!isoStr) return '';
  const parts = isoStr.split('-');
  if (parts.length !== 3) return isoStr;
  const [year, month, day] = parts;
  const mIdx = parseInt(month, 10) - 1;
  const monthName = monthNames(isUz ? 'uz' : 'ru')[mIdx];
  if (!monthName) return `${day}.${month}.${year}`;
  return `${parseInt(day, 10)} ${monthName.slice(0, 3).toLowerCase()} ${year}`;
}

export function CustomDatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  placeholder,
  className = '',
  portal = false,
  ariaLabel,
}: CustomDatePickerProps) {
  // Язык берётся из контекста, а не из свойства: свойство забывали в
  // одиннадцати из двадцати одного места вызова, и календарь в документах,
  // отчётах и складских формах рисовался по-русски на узбекском экране.
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = useAnchoredMenu(isOpen && portal, triggerRef, 360, CALENDAR_WIDTH);

  // Parse current date or fallback to today
  const selectedDate = useMemo(() => {
    if (!value) return null;
    const parts = value.split('-').map(Number);
    if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    return null;
  }, [value]);

  const [viewYear, setViewYear] = useState<number>(() => {
    if (selectedDate) return selectedDate.getFullYear();
    return new Date().getFullYear();
  });

  const [viewMonth, setViewMonth] = useState<number>(() => {
    if (selectedDate) return selectedDate.getMonth();
    return new Date().getMonth();
  });

  // Sync view when opened with a selected date
  useEffect(() => {
    if (isOpen && selectedDate) {
      setViewYear(selectedDate.getFullYear());
      setViewMonth(selectedDate.getMonth());
    }
  }, [isOpen, selectedDate]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside = containerRef.current?.contains(target) || menuRef.current?.contains(target);
      if (!inside) setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    // Место календарю посчитано один раз - при прокрутке он бы уехал от поля.
    //
    // Прокрутка внутри самого календаря - исключение. На 360 поле стоит низко,
    // календарю остаётся полоска высоты, и нижние недели видно только его
    // собственной прокруткой. Закрывать по ней значит не давать выбрать конец
    // месяца вовсе.
    //
    // И первые полсекунды прокрутку не слушаем - как в списке: на узком экране
    // браузер доводит поле до видимой области уже после нажатия, и этот
    // доводочный скролл захлопывал календарь в момент открытия.
    const openedAt = Date.now();
    const close = (e: Event) => {
      if (Date.now() - openedAt < 500) return;
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setIsOpen(false);
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
      if (portal) window.addEventListener('scroll', close, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [isOpen, portal]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Generate calendar days
  const calendarCells = useMemo(() => {
    const firstDayOfMonth = new Date(viewYear, viewMonth, 1);
    const lastDayOfMonth = new Date(viewYear, viewMonth + 1, 0);

    // Monday as 0, Sunday as 6
    let startingDay = firstDayOfMonth.getDay() - 1;
    if (startingDay < 0) startingDay = 6;

    const daysInMonth = lastDayOfMonth.getDate();
    const prevMonthLastDay = new Date(viewYear, viewMonth, 0).getDate();

    const cells: Array<{
      dateStr: string;
      dayNumber: number;
      isCurrentMonth: boolean;
      isToday: boolean;
      isSelected: boolean;
      isDisabled: boolean;
    }> = [];

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`;

    // Previous month padding
    for (let i = startingDay - 1; i >= 0; i--) {
      const dayNum = prevMonthLastDay - i;
      const m = viewMonth === 0 ? 12 : viewMonth;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      cells.push({
        dateStr,
        dayNumber: dayNum,
        isCurrentMonth: false,
        isToday: dateStr === todayStr,
        isSelected: dateStr === value,
        isDisabled: Boolean((minDate && dateStr < minDate) || (maxDate && dateStr > maxDate)),
      });
    }

    // Current month days
    for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      cells.push({
        dateStr,
        dayNumber: dayNum,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        isSelected: dateStr === value,
        isDisabled: Boolean((minDate && dateStr < minDate) || (maxDate && dateStr > maxDate)),
      });
    }

    // Next month padding to fill 35 or 42 cells
    const remaining = (7 - (cells.length % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      const m = viewMonth === 11 ? 1 : viewMonth + 2;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      cells.push({
        dateStr,
        dayNumber: i,
        isCurrentMonth: false,
        isToday: dateStr === todayStr,
        isSelected: dateStr === value,
        isDisabled: Boolean((minDate && dateStr < minDate) || (maxDate && dateStr > maxDate)),
      });
    }

    return cells;
  }, [viewYear, viewMonth, value, minDate, maxDate]);

  const selectDate = (dateStr: string) => {
    onChange(dateStr);
    setIsOpen(false);
  };

  const applyOffsetDays = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    selectDate(dateStr);
  };

  const monthLabel = monthNames(isUz ? 'uz' : 'ru')[viewMonth];
  const weekdays = weekdayNames(isUz ? 'uz' : 'ru');

  const calendar = (
    <div
      ref={menuRef}
      style={portal ? anchor.style : undefined}
      className={
        portal
          ? 'z-[70] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-3 shadow-2xl'
          : 'absolute right-0 sm:right-auto sm:left-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-3 shadow-2xl backdrop-blur-md'
      }
    >
          {/* Header Month/Year & Navigation */}
          <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-zinc-100 dark:border-zinc-800/80">
            <button
              type="button"
              onClick={prevMonth}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <ChevronLeft size={15} />
            </button>
            <div className="font-semibold text-xs text-zinc-950 dark:text-zinc-50 font-mono">
              {monthLabel} {viewYear}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <ChevronRight size={15} />
            </button>
          </div>

          {/* Quick Presets */}
          <div className="grid grid-cols-4 gap-1 mb-2.5">
            <button
              type="button"
              onClick={() => applyOffsetDays(0)}
              className="py-1 px-1.5 rounded-md text-[10px] font-mono text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-center transition-colors cursor-pointer border border-zinc-100 dark:border-zinc-800/60"
            >
              {isUz ? 'Bugun' : 'Сегодня'}
            </button>
            <button
              type="button"
              onClick={() => applyOffsetDays(3)}
              className="py-1 px-1.5 rounded-md text-[10px] font-mono text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-center transition-colors cursor-pointer border border-zinc-100 dark:border-zinc-800/60"
            >
              +3 {isUz ? 'kun' : 'дня'}
            </button>
            <button
              type="button"
              onClick={() => applyOffsetDays(7)}
              className="py-1 px-1.5 rounded-md text-[10px] font-mono text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-center transition-colors cursor-pointer border border-zinc-100 dark:border-zinc-800/60"
            >
              +7 {isUz ? 'kun' : 'дней'}
            </button>
            <button
              type="button"
              onClick={() => applyOffsetDays(14)}
              className="py-1 px-1.5 rounded-md text-[10px] font-mono text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-center transition-colors cursor-pointer border border-zinc-100 dark:border-zinc-800/60"
            >
              +14 {isUz ? 'kun' : 'дн.'}
            </button>
          </div>

          {/* Day of Week Headers */}
          <div className="grid grid-cols-7 gap-1 text-center mb-1">
            {weekdays.map((wd, i) => (
              <span
                key={i}
                className="text-[10px] font-mono font-medium text-zinc-400 dark:text-zinc-500 py-0.5"
              >
                {wd}
              </span>
            ))}
          </div>

          {/* Calendar Day Grid */}
          <div className="grid grid-cols-7 gap-1 text-center">
            {calendarCells.map((cell, idx) => {
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={cell.isDisabled}
                  onClick={() => selectDate(cell.dateStr)}
                  className={`h-7 rounded-md text-xs font-mono transition-colors flex items-center justify-center relative cursor-pointer ${
                    cell.isDisabled
                      ? 'opacity-25 cursor-not-allowed text-zinc-400'
                      : cell.isSelected
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 font-bold shadow-2xs'
                      : cell.isCurrentMonth
                      ? 'text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                      : 'text-zinc-400 dark:text-zinc-600 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/50'
                  }`}
                >
                  <span>{cell.dayNumber}</span>
                  {cell.isToday && !cell.isSelected && (
                    <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-zinc-950 dark:bg-zinc-100" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Selected Date Summary & Clear */}
          <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-[11px] font-mono">
            <span className="text-zinc-400">
              {value ? formatDateDisplay(value, isUz) : isUz ? 'Tanlanmagan' : 'Не выбрано'}
            </span>
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                }}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <X size={11} />
                <span>{isUz ? 'Tozalash' : 'Сброс'}</span>
              </button>
            )}
          </div>
    </div>
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-mono text-xs cursor-pointer shadow-2xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors flex items-center justify-between text-left focus:outline-hidden"
      >
        <div className="flex items-center gap-2 truncate">
          <CalendarIcon size={13} className="text-zinc-400 shrink-0" />
          <span className="truncate">
            {value ? (
              <span className="font-medium text-zinc-950 dark:text-zinc-50">
                {formatDateDisplay(value, isUz)}
              </span>
            ) : (
              <span className="text-zinc-400">
                {placeholder || (isUz ? 'Sanani tanlang' : 'Выберите дату')}
              </span>
            )}
          </span>
        </div>
        <ChevronDown
          size={14}
          className={`text-zinc-400 shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-zinc-700 dark:text-zinc-200' : ''
          }`}
        />
      </button>

      {/* Calendar Dropdown */}
      {isOpen && (portal ? createPortal(calendar, document.body) : calendar)}
    </div>
  );
}
