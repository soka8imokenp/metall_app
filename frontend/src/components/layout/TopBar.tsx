import React from 'react';
import { PanelLeft, Sun, Moon, Search, HelpCircle } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { articleForTopic } from '../../help/articles.ts';

export const TopBar: React.FC = () => {
  const {
    theme,
    toggleTheme,
    locale,
    setLocale,
    activeModule,
    toggleSidebar,
    setIsSearchOpen,
    openHelp,
    t,
  } = useApp();

  const getPageTitle = () => {
    switch (activeModule) {
      case 'dashboard':
        return t('nav.dashboard');
      case 'sales':
        return t('nav.sales');
      case 'warehouse':
        return t('nav.warehouse');
      case 'production':
        return t('nav.production');
      case 'finance':
        return t('nav.finance');
      case 'documents':
        return t('nav.documents');
      case 'crm':
        return t('nav.crm');
      case 'admin':
        return t('nav.admin');
      case 'help':
        return t('nav.get_help');
      default:
        return t('nav.dashboard');
    }
  };

  /**
   * Статья этого раздела — её открывает кнопка «?» рядом с названием.
   *
   * Кнопка живёт в шапке, а не внутри каждого из восьми экранов: шапка и есть
   * заголовок раздела, и восьми копий одной кнопки не нужно. На самой
   * «Справке» кнопки нет — она вела бы туда, где человек уже стоит.
   */
  const helpArticle = activeModule === 'help' ? null : articleForTopic(activeModule);

  return (
    <header className="h-12 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#09090b] px-4 flex items-center justify-between shrink-0 select-none">
      {/* Left side: Panel toggle + Current Page Title */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          title={t('nav.toggleSidebar')}
          aria-label={t('nav.toggleSidebar')}
          className="text-zinc-500 hover:text-zinc-950 dark:hover:text-zinc-100 p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <PanelLeft size={16} />
        </button>

        <div className="h-4 w-[1px] bg-zinc-200 dark:bg-zinc-800" />

        <span className="text-[13px] font-medium text-zinc-950 dark:text-zinc-50 tracking-tight">
          {getPageTitle()}
        </span>

        {helpArticle && (
          <button
            type="button"
            data-role="help-for-module"
            data-help-target={helpArticle.slug}
            onClick={() => openHelp(helpArticle.slug)}
            title={t('help.module')}
            aria-label={t('help.module')}
            className="text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 p-1 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <HelpCircle size={15} />
          </button>
        )}
      </div>

      {/* Right side: Global Search, Language Switcher, Theme Toggle */}
      <div className="flex items-center gap-2 text-xs">
        {/* Quick Search Trigger */}
        <button
          onClick={() => setIsSearchOpen(true)}
          className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer bg-white dark:bg-zinc-900 shadow-2xs"
          title={t('nav.search')}
        >
          <Search size={13} className="text-zinc-400" />
          <span className="text-xs">{t('nav.search')}</span>
        </button>

        {/* Language Switcher (RU / UZ) */}
        <div className="flex items-center border border-zinc-200 dark:border-zinc-800 rounded-lg p-0.5 bg-zinc-50 dark:bg-zinc-900 shadow-2xs">
          <button
            onClick={() => setLocale('ru')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              locale === 'ru'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            RU
          </button>
          <button
            onClick={() => setLocale('uz')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              locale === 'uz'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            UZ
          </button>
        </div>

        {/* Theme Toggle (Sun / Moon) */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer bg-white dark:bg-zinc-900 shadow-2xs"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </header>
  );
};
