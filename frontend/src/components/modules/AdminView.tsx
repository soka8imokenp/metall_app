import React, { useEffect, useState } from 'react';
import {
  Activity,
  Coins,
  DatabaseBackup,
  KeyRound,
  LogIn,
  Plug,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { AdminBackups } from './AdminBackups';
import { AdminResetRequests } from './AdminResetRequests';
import { AdminUsers } from './AdminUsers';
import { AdminRoles } from './AdminRoles';
import { AdminAudit, AdminLogins } from './AdminJournals';
import { AdminExchange } from './AdminExchange';
import { CurrencySettings } from './CurrencyRates';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { CARD } from './warehouse-ui';

/**
 * Раздел «Настройки» (ТЗ 3.3, 3.4) — в коде и в маршруте он остался `admin`.
 *
 * Пять вкладок, все на живом API. До 01.10 матрица прав и журнал действий
 * здесь были макетом: пять ролей и семь прав, вписанных в вёрстку, и
 * переключатели, которые ничего не сохраняли. Это был последний такой экран в
 * системе.
 *
 * Названия вкладок — по-человечески, без «RBAC» и «Audit Trail»: раздел
 * открывает администратор клиента, а не мы.
 */

type Tab =
  | 'users'
  | 'roles'
  | 'currencies'
  | 'audit'
  | 'logins'
  | 'exchange'
  | 'reset'
  | 'backups';

export const AdminView: React.FC = () => {
  const { locale, searchJump } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayUsers = session?.permissions.includes('admin.users') ?? false;

  const [tab, setTab] = useState<Tab>('users');
  /**
   * Находка из общего поиска открывает вкладку людей. Она и так первая, но
   * администратор чаще приходит сюда из журналов или роли — и тогда находка
   * попала бы не на тот экран. Строку в поле подставляет сама вкладка.
   */
  useEffect(() => {
    if (searchJump?.module === 'admin' && searchJump.view === 'users') setTab('users');
  }, [searchJump]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    {
      key: 'users',
      label: isUz ? 'Odamlar' : 'Люди',
      icon: <Users className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      key: 'roles',
      label: isUz ? 'Rollar va huquqlar' : 'Роли и права',
      icon: <ShieldCheck className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      key: 'currencies',
      label: isUz ? 'Valyuta va kurslar' : 'Валюты и курсы',
      icon: <Coins className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      key: 'audit',
      label: isUz ? 'Harakatlar jurnali' : 'Журнал действий',
      icon: <Activity className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      key: 'logins',
      label: isUz ? 'Kirishlar jurnali' : 'Журнал входов',
      icon: <LogIn className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      // Рядом с журналами действий и входов: обмен читают тем же движением —
      // «что происходило и чем кончилось».
      key: 'exchange',
      label: isUz ? 'Almashinuv' : 'Обмен с системами',
      icon: <Plug className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      key: 'reset',
      label: isUz ? 'Parol arizalari' : 'Заявки на пароль',
      icon: <KeyRound className="w-3.5 h-3.5 shrink-0" />,
    },
    {
      // Последней: сюда заходят не по делу дня, а раз в месяц — проверить, что
      // копии есть. Рядом с журналами её искали бы среди того, что читают.
      key: 'backups',
      label: isUz ? 'Baza nusxalari' : 'Копии базы',
      icon: <DatabaseBackup className="w-3.5 h-3.5 shrink-0" />,
    },
  ];

  // Раздел целиком про доступы: без права им управлять смотреть тут нечего, и
  // честнее сказать это словами, чем показать пустые вкладки.
  if (!mayUsers) {
    return (
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Bu bo‘lim kirish huquqlarini boshqarish uchun. Sizda «Foydalanuvchilarni boshqarish» huquqi yo‘q.'
          : 'Этот раздел — про доступы в систему. Права «Управление пользователями» у вас нет, ' +
            'поэтому показывать здесь нечего: попросите администратора.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {/* Полоса вкладок объявлена по стандарту: `tablist` + `tab` +
          `aria-selected`. Прежде на кнопке стояла роль `tab` с `aria-pressed`
          — она роли `tab` не положена, и доступного имени у вкладки не
          оставалось: экранный диктор и прогон её не находили. */}
      <div
        role="tablist"
        aria-label={isUz ? 'Bo‘limlar' : 'Разделы администрирования'}
        className="flex flex-wrap items-center gap-1.5 text-xs min-w-0"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`admin-tab-${t.key}`}
            aria-controls={`admin-panel-${t.key}`}
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={
              'px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5 ' +
              (tab === t.key
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200')
            }
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
        {tab === 'users' && <AdminUsers />}
        {tab === 'roles' && <AdminRoles />}
        {tab === 'currencies' && <CurrencySettings />}
        {tab === 'audit' && <AdminAudit />}
        {tab === 'logins' && <AdminLogins />}
        {tab === 'exchange' && <AdminExchange />}
        {tab === 'reset' && <AdminResetRequests />}
        {tab === 'backups' && <AdminBackups />}
      </div>
    </div>
  );
};
