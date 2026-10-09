/**
 * METALL ASIA App State Context
 * Handles Theme, Company Switching (X-Company-Id), Language (ru/uz), and Active Module Navigation
 */

import React, { createContext, useContext, useState, useEffect } from 'react';
import { CompanyId } from '../types/api';
import { apiClient, setApiCompany, setApiLocale } from '../lib/api-client';
import { availableCompanyKeys } from '../lib/companies';
import { useAuth } from './AuthContext';

export type AppLocale = 'ru' | 'uz';
export type AppTheme = 'dark' | 'light';

export type AppModule = 
  | 'dashboard'
  | 'sales'
  | 'warehouse'
  | 'production'
  | 'finance'
  | 'documents'
  | 'crm'
  | 'admin'
  | 'help';

/** Куда вести по находке и что там искать. */
export interface SearchJump {
  module: AppModule;
  /** Вкладка внутри раздела; приходит с сервера вместе с группой. */
  view: string;
  query: string;
}

interface AppContextValue {
  theme: AppTheme;
  toggleTheme: () => void;
  company: CompanyId;
  setCompany: (comp: CompanyId) => void;
  locale: AppLocale;
  setLocale: (loc: AppLocale) => void;
  activeModule: AppModule;
  setActiveModule: (mod: AppModule) => void;
  isSidebarCollapsed: boolean;
  toggleSidebar: () => void;
  // Modals & Panels
  isCreateOrderModalOpen: boolean;
  setIsCreateOrderModalOpen: (open: boolean) => void;
  isSearchOpen: boolean;
  setIsSearchOpen: (open: boolean) => void;
  /**
   * Находка из окна поиска, которую ещё никто не забрал.
   *
   * Окно ищет по всем данным сразу, а открывать запись умеет сам раздел —
   * у каждого своя строка поиска и свой список. Поэтому окно не открывает
   * карточку, а кладёт сюда «иди в такой-то раздел и покажи вот это», и
   * раздел подставляет строку себе. Иначе окну пришлось бы знать внутреннее
   * устройство восьми разделов.
   */
  searchJump: SearchJump | null;
  jumpToSearch: (jump: SearchJump) => void;
  clearSearchJump: () => void;
  /**
   * Открытая статья справки; `null` — список статей.
   *
   * Живёт здесь, а не внутри раздела: в статью ведут три входа — пункт меню,
   * кнопка «?» в заголовке раздела и ссылка из другой статьи, — и все три
   * обязаны сначала переключить раздел. Местное состояние раздела при переходе
   * с другого экрана сбрасывалось бы, и «?» открывала бы список.
   */
  helpSlug: string | null;
  /** Открыть справку: со статьёй или на списке. */
  openHelp: (slug?: string | null) => void;
  // Localization helper
  t: (key: string) => string;
}

/** Граница узкого экрана — та же, что у Tailwind `sm`. */
const NARROW_WIDTH = 640;

const AppContext = createContext<AppContextValue | null>(null);

// Core translation dictionary
const DICTIONARY: Record<AppLocale, Record<string, string>> = {
  ru: {
    'brand.name': 'Acme Inc.',
    'brand.system': 'METALL ASIA ERP/MES',
    'quick.create': 'Быстро создать',
    'nav.dashboard': 'Дашборд',
    'nav.lifecycle': 'Жизненный цикл',
    'nav.analytics': 'Аналитика',
    'nav.projects': 'Проекты',
    'nav.team': 'Команда',
    'nav.documents_section': 'Документы',
    'nav.data_library': 'База данных',
    'nav.reports': 'Отчёты',
    'nav.word_assistant': 'Текстовый помощник',
    'nav.more': 'Ещё',
    'nav.settings': 'Настройки',
    'nav.logout': 'Выйти',
    'nav.toggleSidebar': 'Свернуть или развернуть боковую панель',
    // Одно слово во всех трёх местах: пункт меню, заголовок экрана, текст
    // статьи. Ключ лежал в словаре с самого импорта фронта и гласил «Помощь»,
    // а экран и все статьи говорят «Справка» — человек искал в меню то слово,
    // которое прочитал в инструкции, и не находил. Держит
    // `help-content.test.ts`.
    'nav.get_help': 'Справка',
    'help.module': 'Справка по этому разделу',
    'nav.search': 'Поиск',
    'theme.light': 'Включить светлую тему',
    'theme.dark': 'Включить тёмную тему',
    'nav.sales': 'Продажи',
    'nav.warehouse': 'Склад',
    'nav.production': 'Производство',
    'nav.finance': 'Финансы',
    'nav.documents': 'Документы',
    'nav.crm': 'CRM',
    'nav.admin': 'Настройки',
    // Названия юрлиц со встречи 07.10: опт - ООО «Металл Азия», завод - ООО
    // «Ташкентский изоляционный завод» (ТИЗ). Короткое имя стоит в свёрнутом
    // сайдбаре, поэтому оно и короткое: «ТИЗ», а не название целиком.
    'company.trade': 'ООО «Металл Азия»',
    'company.trade_short': 'Металл Азия',
    'company.trade_sub': 'Торговый дом и сбыт',
    'company.factory': 'ООО «Ташкентский изоляционный завод»',
    'company.factory_short': 'ТИЗ',
    'company.factory_sub': 'Трубный завод ППУ',
    'company.all': 'Обе компании',
    'company.all_short': 'Обе',
    'company.all_sub': 'Сводный доступ по двум юрлицам',
    'kpi.total_revenue': 'Выручка по обеим компаниям',
    'kpi.revenue_sub1': '+12.5% к прошлому месяцу',
    'kpi.revenue_sub2': 'План месяца выполнен на 94%',
    'kpi.metal_shipments': 'Отгрузка металлопроката',
    'kpi.shipments_sub1': '+8.2% к прошлому периоду',
    'kpi.shipments_sub2': 'Сергели, Эркин, Бектемир',
    'kpi.warehouse_stock': 'Остатки на складах',
    'kpi.stock_sub1': '58.2 млрд UZS в наличии',
    'kpi.stock_sub2': '4 850 т труб и сортового проката',
    'kpi.receivables': 'Дебиторская задолженность',
    'kpi.receivables_sub1': '88% в пределах нормы',
    'kpi.receivables_sub2': 'Кредитные лимиты застройщиков',
    'chart.total_visitors': 'Динамика обеих компаний',
    'chart.subtitle': 'Совокупный объем производства и отгрузок по дням',
    'time.last_3_months': 'Последние 3 месяца',
    'time.last_30_days': 'Последние 30 дней',
    'time.last_7_days': 'Последние 7 дней',
    'chart.plant': 'ТИЗ (трубы ППУ и ТЭСА)',
    'chart.trade': '«Металл Азия» (металлопрокат)',
    'chart.erkin': 'Логистический комплекс «Эркин»',
    'chart.mobile': 'Отгрузки труб и металлопроката (т)',
    'chart.desktop': 'Поступление оплат (млрд UZS)',
    'tab.all_specs': 'Все спецификации',
    'tab.in_work': 'В производстве',
    'tab.quality_control': 'Контроль ОТК',
    'tab.shipped': 'К отгрузке',
    'tab.pending_payment': 'Ожидает оплаты',
    'tab.outline': 'Структура',
    'tab.past_performance': 'История выполнения',
    'tab.key_personnel': 'Ответственные',
    'tab.focus_documents': 'Ключевые документы',
    'action.customize_columns': 'Настроить столбцы',
    'action.add_section': 'Новая спецификация',
    'action.export': 'Экспорт',
    'action.scan_barcode': 'Скан QR / Штрихкод',
    'action.handover': 'Контракт API / Stage 2',
    'table.order_no': '№ Спецификации',
    'table.client': 'Контрагент / Клиент',
    'table.product': 'Продукция и ГОСТ',
    'table.volume': 'Объем / Вес',
    'table.amount': 'Сумма (UZS)',
    'table.status': 'Статус',
    'table.manager': 'Менеджер',
    'table.header': 'Наименование / Раздел',
    'table.type': 'Тип продукции',
    'table.target': 'План',
    'table.limit': 'Лимит',
    'table.reviewer': 'Ответственный',
    'status.in_process': 'В производстве',
    'status.ready_to_ship': 'Готов к отгрузке',
    'status.otk': 'Контроль ОТК',
    'status.done': 'Отгружено',
    'status.pending': 'Ожидает оплаты',
    'status.cancelled': 'Отменено',
  },
  uz: {
    'brand.name': 'Acme Inc.',
    'brand.system': 'METALL ASIA ERP/MES',
    'quick.create': 'Tezkor yaratish',
    'nav.dashboard': 'Boshqaruv paneli',
    'nav.lifecycle': 'Hayotiy tsikl',
    'nav.analytics': 'Tahlil',
    'nav.projects': 'Loyihalar',
    'nav.team': 'Jamoa',
    'nav.documents_section': 'Hujjatlar',
    'nav.data_library': 'Maʼlumotlar bazasi',
    'nav.reports': 'Hisobotlar',
    'nav.word_assistant': 'Matn yordamchisi',
    'nav.more': 'Ko‘proq',
    'nav.settings': 'Sozlamalar',
    'nav.logout': 'Chiqish',
    'nav.toggleSidebar': 'Yon panelni yig‘ish yoki yozish',
    'nav.get_help': 'Yordam',
    'help.module': 'Bu bo‘lim bo‘yicha yordam',
    'nav.search': 'Qidiruv',
    'theme.light': 'Yorug‘ mavzuni yoqish',
    'theme.dark': 'Tungi mavzuni yoqish',
    'nav.sales': 'Sotuvlar',
    'nav.warehouse': 'Omborxona',
    'nav.production': 'Ishlab chiqarish',
    'nav.finance': 'Moliya',
    'nav.documents': 'Hujjatlar',
    'nav.crm': 'CRM',
    'nav.admin': 'Sozlamalar',
    'company.trade': '«Metall Asia» MChJ',
    'company.trade_short': 'Metall Asia',
    'company.trade_sub': 'Savdo va distribyutsiya',
    'company.factory': '«Toshkent izolyatsiya zavodi» MChJ',
    'company.factory_short': 'TIZ',
    'company.factory_sub': 'Quvur va izolyatsiya zavodi',
    'company.all': 'Ikkala kompaniya',
    'company.all_short': 'Ikkalasi',
    'company.all_sub': 'Ikki yuridik shaxs bo‘yicha umumiy',
    'kpi.total_revenue': 'Ikkala kompaniya tushumi',
    'kpi.revenue_sub1': 'O‘tgan oyga nisbatan +12.5%',
    'kpi.revenue_sub2': 'Oylik reja 94% ga bajarildi',
    'kpi.metal_shipments': 'Metall prokat yuklash',
    'kpi.shipments_sub1': 'O‘tgan davrga nisbatan +8.2%',
    'kpi.shipments_sub2': 'Sergeli, Erkin, Bektemir',
    'kpi.warehouse_stock': 'Ombor qoldiqlari',
    'kpi.stock_sub1': '58.2 mlrd so‘m mavjud',
    'kpi.stock_sub2': '4 850 t quvur va metall prokat',
    'kpi.receivables': 'Debitorlik qarzdorligi',
    'kpi.receivables_sub1': '88% meʼyor doirasida',
    'kpi.receivables_sub2': 'Pudrat kompaniyalari limiti',
    'chart.total_visitors': 'Ikkala kompaniya dinamikasi',
    'chart.subtitle': 'Kunlik ishlab chiqarish va yuklash umumiy hajmi',
    'time.last_3_months': 'Oxirgi 3 oy',
    'time.last_30_days': 'Oxirgi 30 kun',
    'time.last_7_days': 'Oxirgi 7 kun',
    'chart.plant': 'TIZ (PPU va TESA quvurlari)',
    'chart.trade': '«Metall Asia» (metall prokat)',
    'chart.erkin': '«Erkin» logistika majmuasi',
    'chart.mobile': 'Quvur va prokat yuklash (t)',
    'chart.desktop': 'To‘lovlar tushumi (mlrd so‘m)',
    'tab.all_specs': 'Barcha spetsifikatsiyalar',
    'tab.in_work': 'Ishlab chiqarishda',
    'tab.quality_control': 'Sifat nazorati (OTK)',
    'tab.shipped': 'Yuklashga tayyor',
    'tab.pending_payment': 'To‘lov kutilmoqda',
    'tab.outline': 'Tuzilma',
    'tab.past_performance': 'Avvalgi natijalar',
    'tab.key_personnel': 'Asosiy xodimlar',
    'tab.focus_documents': 'Muhim hujjatlar',
    'action.customize_columns': 'Ustunlarni sozlash',
    'action.add_section': 'Yangi spetsifikatsiya',
    'action.export': 'Eksport',
    'action.scan_barcode': 'Skaner QR / Shtrixkod',
    'action.handover': 'API Shartnomasi / 2-bosqich',
    'table.order_no': 'Spetsifikatsiya №',
    'table.client': 'Mijoz / Pudratchi',
    'table.product': 'Mahsulot va GOST',
    'table.volume': 'Hajm / Vazn',
    'table.amount': 'Summa (so‘m)',
    'table.status': 'Holat',
    'table.manager': 'Menejer',
    'table.header': 'Nomi / Bo‘lim',
    'table.type': 'Mahsulot turi',
    'table.target': 'Reja',
    'table.limit': 'Cheklov',
    'table.reviewer': 'Masʼul xodim',
    'status.in_process': 'Ishlab chiqarishda',
    'status.ready_to_ship': 'Yuklashga tayyor',
    'status.otk': 'Sifat nazorati (OTK)',
    'status.done': 'Yuklandi',
    'status.pending': 'To‘lov kutilmoqda',
    'status.cancelled': 'Bekor qilingan',
  },
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { session } = useAuth();
  const [theme, setTheme] = useState<AppTheme>(() => {
    try {
      const saved = localStorage.getItem('metall_theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // fallback
    }
    return 'light'; // Default to light theme matching user screenshot
  });
  const [company, setCompanyState] = useState<CompanyId>('company_trade');
  /**
   * Язык берётся у человека, а не у вкладки: в профиле он один на систему и
   * бота. До этой правки выбор жил только в памяти страницы и при каждой
   * перезагрузке возвращался на русский — узбекский экран нельзя было
   * оставить за собой.
   */
  const [locale, setLocaleState] = useState<AppLocale>(() => {
    try {
      const saved = localStorage.getItem('metall_locale');
      if (saved === 'ru' || saved === 'uz') return saved;
    } catch {
      // приватный режим: остаёмся на языке профиля
    }
    return 'ru';
  });
  const [activeModule, setActiveModule] = useState<AppModule>('dashboard');
  const [searchJump, setSearchJump] = useState<SearchJump | null>(null);
  /**
   * На узком экране сайдбар свёрнут по умолчанию. Развёрнутый он занимает 240
   * точек из 360, и содержимое схлопывается до одной буквы в строке — видно на
   * снимках `qa/dashboard-live/shots/dashboard-360-*-expanded.png`. Развернуть
   * руками по-прежнему можно: автоматика только про старт и про переход через
   * границу вниз.
   */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < NARROW_WIDTH,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_WIDTH - 1}px)`);
    const apply = (e: MediaQueryList | MediaQueryListEvent) => {
      if (e.matches) setIsSidebarCollapsed(true);
    };
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Modals
  const [isCreateOrderModalOpen, setIsCreateOrderModalOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [helpSlug, setHelpSlug] = useState<string | null>(null);

  // Sync theme with HTML root class
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('metall_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Global keyboard shortcut for search (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => !prev);
  };

  const setCompany = (comp: CompanyId) => {
    setCompanyState(comp);
    setApiCompany(comp);
  };

  /** Перейти в раздел и оставить ему строку, которую он подставит себе. */
  const jumpToSearch = (jump: SearchJump) => {
    setActiveModule(jump.module);
    setSearchJump(jump);
  };

  /**
   * Находку гасит не тот, кто её забрал, а окно поиска при следующем открытии.
   * На один раздел подписано несколько экранов — в CRM это и клиенты, и
   * сделки, — и гашение первым подписчиком оставляло остальных ни с чем.
   * От повторного срабатывания защищается сам подписчик (`useSearchJump`).
   */
  const clearSearchJump = () => setSearchJump(null);

  /** Открыть справку. Без слага — список статей. */
  const openHelp = (slug: string | null = null) => {
    setHelpSlug(slug);
    setActiveModule('help');
  };

  /**
   * Компанию выбирает роль, а не умолчание фронта. У мастера цеха в сессии
   * только завод: если оставить `company_trade`, шапка назовёт торговый дом,
   * а на экране будут заводские данные — заголовок X-Company-Id для
   * недоступной компании не уходит, и сервер отдаёт разрешённое ролью.
   */
  /**
   * Язык запроса идёт за языком экрана, в том числе при первой отрисовке.
   * Без этого после перезагрузки экран был узбекским, а заголовок
   * Accept-Language уходил русским: названия справочников и шапки отчётов
   * приходили по-русски, и половина экрана говорила не на том языке.
   */
  useEffect(() => {
    setApiLocale(locale);
  }, [locale]);

  /**
   * Язык профиля при входе. Выбор в этом браузере сильнее: человек мог только
   * что нажать UZ, и возвращать его на язык профиля значит отменять нажатие.
   */
  useEffect(() => {
    if (!session) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('metall_locale');
    } catch {
      saved = null;
    }
    if (saved === 'ru' || saved === 'uz') {
      // Выбор гостя со экрана входа: до входа его некуда было отправить.
      if (saved !== session.user?.locale) void apiClient.auth.setLocale(saved).catch(() => null);
      return;
    }
    const mine = session.user?.locale;
    if (mine && mine !== locale) {
      setLocaleState(mine);
      setApiLocale(mine);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const keys = availableCompanyKeys(session.companies);
    if (keys.length === 0) return;
    const next = keys.includes(company) ? company : keys[0]!;
    if (next !== company) setCompanyState(next);
    setApiCompany(next);
  }, [session, company]);

  const setLocale = (loc: AppLocale) => {
    setLocaleState(loc);
    setApiLocale(loc);
    try {
      localStorage.setItem('metall_locale', loc);
    } catch {
      // приватный режим: язык останется на этот сеанс
    }
    // Сервер — источник правды: там язык прочитает бот и уведомления. Отказ
    // не показываем: выбор уже применён на экране, и ругаться на него нечем.
    //
    // Только для вошедшего: на экране входа язык тоже переключают, а запрос
    // без токена вернул бы 401 и насорил в консоли браузера. Выбор гостя
    // доедет до профиля при первом же переключении после входа.
    if (session) void apiClient.auth.setLocale(loc).catch(() => null);
  };

  const t = (key: string): string => {
    return DICTIONARY[locale]?.[key] || DICTIONARY['ru'][key] || key;
  };

  return (
    <AppContext.Provider
      value={{
        theme,
        toggleTheme,
        company,
        setCompany,
        locale,
        setLocale,
        activeModule,
        setActiveModule,
        isSidebarCollapsed,
        toggleSidebar,
        isCreateOrderModalOpen,
        setIsCreateOrderModalOpen,
        isSearchOpen,
        setIsSearchOpen,
        searchJump,
        jumpToSearch,
        clearSearchJump,
        helpSlug,
        openHelp,
        t,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
