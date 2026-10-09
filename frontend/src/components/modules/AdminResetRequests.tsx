import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, UserX } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { PasswordResetRequest } from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';

/**
 * Очередь заявок на сброс пароля.
 *
 * Система пароль не рассылает: тракта рассылки нет ни в одном модуле, а
 * отправлять новый пароль по одному знанию логина — отдавать учётку тому, кто
 * логин угадал. Поэтому заявка попадает сюда, человека узнают и пароль
 * выдают тем способом, которым у них принято.
 *
 * Строка прямо говорит, есть ли такая учётка. Заявку принимают на любой
 * набранный логин — иначе форма входа становится справочником учёток, — и
 * разбирающий должен видеть, что «логина нет», а не искать его сам.
 */

const when = (iso: string, isUz: boolean) =>
  new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export const AdminResetRequests: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayHandle = session?.permissions.includes('admin.users') ?? false;

  const [rows, setRows] = useState<PasswordResetRequest[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.auth.resetRequests(all ? 'all' : 'new');
      setRows(res.data.rows);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [all]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Выданный пароль. Живёт только в этом состоянии и только до перезагрузки:
   * сервер его больше не отдаёт ни по какому запросу. Поэтому плашка с ним
   * закрывается руками, а не сама по таймеру — пароль надо успеть передать.
   */
  const [issued, setIssued] = useState<{ login: string; password: string } | null>(null);

  const handle = async (uid: string, action: 'done' | 'rejected', login: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.auth.handleResetRequest(uid, action, note.trim() || undefined);
      setOpenUid(null);
      setNote('');
      if (res.data.password) setIssued({ login, password: res.data.password });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const statusText = (r: PasswordResetRequest) =>
    r.status === 'new'
      ? isUz ? 'navbatda' : 'в очереди'
      : r.status === 'done'
        ? isUz ? 'parol berildi' : 'пароль выдан'
        : isUz ? 'rad etildi' : 'отклонена';

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Tizim parolni yubormaydi. Odam ariza qoldiradi, siz uni tanib «Parolni tiklash» ' +
            'ni bosasiz — tizim vaqtinchalik parol beradi va uni bir marta, shu yerda ' +
            'ko‘rsatadi. Parolni odatdagi usulda o‘zingiz topshirasiz. Odam u bilan kiradi va ' +
            'darhol o‘z parolini qo‘yadi.'
          : 'Система пароль не присылает. Человек оставляет заявку, вы узнаёте его и нажимаете ' +
            '«Сбросить пароль» — система выдаст временный пароль и покажет его один раз, здесь. ' +
            'Передаёте его сами, тем способом, которым у вас принято. Человек войдёт по нему и ' +
            'сразу поставит свой.'}
      </div>

      {/* Пароль показывается один раз: сервер его больше не отдаст ни по
          какому запросу. Поэтому плашка стоит наверху, закрывается руками и
          не исчезает сама — пароль надо успеть передать. */}
      {issued && (
        <div
          className={
            CARD +
            ' p-4 flex flex-col gap-2 min-w-0 ring-1 ring-amber-500/40 bg-amber-50/60 dark:bg-amber-500/5'
          }
          role="alert"
          data-role="issued-password"
        >
          <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
            {isUz
              ? `«${issued.login}» uchun vaqtinchalik parol`
              : `Временный пароль для «${issued.login}»`}
          </div>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <code className="px-2 py-1 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 font-mono text-sm text-zinc-950 dark:text-zinc-50 break-all select-all">
              {issued.password}
            </code>
            <button type="button" className={BTN_GHOST} onClick={() => setIssued(null)}>
              {isUz ? 'Yopish' : 'Закрыть'}
            </button>
          </div>
          <div className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
            {isUz
              ? 'Boshqa marta ko‘rsatilmaydi va tizimda saqlanmaydi. Hozir topshiring — ' +
                'odam u bilan kiradi va o‘z parolini qo‘yadi.'
              : 'Второй раз он не покажется и в системе не хранится. Передайте сейчас — ' +
                'человек войдёт по нему и поставит свой.'}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {isUz ? 'Yopilganlarini ham ko‘rsatish' : 'Показать закрытые'}
        </label>
      </div>

      {error && <ErrorBox text={error.message} onRetry={load} isUz={isUz} />}

      <div className={CARD + ' flex flex-col min-w-0'}>
        {rows === null && !error ? (
          <Skeleton rows={3} />
        ) : rows && rows.length === 0 ? (
          <Empty
            text={
              isUz
                ? 'Ariza yo‘q — hech kim parolini so‘ramagan.'
                : 'Заявок нет — никто не просил пароль.'
            }
          />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 min-w-0">
            {(rows ?? []).map((r) => (
              <li key={r.uid} className="px-4 py-3 flex flex-col gap-2 min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                    {r.login}
                  </span>
                  {r.known ? (
                    <span className="text-[11px] text-zinc-500 break-words">{r.fullName}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                      <UserX className="w-3 h-3 shrink-0" />
                      {isUz ? 'bunday hisob yo‘q' : 'такой учётки нет'}
                    </span>
                  )}
                  {r.known && r.active === false && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-500">
                      {isUz ? 'hisob o‘chirilgan' : 'учётка выключена'}
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-500 ms-auto">{when(r.createdAt, isUz)}</span>
                </div>

                <div className="text-xs text-zinc-700 dark:text-zinc-300 break-words">
                  {r.contact}
                  {r.note && <span className="text-zinc-500"> — {r.note}</span>}
                </div>

                {r.status !== 'new' && (
                  <div className="text-[11px] text-zinc-500 break-words">
                    {statusText(r)}
                    {r.handledBy && ` · ${r.handledBy}`}
                    {r.handledAt && ` · ${when(r.handledAt, isUz)}`}
                    {r.handledNote && ` · ${r.handledNote}`}
                  </div>
                )}

                {r.status === 'new' && mayHandle && (
                  openUid === r.uid ? (
                    <div className="flex flex-col gap-2 min-w-0">
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={
                          isUz
                            ? 'Izoh: qanday topshirdingiz'
                            : 'Комментарий: как передали пароль'
                        }
                        className={FIELD}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handle(r.uid, 'done', r.login)}
                          className={BTN_PRIMARY}
                          title={
                            isUz
                              ? 'Tizim vaqtinchalik parol beradi va uni bir marta ko‘rsatadi'
                              : 'Система выдаст временный пароль и покажет его один раз'
                          }
                        >
                          {isUz ? 'Parolni tiklash' : 'Сбросить пароль'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handle(r.uid, 'rejected', r.login)}
                          className={BTN_GHOST}
                          title={
                            isUz
                              ? 'Ariza yopiladi, parol berilmaydi'
                              : 'Заявка закроется, пароль не выдаём'
                          }
                        >
                          {isUz ? 'Rad etish' : 'Отклонить'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setOpenUid(null);
                            setNote('');
                          }}
                          className={BTN_GHOST}
                        >
                          {isUz ? 'Bekor qilish' : 'Отмена'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenUid(r.uid);
                          setNote('');
                        }}
                        className={BTN_GHOST + ' inline-flex items-center gap-1.5'}
                      >
                        <KeyRound className="w-3.5 h-3.5 shrink-0" />
                        {isUz ? 'Arizani yopish' : 'Закрыть заявку'}
                      </button>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
