import { HELP_ARTICLES, TOPIC_ORDER, type HelpArticle } from './articles.ts';
import { moduleAllowed } from '../lib/modules.ts';

/**
 * Кому видна статья справки.
 *
 * Требование заказчика (07.10): сотрудник видит статьи своих модулей, статьи
 * администратора — только роли с правом на «Настройки».
 *
 * Отбор идёт по той же таблице `MODULE_PERMISSIONS`, что отбирает пункты
 * меню и разделы в `App.tsx`. Отдельного условия здесь нет намеренно: иначе
 * у кладовщика однажды окажется в справке инструкция по финансам, которых он
 * не видит, и он пойдёт искать кнопку, которой у него нет.
 *
 * Это оформление, а не ограничение доступа: текст статей лежит в бандле и
 * доступен любому, кто его откроет. Секретов в статьях нет — ни паролей, ни
 * ключей, и быть не должно.
 */
export const articleVisible = (article: HelpArticle, can: (p: string) => boolean): boolean => {
  if (article.audience === 'admin') return moduleAllowed('admin', can);
  if (article.topic === 'general' || article.topic === 'help') return true;
  return moduleAllowed(article.topic, can);
};

/** Статьи, открытые этим правам, в порядке тем и внутри темы — как в описи. */
export const visibleArticles = (can: (p: string) => boolean): HelpArticle[] => {
  const rank = new Map(TOPIC_ORDER.map((t, i) => [t, i]));
  return HELP_ARTICLES.filter((a) => articleVisible(a, can)).sort(
    (a, b) => (rank.get(a.topic) ?? 99) - (rank.get(b.topic) ?? 99),
  );
};

export interface HelpSearchItem {
  article: HelpArticle;
  /** Заголовок, подзаголовок и текст статьи одной строкой. */
  haystack: string;
}

/**
 * Приведение строки к виду, по которому сравниваем.
 *
 * «ё» к «е» — не придирка: кладовщик наберёт «учет расхождений», а в тексте
 * статьи стоит «учёт», и поиск вернёт пусто там, где статья есть.
 */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/ /g, ' ');

/**
 * Отбор по строке поиска: нужны все слова запроса, порядок не важен.
 *
 * «Все слова», а не «любое»: по «склад» в справке склада найдётся всё, и
 * поиск перестанет сужать. Пустой запрос не отсеивает ничего — список
 * показывается целиком.
 */
export const matchArticles = (items: HelpSearchItem[], query: string): HelpSearchItem[] => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((it) => {
    const hay = fold(it.haystack);
    return words.every((w) => hay.includes(w));
  });
};
