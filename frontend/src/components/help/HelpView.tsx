import React from 'react';
import { ArrowLeft, BookOpen, Search, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { CARD, FIELD, Empty } from '../modules/warehouse-ui';
import { HelpMarkdown } from './HelpMarkdown';
import {
  TOPIC_ORDER,
  TOPIC_TITLE,
  articleBySlug,
  type HelpArticle,
  type HelpTopic,
} from '../../help/articles.ts';
import { matchArticles, visibleArticles } from '../../help/access.ts';
import { helpBody, helpHaystack } from '../../help/content.ts';

/**
 * Раздел «Справка» (задача Отабека от 07.10).
 *
 * Два состояния: список статей с поиском и статья на всю карточку. Отдельного
 * окна поверх интерфейса нет намеренно — инструкцию читают долго, рядом с ней
 * открывают тот самый экран, и модальное окно пришлось бы закрывать на каждом
 * шаге.
 *
 * Что показывать, решают права: сотрудник видит статьи своих разделов, статьи
 * администратора — только роли с правом на «Настройки» (`help/access.ts`).
 */
export const HelpView: React.FC = () => {
  const { locale, helpSlug, openHelp } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';

  const [query, setQuery] = React.useState('');

  const mine = React.useMemo(() => visibleArticles(can), [can]);

  /**
   * Строка поиска идёт по заголовку, подзаголовку и **тексту** статьи.
   *
   * Только по заголовкам было бы повторением списка: человек ищет «сторно» или
   * «просрочка», а не «журнал движений». Русский заголовок в строке поиска
   * остаётся всегда — в узбекском интерфейсе половина текста пока русская, и
   * терять по ней находки нельзя.
   */
  const found = React.useMemo(() => {
    const items = mine.map((article) => ({
      article,
      haystack: helpHaystack(article, isUz ? 'uz' : 'ru'),
    }));
    return matchArticles(items, query).map((it) => it.article);
  }, [mine, query, isUz]);

  const opened = helpSlug ? articleBySlug(helpSlug) : null;
  /** Открытая статья обязана быть разрешённой: в неё ведёт и кнопка «?». */
  const allowed = opened && mine.some((a) => a.slug === opened.slug) ? opened : null;

  if (allowed) return <Article article={allowed} isUz={isUz} onOpen={openHelp} />;

  const byTopic = TOPIC_ORDER.map((topic) => ({
    topic,
    items: found.filter((a) => a.topic === topic),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-3 min-w-0" data-screen="help">
      <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
        <div className="flex items-start gap-2.5 min-w-0">
          <BookOpen className="w-4 h-4 shrink-0 mt-0.5 text-zinc-400" />
          <div className="flex flex-col min-w-0">
            <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50 break-words">
              {isUz ? 'Yordam' : 'Справка'}
            </h2>
            <p className="text-zinc-500 text-xs break-words">
              {isUz
                ? 'Bo‘limlar bo‘yicha qadamli ko‘rsatmalar. Faqat sizga ochiq bo‘limlar ko‘rinadi.'
                : 'Пошаговые инструкции по разделам. Видны только те разделы, которые открыты вам.'}
            </p>
          </div>
        </div>

        {/* Поиск: поле на всю ширину, крестик очищает. На 360 это единственный
            способ не прокручивать весь список до нужной статьи. */}
        <div className="relative min-w-0">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-role="help-search"
            aria-label={isUz ? 'Yordamda qidirish' : 'Поиск по справке'}
            placeholder={
              isUz ? 'Masalan: storno, inventarizatsiya, parol' : 'Например: сторно, инвентаризация, пароль'
            }
            className={FIELD + ' pl-8 pr-8'}
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={isUz ? 'Tozalash' : 'Очистить'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {byTopic.length === 0 ? (
        <div className={CARD}>
          <Empty
            text={
              isUz
                ? `«${query}» bo‘yicha maqola topilmadi. Boshqa so‘z bilan urinib ko‘ring.`
                : `По запросу «${query}» статей нет. Попробуйте другое слово.`
            }
          />
        </div>
      ) : (
        byTopic.map((group) => (
          <section key={group.topic} className={CARD + ' p-4 flex flex-col gap-2 min-w-0'}>
            <h3
              data-help-group={group.topic}
              className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
            >
              {topicTitle(group.topic, isUz)}
            </h3>
            {/* Сетка, а не подогнанные ширины: на 360 одна колонка, с 640 — две. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
              {group.items.map((a) => (
                <button
                  key={a.slug}
                  type="button"
                  data-help-article={a.slug}
                  onClick={() => openHelp(a.slug)}
                  className="text-left rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer min-w-0"
                >
                  <span className="block text-xs font-medium text-zinc-950 dark:text-zinc-50 break-words">
                    {isUz ? a.uz : a.ru}
                  </span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 break-words">
                    {isUz ? a.uzLead : a.ruLead}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
};

const topicTitle = (topic: HelpTopic, isUz: boolean) =>
  isUz ? TOPIC_TITLE[topic].uz : TOPIC_TITLE[topic].ru;

const Article: React.FC<{
  article: HelpArticle;
  isUz: boolean;
  onOpen: (slug: string | null) => void;
}> = ({ article, isUz, onOpen }) => {
  const body = helpBody(article.slug, isUz ? 'uz' : 'ru');

  return (
    <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'} data-screen="help-article">
      <button
        type="button"
        onClick={() => onOpen(null)}
        data-role="help-back"
        className="self-start inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {isUz ? 'Barcha maqolalar' : 'Все статьи'}
      </button>

      <div className="flex flex-col min-w-0">
        <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          {topicTitle(article.topic, isUz)}
        </span>
        <h2
          data-role="help-title"
          className="text-sm font-semibold text-zinc-950 dark:text-zinc-50 break-words"
        >
          {isUz ? article.uz : article.ru}
        </h2>
        <p className="text-zinc-500 text-xs break-words">{isUz ? article.uzLead : article.ruLead}</p>
      </div>

      {/* Требование заказчика: нет узбекского перевода — статья по-русски и с
          пометкой, а не пустая карточка. */}
      {body?.fallback && (
        <div
          data-role="help-fallback"
          className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-[11px] text-zinc-600 dark:text-zinc-400 break-words"
        >
          Bu maqolaning o‘zbekcha tarjimasi hali yo‘q — matn rus tilida ko‘rsatilgan.
          <span className="block text-zinc-500 dark:text-zinc-500">
            Узбекского перевода этой статьи пока нет — текст показан по-русски.
          </span>
        </div>
      )}

      {body ? (
        <HelpMarkdown markdown={body.markdown} onOpen={onOpen} />
      ) : (
        <Empty
          text={
            isUz
              ? 'Maqola matni topilmadi. Ishlab chiquvchiga xabar bering.'
              : 'Текст статьи не найден. Сообщите разработчику.'
          }
        />
      )}
    </div>
  );
};
