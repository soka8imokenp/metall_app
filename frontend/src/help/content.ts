import { articleText } from './markdown.ts';
import type { HelpArticle } from './articles.ts';

/**
 * Тексты статей — в бандл фронта.
 *
 * Статьи лежат файлами в репозитории (`content/ru`, `content/uz`), а не в
 * базе: редактор справки в базе — это отдельный экран, права на него и
 * миграция, а править текст инструкции всё равно будем мы в том же коммите, в
 * котором меняется сам экран. Заказчику обещан раздел в системе, а не
 * редактор, и БД под это не заводим.
 *
 * `eager: true` намеренно: статей три десятка, вместе они весят десятки
 * килобайт, а отложенная загрузка дала бы пустую карточку на секунду и
 * невозможность искать по тексту, пока файлы не приехали.
 *
 * Этот файл — единственный, который умеет только Vite (`import.meta.glob`).
 * Поэтому вся логика (разбор, отбор по правам, поиск) лежит рядом в обычных
 * модулях: их проверяет `node --test` без сборки и без браузера.
 */
const RU = import.meta.glob('./content/ru/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const UZ = import.meta.glob('./content/uz/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export type HelpLocale = 'ru' | 'uz';

export interface HelpBody {
  markdown: string;
  /** На каком языке текст на самом деле. */
  shownIn: HelpLocale;
  /** Просили узбекский, а отдали русский. */
  fallback: boolean;
}

/**
 * Текст статьи.
 *
 * Требование заказчика: нет узбекского перевода — статья показывается
 * по-русски **с пометкой**, а не пустой. Пустая карточка читается как
 * поломка системы, и сотрудник второй раз в справку не пойдёт.
 */
export const helpBody = (slug: string, locale: HelpLocale): HelpBody | null => {
  if (locale === 'uz') {
    const uz = UZ[`./content/uz/${slug}.md`];
    if (uz) return { markdown: uz, shownIn: 'uz', fallback: false };
    const ru = RU[`./content/ru/${slug}.md`];
    return ru ? { markdown: ru, shownIn: 'ru', fallback: true } : null;
  }
  const ru = RU[`./content/ru/${slug}.md`];
  return ru ? { markdown: ru, shownIn: 'ru', fallback: false } : null;
};

/** Заголовок, подзаголовок и весь текст статьи одной строкой — для поиска. */
export const helpHaystack = (article: HelpArticle, locale: HelpLocale): string => {
  const body = helpBody(article.slug, locale);
  const title = locale === 'uz' ? article.uz : article.ru;
  const lead = locale === 'uz' ? article.uzLead : article.ruLead;
  return [title, lead, article.ru, article.ruLead, body ? articleText(body.markdown) : ''].join(' ');
};
