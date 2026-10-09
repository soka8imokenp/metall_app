/**
 * Какие компании доступны пользователю.
 *
 * Фронт знает компании под своими ключами (`company_trade`, `company_factory`),
 * бэкенд — по кодам (`trade`, `plant`). Состав приходит в сессии и зависит от
 * назначений роли: у мастера цеха там один завод, у директора обе компании.
 *
 * Отсюда берут список и переключатель в сайдбаре, и выбор по умолчанию: иначе
 * в шапке стоит торговый дом, а на экране — заводские заказы, потому что
 * заголовок X-Company-Id для недоступной компании не уходит вовсе и сервер
 * отдаёт то, что разрешено ролью.
 */

import { AuthCompany, CompanyId } from '../types/api';

const KEY_BY_CODE: Record<string, CompanyId> = {
  trade: 'company_trade',
  plant: 'company_factory',
};

/**
 * Ключи в порядке показа. Сводный холдинг добавляется только тогда, когда
 * сводить есть что: с одной компанией пункт «все» ничего не меняет.
 */
export function availableCompanyKeys(companies: AuthCompany[]): CompanyId[] {
  const keys: CompanyId[] = [];
  for (const code of ['trade', 'plant']) {
    const key = KEY_BY_CODE[code];
    if (key && companies.some((c) => c.code === code)) keys.push(key);
  }
  if (keys.length > 1) keys.push('all');
  return keys;
}
