import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronsUpDown,
  Check,
  LayoutDashboard,
  ShoppingBag,
  Warehouse,
  Factory,
  CreditCard,
  FileText,
  Users,
  Settings,
  Search,
  BookOpen,
  LogOut,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { CompanyId } from '../../types/api';
import type { AppModule } from '../../context/AppContext';
import { availableCompanyKeys } from '../../lib/companies';
import { moduleAllowed } from '../../lib/modules';
import { APP_VERSION } from '../../lib/app-version';
import brandGlyph from '../../assets/brand/metall-asia-glyph.png';
import brandWordmark from '../../assets/brand/metall-asia-wordmark-white.png';

/** Инициалы из ФИО: «Азиз Саидов» → «АС». Пустое имя — логотип компании. */
function initials(fullName?: string): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'M';
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export const Sidebar: React.FC = () => {
  const {
    activeModule,
    setActiveModule,
    isSidebarCollapsed,
    setIsSearchOpen,
    openHelp,
    company,
    setCompany,
    t,
  } = useApp();
  const { session, logout, can } = useAuth();

  const [isCompanyDropdownOpen, setIsCompanyDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const collapsed = isSidebarCollapsed;

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsCompanyDropdownOpen(false);
      }
    };
    if (isCompanyDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isCompanyDropdownOpen]);

  const LABELS: Record<CompanyId, { title: string; shortName: string; subtitle: string }> = {
    company_trade: {
      title: t('company.trade'),
      shortName: t('company.trade_short'),
      subtitle: t('company.trade_sub'),
    },
    company_factory: {
      title: t('company.factory'),
      shortName: t('company.factory_short'),
      subtitle: t('company.factory_sub'),
    },
    all: {
      title: t('company.all'),
      shortName: t('company.all_short'),
      subtitle: t('company.all_sub'),
    },
  };

  // В списке ровно те компании, что дала сессия: показать чужую — значит
  // назвать в шапке одно, а показать под ней данные другой.
  const companies: Array<{
    id: CompanyId;
    title: string;
    subtitle: string;
    shortName: string;
  }> = availableCompanyKeys(session?.companies ?? []).map((id) => ({ id, ...LABELS[id] }));

  const currentCompany = companies.find((c) => c.id === company) ?? companies[0] ?? LABELS.all;

  /**
   * Список компаний одинаков в обоих состояниях сайдбара. Раньше он был только
   * в развёрнутом: на узком экране значок открывал переключатель, которого нет
   * в разметке, и сменить компанию было нельзя вовсе.
   */
  const companyList = (
    <div className="flex flex-col gap-0.5">
      {companies.map((comp) => {
        const isSelected = comp.id === company;
        return (
          <button
            key={comp.id}
            // Признак для прогона: список компаний — единственное, что отличает
            // одного собственника от другого, и проверять его надо по разметке,
            // а не по картинке (`qa/roles-live`).
            data-company-option={comp.id}
            onClick={() => {
              setCompany(comp.id);
              setIsCompanyDropdownOpen(false);
            }}
            className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
              isSelected
                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 font-medium'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <div className="flex flex-col min-w-0">
              <span className="text-xs truncate">{comp.title}</span>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                {comp.subtitle}
              </span>
            </div>
            {isSelected && (
              <Check size={14} className="text-zinc-950 dark:text-zinc-50 stroke-[2.5] shrink-0 ml-2" />
            )}
          </button>
        );
      })}
    </div>
  );

  /*
    Меню собирается по правам (ТЗ 3.3).

    До 06.10 все семь разделов и «Настройки» рисовались любой роли: сервер
    отказывал, а экран показывал пустую таблицу и ошибку — выглядело как
    поломка, а не как «вам сюда нельзя». Теперь закрытого пункта в меню
    просто нет.

    Это оформление, а не ограничение доступа: спрятанный пункт никого не
    держит, адрес набирается руками. Доступ закрывает сервер, и проверено это
    там же — `backend/test/role-access.e2e.spec.ts`.
  */
  const allNavigationItems = [
    {
      id: 'dashboard',
      label: t('nav.dashboard'),
      icon: LayoutDashboard,
      action: () => setActiveModule('dashboard'),
    },
    {
      id: 'sales',
      label: t('nav.sales'),
      icon: ShoppingBag,
      action: () => setActiveModule('sales'),
    },
    {
      id: 'warehouse',
      label: t('nav.warehouse'),
      icon: Warehouse,
      action: () => setActiveModule('warehouse'),
    },
    {
      id: 'production',
      label: t('nav.production'),
      icon: Factory,
      action: () => setActiveModule('production'),
    },
    {
      id: 'finance',
      label: t('nav.finance'),
      icon: CreditCard,
      action: () => setActiveModule('finance'),
    },
    {
      id: 'documents',
      label: t('nav.documents'),
      icon: FileText,
      action: () => setActiveModule('documents'),
    },
    {
      id: 'crm',
      label: t('nav.crm'),
      icon: Users,
      action: () => setActiveModule('crm'),
    },
  ];

  const navigationItems = allNavigationItems.filter((item) =>
    moduleAllowed(item.id as AppModule, can),
  );
  const mayAdmin = moduleAllowed('admin', can);

  /**
   * Подпись строки. Ширину не схлопываем: текст уезжает под край панели и
   * гаснет, пока едет сама панель — иначе он пропадал бы рывком в первый кадр.
   */
  const label = (text: string) => (
    <span
      className={`ml-2.5 whitespace-nowrap transition-opacity duration-200 ${
        collapsed ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {text}
    </span>
  );

  /**
   * Иконка живёт в коробке 16 точек на отступе 8 от края панели: вместе с
   * `px-3` самой панели центр иконки приходится ровно на середину свёрнутой
   * полосы (12 + 8 + 8 = 28 из 56), и при сворачивании ряд не дёргается.
   */
  const glyphBox = (node: React.ReactNode) => (
    <span className="w-4 flex items-center justify-center shrink-0">{node}</span>
  );

  return (
    <aside
      className={`${
        collapsed ? 'w-14' : 'w-[240px]'
      } transition-[width] duration-300 ease-out bg-white dark:bg-[#09090b] flex flex-col justify-between shrink-0 select-none text-zinc-900 dark:text-zinc-100 text-[13px] h-screen sticky top-0 overflow-y-auto overflow-x-hidden px-3 py-3 border-r border-zinc-200 dark:border-zinc-800`}
    >
      <div className="flex flex-col gap-1">
        {/* Логотип и под ним выбор бизнеса. В свёрнутой полосе от логотипа
            остаётся красный квадрат, он же и открывает список компаний:
            строка с названием в 56 точек не помещается.

            Плашка живёт внутри отступов панели и со скруглением. В свёрнутом
            виде она чуть выходит за `px-3` (`-mx-1`, 40 точек из 56): ровно
            по `px-3` остаётся 32 точки, и знак туда целиком не влезает,
            а резать его нельзя. Поля по 4 точки с каждой стороны остаются.

            В развёрнутой панели плашка тоже шире отступов (`-mx-1`, 224 точки
            из 240): при ширине ровно по `px-3` знак и слово упирались в края
            красного прямоугольника — поле выходило 3 точки. Теперь поле ≈14,
            и это проверяется замером в `qa/sidebar-brand`.

            Высота плашки 44 точки, знак 16, слово 9 (решение Отабека от 06.10:
            «логотип слишком огромный»). До этого было 56/20/11. Пропорции те
            же, уменьшено всё вместе: знак отдельно ужимать нельзя — поля
            внутри плашки съедут. Нижний предел знака держит замер в
            `qa/sidebar-brand`.

            Свёрнутая полоса уменьшена тем же решением: квадрат 40 вместо 48,
            знак 11 вместо 14. Здесь всё упирается в ширину: знак 2,86:1, при
            высоте 14 он выходит 40 точек в ширину и в квадрат 40 влезает
            впритык. Поэтому квадрат и знак ужимаются только вместе. */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsCompanyDropdownOpen((prev) => !prev)}
            data-company-switch="logo"
            title={currentCompany.title}
            aria-label={currentCompany.title}
            className={`mb-2 rounded-xl overflow-hidden flex items-center justify-center shrink-0 cursor-pointer shadow-2xs bg-linear-to-br from-[#d12348] to-[#b31231] transition-all duration-300 ease-out ${
              collapsed ? '-mx-1 w-10 h-10' : '-mx-1 w-[calc(100%+0.5rem)] h-11'
            }`}
          >
            {/* Знак виден целиком в обоих состояниях: в развёрнутой шапке он
                идёт со словом «METALL ASIA», в свёрнутой полосе слово уходит,
                а знак садится до ширины полосы. Обрезать фирменный знак краем
                панели нельзя — он перестаёт быть знаком. */}
            <img
              src={brandGlyph}
              alt="METALL ASIA"
              className={`w-auto max-w-none shrink-0 transition-all duration-300 ease-out ${
                collapsed ? 'h-[11px]' : 'h-4'
              }`}
            />
            {/* Ширину слова задаём ровно одним классом: `w-auto` рядом с `w-0`
                даёт конфликт, и в свёрнутой полосе слово остаётся во всю свою
                ширину — знак при этом уезжает за край, панель выглядит пустой. */}
            <img
              src={brandWordmark}
              alt=""
              aria-hidden
              className={`h-[9px] max-w-none shrink-0 overflow-hidden transition-all duration-300 ease-out ${
                collapsed ? 'ml-0 w-0 opacity-0' : 'ml-2 w-auto opacity-100'
              }`}
            />
          </button>

          <button
            onClick={() => setIsCompanyDropdownOpen((prev) => !prev)}
            data-company-switch="label"
            tabIndex={collapsed ? -1 : 0}
            aria-hidden={collapsed}
            className={`w-full flex items-center justify-between rounded-lg text-left cursor-pointer group overflow-hidden transition-all duration-300 ease-out ${
              collapsed
                ? 'h-0 mt-0 py-0 opacity-0'
                : 'h-10 mt-1 px-2 py-1.5 opacity-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/70'
            }`}
          >
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="font-semibold text-xs text-zinc-950 dark:text-zinc-50 truncate">
                {currentCompany.shortName}
              </span>
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                {currentCompany.subtitle}
              </span>
            </div>

            <ChevronsUpDown
              size={14}
              className="text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200 shrink-0 ml-1"
            />
          </button>

          {/* Свёрнутой полосы под список не хватает — он выезжает вбок. */}
          {isCompanyDropdownOpen && (
            <div
              className={`absolute bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg p-1 z-50 text-xs animate-in fade-in-50 zoom-in-95 duration-100 ${
                collapsed ? 'left-full top-0 ml-2 w-60' : 'left-0 right-0 top-full mt-1'
              }`}
            >
              {companyList}
            </div>
          )}
        </div>

        {/* Clean Enterprise Module Navigation */}
        <nav className="flex flex-col gap-0.5 mt-2">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeModule === item.id;
            return (
              <button
                key={item.id}
                data-module={item.id}
                onClick={item.action}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center px-2 py-2 rounded-lg text-left transition-colors cursor-pointer text-xs ${
                  isActive
                    ? 'bg-zinc-100 dark:bg-zinc-800 font-medium text-zinc-950 dark:text-zinc-50 shadow-2xs'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 font-normal'
                }`}
              >
                {glyphBox(
                  <Icon
                    size={15}
                    className={
                      isActive
                        ? 'text-zinc-950 dark:text-zinc-100'
                        : 'text-zinc-500 dark:text-zinc-400'
                    }
                  />,
                )}
                {label(item.label)}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Footer Section: Search, Settings, User Profile */}
      <div className="flex flex-col gap-0.5 pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
        <button
          onClick={() => setIsSearchOpen(true)}
          title={collapsed ? t('nav.search') : undefined}
          className="w-full flex items-center px-2 py-1.5 rounded-lg text-left text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer text-xs"
        >
          {glyphBox(<Search size={15} className="text-zinc-400" />)}
          {label(t('nav.search'))}
        </button>

        {/* «Справка» — раздел с инструкциями внутри системы (задача Отабека
            от 07.10: отдельные PDF и Word заказчик принимать отказался).
            Стоит здесь, а не среди семи модулей: это не участок учёта, а то,
            куда идут, когда на участке что-то непонятно — рядом с поиском.
            Открыта любой вошедшей роли; какие статьи в ней видны, решают
            права (`help/access.ts`). Ключ подписи `nav.get_help` лежал в
            словаре с самого импорта фронта и до сих пор никуда не вёл. */}
        <button
          data-module="help"
          onClick={() => openHelp(null)}
          title={collapsed ? t('nav.get_help') : undefined}
          className={`w-full flex items-center px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer text-xs ${
            activeModule === 'help'
              ? 'bg-zinc-100 dark:bg-zinc-800 font-medium text-zinc-950 dark:text-zinc-50'
              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
          }`}
        >
          {glyphBox(<BookOpen size={15} className="text-zinc-400" />)}
          {label(t('nav.get_help'))}
        </button>

        {/* «Настройки» — название заказчика (02.10). Раздел тот же: люди,
            роли и журналы. Настройки учёта по-прежнему живут в справочниках
            своего модуля, и если их начнут искать здесь — говорить об этом
            заказчику, а не переименовывать обратно молча.
            Свёрнутой полосе эта кнопка нужна не меньше: на 360 панель
            сворачивается сама, и другого входа в доступы с телефона нет.

            Без прав на администрирование кнопки нет вовсе. Прежде она стояла
            у всех и открывала раздел с одной строкой «показывать здесь
            нечего» — честная строка, но собственник и кладовщик видели в меню
            вход, которого у них нет. */}
        {mayAdmin && (
          <button
            data-module="admin"
            onClick={() => setActiveModule('admin')}
            title={collapsed ? t('nav.admin') : undefined}
            className={`w-full flex items-center px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer text-xs ${
              activeModule === 'admin'
                ? 'bg-zinc-100 dark:bg-zinc-800 font-medium text-zinc-950 dark:text-zinc-50'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
            }`}
          >
            {glyphBox(<Settings size={15} className="text-zinc-400" />)}
            {label(t('nav.admin'))}
          </button>
        )}

        {/* Карточка пользователя: имя и логин из сессии, а не из разметки */}
        <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between px-0.5">
          <div className="flex items-center min-w-0">
            <div className="w-7 h-7 rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold flex items-center justify-center text-xs shrink-0">
              <span className="font-mono text-[11px]">{initials(session?.user.fullName)}</span>
            </div>
            <div
              className={`flex flex-col min-w-0 leading-tight ml-2.5 transition-opacity duration-200 ${
                collapsed ? 'opacity-0' : 'opacity-100'
              }`}
            >
              <span className="font-medium text-xs text-zinc-950 dark:text-zinc-50 truncate whitespace-nowrap">
                {session?.user.fullName || 'METALL ASIA'}
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate whitespace-nowrap">
                {session?.user.login || '—'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={logout}
            title={t('nav.logout')}
            aria-label={t('nav.logout')}
            tabIndex={collapsed ? -1 : 0}
            className={`text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-opacity duration-200 cursor-pointer shrink-0 ${
              collapsed ? 'opacity-0' : 'opacity-100'
            }`}
          >
            <LogOut size={14} />
          </button>
        </div>
        {/* Версия открытой сборки: по ней видно, та же она у заказчика или нет.
            Без неё спор «я выкатил» — «я не вижу» не разрешить. */}
        <div
          className={`px-2 pt-1 text-[10px] font-mono text-zinc-300 dark:text-zinc-600 truncate whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? 'opacity-0' : 'opacity-100'
          }`}
        >
          {`v ${APP_VERSION}`}
        </div>
      </div>
    </aside>
  );
};
