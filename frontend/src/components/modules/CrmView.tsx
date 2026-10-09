/**
 * CRM (ТЗ §8): обращения, клиенты, воронка сделок, задачи, отчёты, справочники.
 *
 * Вкладки идут в порядке жизни клиента, а не в порядке нашей разработки:
 * сначала обращение, потом карточка, потом сделка, а задачи и лента общения
 * идут через все три. С обращений начинается день менеджера, поэтому они и
 * открываются первыми.
 *
 * Все три вкладки работают на живом API. Фикстуры `MOCK_CRM_DEALS`, на
 * которых держалась воронка из импортированного макета, больше не
 * используются: четыре колонки там были вписаны в вёрстку, а по ТЗ 8.3
 * стадии настраиваются, и рисовать их надо по справочнику компании.
 */

import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { CrmLeads } from './CrmLeads';
import { CrmPartners } from './CrmPartners';
import { CrmDeals } from './CrmDeals';
import { CrmTasks } from './CrmTasks';
import { CrmReports } from './CrmReports';
import { CrmRefs } from './CrmRefs';

type Tab = 'leads' | 'partners' | 'deals' | 'tasks' | 'reports' | 'refs';

export const CrmView: React.FC = () => {
  const { locale, searchJump } = useApp();
  const isUz = locale === 'uz';
  const [tab, setTab] = useState<Tab>('leads');
  /**
   * Находка из общего поиска открывает свою вкладку: клиент — «Клиенты»,
   * сделка — «Сделки». Строку в список подставляет уже сама вкладка.
   */
  React.useEffect(() => {
    if (searchJump?.module !== 'crm') return;
    if (searchJump.view === 'partners' || searchJump.view === 'deals') setTab(searchJump.view);
  }, [searchJump]);

  return (
    <div className="flex flex-col gap-4 text-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50 break-words">
            {isUz ? 'Mijozlar va bitimlar (CRM)' : 'Клиенты и сделки (CRM)'}
          </h2>
          <p className="text-zinc-500 text-xs break-words">
            {isUz
              ? 'Murojaatlar, mijozlar bazasi, sotuv voronkasi, vazifalar va hisobotlar'
              : 'Обращения, база клиентов, воронка продаж, задачи и отчёты'}
          </p>
        </div>

        {/* Четыре вкладки в строку на 360 не помещаются — переключатель
            переносит их, а не уезжает вбок вместе со страницей. */}
        <div className="flex flex-wrap items-center border border-zinc-200 dark:border-zinc-800 rounded-lg p-0.5 bg-zinc-50 dark:bg-zinc-900 sm:shrink-0">
          {(
            [
              ['leads', isUz ? 'Murojaatlar' : 'Обращения'],
              ['partners', isUz ? 'Mijozlar' : 'Клиенты'],
              ['deals', isUz ? 'Bitimlar' : 'Сделки'],
              ['tasks', isUz ? 'Vazifalar' : 'Задачи'],
              ['reports', isUz ? 'Hisobotlar' : 'Отчёты'],
              ['refs', isUz ? 'Ma’lumotnomalar' : 'Справочники'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap cursor-pointer ${
                tab === key
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {tab === 'leads' ? (
        <CrmLeads />
      ) : tab === 'partners' ? (
        <CrmPartners />
      ) : tab === 'deals' ? (
        <CrmDeals />
      ) : tab === 'tasks' ? (
        <CrmTasks />
      ) : tab === 'reports' ? (
        <CrmReports />
      ) : (
        <CrmRefs />
      )}
    </div>
  );
};
