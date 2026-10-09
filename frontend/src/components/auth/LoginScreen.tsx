import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, LogIn, Moon, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { apiClient, apiUsesMocks, ApiError } from '../../lib/api-client';
import { BrandMark, BrandWordmark } from '../common/Brand';
import { LoginBackdrop } from './LoginBackdrop';
import { APP_VERSION } from '../../lib/app-version';
// Оформление карточки общее с экраном обязательной смены пароля: эти два
// человек видит подряд, одной задачей.
import { CARD, FILL, INPUT, LABEL, LINK, SUBMIT, SWITCH } from './auth-ui';

/**
 * Вход в систему. Раскладка — центральная колонка shadcn `login-05`: знак,
 * название, форма, и ничего больше. Раскладка на flex, без подогнанных
 * пикселей: форма одинаково стоит и на 360, и на 1440.
 *
 * Текст ошибки хранится ключом, а не готовой строкой: переключив язык после
 * неудачного входа, человек должен увидеть ошибку на своём языке, а не ту,
 * что успела записаться.
 *
 * «Забыли пароль» открывается не окном поверх, а сменой содержимого той же
 * карточки. Окно поверх пришлось бы закрывать, чтобы вернуться к полям, и на
 * 360 оно заняло бы весь экран — то же самое, только с лишней рамкой.
 */

type ErrKey = 'network' | 'invalid' | 'blocked' | 'other';

const TEXT = {
  ru: {
    subtitle: 'Единая система управления',
    login: 'Логин',
    password: 'Пароль',
    submit: 'Войти',
    pending: 'Вхожу…',
    access: 'Доступ выдаёт администратор компании',
    light: 'Включить светлую тему',
    dark: 'Включить тёмную тему',
    network: 'Сервер недоступен. Проверьте, что бэкенд запущен.',
    invalid: 'Неверный логин или пароль',
    blocked: 'Учётная запись временно заблокирована',
    other: 'Не удалось войти',
    mocks:
      'Режим моков: данные ненастоящие. Живой бэкенд включается переменными ' +
      'VITE_USE_MOCKS=false и VITE_API_URL.',
    forgot: 'Забыли пароль?',
    resetTitle: 'Восстановление доступа',
    resetHint:
      'Новый пароль выдаёт администратор — система его не присылает. ' +
      'Оставьте заявку, с вами свяжутся и передадут пароль лично.',
    contact: 'Как с вами связаться',
    contactHolder: 'Телефон или почта',
    note: 'Комментарий',
    noteHolder: 'Необязательно: отдел, должность, что случилось',
    send: 'Отправить заявку',
    sending: 'Отправляю…',
    back: 'Вернуться ко входу',
    sentTitle: 'Заявка принята',
    sentText:
      'Администратор увидит её и свяжется с вами по указанным данным. ' +
      'Пароль приходит от человека, а не письмом из системы.',
  },
  uz: {
    subtitle: 'Yagona boshqaruv tizimi',
    login: 'Login',
    password: 'Parol',
    submit: 'Kirish',
    pending: 'Kiryapman…',
    access: 'Kirish huquqini kompaniya administratori beradi',
    light: 'Yorug‘ mavzuni yoqish',
    dark: 'Qorong‘i mavzuni yoqish',
    network: 'Server javob bermayapti. Backend ishga tushirilganini tekshiring.',
    invalid: 'Login yoki parol noto‘g‘ri',
    blocked: 'Hisob vaqtincha bloklangan',
    other: 'Kirib bo‘lmadi',
    mocks:
      'Mok-rejim: ma’lumotlar haqiqiy emas. Jonli backend VITE_USE_MOCKS=false ' +
      'va VITE_API_URL o‘zgaruvchilari bilan yoqiladi.',
    forgot: 'Parolni unutdingizmi?',
    resetTitle: 'Kirishni tiklash',
    resetHint:
      'Yangi parolni administrator beradi — tizim uni yubormaydi. ' +
      'Ariza qoldiring, siz bilan bog‘lanib parolni shaxsan topshiradi.',
    contact: 'Siz bilan qanday bog‘lanamiz',
    contactHolder: 'Telefon yoki pochta',
    note: 'Izoh',
    noteHolder: 'Majburiy emas: bo‘lim, lavozim, nima bo‘lgani',
    send: 'Ariza yuborish',
    sending: 'Yuboryapman…',
    back: 'Kirishga qaytish',
    sentTitle: 'Ariza qabul qilindi',
    sentText:
      'Administrator uni ko‘radi va ko‘rsatilgan ma’lumotlar bo‘yicha bog‘lanadi. ' +
      'Parolni tizim emas, odam beradi.',
  },
} as const;

export const LoginScreen: React.FC = () => {
  const { login, isPending } = useAuth();
  const { theme, toggleTheme, locale, setLocale } = useApp();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<{ key: ErrKey; raw?: string } | null>(null);
  const [view, setView] = useState<'login' | 'reset' | 'sent'>('login');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const t = TEXT[locale === 'uz' ? 'uz' : 'ru'];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await login(loginName.trim(), password);
    } catch (e2) {
      if (e2 instanceof ApiError) {
        if (e2.code === 'NETWORK_ERROR') setErr({ key: 'network' });
        else if (e2.code === 'ACCOUNT_LOCKED') setErr({ key: 'blocked' });
        else if (e2.status === 401) setErr({ key: 'invalid' });
        else setErr({ key: 'other', raw: e2.message });
      } else {
        setErr({ key: 'other' });
      }
    }
  };

  // Кнопка гаснет только на пустом поле. Порог длины пароля здесь запирал вход
  // учётке с коротким паролем: пароль задаёт не эта форма, и судить его длину
  // ей нечем. Сторож — qa/login-live.
  const disabled = isPending || loginName.trim().length < 2 || password.length < 1;

  /**
   * Заявка на сброс. Ответ сервера одинаков и на живой логин, и на выдуманный,
   * поэтому экран показывает «принято» без оговорок: рассказывать, нашёлся ли
   * логин, значило бы выдавать список учёток тому, кто их перебирает.
   */
  const sendReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSending(true);
    try {
      await apiClient.auth.requestPasswordReset(loginName.trim(), contact.trim(), note.trim());
      setView('sent');
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'NETWORK_ERROR') setErr({ key: 'network' });
      else setErr({ key: 'other', raw: e2 instanceof ApiError ? e2.message : undefined });
    } finally {
      setSending(false);
    }
  };

  const toView = (next: 'login' | 'reset') => {
    setErr(null);
    setView(next);
  };

  const cantSend = sending || loginName.trim().length < 2 || contact.trim().length < 3;
  const errorLine = err && (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400 leading-relaxed break-words">
      {err.key === 'other' && err.raw ? err.raw : t[err.key]}
    </p>
  );

  return (
    <div className="relative min-h-svh w-full overflow-hidden bg-zinc-50 dark:bg-[#09090b]">
      <LoginBackdrop />

      <div className="rise absolute top-4 right-4 z-10 flex items-center gap-2" style={{ animationDelay: '380ms' }}>
        <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 p-0.5 shadow-2xs backdrop-blur-sm">
          {(['ru', 'uz'] as const).map((loc) => (
            <button
              key={loc}
              type="button"
              onClick={() => setLocale(loc)}
              aria-pressed={locale === loc}
              className={
                SWITCH +
                (locale === loc
                  ? ' bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : ' text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
              }
            >
              {loc.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? t.light : t.dark}
          aria-label={theme === 'dark' ? t.light : t.dark}
          className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100 shadow-2xs backdrop-blur-sm transition-colors cursor-pointer"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
        <div className="w-full max-w-sm flex flex-col gap-6 min-w-0">
          <div className="rise flex flex-col items-center gap-4 text-center">
            <BrandMark className="h-12 sm:h-14" />
            <BrandWordmark className="h-5 sm:h-6" />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.subtitle}</p>
          </div>

          {view === 'login' && (
            <form onSubmit={submit} className="flex flex-col gap-6 min-w-0">
              <div className={'rise ' + CARD} style={{ animationDelay: '140ms' }}>
                <label className="flex flex-col gap-2 min-w-0">
                  <span className={LABEL}>{t.login}</span>
                  <input
                    type="text"
                    autoComplete="username"
                    autoFocus
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    className={INPUT}
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0">
                  <span className={LABEL}>{t.password}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT}
                  />
                </label>

                {errorLine}

                <button type="submit" disabled={disabled} className={SUBMIT}>
                  {!disabled && <span aria-hidden="true" className={FILL} />}
                  {isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <LogIn className="w-4 h-4" />
                  )}
                  <span>{isPending ? t.pending : t.submit}</span>
                </button>

                <button type="button" onClick={() => toView('reset')} className={LINK}>
                  {t.forgot}
                </button>
              </div>

              <p
                className="rise text-center text-xs text-zinc-600 dark:text-zinc-400 break-words"
                style={{ animationDelay: '280ms' }}
              >
                {t.access}
              </p>
            </form>
          )}

          {view === 'reset' && (
            <form onSubmit={sendReset} className="flex flex-col gap-6 min-w-0">
              <div className={'rise ' + CARD}>
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
                    {t.resetTitle}
                  </h1>
                  <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {t.resetHint}
                  </p>
                </div>

                <label className="flex flex-col gap-2 min-w-0">
                  <span className={LABEL}>{t.login}</span>
                  <input
                    type="text"
                    autoComplete="username"
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    className={INPUT}
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0">
                  <span className={LABEL}>{t.contact}</span>
                  <input
                    type="text"
                    placeholder={t.contactHolder}
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    className={INPUT}
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0">
                  <span className={LABEL}>{t.note}</span>
                  <textarea
                    rows={2}
                    placeholder={t.noteHolder}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className={INPUT + ' h-auto py-2 resize-none'}
                  />
                </label>

                {errorLine}

                <button type="submit" disabled={cantSend} className={SUBMIT}>
                  {!cantSend && <span aria-hidden="true" className={FILL} />}
                  {sending && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{sending ? t.sending : t.send}</span>
                </button>

                <button type="button" onClick={() => toView('login')} className={LINK}>
                  <ArrowLeft className="w-3 h-3 inline-block me-1 align-[-1px]" />
                  {t.back}
                </button>
              </div>
            </form>
          )}

          {view === 'sent' && (
            <div className={'rise ' + CARD + ' items-center text-center'}>
              <CheckCircle2 className="w-8 h-8 text-zinc-400 dark:text-zinc-500" />
              <div className="flex flex-col gap-1.5">
                <h1 className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
                  {t.sentTitle}
                </h1>
                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {t.sentText}
                </p>
              </div>
              <button type="button" onClick={() => toView('login')} className={LINK}>
                <ArrowLeft className="w-3 h-3 inline-block me-1 align-[-1px]" />
                {t.back}
              </button>
            </div>
          )}

          {apiUsesMocks() && (
            <p className="text-xs text-amber-600 dark:text-amber-500 leading-relaxed break-words">
              {t.mocks}
            </p>
          )}

          {/* Версия сборки — до входа, а не только внутри.
              Когда спорят «выкачено» против «не вижу», ответ должен читаться с
              первого экрана: открыл адрес — увидел версию. Иначе человека
              приходится вести через вход и мелкую строку в углу, и разговор
              буксует на каждом шаге. */}
          <p className="text-[10px] font-mono text-zinc-400 dark:text-zinc-600 break-all">
            {`v ${APP_VERSION}`}
          </p>
        </div>
      </div>
    </div>
  );
};
