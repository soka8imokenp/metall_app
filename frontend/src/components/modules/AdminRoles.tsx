import React, { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { AdminPermissionModule, AdminRole } from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { refName } from '../../lib/formatters';

/**
 * Роли и матрица прав (ТЗ 3.3).
 *
 * Матрица — это связь «роль × право», и она пишется. До этого экрана она была
 * картинкой: пять ролей и семь прав, вбитых в вёрстку, переключатели не
 * сохраняли ничего. Теперь строки — настоящие права системы (их двадцать
 * шесть), столбцы — настоящие роли, а нажатие уходит на сервер.
 *
 * Правка не применяется по одной галочке: набор прав роли отправляется целиком
 * кнопкой «Сохранить». Так человек видит, что именно поменял, до того как это
 * начнёт действовать, — у прав доступа это важнее мгновенного отклика.
 */

type Draft = Record<string, string[]>;

export const AdminRoles: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('admin.roles') ?? false;

  const [modules, setModules] = useState<AdminPermissionModule[] | null>(null);
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [perms, rolesRes] = await Promise.all([
        apiClient.admin.permissions(),
        apiClient.admin.roles(),
      ]);
      setModules(perms.data.modules);
      setRoles(rolesRes.data.rows);
      setDraft(Object.fromEntries(rolesRes.data.rows.map((r) => [r.code, [...r.permissions]])));
    } catch (e) {
      setModules(null);
      setRoles(null);
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (roleCode: string, permission: string) => {
    setDraft((prev) => {
      const current = prev[roleCode] ?? [];
      return {
        ...prev,
        [roleCode]: current.includes(permission)
          ? current.filter((p) => p !== permission)
          : [...current, permission],
      };
    });
  };

  const dirty = (r: AdminRole) => {
    const next = [...(draft[r.code] ?? [])].sort();
    const before = [...r.permissions].sort();
    return next.join(',') !== before.join(',');
  };

  const save = async (r: AdminRole) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.admin.setRolePermissions(r.code, draft[r.code] ?? []);
      setNotice(
        isUz
          ? `«${r.nameUz}» roli huquqlari saqlandi`
          : `Права роли «${r.nameRu}» сохранены. Они действуют со следующего входа человека.`,
      );
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: AdminRole) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.admin.removeRole(r.code);
      setNotice(isUz ? 'Rol o‘chirildi' : 'Роль удалена');
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (error && !roles) return <ErrorBox text={error.message} onRetry={load} isUz={isUz} />;
  if (!modules || !roles) return <Skeleton rows={6} />;

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Rol — huquqlar to‘plami. Belgini qo‘yib «Saqlash»ni bosing: o‘zgarish odam keyingi ' +
            'kirganida ishlaydi. Tizim rollarining huquqlari tahrirlanadi, kodi esa yo‘q.'
          : 'Роль — это набор прав. Поставьте галочки и нажмите «Сохранить»: правка начнёт ' +
            'действовать со следующего входа человека. У системных ролей правятся права, но не код ' +
            'и не само их существование — на код опирается настройка системы.'}
      </div>

      {error && <ErrorBox text={error.message} onRetry={load} isUz={isUz} />}
      {notice && (
        <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 break-words">
          {notice}
        </div>
      )}

      {mayEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className={BTN_GHOST + ' inline-flex items-center gap-1.5'}
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            {isUz ? 'Yangi rol' : 'Новая роль'}
          </button>
        </div>
      )}

      {adding && (
        <NewRole
          isUz={isUz}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.admin.createRole(input);
              setAdding(false);
              setNotice(isUz ? 'Rol yaratildi' : 'Роль заведена');
              await load();
            } catch (e) {
              setError(e as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {/* Матрица: на широком экране таблицей, на узком — ролями по очереди.
          Двадцать шесть прав на шесть ролей в 360 px не поместить никак, а
          боковая прокрутка в таблице прав — худший из вариантов: человек не
          видит, в каком столбце ставит галочку. */}
      <div className={CARD + ' hidden lg:block overflow-x-auto min-w-0'}>
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500">
              <th className="px-3 py-2 font-medium">{isUz ? 'Huquq' : 'Право'}</th>
              {roles.map((r) => (
                <th key={r.code} className="px-2 py-2 font-medium text-center align-bottom">
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-zinc-900 dark:text-zinc-100 break-words">
                      {refName(r, isUz)}
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      {isUz ? `${r.users} kishi` : `${r.users} чел.`}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <React.Fragment key={m.module}>
                <tr className="bg-zinc-50/50 dark:bg-zinc-900/30">
                  <td
                    colSpan={roles.length + 1}
                    className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500"
                  >
                    {refName(m, isUz)}
                  </td>
                </tr>
                {m.permissions.map((p) => (
                  <tr
                    key={p.code}
                    className="border-b border-zinc-100 dark:border-zinc-800/60 last:border-0"
                  >
                    <td className="px-3 py-2 min-w-0">
                      <div className="flex flex-col">
                        <span className="text-zinc-800 dark:text-zinc-200 break-words">
                          {isUz ? p.descriptionUz : p.descriptionRu}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono break-all">
                          {p.code}
                        </span>
                      </div>
                    </td>
                    {roles.map((r) => {
                      const on = (draft[r.code] ?? []).includes(p.code);
                      return (
                        <td key={`${r.code}:${p.code}`} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            disabled={!mayEdit || busy}
                            aria-label={`${refName(r, isUz)} — ${p.code}`}
                            aria-pressed={on}
                            onClick={() => toggle(r.code, p.code)}
                            className={
                              'w-5 h-5 inline-flex items-center justify-center rounded border transition-colors ' +
                              (mayEdit ? 'cursor-pointer ' : 'cursor-not-allowed ') +
                              (on
                                ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                                : 'border-zinc-300 dark:border-zinc-700 text-transparent hover:border-zinc-400')
                            }
                          >
                            <Check className="w-3 h-3" />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="px-3 py-2 text-[11px] text-zinc-500">
                {isUz ? 'O‘zgarishlar' : 'Изменения'}
              </td>
              {roles.map((r) => (
                <td key={r.code} className="px-2 py-2 text-center">
                  {mayEdit && dirty(r) ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => save(r)}
                      className={BTN_PRIMARY + ' h-7'}
                    >
                      {isUz ? 'Saqlash' : 'Сохранить'}
                    </button>
                  ) : (
                    <span className="text-[11px] text-zinc-400">—</span>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 360: роль за ролью, права списком с галочками */}
      <div className="flex flex-col gap-3 lg:hidden min-w-0">
        {roles.map((r) => (
          <div key={r.code} className={CARD + ' p-3 flex flex-col gap-2 min-w-0'}>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {refName(r, isUz)}
              </span>
              <span className="text-[11px] text-zinc-400 font-mono break-all">{r.code}</span>
              <span className="text-[11px] text-zinc-500 ms-auto">
                {isUz ? `${r.users} kishi` : `${r.users} чел.`}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              {modules.map((m) => (
                <div key={m.module} className="flex flex-col gap-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                    {refName(m, isUz)}
                  </span>
                  {m.permissions.map((p) => {
                    const on = (draft[r.code] ?? []).includes(p.code);
                    return (
                      <label
                        key={p.code}
                        className="flex items-start gap-2 text-[11px] text-zinc-700 dark:text-zinc-300 min-w-0 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!mayEdit || busy}
                          onChange={() => toggle(r.code, p.code)}
                          className="mt-0.5 shrink-0"
                        />
                        <span className="break-words">{isUz ? p.descriptionUz : p.descriptionRu}</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            {mayEdit && (
              <div className="flex flex-wrap gap-2">
                {dirty(r) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save(r)}
                    className={BTN_PRIMARY + ' h-7'}
                  >
                    {isUz ? 'Saqlash' : 'Сохранить'}
                  </button>
                )}
                {!r.isSystem && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(r)}
                    className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                  >
                    <Trash2 className="w-3 h-3 shrink-0" />
                    {isUz ? 'O‘chirish' : 'Удалить'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Удаление своей роли на широком экране: в подвале матрицы ему места
          нет — там по кнопке на столбец, и «Удалить» рядом с «Сохранить»
          нажимали бы по ошибке. */}
      {mayEdit && roles.some((r) => !r.isSystem) && (
        <div className="hidden lg:flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'O‘z rollari:' : 'Свои роли:'}
          </span>
          {roles
            .filter((r) => !r.isSystem)
            .map((r) => (
              <button
                key={r.code}
                type="button"
                disabled={busy}
                onClick={() => remove(r)}
                className={BTN_GHOST + ' h-7 inline-flex items-center gap-1'}
                title={
                  isUz
                    ? 'Faqat hech kimga berilmagan rol o‘chiriladi'
                    : 'Удалится только роль, которая никому не назначена'
                }
              >
                <Trash2 className="w-3 h-3 shrink-0" />
                {refName(r, isUz)}
              </button>
            ))}
        </div>
      )}
    </div>
  );
};

const NewRole: React.FC<{
  isUz: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    code: string;
    nameRu: string;
    nameUz: string;
    permissions: string[];
  }) => void;
}> = ({ isUz, busy, onCancel, onSubmit }) => {
  const [code, setCode] = useState('');
  const [nameRu, setNameRu] = useState('');
  const [nameUz, setNameUz] = useState('');
  const codeOk = /^[a-z][a-z0-9_]{2,31}$/.test(code);

  return (
    <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 min-w-0">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {isUz ? 'Kod' : 'Код'}
          </span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase().trim())}
            placeholder="shift_master"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {isUz ? 'Nomi (ruscha)' : 'Название по-русски'}
          </span>
          <input value={nameRu} onChange={(e) => setNameRu(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {isUz ? 'Nomi (o‘zbekcha)' : 'Название по-узбекски'}
          </span>
          <input value={nameUz} onChange={(e) => setNameUz(e.target.value)} className={FIELD} />
        </label>
      </div>
      <p className="text-[11px] text-zinc-500 break-words">
        {isUz
          ? 'Rol bo‘sh huquqlar bilan yaratiladi: belgilarni matritsada qo‘yasiz.'
          : 'Роль заводится без прав — галочки проставите в матрице. Код после заведения не меняется: ' +
            'на него ссылаются назначения.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !codeOk || nameRu.trim().length < 2 || nameUz.trim().length < 2}
          onClick={() =>
            onSubmit({
              code,
              nameRu: nameRu.trim(),
              nameUz: nameUz.trim(),
              permissions: [],
            })
          }
          className={BTN_PRIMARY}
        >
          {isUz ? 'Yaratish' : 'Завести'}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};
