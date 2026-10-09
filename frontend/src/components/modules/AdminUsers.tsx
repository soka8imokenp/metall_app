import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Lock, Plus, Send, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { AdminAssignmentInput, AdminRole, AdminUser } from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { refName } from '../../lib/formatters';
import { useSearchJump } from '../../lib/use-search-jump';

/**
 * Люди в системе (ТЗ 3.3).
 *
 * До этого экрана завести человека можно было только пересевом базы. Здесь
 * его заводят, назначают роли по компаниям, задают пароль и закрывают доступ
 * уволившемуся.
 *
 * Чего здесь нет сознательно: показа действующего пароля. Его нет и у сервера —
 * хранится только хеш. Поэтому «забыл пароль» решается выдачей нового, а не
 * подсматриванием прежнего, и это видно по самой форме.
 */

const when = (iso: string | null, isUz: boolean) =>
  iso
    ? new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Роль в компании одной строкой: «Кладовщик · Торговый дом». */
const assignmentText = (u: AdminUser, isUz: boolean) =>
  u.assignments.length === 0
    ? isUz
      ? 'rol yo‘q'
      : 'роли нет'
    : u.assignments
        .map((a) => `${refName(a.role, isUz)} · ${a.company.nameRu}`)
        .join(', ');

type Mode =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; uid: string }
  | { kind: 'roles'; uid: string }
  | { kind: 'password'; uid: string };

export const AdminUsers: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const may = session?.permissions.includes('admin.users') ?? false;
  const companies = session?.companies ?? [];

  const [rows, setRows] = useState<AdminUser[] | null>(null);
  // Список обрезался пределом молча: сколько людей всего, экран не говорил,
  // и за сотой учёткой администратор не узнал бы, что есть ещё. Предел
  // растёт по кнопке — так же, как в журналах рядом.
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [withInactive, setWithInactive] = useState(true);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  /**
   * Выданный код привязки Telegram. Живёт только в памяти экрана: второй раз
   * его не покажет никто — в базе лежит хеш.
   */
  const [tgCode, setTgCode] = useState<{ uid: string; code: string; expiresAt: string } | null>(
    null,
  );

  const issueTelegram = async (uid: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiClient.admin.telegramCode(uid);
      setTgCode({ uid, code: res.data.code, expiresAt: res.data.expiresAt });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const [users, rolesRes] = await Promise.all([
        apiClient.admin.users({
          search: search.trim() || undefined,
          includeInactive: withInactive,
          limit,
        }),
        apiClient.admin.roles(),
      ]);
      setRows(users.data.rows);
      setTotal(users.data.total);
      setRoles(rolesRes.data.rows);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [search, withInactive, limit]);

  // Сотрудника, найденного общим поиском, подставляем в это же поле: список
  // сузится до него, и дальше с ним работают обычными кнопками экрана.
  useSearchJump('admin', setSearch, 'users');

  // Новый поиск начинается с первой страницы: иначе предел, выросший на
  // прошлом запросе, тянул бы за собой лишнее.
  useEffect(() => {
    setLimit(50);
  }, [search, withInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => {
    if (mode.kind === 'edit' || mode.kind === 'roles' || mode.kind === 'password') {
      return (rows ?? []).find((r) => r.uid === mode.uid) ?? null;
    }
    return null;
  }, [mode, rows]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setMode({ kind: 'none' });
      setNotice(done);
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isUz ? 'Login yoki ism' : 'Логин или имя'}
          aria-label={isUz ? 'Qidirish' : 'Поиск'}
          className={FIELD + ' max-w-[16rem]'}
        />
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={withInactive}
            onChange={(e) => setWithInactive(e.target.checked)}
          />
          {isUz ? 'O‘chirilganlar ham' : 'Показывать выключенных'}
        </label>
        <span className="text-[11px] text-zinc-500">
          {isUz
            ? `${rows?.length ?? 0} dan ${total} ko‘rsatildi`
            : `показано ${rows?.length ?? 0} из ${total}`}
        </span>
        {may && (
          <button
            type="button"
            onClick={() => setMode({ kind: 'create' })}
            className={BTN_PRIMARY + ' ms-auto inline-flex items-center gap-1.5'}
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            {isUz ? 'Odam qo‘shish' : 'Добавить человека'}
          </button>
        )}
      </div>

      {error && <ErrorBox text={error.message} onRetry={load} isUz={isUz} />}
      {notice && (
        <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 break-words">
          {notice}
        </div>
      )}

      {mode.kind === 'create' && (
        <UserForm
          isUz={isUz}
          roles={roles}
          companies={companies}
          busy={busy}
          onCancel={() => setMode({ kind: 'none' })}
          onSubmit={(input) =>
            act(
              () => apiClient.admin.createUser(input),
              isUz
                ? `Hisob yaratildi: ${input.login}`
                : `Учётная запись заведена: ${input.login}. Пароль передайте человеку — показать его снова система не сможет.`,
            )
          }
        />
      )}

      <div className={CARD + ' flex flex-col min-w-0'}>
        {rows === null && !error ? (
          <Skeleton rows={4} />
        ) : rows && rows.length === 0 ? (
          <Empty text={isUz ? 'Hisoblar topilmadi' : 'Учётных записей не нашлось'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 min-w-0">
            {(rows ?? []).map((u) => (
              <li key={u.uid} className="px-4 py-3 flex flex-col gap-2 min-w-0">
                <div className="flex flex-col lg:flex-row lg:items-start gap-2 lg:gap-4 min-w-0">
                  <div className="flex flex-col gap-1 min-w-0 lg:flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <span className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 break-all">
                        {u.login}
                      </span>
                      <span className="text-xs text-zinc-700 dark:text-zinc-300 break-words">
                        {u.fullName}
                      </span>
                      {!u.isActive && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                          <UserX className="w-3 h-3 shrink-0" />
                          {isUz ? 'o‘chirilgan' : 'выключен'}
                        </span>
                      )}
                      {u.telegram.linked && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-sky-600 dark:text-sky-400">
                          <Send className="w-3 h-3 shrink-0" />
                          {isUz
                            ? `Telegram ulangan ${when(u.telegram.linkedAt, isUz)}`
                            : `Telegram подключён ${when(u.telegram.linkedAt, isUz)}`}
                        </span>
                      )}
                      {u.telegram.blocked && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                          <Send className="w-3 h-3 shrink-0" />
                          {isUz
                            ? 'bot yozolmaydi — odam botni yopgan'
                            : 'бот писать не может — человек закрыл бота'}
                        </span>
                      )}
                      {!u.telegram.linked && u.telegram.codeExpiresAt && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                          <Send className="w-3 h-3 shrink-0" />
                          {isUz
                            ? `kod ${when(u.telegram.codeExpiresAt, isUz)} gacha`
                            : `код выдан, годен до ${when(u.telegram.codeExpiresAt, isUz)}`}
                        </span>
                      )}
                      {u.lockedUntil && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400">
                          <Lock className="w-3 h-3 shrink-0" />
                          {isUz
                            ? `bloklangan ${when(u.lockedUntil, isUz)} gacha`
                            : `заблокирован до ${when(u.lockedUntil, isUz)}`}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-zinc-500 break-words">
                      {assignmentText(u, isUz)}
                    </span>
                    <span className="text-[11px] text-zinc-400 break-words">
                      {isUz ? 'oxirgi kirish' : 'последний вход'}: {when(u.lastLoginAt, isUz)}
                      {u.email ? ` · ${u.email}` : ''}
                    </span>
                  </div>

                  {may && (
                    <div className="flex flex-wrap gap-1.5 lg:justify-end shrink-0">
                      <button
                        type="button"
                        onClick={() => setMode({ kind: 'edit', uid: u.uid })}
                        className={BTN_GHOST + ' h-7'}
                      >
                        {isUz ? 'Tahrirlash' : 'Правка'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode({ kind: 'roles', uid: u.uid })}
                        className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                      >
                        <ShieldCheck className="w-3 h-3 shrink-0" />
                        {isUz ? 'Rollar' : 'Роли'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode({ kind: 'password', uid: u.uid })}
                        className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                        title={
                          isUz
                            ? 'Yangi parol beriladi, eskisini tizim ko‘rsatmaydi'
                            : 'Задаём новый пароль: прежний система показать не может, он хранится хешем'
                        }
                      >
                        <KeyRound className="w-3 h-3 shrink-0" />
                        {isUz ? 'Parol' : 'Пароль'}
                      </button>
                      {u.lockedUntil && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            act(
                              () => apiClient.admin.unlock(u.uid),
                              isUz ? 'Blok olindi' : 'Блокировка снята',
                            )
                          }
                          className={BTN_GHOST + ' h-7'}
                        >
                          {isUz ? 'Blokni olish' : 'Снять блокировку'}
                        </button>
                      )}
                      {/* Привязка Telegram: код выдаём, пока не подключён, и
                          отключаем, когда подключён. Двух кнопок сразу не
                          бывает — человек один, привязка одна. */}
                      {u.isActive && !u.telegram.linked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void issueTelegram(u.uid)}
                          className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                          title={
                            isUz
                              ? 'Bir martalik kod: odam botga /start <kod> yozadi'
                              : 'Одноразовый код: человек пишет боту /start <код>. Код виден один раз'
                          }
                        >
                          <Send className="w-3 h-3 shrink-0" />
                          {u.telegram.codeExpiresAt
                            ? isUz
                              ? 'Yangi kod'
                              : 'Новый код'
                            : isUz
                              ? 'Telegram ulash'
                              : 'Подключить Telegram'}
                        </button>
                      )}
                      {u.telegram.linked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            act(
                              () => apiClient.admin.telegramUnlink(u.uid),
                              isUz ? 'Telegram uzildi' : 'Telegram отключён',
                            )
                          }
                          className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                          title={
                            isUz
                              ? 'Bog‘lanish olinadi, hisob joyida qoladi'
                              : 'Привязка снимается, учётка остаётся. Нужно, если телефон потерян'
                          }
                        >
                          <Send className="w-3 h-3 shrink-0" />
                          {isUz ? 'Telegramni uzish' : 'Отключить Telegram'}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () => apiClient.admin.patchUser(u.uid, { isActive: !u.isActive }),
                            u.isActive
                              ? isUz
                                ? 'Hisob o‘chirildi'
                                : 'Доступ закрыт'
                              : isUz
                                ? 'Hisob yoqildi'
                                : 'Доступ открыт',
                          )
                        }
                        className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                        title={
                          u.isActive
                            ? isUz
                              ? 'Kirish yopiladi, yozuvlari joyida qoladi'
                              : 'Вход закроется, а всё записанное им останется на месте'
                            : isUz
                              ? 'Kirish ochiladi'
                              : 'Вход откроется'
                        }
                      >
                        {u.isActive ? (
                          <>
                            <UserX className="w-3 h-3 shrink-0" />
                            {isUz ? 'O‘chirish' : 'Выключить'}
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-3 h-3 shrink-0" />
                            {isUz ? 'Yoqish' : 'Включить'}
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {tgCode?.uid === u.uid && (
                  <div className="rounded-lg border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-3 py-2 flex flex-col gap-1 min-w-0">
                    <span className="font-mono text-base tracking-[0.2em] text-sky-900 dark:text-sky-200 break-all">
                      {tgCode.code}
                    </span>
                    <span className="text-[11px] text-sky-800 dark:text-sky-300 break-words">
                      {isUz
                        ? `Odam botga yozadi: /start ${tgCode.code}`
                        : `Человек пишет боту: /start ${tgCode.code}`}
                    </span>
                    <span className="text-[11px] text-sky-700 dark:text-sky-400 break-words">
                      {isUz
                        ? `Kod ${when(tgCode.expiresAt, isUz)} gacha va bir marta ko‘rinadi`
                        : `Код годен до ${when(tgCode.expiresAt, isUz)} и показывается один раз: закроете — не вернуть, нужно будет выдать новый`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTgCode(null)}
                      className={BTN_GHOST + ' h-7 self-start'}
                    >
                      {isUz ? 'Yopish' : 'Скрыть'}
                    </button>
                  </div>
                )}

                {current?.uid === u.uid && mode.kind === 'edit' && (
                  <EditForm
                    user={u}
                    isUz={isUz}
                    busy={busy}
                    onCancel={() => setMode({ kind: 'none' })}
                    onSubmit={(patch) =>
                      act(
                        () => apiClient.admin.patchUser(u.uid, patch),
                        isUz ? 'Saqlandi' : 'Сохранено',
                      )
                    }
                  />
                )}

                {current?.uid === u.uid && mode.kind === 'roles' && (
                  <RolesForm
                    user={u}
                    roles={roles}
                    companies={companies}
                    isUz={isUz}
                    busy={busy}
                    onCancel={() => setMode({ kind: 'none' })}
                    onSubmit={(assignments) =>
                      act(
                        () => apiClient.admin.setRoles(u.uid, assignments),
                        isUz ? 'Rollar saqlandi' : 'Роли сохранены',
                      )
                    }
                  />
                )}

                {current?.uid === u.uid && mode.kind === 'password' && (
                  <PasswordForm
                    isUz={isUz}
                    busy={busy}
                    onCancel={() => setMode({ kind: 'none' })}
                    onSubmit={(password) =>
                      act(
                        () => apiClient.admin.setPassword(u.uid, password),
                        isUz
                          ? 'Parol o‘rnatildi — odamga o‘zingiz aytasiz'
                          : 'Пароль задан. Передайте его человеку сами: показать снова система не сможет.',
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows && total > rows.length && (
        <div>
          <button type="button" onClick={() => setLimit((l) => l + 50)} className={BTN_GHOST}>
            {isUz ? 'Yana 50 ta' : 'Показать ещё 50'}
          </button>
        </div>
      )}
    </div>
  );
};

// --- формы ------------------------------------------------------------------

const LABEL = 'text-[11px] uppercase tracking-wide text-zinc-500';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="flex flex-col gap-1 min-w-0">
    <span className={LABEL}>{label}</span>
    {children}
  </label>
);

/**
 * Выбор ролей: роль × компания.
 *
 * Список, а не одна роль: кладовщик работает и в «Торговом доме», и на заводе,
 * а директор видит обе компании. Одна роль на компанию — ограничение сервера,
 * и экран его повторяет, чтобы не предлагать того, что получит отказ.
 */
const RolePicker: React.FC<{
  roles: AdminRole[];
  companies: { uid: string; code: string; nameRu: string }[];
  value: AdminAssignmentInput[];
  onChange: (next: AdminAssignmentInput[]) => void;
  isUz: boolean;
}> = ({ roles, companies, value, onChange, isUz }) => {
  const has = (roleCode: string, companyUid: string) =>
    value.some((v) => v.roleCode === roleCode && v.companyUid === companyUid);

  const toggle = (roleCode: string, companyUid: string) => {
    onChange(
      has(roleCode, companyUid)
        ? value.filter((v) => !(v.roleCode === roleCode && v.companyUid === companyUid))
        : [...value, { roleCode, companyUid }],
    );
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <span className={LABEL}>{isUz ? 'Rollar kompaniyalar bo‘yicha' : 'Роли по компаниям'}</span>
      <div className="flex flex-col gap-2 min-w-0">
        {companies.map((c) => (
          <div key={c.uid} className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500 break-words">{refName(c, isUz)}</span>
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {roles.map((r) => (
                <button
                  key={`${c.uid}:${r.code}`}
                  type="button"
                  onClick={() => toggle(r.code, c.uid)}
                  aria-pressed={has(r.code, c.uid)}
                  className={
                    'px-2 py-1 rounded-md border text-[11px] transition-colors cursor-pointer ' +
                    (has(r.code, c.uid)
                      ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800')
                  }
                >
                  {refName(r, isUz)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const UserForm: React.FC<{
  roles: AdminRole[];
  companies: { uid: string; code: string; nameRu: string }[];
  isUz: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    login: string;
    fullName: string;
    password: string;
    email?: string;
    phone?: string;
    locale?: 'ru' | 'uz';
    assignments: AdminAssignmentInput[];
  }) => void;
}> = ({ roles, companies, isUz, busy, onCancel, onSubmit }) => {
  const [login, setLogin] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [assignments, setAssignments] = useState<AdminAssignmentInput[]>([]);

  const loginOk = /^[a-z][a-z0-9._-]{2,31}$/.test(login);
  const ready = loginOk && fullName.trim().length > 1 && password.length >= 6;

  return (
    <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-w-0">
        <Row label={isUz ? 'Login' : 'Логин'}>
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value.toLowerCase().trim())}
            className={FIELD}
            placeholder="a.saidov"
            autoComplete="off"
          />
          {login.length > 0 && !loginOk && (
            <span className="text-[11px] text-rose-600 dark:text-rose-400 break-words">
              {isUz
                ? 'Login: kichik lotin harfi bilan boshlanadi, keyin harf, raqam, nuqta yoki _'
                : 'Логин: со строчной латинской буквы, дальше латиница, цифры, точка, дефис или _'}
            </span>
          )}
        </Row>
        <Row label={isUz ? 'F.I.Sh.' : 'ФИО'}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={FIELD} />
        </Row>
        <Row label={isUz ? 'Parol' : 'Пароль'}>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={FIELD}
            autoComplete="new-password"
            placeholder={isUz ? 'kamida 6 belgi' : 'не меньше 6 знаков'}
          />
        </Row>
        <Row label={isUz ? 'Pochta' : 'Почта'}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD} />
        </Row>
        <Row label={isUz ? 'Telefon' : 'Телефон'}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={FIELD} />
        </Row>
      </div>

      <RolePicker
        roles={roles}
        companies={companies}
        value={assignments}
        onChange={setAssignments}
        isUz={isUz}
      />

      <p className="text-[11px] text-zinc-500 break-words">
        {isUz
          ? 'Parolni odamning o‘ziga aytasiz: tizim uni keyin ko‘rsatmaydi, faqat yangisini beradi.'
          : 'Пароль передаёте человеку сами: система его потом не покажет — только выдаст новый. Роли ' +
            'можно оставить пустыми, но тогда он войдёт и не увидит ни одного раздела.'}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() =>
            onSubmit({
              login,
              fullName: fullName.trim(),
              password,
              ...(email.trim() ? { email: email.trim() } : {}),
              ...(phone.trim() ? { phone: phone.trim() } : {}),
              assignments,
            })
          }
          className={BTN_PRIMARY}
        >
          {busy ? (isUz ? 'Yozilmoqda…' : 'Завожу…') : isUz ? 'Yaratish' : 'Завести'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};

const EditForm: React.FC<{
  user: AdminUser;
  isUz: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (patch: {
    fullName?: string;
    email?: string | null;
    phone?: string | null;
    locale?: 'ru' | 'uz';
  }) => void;
}> = ({ user, isUz, busy, onCancel, onSubmit }) => {
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [userLocale, setUserLocale] = useState<'ru' | 'uz'>(user.locale);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-3 min-w-0">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-w-0">
        <Row label={isUz ? 'F.I.Sh.' : 'ФИО'}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={FIELD} />
        </Row>
        <Row label={isUz ? 'Pochta' : 'Почта'}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD} />
        </Row>
        <Row label={isUz ? 'Telefon' : 'Телефон'}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={FIELD} />
        </Row>
        <Row label={isUz ? 'Interfeys tili' : 'Язык интерфейса'}>
          <div className="flex gap-1.5">
            {(['ru', 'uz'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setUserLocale(l)}
                aria-pressed={userLocale === l}
                className={
                  'px-2 py-1 rounded-md border text-[11px] cursor-pointer transition-colors ' +
                  (userLocale === l
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300')
                }
              >
                {l === 'ru' ? 'Русский' : 'O‘zbek'}
              </button>
            ))}
          </div>
        </Row>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || fullName.trim().length < 2}
          onClick={() =>
            onSubmit({
              fullName: fullName.trim(),
              email: email.trim() || null,
              phone: phone.trim() || null,
              locale: userLocale,
            })
          }
          className={BTN_PRIMARY}
        >
          {isUz ? 'Saqlash' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};

const RolesForm: React.FC<{
  user: AdminUser;
  roles: AdminRole[];
  companies: { uid: string; code: string; nameRu: string }[];
  isUz: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (assignments: AdminAssignmentInput[]) => void;
}> = ({ user, roles, companies, isUz, busy, onCancel, onSubmit }) => {
  const [assignments, setAssignments] = useState<AdminAssignmentInput[]>(
    user.assignments.map((a) => ({ roleCode: a.role.code, companyUid: a.company.uid })),
  );

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-3 min-w-0">
      <RolePicker
        roles={roles}
        companies={companies}
        value={assignments}
        onChange={setAssignments}
        isUz={isUz}
      />
      <p className="text-[11px] text-zinc-500 break-words">
        {isUz
          ? 'Rol olinsa, odam yozganlari joyida qoladi — faqat kirish doirasi o‘zgaradi.'
          : 'Снятая роль не стирает то, что человек записал: меняется только то, что ему доступно дальше.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmit(assignments)}
          className={BTN_PRIMARY}
        >
          {isUz ? 'Saqlash' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};

const PasswordForm: React.FC<{
  isUz: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (password: string) => void;
}> = ({ isUz, busy, onCancel, onSubmit }) => {
  const [password, setPassword] = useState('');

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-3 min-w-0">
      <Row label={isUz ? 'Yangi parol' : 'Новый пароль'}>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD + ' max-w-[20rem]'}
          autoComplete="new-password"
          placeholder={isUz ? 'kamida 6 belgi' : 'не меньше 6 знаков'}
        />
      </Row>
      <p className="text-[11px] text-zinc-500 break-words">
        {isUz
          ? 'Eski parolni tizim ko‘rsatmaydi: u faqat xeshda saqlanadi. Yangisini o‘zingiz topshirasiz.'
          : 'Прежний пароль система показать не может — он хранится хешем, а не текстом. Новый передайте человеку сами.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || password.length < 6}
          onClick={() => onSubmit(password)}
          className={BTN_PRIMARY}
        >
          {isUz ? 'Parolni o‘rnatish' : 'Задать пароль'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};
