import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useUpdateAvailable } from '../lib/app-version';

/**
 * Полоса «вышло обновление» с кнопкой перезагрузки.
 *
 * Появляется, только когда на сервере действительно лежит сборка новее
 * открытой (см. `lib/app-version.ts`). Перезагружаем по нажатию, а не сами:
 * человек может стоять в заполненной форме.
 *
 * Полоса в потоке страницы, а не поверх неё: всплывающее окно поверх таблицы
 * закрывает как раз ту строку, с которой человек работает.
 */
export const UpdateBanner: React.FC = () => {
  const stale = useUpdateAvailable();
  const { locale } = useApp();
  const isUz = locale === 'uz';

  if (!stale) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200">
      <span className="min-w-0 break-words">
        {isUz
          ? 'Tizimning yangi versiyasi chiqdi. Yangilanishlarni ko‘rish uchun sahifani qayta yuklang.'
          : 'Вышла новая версия системы. Перезагрузите страницу, чтобы увидеть изменения.'}
      </span>
      <button
        type="button"
        // `reload` достаточно: `index.html` отдаётся с запретом на кэш, и
        // браузер заберёт новый список файлов.
        onClick={() => window.location.reload()}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
      >
        <RefreshCw size={13} />
        {isUz ? 'Qayta yuklash' : 'Перезагрузить'}
      </button>
    </div>
  );
};
