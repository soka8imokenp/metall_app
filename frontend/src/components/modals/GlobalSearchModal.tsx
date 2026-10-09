import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Search,
  LayoutDashboard,
  ShoppingBag,
  Warehouse,
  Factory,
  CreditCard,
  FileText,
  Users,
  Settings,
  Loader2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { AppModule } from '../../context/AppContext';
import { apiClient } from '../../lib/api-client';
import type { SearchGroup } from '../../types/api';

/**
 * Поиск по всей системе.
 *
 * Раньше окно искало только названия разделов, то есть повторяло меню, которое
 * и так на экране. Теперь оно спрашивает сервер (`GET /search`) и показывает
 * сами записи: номенклатуру, контрагентов, заказы, партии, документы, сделки,
 * склады, сотрудников. Разделы остались первой группой — по ним переходят чаще
 * всего, и они находятся без запроса, пока ответ ещё едет.
 *
 * Что человеку не положено по правам, сервер не присылает вовсе: прятать
 * группы на экране не нужно и нельзя — спрятанное всё равно приехало бы в
 * браузер.
 */

/** Раздел — это тоже результат поиска, просто найденный на месте. */
const SECTIONS: { id: AppModule; icon: React.ElementType }[] = [
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'sales', icon: ShoppingBag },
  { id: 'warehouse', icon: Warehouse },
  { id: 'production', icon: Factory },
  { id: 'finance', icon: CreditCard },
  { id: 'documents', icon: FileText },
  { id: 'crm', icon: Users },
  { id: 'admin', icon: Settings },
];

const ICON_BY_MODULE: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard,
  sales: ShoppingBag,
  warehouse: Warehouse,
  production: Factory,
  finance: CreditCard,
  documents: FileText,
  crm: Users,
  admin: Settings,
};

/** Нижняя граница запроса на сервер — та же, что у маршрута. */
const MIN_QUERY = 2;

export const GlobalSearchModal: React.FC = () => {
  const { isSearchOpen, setIsSearchOpen, setActiveModule, jumpToSearch, locale, t } = useApp();
  const isUz = locale === 'uz';
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  /** Отказ сервера показываем словами: молчащее окно читается как «ничего нет». */
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(0);

  const needle = query.trim();

  useEffect(() => {
    if (!isSearchOpen) {
      setQuery('');
      setGroups([]);
      setFailed(false);
      setCursor(0);
    }
  }, [isSearchOpen]);

  useEffect(() => {
    if (needle.length < MIN_QUERY) {
      setGroups([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    // Запрос откладывается: иначе каждая буква поднимает девять таблиц.
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      apiClient.search
        .find(needle, 5)
        .then((res) => {
          if (!alive) return;
          setGroups(res.data.groups);
          setFailed(false);
        })
        .catch(() => {
          if (!alive) return;
          setGroups([]);
          setFailed(true);
        })
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [needle]);

  /** Разделы, подходящие под строку: ищутся на месте, ответа не ждут. */
  const sections = useMemo(() => {
    const low = needle.toLowerCase();
    return SECTIONS.map((s) => ({ ...s, label: t(`nav.${s.id}`) })).filter(
      (s) => !low || s.label.toLowerCase().includes(low),
    );
  }, [needle, t]);

  /**
   * Плоский список всего, что можно выбрать клавишами. Собирается из тех же
   * данных, что и разметка, — иначе стрелка и ↵ однажды уедут на другую
   * строку, чем подсвечена.
   */
  const flat = useMemo(() => {
    const out: { key: string; go: () => void }[] = [];
    for (const s of sections) {
      out.push({ key: `section:${s.id}`, go: () => setActiveModule(s.id) });
    }
    for (const g of groups) {
      for (const r of g.rows) {
        out.push({
          key: `${g.kind}:${r.uid}`,
          // В раздел идём с той строкой, по которой запись нашлась: список
          // раздела сузится до неё же.
          go: () =>
            jumpToSearch({ module: g.module as AppModule, view: g.view, query: r.title }),
        });
      }
    }
    return out;
  }, [sections, groups, setActiveModule, jumpToSearch]);

  useEffect(() => setCursor(0), [needle, groups.length]);

  if (!isSearchOpen) return null;

  const choose = (index: number) => {
    const target = flat[index];
    if (!target) return;
    target.go();
    setIsSearchOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setIsSearchOpen(false);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0)));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
    if (e.key === 'Enter') choose(cursor);
  };

  const rowClass = (index: number) =>
    `w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between gap-3 group ${
      index === cursor
        ? 'bg-zinc-100 dark:bg-zinc-800'
        : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
    }`;

  let index = -1;
  const nothing =
    !loading && !failed && sections.length === 0 && groups.length === 0 && needle.length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-start justify-center pt-20 p-4">
      <div className="w-full max-w-xl rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] shadow-2xl overflow-hidden flex flex-col text-xs">
        {/* Строка ввода */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <Search size={16} className="text-zinc-400 shrink-0" />
          <input
            type="text"
            autoFocus
            aria-label={isUz ? 'Tizim bo‘ylab qidiruv' : 'Поиск по системе'}
            placeholder={
              isUz
                ? 'Mahsulot, mijoz, buyurtma, hujjat…'
                : 'Товар, клиент, заказ, документ…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="w-full bg-transparent text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-hidden"
          />
          {loading && <Loader2 size={14} className="text-zinc-400 animate-spin shrink-0" />}
          <button
            onClick={() => setIsSearchOpen(false)}
            aria-label={isUz ? 'Yopish' : 'Закрыть'}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 shrink-0"
          >
            <X size={15} />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2 flex flex-col gap-1">
          {/* Чем это окно отличается от прежнего — должно быть видно до того,
              как человек начнёт печатать. Иначе сверху список разделов, и новая
              панель от старой (искавшей только по меню) неотличима: её
              закрывают, не начав вводить, и считают, что ничего не изменилось. */}
          {needle.length === 0 && (
            <div className="px-3 pt-1 pb-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {isUz
                ? 'Mahsulot, mijoz, sotuv va sex buyurtmasi, partiya, hujjat, bitim, ombor va xodim bo‘yicha qidiradi. Nom yoki raqamning bir qismini kiriting.'
                : 'Ищет по товарам, клиентам, заказам продаж и цеха, партиям, документам, сделкам, складам и сотрудникам. Введите кусок названия или номера.'}
            </div>
          )}

          {/* Разделы */}
          {sections.length > 0 && (
            <>
              <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {isUz ? 'Bo‘limlar' : 'Разделы'}
              </div>
              {sections.map((s) => {
                const Icon = s.icon;
                index += 1;
                const own = index;
                return (
                  <button
                    key={s.id}
                    onClick={() => choose(own)}
                    onMouseEnter={() => setCursor(own)}
                    className={rowClass(own)}
                  >
                    <span className="flex items-center gap-2 truncate text-zinc-800 dark:text-zinc-200">
                      <Icon size={13} className="text-zinc-400 shrink-0" />
                      {s.label}
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                      {isUz ? 'Ochish ↵' : 'Открыть ↵'}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {/* Данные */}
          {groups.map((g) => {
            const Icon = ICON_BY_MODULE[g.module] ?? Search;
            return (
              <React.Fragment key={g.kind}>
                <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                  {g.title}
                </div>
                {g.rows.map((r) => {
                  index += 1;
                  const own = index;
                  return (
                    <button
                      key={`${g.kind}:${r.uid}`}
                      onClick={() => choose(own)}
                      onMouseEnter={() => setCursor(own)}
                      className={rowClass(own)}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Icon size={13} className="text-zinc-400 shrink-0" />
                        <span className="truncate text-zinc-800 dark:text-zinc-200">{r.title}</span>
                      </span>
                      {r.subtitle && (
                        <span className="text-[10px] text-zinc-400 font-mono truncate max-w-[40%] shrink-0">
                          {r.subtitle}
                        </span>
                      )}
                    </button>
                  );
                })}
              </React.Fragment>
            );
          })}

          {needle.length > 0 && needle.length < MIN_QUERY && (
            <div className="py-6 text-center text-zinc-400">
              {isUz ? 'Kamida ikki belgi kiriting' : 'Введите хотя бы два знака'}
            </div>
          )}
          {failed && (
            <div className="py-6 text-center text-zinc-400">
              {isUz ? 'Qidiruv javob bermadi' : 'Поиск не ответил'}
            </div>
          )}
          {nothing && (
            // Голое «ничего не нашлось» читается как «поиск не работает».
            // Поэтому говорим и сам запрос, и где именно искали: тогда видно,
            // что искали по данным, а не по названиям разделов.
            <div className="py-6 px-3 text-center flex flex-col gap-1.5">
              <div className="text-zinc-500 dark:text-zinc-400">
                {isUz ? `«${needle}» topilmadi` : `По запросу «${needle}» ничего не нашлось`}
              </div>
              <div className="text-[11px] leading-relaxed text-zinc-400">
                {isUz
                  ? 'Mahsulot, mijoz, sotuv va sex buyurtmasi, partiya, hujjat, bitim, ombor va xodim bo‘yicha qidirildi.'
                  : 'Искали по товарам, клиентам, заказам продаж и цеха, партиям, документам, сделкам, складам и сотрудникам.'}
              </div>
            </div>
          )}
        </div>

        {/* Подсказка по клавишам */}
        <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
          <span>{isUz ? 'Tanlash: ↵' : 'Выбор: ↵'}</span>
          <span>{isUz ? 'Ko‘chish: ↑↓' : 'Переход: ↑↓'}</span>
          <span>{isUz ? 'Yopish: Esc' : 'Закрыть: Esc'}</span>
        </div>
      </div>
    </div>
  );
};
