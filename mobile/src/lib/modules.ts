import { Feather } from '@/ui/Icon';
import type { Dict } from '@/i18n/ru';

export type ModuleKey = 'warehouse' | 'production' | 'finance' | 'sales' | 'documents';

export const MODULES: Record<ModuleKey, { icon: keyof typeof Feather.glyphMap; label: keyof Dict; view: string; act: string[] }> = {
  warehouse: { icon: 'package', label: 'tabWarehouse', view: 'warehouse.view', act: ['warehouse.move', 'warehouse.inventory', 'warehouse.writeoff'] },
  production: { icon: 'tool', label: 'tabProduction', view: 'production.view', act: ['production.work', 'production.manage'] },
  finance: { icon: 'credit-card', label: 'tabFinance', view: 'finance.view', act: ['finance.post', 'finance.approve'] },
  sales: { icon: 'shopping-bag', label: 'tabSales', view: 'sales.view', act: ['sales.edit'] },
  documents: { icon: 'file-text', label: 'tabDocuments', view: 'documents.view', act: ['documents.edit', 'documents.approve'] },
};

/** Модули, доступные человеку, — те, с кем он работает руками, идут первыми. */
export function visibleModules(can: (...p: string[]) => boolean): ModuleKey[] {
  const keys = (Object.keys(MODULES) as ModuleKey[]).filter((k) => can(MODULES[k].view));
  const score = (k: ModuleKey) => (can(...MODULES[k].act) ? 0 : 1);
  return keys.sort((a, b) => score(a) - score(b));
}
