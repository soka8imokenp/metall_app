import React, { useState } from 'react';
import { KeyRound, Loader2, LogOut, Moon, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { ApiError } from '../../lib/api-client';
import { BrandMark, BrandWordmark } from '../common/Brand';
import { LoginBackdrop } from './LoginBackdrop';
import { CARD, FILL, INPUT, LABEL, LINK, SUBMIT, SWITCH } from './auth-ui';

/**
 * Обязательная смена пароля (требование Отабека от 06.10: «после первого входа
 * человек обязан сменить пароль, пока не сменит — дальше не пускать»).
 *
 * Это **экран**, а не окно поверх интерфейса. Окно пришлось бы запирать от
 * закрытия — от Escape, от щелчка мимо, от кнопки «назад», — и каждая такая
 * запертая дверь однажды открывается. Здесь обходить нечего: пока сервер
 * держит признак, за этим экраном ничего не отрисовано, а сам сервер на
 * любой другой маршрут отвечает отказом. Прячется он только тогда, когда
 * признак снят, и снимает его сервер, а не кнопка.
 *
 * Выход оставлен: человек мог войти не своей учёткой или решить, что пароль
 * ему сбросят заново. Запирать его внутри незачем — данных он всё равно не
 * видит.
 *
 * Поля — те же, что на входе, и оформление то же (`auth-ui.ts`): человек
 * видит эти два экрана подряд, одной задачей.
 */

const TEXT = {
  ru: {
    title: 'Измените пароль',
    hint:
      'Этот пароль выдан вам и известен не только вам: его знает тот, кто ' +
      'заводил учётную запись. Придумайте свой — до этого система закрыта.',
    account: 'Учётная запись',
    current: 'Текущий пароль',
    next: 'Новый пароль',
    repeat: 'Повторите новый пароль',
    // Образец пароля по умолчанию здесь не называем: он «роль123», и назвать
    // его на экране — всё равно что написать на двери код замка.
    rule: 'Не короче 8 знаков. Выданный вам пароль по умолчанию не подойдёт.',
    submit: 'Сменить пароль и войти',
    pending: 'Меняю…',
    logout: 'Выйти и войти другой учётной записью',
    light: 'Включить светлую тему',
    dark: 'Включить тёмную тему',
    mismatch: 'Пароли не совпадают',
    short: 'Новый пароль короче 8 знаков',
    wrong: 'Текущий пароль неверен',
    network: 'Сервер недоступен. Проверьте, что бэкенд запущен.',
    other: 'Не удалось сменить пароль',
  },
  uz: {
    title: 'Parolni o‘zgartiring',
    hint:
      'Bu parol sizga berilgan va faqat sizga ma’lum emas: uni hisobni ochgan ' +
      'odam ham biladi. O‘zingizning parolingizni o‘ylab toping — shunga qadar ' +
      'tizim yopiq.',
    account: 'Hisob',
    current: 'Hozirgi parol',
    next: 'Yangi parol',
    repeat: 'Yangi parolni takrorlang',
    rule: 'Kamida 8 belgi. Sizga berilgan standart parol yaramaydi.',
    submit: 'Parolni o‘zgartirib kirish',
    pending: 'O‘zgartiryapman…',
    logout: 'Chiqish va boshqa hisob bilan kirish',
    light: 'Yorug‘ mavzuni yoqish',
    dark: 'Qorong‘i mavzuni yoqish',
    mismatch: 'Parollar bir xil emas',
    short: 'Yangi parol 8 belgidan qisqa',
    wrong: 'Hozirgi parol xato',
    network: 'Server mavjud emas. Backend ishga tushganini tekshiring.',
    other: 'Parolni o‘zgartirib bo‘lmadi',
  },
} as const;

/** Нижняя граница та же, что на сервере (`auth.service.ts`, `MIN_PASSWORD`). */
const MIN = 8;

type ErrKey = 'mismatch' | 'short' | 'wrong' | 'network' | 'other';

export const ChangePasswordScreen: React.FC = () => {
  const { session, changePassword, logout, isPending } = useAuth();
  const { theme, toggleTheme, locale, setLocale } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  // Ошибка хранится ключом, а не готовой строкой: переключив язык после
  // отказа, человек должен увидеть причину на своём языке, а не ту, что
  // успела записаться. То же решение, что на экране входа.
  const [err, setErr] = useState<{ key: ErrKey; raw?: string } | null>(null);

  const t = TEXT[locale === 'uz' ? 'uz' : 'ru'];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    // Два поля на новый пароль сверяются здесь: сервер видит только одно, и
    // опечатка в новом пароле иначе запирает учётку наглухо — старый уже не
    // работает, а нового человек не знает.
    if (next !== repeat) {
      setErr({ key: 'mismatch' });
      return;
    }
    if (next.length < MIN) {
      setErr({ key: 'short' });
      return;
    }

    try {
      await changePassword(current, next);
    } catch (e2) {
      if (e2 instanceof ApiError) {
        if (e2.code === 'NETWORK_ERROR') setErr({ key: 'network' });
        else if (e2.status === 401) setErr({ key: 'wrong' });
        // 422 — отказ по содержанию пароля (дефолтный, совпал с текущим).
        // Текст приходит с сервера на языке запроса, и свой здесь был бы
        // вторым переводом того же правила.
        else setErr({ key: 'other', raw: e2.message });
      } else {
        setErr({ key: 'other' });
      }
    }
  };

  const disabled =
    isPending || current.length < 1 || next.length < MIN || repeat.length < MIN;

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-white dark:bg-[#09090b]">
      <LoginBackdrop />

      <div className="relative z-10 flex min-h-screen items-center justify-center p-4">
        <div className="flex w-full max-w-[400px] flex-col gap-5 min-w-0">
          <div className="flex flex-col items-center gap-3">
            <BrandMark className="h-10 w-10" />
            <BrandWordmark className="h-4" />
          </div>

          <form className={CARD} onSubmit={submit} data-screen="change-password">
            <div className="flex flex-col gap-2">
              <h1 className="flex items-center gap-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">
                <KeyRound className="h-4 w-4 shrink-0 text-zinc-400" />
                {t.title}
              </h1>
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400 break-words">
                {t.hint}
              </p>
              {/* Кого именно просят сменить пароль: на стенде в одном браузере
                  входят девятью учётками подряд, и без логина на экране легко
                  менять пароль не той.

                  Подпись обязательна. Голый логин заказчик 06.10 прочитал как
                  сбой («непонятный текст на панели»): на снимке туда попала
                  временная учётка прогона, и строка без подписи выглядит
                  мусором, а не именем учётной записи. */}
              <p
                className="text-xs text-zinc-500 dark:text-zinc-500 break-all"
                data-role="change-password-account"
              >
                {t.account}:{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {session?.user.login}
                </span>
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={LABEL} htmlFor="cp-current">
                {t.current}
              </label>
              <input
                id="cp-current"
                type="password"
                autoComplete="current-password"
                className={INPUT}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={LABEL} htmlFor="cp-next">
                {t.next}
              </label>
              <input
                id="cp-next"
                type="password"
                autoComplete="new-password"
                className={INPUT}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-500 break-words">
                {t.rule}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={LABEL} htmlFor="cp-repeat">
                {t.repeat}
              </label>
              <input
                id="cp-repeat"
                type="password"
                autoComplete="new-password"
                className={INPUT}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </div>

            {err && (
              <p
                role="alert"
                className="text-xs text-red-600 dark:text-red-400 break-words"
                data-role="change-password-error"
              >
                {err.key === 'other' && err.raw ? err.raw : t[err.key]}
              </p>
            )}

            <button type="submit" className={SUBMIT} disabled={disabled}>
              {!disabled && <span className={FILL} aria-hidden />}
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {isPending ? t.pending : t.submit}
            </button>

            <button type="button" className={LINK + ' inline-flex items-center gap-1.5 self-start'} onClick={logout}>
              <LogOut className="h-3 w-3 shrink-0" />
              {t.logout}
            </button>
          </form>

          <div className="flex items-center justify-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-zinc-900/5 dark:bg-white/5 p-0.5">
              {(['ru', 'uz'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLocale(l)}
                  className={
                    SWITCH +
                    (locale === l
                      ? ' bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-xs'
                      : ' text-zinc-500 dark:text-zinc-400')
                  }
                >
                  {l === 'ru' ? 'RU' : 'UZ'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === 'dark' ? t.light : t.dark}
              aria-label={theme === 'dark' ? t.light : t.dark}
              className="rounded-lg p-1.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
