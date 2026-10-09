/**
 * METALL ASIA API Types & Data Contracts
 * Corresponds strictly to 04-API-CONTRACT.md and 03-DATA-MODEL.md.
 * 
 * NOTE FOR BACKEND DEVELOPER / SECOND STAGE AI:
 * All high-precision numerical values (money, quantities, percentages) are represented
 * as strings ("1250000.0000") to avoid IEEE 754 floating-point rounding errors.
 */

export interface ApiResponse<T> {
  data: T;
  meta?: PaginationMeta;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{
      field?: string;
      message: string;
      meta?: Record<string, any>;
    }>;
    requestId?: string;
  };
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  nextCursor?: string;
}

export interface PermissionsMap {
  canView?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canApprove?: boolean;
  canReject?: boolean;
  canPost?: boolean;
  canReverse?: boolean;
  canShip?: boolean;
  canStart?: boolean;
  canPause?: boolean;
  canFinish?: boolean;
  canClose?: boolean;
  [key: string]: boolean | undefined;
}

export type CompanyId = 'company_trade' | 'company_factory' | 'all';

export interface Company {
  uid: string;
  id: string;
  nameRu: string;
  nameUz: string;
  inn: string;
  legalAddress: string;
  baseCurrency: string;
  isActive: boolean;
  roles: string[];
}

export interface UserProfile {
  uid: string;
  fullName: string;
  login: string;
  email: string;
  locale: 'ru' | 'uz';
  avatarUrl?: string;
  role: string;
  telegramLinked: boolean;
}

/* ------------------- CATALOG & ATTRIBUTES ------------------- */
export interface ItemAttributes {
  pipeType?: string;          // круглая, профильная, бесшовная
  steelGrade?: string;        // Ст20, 09Г2С, 17Г1С
  diameterMm?: string;        // 108, 159, 219, 325
  wallThicknessMm?: string;   // 4.0, 6.0, 8.0
  lengthMm?: string;          // 12000
  weightKgPerUnit?: string;   // 10.26
  insulationType?: string;    // ППУ-1, ППУ-2, ОЦ (оцинкованная)
  gost?: string;              // ГОСТ 8732-78, ТУ 14-3Р-50-2001
}

export interface CatalogItem {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  itemType: 'raw' | 'goods' | 'component' | 'semi' | 'finished';
  baseUnit: { code: string; nameRu: string; nameUz: string };
  attributes: ItemAttributes;
  trackBatches: boolean;
  trackSerials: boolean;
  minQty: string;
  criticalQty: string;
  vatRate: string;
  barcode: string;
  stock: {
    onHand: string;
    reserved: string;
    available: string;
  };
  unitCost: string;
  version: number;
  permissions: PermissionsMap;
}

/* ------------------- WAREHOUSE & STOCK ------------------- */
export interface StockBalance {
  uid: string;
  companyId: string;
  item: CatalogItem;
  warehouse: { uid: string; nameRu: string; nameUz: string; code: string };
  zone: string;
  location: string;
  batchNumber?: string;
  serialNumber?: string;
  qtyOnHand: string;
  qtyReserved: string;
  qtyAvailable: string;
  unitCost: string;
  totalCost: string;
  isBelowMin: boolean;
  isBelowCritical: boolean;
}

export interface StockMove {
  uid: string;
  companyId: string;
  movedAt: string;
  operationType: 'receipt' | 'transfer' | 'issue_to_production' | 'return_from_production' | 'shipment' | 'write_off' | 'surplus';
  itemCode: string;
  itemName: string;
  batchNumber?: string;
  fromLocation?: string;
  toLocation?: string;
  qty: string;
  unit: string;
  costTotal: string;
  documentNumber: string;
  partnerName?: string;
  author: string;
  comment?: string;
  isReversed?: boolean;
}

/* ------------------- SALES & ORDERS ------------------- */
export type OrderStatus = 'draft' | 'confirmed' | 'reserved' | 'in_production' | 'picking' | 'shipped' | 'closed' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'partial' | 'paid';
export type ShipmentStatus = 'none' | 'partial' | 'full';

export interface SalesOrderLine {
  uid: string;
  itemUid: string;
  itemCode: string;
  itemName: string;
  steelGrade?: string;
  diameter?: string;
  wallThickness?: string;
  qty: string;
  unit: string;
  price: string;
  discountPercent: string;
  vatRate: string;
  amountNet: string;
  amountVat: string;
  amountTotal: string;
  costTotal: string;
  availableQty: string;
  reservedQty: string;
  shortageQty?: string;
  canProduce?: boolean;
  isShortage: boolean;
}

export interface SalesOrder {
  uid: string;
  number: string;
  companyId: string;
  partner: { uid: string; name: string; inn: string; debtLimit: string; currentDebt: string };
  manager: { uid: string; fullName: string };
  orderDate: string;
  deliveryDate: string;
  paymentDueDate: string;
  warehouseName: string;
  currency: string;
  amountNet: string;
  amountVat: string;
  amountTotal: string;
  costTotal: string;
  marginTotal: string;
  marginPercent: string;
  paidAmount: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  shipmentStatus: ShipmentStatus;
  isOverdue: boolean;
  overdueDays?: number;
  lines: SalesOrderLine[];
  version: number;
  permissions: PermissionsMap;
}

/* ------------------- PRODUCTION & MES ------------------- */
export type ProductionStatus = 'draft' | 'planned' | 'in_progress' | 'paused' | 'produced' | 'closed' | 'cancelled';

/* ------------------- FINANCE & ACCOUNTING ------------------- */
export type FinanceOperationType = 'income' | 'expense' | 'transfer' | 'conversion';
export type FinanceStatus = 'draft' | 'pending_approval' | 'approved' | 'posted' | 'rejected' | 'reversed';

/**
 * Остаток счёта. Своего uid у счёта в модели нет — ключом служит компания и
 * код счёта, тот самый, что напечатан в журнале и в карточке операции.
 */
export interface FinanceAccountBalance {
  key: string;
  code: string;
  nameRu: string;
  nameUz: string;
  kind: 'cash' | 'bank' | 'receivable' | 'payable' | 'income' | 'expense' | 'vat' | 'transit';
  currency: string;
  company: { uid: string; code: string };
  /** Сумма проводок, а не хранимое поле. Всегда в базовой валюте. */
  saldo: string;
  entries: number;
}

export interface FinanceFlow {
  inflow: string;
  outflow: string;
  net: string;
  incomeOps: number;
  expenseOps: number;
  /** Переводы и покупка валюты: в приток и отток они не входят. */
  transferOps: number;
}

export interface FinanceCashflowSlice {
  nameRu: string;
  nameUz: string;
  direction: 'inflow' | 'outflow';
  activity: 'operating' | 'investing' | 'financing';
  amount: string;
  ops: number;
}

export interface FinanceApprovalQueue {
  draft: number;
  pendingApproval: number;
  approved: number;
  rejected: number;
  reversed: number;
  /** Деньги, обещанные наружу, но ещё не ушедшие. Черновики сюда не входят. */
  amountPending: string;
}

export interface FinanceSummary {
  period: DashboardPeriod;
  accounts: FinanceAccountBalance[];
  flow: FinanceFlow;
  byItem: FinanceCashflowSlice[];
  approval: FinanceApprovalQueue;
  receivables: { total: string; overdue: string; partners: number };
}

export interface FinanceOperationRow {
  uid: string;
  number: string;
  type: FinanceOperationType;
  status: FinanceStatus;
  occurredAt: string;
  plannedDate: string | null;
  postedAt: string | null;
  amount: string;
  currency: string;
  rate: string;
  amountBase: string;
  account: { code: string; nameRu: string; nameUz: string };
  counterAccount: { code: string; nameRu: string; nameUz: string } | null;
  cashflowItem: { nameRu: string; nameUz: string; direction: 'inflow' | 'outflow' } | null;
  partner: { uid: string; nameRu: string; nameUz: string } | null;
  company: { uid: string; code: string };
  comment: string | null;
  /**
   * Версия строки. Её возвращают в теле любого действия над операцией: сервер
   * пишет условием `version = присланная`, поэтому устаревшая карточка получит
   * 409 вместо тихой записи поверх чужой правки.
   */
  version: number;
  /** Сколько проводок у операции. У непроведённой — ноль, и это нормально. */
  entries: number;
}

/**
 * Что можно сделать с операцией. Порядок тот же, что на экране, и он же —
 * порядок жизненного пути: черновик уходит на согласование, согласованную
 * утверждают или отклоняют, утверждённую проводят.
 */
export type FinanceAction = 'submit' | 'approve' | 'reject' | 'post';

export interface FinanceActionResult {
  uid: string;
  number: string;
  status: FinanceStatus;
  version: number;
  /** Сколько проводок родилось. Ноль у всего, кроме проведения. */
  entries: number;
}

/**
 * Справочники формы операции. Наружу идут коды счетов и валют — те же, что
 * печатаются в журнале. У статьи ДДС собственного кода нет, её id приходит
 * строкой: числом BigInt не переживёт JSON.
 *
 * `companyUid` есть у каждой строки не для полноты ответа: счёт, статья и
 * контрагент принадлежат компании, а у пользователя их бывает несколько —
 * тогда список приходит общим и названия в нём повторяются дословно. Без
 * этого поля форма не отличит свою строку от чужой.
 */
export interface FinanceRefs {
  accounts: Array<{
    companyUid: string;
    code: string;
    nameRu: string;
    nameUz: string;
    kind: string;
    currency: string;
  }>;
  cashflowItems: Array<{
    companyUid: string;
    uid: string;
    nameRu: string;
    nameUz: string;
    direction: string;
  }>;
  currencies: string[];
  partners: Array<{ companyUid: string; uid: string; nameRu: string; nameUz: string }>;
}

/**
 * Тело создания операции. Сумма и курс — строки: у `number` копейки на
 * миллиардах теряются молча. Маску проверяет сервер.
 */
export interface FinanceCreateInput {
  companyUid?: string;
  operationType: FinanceOperationType;
  accountCode: string;
  counterAccountCode: string;
  amount: string;
  currencyCode: string;
  rate?: string;
  occurredAt?: string;
  plannedDate?: string;
  cashflowItemUid?: string;
  partnerUid?: string;
  comment?: string;
}

/** Правка черновика: всё необязательно, кроме версии. */
export type FinancePatchInput = { version: number } & Partial<
  Omit<FinanceCreateInput, 'companyUid' | 'operationType'>
>;

export interface FinanceEntryRow {
  account: { code: string; nameRu: string; nameUz: string; kind: string };
  debit: string;
  credit: string;
  occurredAt: string;
}

export interface FinanceOperationCard {
  operation: FinanceOperationRow & {
    createdAt: string;
    createdBy: string | null;
    approvedBy: string | null;
    sourceDocType: string | null;
  };
  entries: FinanceEntryRow[];
  totals: { debit: string; credit: string };
  /** Дебет равен кредиту. У непроведённой операции это ноль против нуля. */
  balanced: boolean;
}

export interface FinanceReceivableRow {
  partner: { uid: string; nameRu: string; nameUz: string };
  orders: number;
  debt: string;
  overdue: string;
  debtLimit: string;
  overLimit: boolean;
  paymentDelayDays: number;
  oldestDueDate: string | null;
  maxOverdueDays: number;
}

export interface FinanceReceivables {
  rows: FinanceReceivableRow[];
  totals: { debt: string; overdue: string };
}

export interface FinancePlanFactRow {
  /** Строка — это бюджет: по uid его правят и удаляют. */
  uid: string;
  company: { uid: string; code: string };
  itemName: string;
  itemNameUz: string;
  activity: 'operating' | 'investing' | 'financing';
  department: { uid: string; nameRu: string; nameUz: string } | null;
  responsible: { uid: string; fullName: string } | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** «2026-10» или «2026-Q4»: период бюджета — месяц или квартал. */
  period: string;
  plan: string;
  fact: string;
  /** Минус — перерасход. Знак важнее модуля: по нему красится строка. */
  deviation: string;
  usedPercent: string | null;
  thresholdWarnPercent: string;
  /** Состояние считает сервер по порогу этого бюджета, а не экран. */
  status: 'ok' | 'warn' | 'over';
  ops: number;
}

/** Справочники формы бюджета. Статьи, подразделения и люди — по компаниям. */
export interface FinanceBudgetRefs {
  items: Array<{
    companyUid: string;
    uid: string;
    nameRu: string;
    nameUz: string;
    direction: 'inflow' | 'outflow';
  }>;
  departments: Array<{ companyUid: string; uid: string; nameRu: string; nameUz: string }>;
  people: Array<{ companyUid: string; uid: string; fullName: string }>;
}

export interface FinanceBudgetInput {
  companyUid?: string;
  departmentUid?: string;
  itemUid: string;
  /** Месяц «2026-10» или квартал «2026-Q4». Произвольные даты сервер не примет. */
  period: string;
  amountPlanned: number;
  thresholdWarnPercent?: number;
  responsibleUid?: string;
}

export interface FinanceBudgetPatch {
  amountPlanned?: number;
  thresholdWarnPercent?: number;
  /** Пустая строка — «снять»: статью и период правка не меняет. */
  responsibleUid?: string;
  departmentUid?: string;
}

export interface FinancePlanFactColumn {
  key: string;
  titleRu: string;
  titleUz?: string;
  type: string;
  align?: string;
  colorBySign?: boolean;
}

/** Состав колонок задаёт сервер — экран не зашивает его в код. */
export interface FinancePlanFact {
  columns: FinancePlanFactColumn[];
  rows: FinancePlanFactRow[];
  totals: { plan: string; fact: string; deviation: string; warn: number; over: number };
}

/**
 * Отчёты финансов из ТЗ 6.9. Порядок — как в самой таблице ТЗ.
 *
 * KPI менеджеров в списке нет: правил расчёта заказчик не давал, и показатель,
 * формулу которого никто не утверждал, в отчёте рисовать нельзя — по нему
 * начнут платить бонусы.
 */
export type FinanceReportKind =
  | 'cashflow'
  | 'balances'
  | 'receivables'
  | 'payables'
  | 'plan-fact'
  | 'pnl'
  | 'margin'
  | 'summary';

/** Разрезы отчёта по марже (ТЗ 6.7): заказ, товар, клиент, менеджер. */
export type FinanceMarginBreakdown = 'order' | 'item' | 'partner' | 'manager';

/**
 * Отчёт — таблица: шапка и строки. Что в какой колонке, решает сервер, и тот
 * же ответ уходит в Excel: иначе на экране одно, а в файле другое.
 *
 * Числа приходят числами, а не подписанными строками: формат («1 234 567,89»)
 * собирается там, где показывают. `totals` сервер считает сам — подвал не
 * пересчитывается на экране, иначе он разойдётся с выгрузкой.
 */
export interface FinanceReport {
  kind: FinanceReportKind;
  title: string;
  /** Что попало в отчёт: период, число строк, ключевые итоги. */
  subtitle: string;
  columns: { title: string; numeric?: boolean; width?: number }[];
  rows: (string | number | null)[][];
  total: number;
  /** Строк больше, чем отдано: отчёт обрезан, и он об этом говорит. */
  truncated: boolean;
  totals: Record<string, number>;
}

/* ------------------- DOCUMENTS & TEMPLATES ------------------- */
export type DocumentStatus = 'draft' | 'pending_approval' | 'approved' | 'signed' | 'returned' | 'cancelled';


/* ------------------- CRM & LEADS ------------------- */
export interface CrmLead {
  uid: string;
  date: string;
  name: string;
  phone: string;
  email: string;
  company: string;
  source: 'website' | 'phone_call' | 'advertisement' | 'telegram' | 'referral';
  status: 'new' | 'in_progress' | 'qualified' | 'converted' | 'rejected';
  manager: string;
  comment: string;
}

export interface CrmDeal {
  uid: string;
  number: string;
  title: string;
  partnerName: string;
  amount: string;
  currency: string;
  stageUid: 'lead' | 'qualification' | 'proposal' | 'contract' | 'won' | 'lost';
  stageName: string;
  probability: number;
  expectedCloseDate: string;
  managerName: string;
  tasksCount: number;
  isOverdue: boolean;
  lostReason?: string;
}

/* ------------------- DASHBOARD ------------------- */
/**
 * Форма ответа /dashboard/summary — по 04-API-CONTRACT.md §14.1.
 * Все величины приходят строками; приводить к числу — только в lib/formatters.
 */
export interface DashboardKpi {
  key: string;
  titleRu: string;
  titleUz: string;
  value: string;
  unit: string;
  /** null — сравнивать не с чем (остаток на складе), стрелку не рисуем. */
  deltaPercent: string | null;
  isPositive: boolean;
  sub1Ru: string;
  sub1Uz: string;
  sub2Ru: string;
  sub2Uz: string;
  targetModule: string;
}

export interface DashboardChartPoint {
  date: string;
  displayDateRu: string;
  displayDateUz: string;
  plantTons: string;
  plantRevenue: string;
  tradeTons: string;
  tradeRevenue: string;
  totalTons: string;
  totalRevenue: string;
  /** Не план, а средний дневной факт периода: планирования продаж в модели нет. */
  baselineTons: string;
}

export type DashboardPeriod = '7d' | '30d' | '3m';
export type DashboardScope = 'holding' | 'trade' | 'plant';

export interface DashboardSummary {
  scope: DashboardScope;
  period: DashboardPeriod;
  companies: Array<{ code: string; nameRu: string; nameUz: string }>;
  kpis: DashboardKpi[];
  chart: DashboardChartPoint[];
  permissions: {
    canViewFinance: boolean;
    canViewProduction: boolean;
    canViewWarehouse: boolean;
    canViewCrm: boolean;
  };
}

export type DashboardPlanTab = 'plan' | 'done';

export interface DashboardPlanRow {
  uid: string;
  kind: 'production' | 'supply';
  number: string;
  header: string;
  sectionType: string;
  status: 'done' | 'in_process';
  planQty: string;
  factQty: string;
  unit: string;
  enterprise: string;
  customer: string;
  responsible: string;
  priority: 'standard' | 'urgent';
  dueDate: string | null;
}

/* ------------------- АУТЕНТИФИКАЦИЯ ------------------- */
export interface AuthCompany {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
}

export interface AuthSession {
  token: string;
  user: { uid: string; login: string; fullName: string; locale: 'ru' | 'uz' };
  companies: AuthCompany[];
  permissions: string[];
  /**
   * Пароль временный: его придумал не сам человек. Вход при этом проходит —
   * иначе сменить пароль было бы нечем, — но ни один другой маршрут не
   * ответит, и интерфейс обязан сразу показать окно смены пароля.
   */
  mustChangePassword: boolean;
}

/* ---------------------------------------------------------------------------
 * Продажи. Ответы `GET /sales/*`.
 *
 * Деньги, количества и доли — строки: точность денег не должна зависеть от
 * двоичного float в браузере. Разбирает их `toNumber` из lib/formatters.
 * Поля `sub*Ru` / `sub*Uz` приходят готовым текстом, в них дробная часть уже
 * отделена запятой.
 * ------------------------------------------------------------------------- */

export interface SalesPortfolio {
  activeOrders: number;
  totalAmount: string;
  paidAmount: string;
  /** null — портфель пуст, доли нет. Подпись тогда не рисуется. */
  paidPercent: string | null;
  overdueAmount: string;
  overduePercent: string | null;
  sub1Ru: string;
  sub1Uz: string;
  sub2Ru: string;
  sub2Uz: string;
}

export interface SalesFulfillment {
  totalOrders: number;
  closedOrders: number;
  closedPercent: string;
}

export interface SalesLoadingPoint {
  date: string;
  displayDateRu: string;
  displayDateUz: string;
  netTons: string;
  /** Среднее за период. Это не «норма»: норматива погрузки в данных нет. */
  baselineTons: string;
}

export interface SalesLoading {
  unitRu: string;
  unitUz: string;
  averagePerDay: string;
  series: SalesLoadingPoint[];
}

export interface SalesSummary {
  period: DashboardPeriod;
  portfolio: SalesPortfolio;
  fulfillment: SalesFulfillment;
  loading: SalesLoading;
}

export type SalesStage = 'all' | 'unpaid' | 'paid' | 'production' | 'shipped';

export interface SalesOrderRow {
  uid: string;
  number: string;
  orderDate: string | null;
  deliveryDate: string | null;
  paymentDueDate: string | null;
  enterprise: string;
  partnerName: string;
  partnerNameUz: string;
  partnerInn: string | null;
  managerName: string | null;
  amountTotal: string;
  paidAmount: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  shipmentStatus: ShipmentStatus;
  linesCount: number;
}

export interface SalesOrderDetailLine {
  uid: string;
  seq: number;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qty: string;
  /** Сколько по строке уже уехало по ТТН. */
  shippedQty: string;
  price: string;
  discountPercent: string;
  vatRate: string;
  amountNet: string;
  amountVat: string;
  amountTotal: string;
  /** Откуда цена: прайс, индивидуальная цена клиента или рука менеджера (ТЗ 9.2). */
  priceSource: PriceSource;
  /** Что показывал прайс в момент заведения строки. */
  listPrice: string | null;
  /** Себестоимость, с которой сравнивали. */
  costRef: string | null;
  /** Основание ручной цены. */
  priceComment: string | null;
}

export type PriceSource = 'list' | 'partner' | 'manual';

/** Что система предлагает за позицию этому клиенту (ТЗ 9.2). */
export interface SalesPriceHint {
  itemCode: string;
  onDate: string;
  price: number | null;
  source: PriceSource | 'none';
  priceTypeCode: string | null;
  priceTypeName: string | null;
  listPrice: number | null;
  partnerPrice: number | null;
  cost: number | null;
  belowCostMode: 'block' | 'approve';
}

export interface RefPriceType {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  kind: 'retail' | 'wholesale' | 'contract' | 'cash' | 'cashless';
  company: { uid: string; code: string };
  usedBy: { prices: number; partners: number; orders: number };
}

export interface RefPriceCell {
  uid: string;
  price: number;
  validFrom: string;
  validTo: string | null;
}

export interface RefPricesPage {
  onDate: string;
  total: number;
  types: { uid: string; code: string; nameRu: string; kind: string; companyUid: string }[];
  rows: {
    item: { uid: string; code: string; name: string; unit: string; companyUid: string };
    prices: Record<string, RefPriceCell>;
  }[];
}

export interface RefPartnerPrice {
  uid: string;
  item: { uid: string; code: string; name: string; unit: string };
  price: number;
  validFrom: string;
  validTo: string | null;
  isCurrent: boolean;
}

export interface SalesOrderShipment {
  uid: string;
  number: string;
  shippedAt: string;
  vehicle: string | null;
  driver: string | null;
  netWeightT: string | null;
  grossWeightT: string | null;
}

export interface SalesOrderDetail {
  uid: string;
  number: string;
  orderDate: string | null;
  deliveryDate: string | null;
  paymentDueDate: string | null;
  enterprise: string;
  enterpriseNameRu: string;
  enterpriseNameUz: string;
  currency: string;
  warehouseNameRu: string | null;
  warehouseNameUz: string | null;
  managerName: string | null;
  comment: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  shipmentStatus: ShipmentStatus;
  amountNet: string;
  amountVat: string;
  amountTotal: string;
  paidAmount: string;
  partner: {
    uid: string;
    nameRu: string;
    nameUz: string;
    inn: string | null;
    debtLimit: string;
    paymentDelayDays: number;
  };
  lines: SalesOrderDetailLine[];
  shipments: SalesOrderShipment[];
}

export interface SalesShipmentRow {
  uid: string;
  number: string;
  shippedAt: string;
  enterprise: string;
  warehouseNameRu: string | null;
  warehouseNameUz: string | null;
  orderUid: string;
  orderNumber: string;
  partnerName: string;
  partnerNameUz: string;
  vehicle: string | null;
  driver: string | null;
  netWeightT: string | null;
  grossWeightT: string | null;
  cargoRu: string;
  cargoUz: string;
  linesCount: number;
}

export interface SalesPartnerRow {
  uid: string;
  nameRu: string;
  nameUz: string;
  inn: string | null;
  enterprise: string;
  debtLimit: string;
  receivable: string;
  /** null — лимит не задан, доля не считается. */
  usedPercent: string | null;
  paymentDelayDays: number;
  activeOrders: number;
}

/* ---------------------------------------------------------------------------
 * Производство. Ответы `GET /production/*`.
 *
 * Главное отличие от старых фикстур: фактическое время этапа не приходит
 * само по себе — за ним стоит журнал событий, и он же приезжает в ответе.
 * Поэтому `actualDurationMin` здесь — уже закрытое время работы, а текущий
 * незакрытый отрезок отдан отдельно: `runningSince` или `pausedSince`.
 * ------------------------------------------------------------------------- */

export type ProductionStageStatus = 'pending' | 'running' | 'paused' | 'done' | 'skipped';
export type ProductionStageEventKind = 'start' | 'pause' | 'resume' | 'finish';

/** Состояние глазами цеха, а не статус из модели: вкладки списка заказов. */
export type ProductionState = 'all' | 'planned' | 'active' | 'done';

export interface ProductionOutputByUnit {
  unit: string;
  good: string;
  defect: string;
  waste: string;
  /** null — выпуска не было, доли брака нет. */
  defectPercent: string | null;
}

export interface ProductionDowntimeReason {
  reasonRu: string | null;
  reasonUz: string | null;
  minutes: number;
  events: number;
}

export interface ProductionWorkCenterLoad {
  code: string;
  nameRu: string;
  nameUz: string;
  /** Сменная мощность участка в штуках — справочная цифра из его карточки. */
  capacityPerShift: string;
  stages: number;
  plannedMin: number;
  actualMin: number;
  /** Простои участка за период, минуты. */
  downtimeMin: number;
  /** Сколько минут завод работал в этом окне. Нет смен — считать не из чего. */
  availableMin: number | null;
  loadPercent: string | null;
}

export interface ProductionSummary {
  period: DashboardPeriod;
  orders: {
    total: number;
    planned: number;
    inProgress: number;
    paused: number;
    produced: number;
    closed: number;
    overdue: number;
  };
  /** По единицам измерения: тонны и погонные метры не складываются. */
  output: ProductionOutputByUnit[];
  downtime: {
    minutes: number;
    events: number;
    byReason: ProductionDowntimeReason[];
  };
  /** Окно периода по календарю завода (Э7): из него считается загрузка. */
  calendar: {
    workingDays: number;
    dayMinutes: number;
    availableMin: number | null;
  };
  workCenters: ProductionWorkCenterLoad[];
}

/** Смена завода: во сколько начинается, во сколько кончается и сколько длится. */
export interface ProductionShift {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  isActive: boolean;
}

export interface ProductionCalendarDay {
  day: string;
  isWorking: boolean;
  /** Заведено руками (праздник, рабочая суббота), а не обычная неделя. */
  isException: boolean;
  comment: string | null;
}

export interface ProductionCalendar {
  /** ISO-дни недели: 1 — понедельник, 7 — воскресенье. */
  workDays: number[];
  shifts: ProductionShift[];
  dayMinutes: number;
  from: string;
  to: string;
  workingDays: number;
  days: ProductionCalendarDay[];
}

export interface ProductionShiftInput {
  code: string;
  nameRu: string;
  nameUz: string;
  startsAt: string;
  endsAt: string;
  isActive?: boolean;
}

/** Отчёты производства (Э8): та же таблица, что уходит в файл. */
export type ProductionReportKind = 'orders' | 'output' | 'materials' | 'deviations' | 'load';

export interface ProductionReport {
  kind: ProductionReportKind;
  title: string;
  subtitle: string;
  columns: { title: string; numeric?: boolean; width?: number }[];
  rows: (string | number | null)[][];
  total: number;
  truncated: boolean;
}

/** Участок цеха: сменная мощность и ставка часа, из которой растут затраты. */
export interface ProductionWorkCenter {
  code: string;
  nameRu: string;
  nameUz: string;
  capacityPerShift: string;
  costPerHour: string;
  isActive: boolean;
  /** Незакрытые этапы на участке: пока они есть, в архив он не уходит. */
  openStages: number;
}

export interface ProductionWorkCenterInput {
  code: string;
  nameRu: string;
  nameUz: string;
  capacityPerShift?: string;
  costPerHour?: string;
  isActive?: boolean;
}

/** Страница списка заказов: строки и сколько их всего. */
export interface ProductionOrdersPage {
  rows: ProductionOrderRow[];
  total: number;
  limit: number;
  offset: number;
}

export type ProductionDeviationKind = 'downtime' | 'overuse' | 'defect' | 'delay';

export interface ProductionDeviationRow {
  occurredAt: string;
  kind: ProductionDeviationKind;
  orderNumber: string | null;
  orderUid: string | null;
  stageNameRu: string | null;
  stageNameUz: string | null;
  workCenterCode: string | null;
  reasonRu: string | null;
  reasonUz: string | null;
  durationMin: number;
  amount: string;
  comment: string | null;
  authorName: string | null;
}

export interface ProductionDeviations {
  period: DashboardPeriod;
  rows: ProductionDeviationRow[];
  totals: {
    kind: ProductionDeviationKind;
    events: number;
    minutes: number;
    amount: string;
  }[];
}

export interface ProductionDowntimeInput {
  workCenterCode: string;
  reasonUid: string;
  minutes: number;
  occurredAt?: string;
  comment?: string;
}

/** Ответ раскладки этапов по сменам: план дат и успеваем ли к сроку. */
export interface ProductionSchedule {
  stages: { seq: number; nameRu: string; plannedStart: string; plannedEnd: string }[];
  finishesOn: string;
  dueDate: string;
  lateDays: number;
}

export interface ProductionOrderRow {
  uid: string;
  number: string;
  enterprise: string;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  dueDate: string | null;
  status: ProductionStatus;
  priority: number;
  responsibleName: string | null;
  qtyPlanned: string;
  qtyProduced: string;
  qtyDefect: string;
  qtyWaste: string;
  /** null — план нулевой, доли нет. */
  qtyPercent: string | null;
  stagesDone: number;
  stagesTotal: number;
}

export interface ProductionStageEventRow {
  event: ProductionStageEventKind;
  occurredAt: string;
  reasonRu: string | null;
  reasonUz: string | null;
  comment: string | null;
}

export interface ProductionStageRow {
  /** Адрес этапа для его файлов: вложение спрашивают по uid владельца. */
  uid: string;
  seq: number;
  nameRu: string;
  nameUz: string;
  status: ProductionStageStatus;
  workCenterCode: string | null;
  workCenterNameRu: string | null;
  workCenterNameUz: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedDurationMin: number;
  /** Закрытое время работы по журналу. Идущий отрезок сюда не входит. */
  actualDurationMin: number;
  runningSince: string | null;
  pausedSince: string | null;
  pauseReasonRu: string | null;
  pauseReasonUz: string | null;
  downtimeMin: number;
  comment: string | null;
  events: ProductionStageEventRow[];
}

export interface ProductionMaterialRow {
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qtyPlanned: string;
  qtyIssued: string;
  qtyUsed: string;
  qtyReturned: string;
  /** Со знаком: перерасход положительный, экономия отрицательная. */
  deviationQty: string;
  costTotal: string;
}

export interface ProductionCostSnapshot {
  calculatedAt: string;
  materialCost: string;
  semiCost: string;
  directCost: string;
  reworkCost: string;
  totalCost: string;
  qtyGood: string;
  unitCost: string;
}

/**
 * Строка расчёта: материал или полуфабрикат с ценой, по которой его списали.
 * У полуфабриката проставлен заказ, который его выпустил, — цена оттуда.
 */
export interface ProductionCostLine {
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qty: string;
  unitCost: string;
  total: string;
  fromOrderNumber: string | null;
}

/** Снимок расчёта в истории: кто и когда посчитал, какой из них текущий. */
export interface ProductionCostEntry extends ProductionCostSnapshot {
  isCurrent: boolean;
  calculatedByName: string | null;
}

/** Текущий расчёт с разбором по строкам и тем, что в нём под вопросом. */
export interface ProductionCostDetail extends ProductionCostEntry {
  lines: ProductionCostLine[];
  warnings: string[];
}

export interface ProductionCostState {
  current: ProductionCostDetail | null;
  history: ProductionCostEntry[];
}

export interface ProductionOrderDetail {
  uid: string;
  number: string;
  enterprise: string;
  enterpriseNameRu: string;
  enterpriseNameUz: string;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  dueDate: string | null;
  status: ProductionStatus;
  priority: number;
  responsibleName: string | null;
  /** Форма правки подставляет ответственного обратно: по имени этого не сделать. */
  responsibleUid: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  closedAt: string | null;
  /** Зачем этот заказ. Причину остановки сюда не пишут — она в журнале. */
  comment: string | null;
  /** Последняя названная причина перехода: почему остановили или отменили. */
  statusReason: string | null;
  statusReasonAt: string | null;
  /**
   * Куда заказ можно перевести. Список считает сервер: своя копия таблицы
   * переходов на экране однажды предложит кнопку, на которую ответят 409.
   */
  nextStatuses: ProductionStatus[];
  /** Править можно только черновик: запланированный заказ уже увидел цех. */
  canEdit: boolean;
  techCardNameRu: string | null;
  techCardNameUz: string | null;
  techCardVersion: number | null;
  salesOrderUid: string | null;
  salesOrderNumber: string | null;
  salesPartnerRu: string | null;
  salesPartnerUz: string | null;
  qtyPlanned: string;
  qtyProduced: string;
  qtyDefect: string;
  qtyWaste: string;
  qtyPercent: string | null;
  stages: ProductionStageRow[];
  materials: ProductionMaterialRow[];
  /** Что цех сдал: годное, брак, отход, полуфабрикат. Новое сверху. */
  outputs: ProductionOutputRow[];
  /** Переделки этого заказа: дочерние заказы на тот же товар. */
  reworks: { uid: string; number: string; status: ProductionStatus; qtyPlanned: string }[];
  /** Заполнено, если сам заказ — переделка: чей брак он исправляет. */
  parentOrder: { uid: string; number: string } | null;
  /** null — расчёта себестоимости по заказу ещё не было. */
  cost: ProductionCostSnapshot | null;
  /** Рабочих дней до срока по календарю завода; у законченного заказа — null. */
  workDaysLeft: number | null;
  workDaysOverdue: number | null;
  dueOnWorkingDay: boolean | null;
}

/** Вид выпуска. Годное и полуфабрикат уходят на склад, брак и отход — нет. */
export type ProductionOutputKind = 'good' | 'defect' | 'waste' | 'semi';

export interface ProductionOutputRow {
  kind: ProductionOutputKind;
  qty: string;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  stageSeq: number | null;
  /** Партия выпуска: по ней прослеживается, из какого сырья сделано. */
  batchNumber: string | null;
  reasonNameRu: string | null;
  reasonNameUz: string | null;
  /** Что цех сказал об этой записи. Причина — «из-за чего», это — «что было». */
  comment: string | null;
  occurredAt: string;
}

/** Что записывают выпуском. Склад нужен тому, что ложится на склад. */
export interface ProductionOutputInput {
  kind: ProductionOutputKind;
  qty: string;
  stageSeq?: number;
  reasonUid?: string;
  itemCode?: string;
  warehouseCode?: string;
  locationCode?: string;
  batchNumber?: string;
  comment?: string;
}

export interface ProductionReworkInput {
  qty: string;
  dueDate: string;
  comment?: string;
}

export interface ProductionReworkBrief {
  uid: string;
  number: string;
  qtyPlanned: string;
  parentNumber: string;
  qtyLeftToRework: string;
}

/** Чем наполняется форма заведения заказа. Список приходит с сервера. */
export interface ProductionOptionItem {
  code: string;
  nameRu: string;
  nameUz: string;
  itemType: string;
  unit: string;
  trackSerials: boolean;
}

export interface ProductionOptions {
  items: ProductionOptionItem[];
  responsibles: { uid: string; fullName: string }[];
  salesOrders: { uid: string; number: string; partnerNameRu: string }[];
  /** Участки для этапов техкарты. */
  workCenters: { code: string; nameRu: string; nameUz: string; capacityPerShift: string }[];
  /** Из чего делают: в материалы карты годится и покупное. */
  materials: { code: string; nameRu: string; nameUz: string; unit: string; itemType: string }[];
  /** Причины простоя — ими объясняют паузу этапа (ТЗ 4.1). */
  downtimeReasons: { uid: string; nameRu: string; nameUz: string }[];
  /** Причины брака и отхода: разные списки, потому что это разные вещи. */
  defectReasons: { uid: string; nameRu: string; nameUz: string }[];
  wasteReasons: { uid: string; nameRu: string; nameUz: string }[];
  /** Склады компании с ячейками: ячейка нужна приёмке выпуска. */
  warehouses: { code: string; nameRu: string; nameUz: string; locations: string[] }[];
}

/** Отметка по этапу: что нажали у станка. */
export type ProductionStageMark = 'start' | 'pause' | 'resume' | 'finish';

export interface ProductionStageBrief {
  seq: number;
  nameRu: string;
  status: ProductionStageStatus;
  actualDurationMin: number;
  orderStatus: ProductionStatus;
}

/** Материал заказа глазами кладовщика: где лежит и сколько свободно. */
export interface ProductionMaterialPlace {
  warehouseCode: string;
  warehouseNameRu: string;
  warehouseNameUz: string;
  locationCode: string | null;
  batchNumber: string | null;
  qtyFree: string;
}

export interface ProductionMaterialBrief {
  itemCode: string;
  qtyPlanned: string;
  qtyIssued: string;
  qtyUsed: string;
  qtyReturned: string;
  /** Сколько сейчас на руках у цеха: выдано минус возвращено и израсходовано. */
  qtyOnHand: string;
}

/** Выдача в цех и возврат: это складское движение, поэтому склад обязателен. */
export interface ProductionMaterialMoveInput {
  itemCode: string;
  qty: string;
  warehouseCode: string;
  locationCode?: string;
  batchNumber?: string;
  comment?: string;
}

/** Этап плана работ, как его задают руками. */
export interface ProductionStageInput {
  seq: number;
  nameRu: string;
  nameUz: string;
  workCenterCode?: string;
  responsibleUid?: string;
  plannedDurationMin: number;
}

// --- Техкарты производства (ТЗ 4.1) -----------------------------------------

export type TechCardStatus = 'draft' | 'active' | 'archived';

export interface TechCardRow {
  uid: string;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  version: number;
  status: TechCardStatus;
  nameRu: string;
  nameUz: string;
  stagesCount: number;
  materialsCount: number;
  totalDurationMin: number;
  createdAt: string;
}

export interface TechCardStageRow {
  seq: number;
  nameRu: string;
  nameUz: string;
  normDurationMin: number;
  isParallel: boolean;
  wastePercent: string;
  workCenterCode: string | null;
  workCenterNameRu: string | null;
  workCenterNameUz: string | null;
}

export interface TechCardMaterialRow {
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qtyPerUnit: string;
  stageSeq: number | null;
  isAutoWriteoff: boolean;
}

export interface TechCardDetail {
  uid: string;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  version: number;
  status: TechCardStatus;
  nameRu: string;
  nameUz: string;
  createdAt: string;
  /** С какого момента карта стала нормой: ставится при вводе в работу. */
  validFrom: string | null;
  /** Править можно только черновик: остальное уже служило нормой. */
  canEdit: boolean;
  totalDurationMin: number;
  stages: TechCardStageRow[];
  materials: TechCardMaterialRow[];
  /** Все версии карты по этой номенклатуре, новые сверху. */
  versions: { uid: string; version: number; status: TechCardStatus }[];
}

export interface TechCardStageInput {
  seq: number;
  nameRu: string;
  nameUz: string;
  workCenterCode?: string;
  normDurationMin: number;
  isParallel?: boolean;
  wastePercent?: string;
}

export interface TechCardMaterialInput {
  itemCode: string;
  qtyPerUnit: string;
  stageSeq?: number;
  isAutoWriteoff?: boolean;
}

export interface TechCardBrief {
  uid: string;
  itemCode: string;
  version: number;
  status: TechCardStatus;
  nameRu: string;
  nameUz: string;
  stagesCount: number;
  materialsCount: number;
  totalDurationMin: number;
}

export interface ProductionOrderInput {
  itemCode: string;
  qtyPlanned: string;
  dueDate: string;
  priority?: number;
  responsibleUid?: string;
  salesOrderUid?: string;
  comment?: string;
}

/** Что сервер отвечает на заведение, правку и переход: коротко о заказе. */
export interface ProductionOrderBrief {
  uid: string;
  number: string;
  status: ProductionStatus;
  itemCode: string;
  qtyPlanned: string;
  dueDate: string;
  nextStatuses: ProductionStatus[];
  canEdit: boolean;
}

// --- Склад -----------------------------------------------------------------

export interface WarehouseStockTotals {
  rows: number;
  items: number;
  batches: number;
  warehouses: number;
  /** Стоимость запаса. Деньги складываются, количества — нет. */
  value: string;
}

export interface WarehouseLevels {
  belowCritical: number;
  belowMin: number;
}

export interface WarehouseSlice {
  uid: string;
  code: string;
  nameRu: string;
  rows: number;
  value: string;
}

export interface WarehouseMoveTotal {
  operationType: string;
  moves: number;
  cost: string;
}

export interface WarehouseSummary {
  period: DashboardPeriod;
  stock: WarehouseStockTotals;
  levels: WarehouseLevels;
  warehouses: WarehouseSlice[];
  moves: WarehouseMoveTotal[];
}

/* ---------------- Штрихкоды, QR и сканер (ТЗ 5.9) ---------------- */

export type CodeKind = 'item' | 'batch' | 'serial' | 'location';
export type Symbology = 'code128' | 'qr';

/**
 * Рисунок кода считает сервер, экран только рисует прямоугольники.
 * Code 128 — чередование полос и пробелов в модулях, начиная с полосы.
 * QR — строки из нулей и единиц.
 */
export type CodeSymbol =
  | { symbology: 'code128'; widths: number[]; modules: number }
  | { symbology: 'qr'; size: number; rows: string[] };

/**
 * Коды этикеток строки остатка. Партии, номера и ячейки в строке может
 * не быть — тогда и кода на них нет.
 */
export interface WarehouseLabelCodes {
  item: string;
  batch: string | null;
  serial: string | null;
  location: string | null;
}

/** Чем именно нашёлся объект: наша этикетка, чужой штрихкод или номер. */
export type ScanMatchedBy =
  | 'labelCode'
  | 'itemBarcode'
  | 'locationBarcode'
  | 'serialNumber'
  | 'itemCode';

interface ScanHitBase {
  matchedBy: ScanMatchedBy;
  labelCode: string;
  companyUid: string;
}

export type WarehouseScanHit =
  | (ScanHitBase & {
      kind: 'item';
      code: string;
      nameRu: string;
      nameUz: string;
      unit: string;
      trackBatches: boolean;
      trackSerials: boolean;
    })
  | (ScanHitBase & {
      kind: 'batch';
      uid: string;
      number: string;
      itemCode: string;
      itemNameRu: string;
    })
  | (ScanHitBase & {
      kind: 'serial';
      number: string;
      state: string;
      itemCode: string;
      itemNameRu: string;
    })
  | (ScanHitBase & {
      kind: 'location';
      warehouseCode: string;
      warehouseNameRu: string;
      zoneCode: string;
      code: string;
    });

/** Шаблон этикетки: размер листа, сетка и симвология — настройка (ТЗ 5.9). */
export interface WarehouseLabelTemplate {
  companyUid: string;
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  pageWidthMm: number;
  pageHeightMm: number;
  labelWidthMm: number;
  labelHeightMm: number;
  columns: number;
  rows: number;
  marginTopMm: number;
  marginLeftMm: number;
  gapXMm: number;
  gapYMm: number;
  symbology: Symbology;
  isDefault: boolean;
  perPage: number;
}

export interface WarehouseLabel {
  labelCode: string;
  kind: CodeKind;
  title: string;
  subtitle: string;
  lines: string[];
  symbol: CodeSymbol;
}

export interface WarehouseLabelSheet {
  template: WarehouseLabelTemplate;
  symbology: Symbology;
  labels: WarehouseLabel[];
}

export interface WarehouseStockRow {
  /** Своего идентификатора у строки нет: это срез склад + позиция + партия. */
  key: string;
  /** Коды для печати этикеток на объекты этой строки (ТЗ 5.9). */
  labelCodes: WarehouseLabelCodes;
  item: {
    code: string;
    nameRu: string;
    nameUz: string;
    unit: string;
    pipeType: string | null;
    steelGrade: string | null;
    diameterMm: number | null;
    wallThicknessMm: number | null;
  };
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  zone: string | null;
  location: string | null;
  batch: { uid: string; number: string } | null;
  /** Серийный номер штучной позиции. У количественного учёта его нет. */
  serial: string | null;
  qtyOnHand: string;
  qtyReserved: string;
  qtyAvailable: string;
  unitCost: string;
  /** Остаток по позиции целиком: то, что лежит на всех складах. */
  itemOnHand: string;
  /**
   * С каким уровнем сравнивали (ТЗ 5.10): со складским или с компанийским.
   * Складской перекрывает компанийский по всей позиции, а не по одному складу.
   */
  levelScope: 'company' | 'warehouse';
  /**
   * Доступное в том же разрезе, что и уровень: наличие минус активные резервы.
   * Именно оно сравнивается с уровнем, а не наличие — обещанный товар лежит на
   * складе, но закрыть им следующую отгрузку нельзя. Бывает отрицательным.
   */
  levelAvailable: string;
  criticalQty: string;
  minQty: string;
  isBelowCritical: boolean;
  isBelowMin: boolean;
}

/**
 * Строка отчёта «Потребность в закупке» (ТЗ 5.10).
 *
 * Разрез строки — `scope`: уровень задан либо на компанию, либо на склад, и
 * одна позиция обеими строками сразу не бывает (складской уровень перекрывает
 * компанийский). У компанийской строки склада нет: цифра про все склады сразу.
 */
export interface WarehousePurchaseNeedRow {
  /** Своего идентификатора у строки нет: это срез разрез + позиция + склад. */
  key: string;
  scope: 'company' | 'warehouse';
  item: {
    code: string;
    nameRu: string;
    nameUz: string;
    itemType: string;
    unit: string;
    pipeType: string | null;
    steelGrade: string | null;
    diameterMm: number | null;
    wallThicknessMm: number | null;
  };
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string } | null;
  minQty: string;
  criticalQty: string;
  onHand: string;
  /** Обещано активными резервами — включая резерв сверх наличия. */
  promised: string;
  /** Доступное: наличие минус обещанное. Бывает отрицательным. */
  available: string;
  /** Плановый расход, вошедший в расчёт этой строки. */
  plannedOut: string;
  /** Весь плановый расход по позиции в компании. */
  plannedCompany: string;
  /**
   * Вошёл ли план в расчёт. У складской строки не входит, когда позиция лежит
   * на нескольких складах: производственный заказ склада не называет, и
   * разложить план по складам нечем.
   */
  plannedApplied: boolean;
  /** Доступное после того, как цех выберет свой план. */
  projected: string;
  /** Сколько дозаказать, чтобы вернуться к минимальному уровню. */
  needQty: string;
  state: 'critical' | 'below_min' | 'ok';
  /** Нужна ли строка закупке: тревога, дозаказ или минус по доступному. */
  needed: boolean;
}

export interface WarehousePurchaseNeeds {
  rows: WarehousePurchaseNeedRow[];
  total: number;
  /** Счётчики считают тревогу, а не показанные строки. */
  totals: { rows: number; critical: number; belowMin: number; plannedHidden: number };
}

/** Отчёты склада из ТЗ 5.1. Порядок — как в самом списке. */
export type WarehouseReportKind =
  | 'stock'
  | 'moves'
  | 'availability'
  | 'turnover'
  | 'inventory-diff';

/**
 * Отчёт — это таблица: шапка и строки. Что в какой колонке, решает сервер, и
 * тот же ответ уходит в Excel: иначе на экране одно, а в файле другое.
 *
 * Числа приходят числами, а не подписанными строками: формат («313,4 т»)
 * собирается там, где показывают.
 */
export interface WarehouseReport {
  kind: WarehouseReportKind;
  title: string;
  /** Что попало в отчёт: склад, период, число строк. */
  subtitle: string;
  columns: { title: string; numeric?: boolean; width?: number }[];
  rows: (string | number | null)[][];
  total: number;
  /** Строк больше, чем отдано: отчёт обрезан, и он об этом говорит. */
  truncated: boolean;
}

export interface WarehouseBatchMove {
  uid: string;
  movedAt: string;
  operationType: string;
  qty: string;
  cost: string;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  partner: string | null;
  docType: string | null;
  docNumber: string | null;
  reason: string | null;
  /** Какое движение отменяет это сторно. У обычного движения — null. */
  reversalOf: string | null;
  /** Движение уже отменено: отменять второй раз нечего. */
  reversed: boolean;
}

export interface WarehouseBatchTrace {
  batch: {
    uid: string;
    number: string;
    /** Код этикетки партии (ТЗ 5.9). */
    labelCode: string;
    producedAt: string | null;
    receivedAt: string;
    unitCost: string;
    certificateNumber: string | null;
    item: { code: string; name: string; unit: string };
    /** Одно из двух: партия либо куплена, либо выпущена цехом. */
    supplier: string | null;
    productionOrder: string | null;
  };
  balances: {
    warehouse: string;
    /** Ячейка `ЗОНА/ЯЧЕЙКА`; null на складе без разметки полок. */
    location: string | null;
    qtyOnHand: string;
    qtyReserved: string;
  }[];
  moves: WarehouseBatchMove[];
  /** «Откуда пришло»: приход, выпуск цехом и материалы того заказа (ТЗ 5.6). */
  upstream: WarehouseTraceLink[];
  /** «Куда ушло»: выдача в цех, продукция заказа, отгрузка с оплатой (ТЗ 5.6). */
  downstream: WarehouseTraceLink[];
}

/**
 * Звено цепочки прослеживаемости.
 *
 * Одна форма на оба конца: у звена всегда есть тип, дата и количество,
 * а остальное заполняет тот, кому есть чем. Два почти одинаковых типа
 * заставили бы писать один и тот же список дважды.
 */
export interface WarehouseTraceLink {
  /** Движение журнала, которым звено записано. У выпуска цеха своего нет. */
  uid: string | null;
  /** `receipt` | `output` | `material` | `issue_to_production` | `shipment` | `write_off`. */
  kind: string;
  at: string;
  qty: string;
  partner: string | null;
  docNumber: string | null;
  productionOrder: string | null;
  /** У материала и продукции — какая это позиция. */
  item: { code: string; name: string } | null;
  /** Партия материала или выпущенной продукции: по ней переходят дальше. */
  batch: { uid: string; number: string } | null;
  salesOrder?: string | null;
  /** Оплата приходит только с отгрузкой: у выдачи в цех покупателя нет. */
  payment?: { status: string; paid: string; total: string } | null;
}

/** Состояние серийного номера: производная от последнего его движения. */
export type SerialState = 'in_stock' | 'in_production' | 'shipped' | 'written_off';

/** Строка подбора номеров: то, что лежит на складе и готово к операции. */
export interface WarehouseSerialOption {
  number: string;
  /** Код этикетки номера (ТЗ 5.9). */
  labelCode: string;
  state: SerialState;
  warehouseCode: string;
  /** Ячейка `ЗОНА/ЯЧЕЙКА`; null на складе без разметки полок. */
  location: string | null;
}

/**
 * Путь серийного номера (ТЗ 5.6).
 *
 * У штучной позиции вопрос не «где партия», а «где вот эта труба»: отсюда
 * состояние и место сейчас, а не список остатков по складам.
 */
export interface WarehouseSerialTrace {
  serial: {
    number: string;
    /** Код этикетки номера (ТЗ 5.9). */
    labelCode: string;
    state: SerialState;
    item: { code: string; name: string; unit: string };
    /** Партия выпуска, если номер родился в цехе. У покупной трубы её нет. */
    batch: { uid: string; number: string } | null;
  };
  /** Где лежит сейчас. Уехавшая или списанная труба места не имеет. */
  place: { warehouse: string; location: string | null; qty: string } | null;
  moves: WarehouseBatchMove[];
}

/** Типы движений, которые человек заводит с экрана склада. */
/**
 * Типы движения, которые заводит человек с экрана склада.
 *
 * Отгрузки и выпуска цеха здесь нет: они рождаются документом — ТТН заказа и
 * заданием производства, — и сервер их с этого маршрута не примет.
 */
export type WarehouseMoveKind =
  | 'receipt'
  | 'write_off'
  | 'transfer'
  | 'issue_to_production'
  | 'return_from_production'
  | 'return_from_client'
  | 'surplus';

/**
 * Все девять типов журнала. Заводят с экрана три, остальные рождаются в
 * производстве и продажах — но в журнале они видны наравне, иначе список
 * умолчал бы половину склада.
 */
export type WarehouseOperationType =
  | 'receipt'
  | 'transfer'
  | 'issue_to_production'
  | 'return_from_production'
  | 'shipment'
  | 'return_from_client'
  | 'write_off'
  | 'surplus'
  | 'output';

/** Строка журнала движений. */
export interface WarehouseMoveRow {
  uid: string;
  movedAt: string;
  operationType: WarehouseOperationType;
  item: { code: string; nameRu: string; nameUz: string; unit: string };
  batch: { uid: string; number: string } | null;
  serial: string | null;
  qty: string;
  cost: string;
  fromWarehouse: { uid: string; code: string; nameRu: string } | null;
  toWarehouse: { uid: string; code: string; nameRu: string } | null;
  /** Место хранения строкой «зона/ячейка»: отдельными полями оно ни о чём не говорит. */
  fromLocation: string | null;
  toLocation: string | null;
  partner: string | null;
  reason: string | null;
  docType: string | null;
  docNumber: string | null;
  comment: string | null;
  author: string | null;
  reversalOf: string | null;
  reversed: boolean;
  /**
   * Считает сервер, а не экран: у движения под документом, у сторно и у уже
   * отменённого кнопки быть не должно, и право на отмену тоже учтено.
   */
  canReverse: boolean;
}

/** Фильтры журнала. Даты — только `ГГГГ-ММ-ДД`, границы считаются по местному дню. */
export interface WarehouseMovesQuery {
  warehouse?: string;
  operationType?: WarehouseOperationType;
  itemCode?: string;
  batchNumber?: string;
  partner?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface WarehouseMovesPage {
  total: number;
  limit: number;
  offset: number;
  rows: WarehouseMoveRow[];
}

/**
 * Справочники формы движения. Каждая строка помечена компанией: склады и
 * номенклатура живут внутри компании, а у кладовщика их бывает две, и названия
 * в списке повторяются дословно.
 */
export interface WarehouseRefs {
  warehouses: Array<{ companyUid: string; code: string; nameRu: string; nameUz: string }>;
  /**
   * Ячейки всех складов сразу. Форма сама сужает их по выбранному складу:
   * их дюжина на склад, и второй запрос на каждый выбор склада дороже, чем
   * весь список разом.
   */
  locations: Array<{
    companyUid: string;
    warehouseCode: string;
    zoneCode: string;
    zoneNameRu: string;
    zoneNameUz: string;
    code: string;
    barcode: string | null;
    /** Код этикетки ячейки (ТЗ 5.9): им её и клеят на стеллаж. */
    labelCode: string;
  }>;
  items: Array<{
    companyUid: string;
    code: string;
    nameRu: string;
    nameUz: string;
    unit: string;
    /** Код этикетки позиции (ТЗ 5.9). */
    labelCode: string;
    /** Партионной номенклатуре номер партии обязателен, остальной — запрещён. */
    trackBatches: boolean;
    /** Штучный учёт: форма спрашивает серийный номер, а не количество. */
    trackSerials: boolean;
  }>;
  reasons: Array<{ companyUid: string; id: string; kind: string; nameRu: string; nameUz: string }>;
  /** Роль контрагента: возврат от клиента спрашивает клиента, приход — поставщика. */
  partners: Array<{
    companyUid: string;
    uid: string;
    nameRu: string;
    isSupplier: boolean;
    isClient: boolean;
  }>;
}

/**
 * Тело движения. Количество и цена — строки: `number` теряет шестой знак на
 * тоннах и копейки на миллиардах. Маску проверяет сервер.
 */
export interface WarehouseMoveInput {
  companyUid?: string;
  operationType: WarehouseMoveKind;
  itemCode: string;
  batchNumber?: string;
  /** Серийный номер: у штучной позиции обязателен, у остальных не принимается. */
  serialNumber?: string;
  qty: string;
  fromWarehouseCode?: string;
  /** Ячейка отправления. Обязательна там, где у склада ячейки есть. */
  fromLocationCode?: string;
  toWarehouseCode?: string;
  /** Ячейка получения. Обязательна там, где у склада ячейки есть. */
  toLocationCode?: string;
  unitCost?: string;
  reasonId?: string;
  partnerUid?: string;
  movedAt?: string;
  comment?: string;
}

/** Ответ на запись: то, что экран показывает сразу после сохранения. */
export interface WarehouseMoveBrief {
  uid: string;
  operationType: string;
  qty: string;
  qtyBase: string;
  itemCode: string;
  batchNumber: string | null;
  serialNumber: string | null;
  fromWarehouseCode: string | null;
  fromLocationCode: string | null;
  toWarehouseCode: string | null;
  toLocationCode: string | null;
  reversalOf: string | null;
}

/**
 * Резерв: товар обещан покупателю, но со склада не уехал.
 *
 * Движения под ним нет — в журнале его искать бессмысленно. В остатке от него
 * видно только число `qtyReserved`; кому и по какому заказу обещано, говорит
 * этот список.
 */
export interface WarehouseReservationRow {
  uid: string;
  companyUid: string;
  item: { code: string; nameRu: string; nameUz: string; unit: string };
  batch: string | null;
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  qty: string;
  expiresAt: string | null;
  createdAt: string;
  author: string | null;
  orderNumber: string | null;
  partner: string | null;
  /** Обещано больше, чем лежит: резерв под поставку, которая ещё в пути. */
  overSold: boolean;
}

export interface WarehouseReservationsPage {
  total: number;
  rows: WarehouseReservationRow[];
}

export interface WarehouseReservationInput {
  companyUid?: string;
  itemCode: string;
  batchNumber?: string;
  warehouseCode: string;
  qty: string;
  expiresAt?: string;
  salesOrderNumber?: string;
}

/**
 * Лист инвентаризации (ТЗ 5.8).
 *
 * `draft` — снимок сделан, но у полки ещё не были. `counting` — считают.
 * `review` — посчитано, расхождения видны, но в остаток ещё не ушли.
 * `approved` — расхождения списаны движениями, лист закрыт. `cancelled` — лист
 * бросили, остаток не тронут.
 *
 * `blockMode` решает судьбу обычных операций по этой зоне на время пересчёта:
 * `block` их запрещает, `mark` пропускает и помечает строку журнала.
 */
export type InventoryStatus = 'draft' | 'counting' | 'review' | 'approved' | 'cancelled';

export interface InventorySheetRow {
  uid: string;
  companyUid: string;
  number: string;
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  /** Код зоны; `null` — считают склад целиком. */
  zone: string | null;
  status: InventoryStatus;
  blockMode: 'block' | 'mark';
  comment: string | null;
  author: string | null;
  createdAt: string;
  countedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: number;
  counted: number;
  diffLines: number;
  /** Деньги расхождения: недостача минусом, излишек плюсом. */
  diffCost: string;
}

export interface InventorySheetLineRow {
  uid: string;
  seq: number;
  item: { code: string; nameRu: string; nameUz: string; unit: string };
  batch: string | null;
  /** Серийный номер: у штучной позиции строка листа заводится на каждую штуку. */
  serial: string | null;
  location: string | null;
  /** Учётное количество на момент создания листа, а не текущее. */
  qtyExpected: string;
  /** `null` — строку ещё не считали; ноль значит «на полке пусто». */
  qtyCounted: string | null;
  qtyDiff: string | null;
  unitCost: string;
  countedBy: string | null;
  countedAt: string | null;
  comment: string | null;
}

export interface InventorySheetsPage {
  total: number;
  rows: InventorySheetRow[];
}

export type InventorySheetDetail = InventorySheetRow & { rows: InventorySheetLineRow[] };

export interface InventorySheetInput {
  companyUid?: string;
  warehouseCode: string;
  zoneCode?: string;
  blockMode?: 'block' | 'mark';
  comment?: string;
}

/**
 * Справочники формы заказа.
 *
 * Каждая строка помечена компанией: у пользователя их бывает несколько, и без
 * пометки форма предложила бы чужого покупателя, а отказ человек увидел бы уже
 * на сохранении.
 */
export interface SalesRefs {
  companies: Array<{ uid: string; code: string; nameRu: string; nameUz: string }>;
  partners: Array<{
    companyUid: string;
    uid: string;
    nameRu: string;
    nameUz: string;
    inn: string | null;
    paymentDelayDays: number;
  }>;
  items: Array<{
    companyUid: string;
    code: string;
    nameRu: string;
    nameUz: string;
    unit: string;
    /** Партионной номенклатуре номер партии в ТТН обязателен, остальной — запрещён. */
    trackBatches: boolean;
    vatRate: string;
    /** Цена последней продажи: подсказка, а не подстановка за менеджера. */
    lastPrice: string | null;
  }>;
  warehouses: Array<{ companyUid: string; code: string; nameRu: string; nameUz: string }>;
}

/** Что по заказу осталось отгрузить и чем: экран ТТН собирается по этому ответу. */
/**
 * Настройки учёта компании (ТЗ 5.7).
 *
 * Метод списания виден каждому, кто смотрит склад: себестоимость в отчёте без
 * него не читается — непонятно, чем она посчитана. Менять его — право
 * `settings.edit`.
 */
export interface RefCompanySettings {
  companyUid: string;
  companyCode: string;
  companyName: string;
  costingMethod: 'fifo' | 'weighted_average';
  /** ТЗ 9.2: продажа дешевле себестоимости — запрет или по праву. */
  belowCostMode: 'block' | 'approve';
  /**
   * Порог «крупного платежа» и предел на получателя за окно, в базовой валюте
   * (требование заказчика 07.10). `null` — ограничения нет.
   */
  approvalLimitSingle: number | null;
  approvalLimitPeriod: number | null;
  /** Длина окна предела в днях: 1 — день, 30 — месяц. */
  approvalPeriodDays: number;
}

export interface SalesAvailability {
  orderUid: string;
  orderNumber: string;
  status: string;
  shipmentStatus: string;
  canShip: boolean;
  lines: Array<{
    lineUid: string;
    seq: number;
    itemCode: string;
    itemNameRu: string;
    itemNameUz: string;
    unit: string;
    trackBatches: boolean;
    qty: string;
    shippedQty: string;
    remainingQty: string;
    warehouseCode: string | null;
    availableQty: string;
    shortage: string;
    batches: Array<{ number: string | null; availableQty: string }>;
    /** Свободные номера труб: у штучной позиции в накладную идут они, а не количество. */
    serials: string[];
    trackSerials: boolean;
  }>;
}

/**
 * Тело заказа. Количество, цена и проценты — строки: `number` теряет шестой
 * знак на тоннах и копейки на миллиардах. Суммы не передаём вовсе — их считает
 * сервер, и присланные поля он отвергает.
 */
export interface SalesOrderInput {
  companyUid?: string;
  partnerUid: string;
  orderDate?: string;
  deliveryDate?: string;
  paymentDueDate?: string;
  warehouseCode?: string;
  comment?: string;
  lines: Array<{
    itemCode: string;
    qty: string;
    /** Пусто — цену подставит прайс (ТЗ 9.2). */
    price?: string;
    discountPercent?: string;
    vatRate?: string;
    /** Обязательно, когда цену ставят руками. */
    priceComment?: string;
  }>;
}

/** Тело ТТН: машина, водитель, вес и строки с партиями. */
export interface SalesShipmentInput {
  warehouseCode?: string;
  shippedAt?: string;
  vehicle?: string;
  driver?: string;
  netWeightT?: string;
  grossWeightT?: string;
  lines: Array<{ lineUid: string; qty: string; batchNumber?: string; serialNumbers?: string[] }>;
}

/** Ответ на запись заказа: то, что экран показывает сразу после сохранения. */
export interface SalesOrderBrief {
  uid: string;
  number: string;
  status: string;
  shipmentStatus: string;
  amountTotal: string;
  linesCount: number;
}

/** Ответ на запись ТТН: вместе с новым состоянием заказа. */
export interface SalesShipmentBrief {
  uid: string;
  number: string;
  orderUid: string;
  orderNumber: string;
  orderStatus: string;
  shipmentStatus: string;
  linesCount: number;
}

/** Статусы заказа: ими подписаны кнопки перевода. */
export type SalesOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'reserved'
  | 'in_production'
  | 'picking'
  | 'shipped'
  | 'closed'
  | 'cancelled';

// --- Вложения к операциям (ТЗ 5.4, 5.6, 6.3) --------------------------------

/** К чему приложен файл. Тип владельца решает, каким правом он спрашивается. */
export type AttachmentOwner =
  | 'stock_move'
  | 'batch'
  | 'finance_operation'
  | 'production_order'
  | 'production_stage'
  | 'document'
  | 'partner';

export type AttachmentKind = 'photo' | 'scan' | 'certificate' | 'other';

export interface Attachment {
  uid: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  comment: string | null;
  createdAt: string;
  author: string | null;
  /** Картинку показываем в странице, остальное скачиваем файлом. */
  disposition: 'inline' | 'attachment';
}

// --- Справочники на запись (ТЗ 5.2, 5.3, 5.7, 5.10) --------------------------

export interface RefUnitFactor {
  unit: string;
  factor: string;
}

export interface RefItemRow {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  itemType: string;
  company: { uid: string; code: string };
  baseUnit: string;
  group: string | null;
  vatRate: string | null;
  trackBatches: boolean;
  trackSerials: boolean;
  isWeighted: boolean;
  minQty: string | null;
  criticalQty: string | null;
  barcode: string | null;
  isActive: boolean;
  version: number;
  /** Сколько движений уже есть: по нему экран закрывает правку кода и единицы. */
  moves: number;
  attributes: {
    pipeType: string | null;
    steelGrade: string | null;
    diameterMm: string | null;
    wallThicknessMm: string | null;
    lengthMm: string | null;
    weightKgPerUnit: string | null;
    insulationType: string | null;
    gost: string | null;
  };
  units: RefUnitFactor[];
}

export interface RefItemInput {
  companyUid?: string;
  code?: string;
  nameRu?: string;
  nameUz?: string;
  itemType?: string;
  baseUnit?: string;
  vatRate?: number;
  trackBatches?: boolean;
  trackSerials?: boolean;
  isWeighted?: boolean;
  isActive?: boolean;
  minQty?: number;
  criticalQty?: number;
  barcode?: string;
  pipeType?: string;
  steelGrade?: string;
  diameterMm?: number;
  wallThicknessMm?: number;
  lengthMm?: number;
  weightKgPerUnit?: number;
  insulationType?: string;
  gost?: string;
  units?: { unit: string; factor: number }[];
}

export interface RefLocation {
  uid: string;
  code: string;
  barcode: string | null;
  isActive: boolean;
  hasStock: boolean;
}

export interface RefZone {
  uid: string;
  code: string;
  nameRu: string;
  isActive: boolean;
  locations: RefLocation[];
}

export interface RefWarehouse {
  uid: string;
  code: string;
  nameRu: string;
  address: string | null;
  isActive: boolean;
  company: { uid: string; code: string };
  zones: RefZone[];
}

export interface RefReason {
  uid: string;
  kind: string;
  nameRu: string;
  nameUz: string;
  isActive: boolean;
  company: { uid: string; code: string };
  moves: number;
}

export interface RefStockLevel {
  uid: string;
  item: { uid: string; code: string; nameRu: string; unit: string };
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  minQty: string;
  criticalQty: string;
  comment: string | null;
}

// --- CRM: клиенты (ТЗ 8.2) --------------------------------------------------

export interface CrmPartnerContact {
  uid: string;
  fullName: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  isPrimary: boolean;
}

export interface CrmPartnerRow {
  uid: string;
  partnerType: 'company' | 'person';
  nameRu: string;
  nameUz: string;
  inn: string | null;
  isClient: boolean;
  isSupplier: boolean;
  company: { uid: string; code: string; nameRu: string; nameUz: string };
  manager: { uid: string; name: string } | null;
  source: { uid: string; name: string } | null;
  priceType: { uid: string; name: string } | null;
  paymentDelayDays: number;
  debtLimit: string;
  tags: string[];
  isActive: boolean;
  version: number;
  contactsCount?: number;
  phone: string | null;
  createdAt: string;
}

export interface CrmPartnerUsage {
  deals: number;
  leads: number;
  orders: number;
  moves: number;
  payments: number;
  batches: number;
  documents: number;
  prices: number;
  tasks: number;
  activities: number;
  files: number;
  total: number;
}

export interface CrmPartnerCard extends CrmPartnerRow {
  bankDetails: Record<string, unknown> | null;
  legalAddress: string | null;
  actualAddress: string | null;
  contacts: CrmPartnerContact[];
  usage: CrmPartnerUsage;
  permissions: { canEdit: boolean; canDelete: boolean };
}

export interface CrmPartnersPage {
  rows: CrmPartnerRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface CrmPartnerOptions {
  managers: { uid: string; name: string }[];
  companies: { uid: string; code: string; nameRu: string; nameUz: string }[];
  sources: { uid: string; code: string; nameRu: string; nameUz: string; channel: string }[];
  priceTypes: { uid: string; code: string; name: string }[];
}

export interface CrmPartnerInput {
  companyUid?: string;
  partnerType?: 'company' | 'person';
  nameRu: string;
  nameUz?: string;
  inn?: string;
  legalAddress?: string;
  actualAddress?: string;
  isClient?: boolean;
  isSupplier?: boolean;
  managerUid?: string;
  sourceUid?: string;
  priceTypeUid?: string;
  paymentDelayDays?: number;
  debtLimit?: number;
  tags?: string[];
}

export interface CrmContactInput {
  fullName: string;
  position?: string;
  phone?: string;
  email?: string;
  telegram?: string;
  isPrimary?: boolean;
}

// --- CRM: лиды (ТЗ 8.1) -----------------------------------------------------

export type CrmLeadStatus = 'new' | 'qualified' | 'converted' | 'rejected';

/** Метки визита: откуда пришло обращение. Приходят с сайта, руками не вводятся. */
export interface CrmLeadMarks {
  has: boolean;
  last: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    clickId: string | null;
    landing: string | null;
    referrer: string | null;
  };
  first: {
    at: string | null;
    source: string | null;
    medium: string | null;
    campaign: string | null;
    landing: string | null;
    referrer: string | null;
    sourceName: string | null;
  };
  analyticsId: string | null;
  visitorId: string | null;
  formCode: string | null;
}

export interface CrmSiteKey {
  uid: string;
  code: string;
  name: string;
  origins: string[];
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  usedCount: number;
  company: { uid: string; code: string; nameRu: string; nameUz: string };
}

export interface CrmSourceRule {
  uid: string;
  priority: number;
  name: string;
  isActive: boolean;
  match: {
    medium: string | null;
    source: string | null;
    referrer: string | null;
    hasClick: boolean | null;
    hasMarks: boolean | null;
    hasReferrer: boolean | null;
  };
  source: { uid: string; name: string };
  company: { uid: string; code: string };
}

export interface CrmLeadRow {
  uid: string;
  name: string;
  phone: string | null;
  email: string | null;
  comment: string | null;
  rejectReason: string | null;
  status: CrmLeadStatus;
  company: { uid: string; code: string };
  source: { uid: string; name: string; channel: string } | null;
  manager: { uid: string; name: string } | null;
  partner: { uid: string; name: string } | null;
  createdAt: string;
  marks: CrmLeadMarks;
}

export interface CrmLeadsPage {
  rows: CrmLeadRow[];
  total: number;
  byStatus: Partial<Record<CrmLeadStatus, number>>;
  limit: number;
  offset: number;
}

export interface CrmLeadInput {
  companyUid?: string;
  sourceUid: string;
  name: string;
  phone?: string;
  email?: string;
  comment?: string;
  managerUid?: string;
}

export interface CrmLeadPatch {
  name?: string;
  phone?: string;
  email?: string;
  comment?: string;
  rejectReason?: string;
  status?: 'new' | 'qualified' | 'rejected';
  sourceUid?: string;
  managerUid?: string;
}

export interface CrmConvertInput {
  partnerUid?: string;
  nameRu?: string;
  inn?: string;
  partnerType?: 'company' | 'person';
  withDeal?: boolean;
  dealTitle?: string;
  dealAmount?: number;
}

export interface CrmConvertResult {
  partnerUid: string;
  dealUid: string | null;
  alreadyConverted: boolean;
  lead: CrmLeadRow;
}

// --- CRM: воронка и сделки (ТЗ 8.3) ------------------------------------------

export interface CrmDealStage {
  uid: string;
  seq: number;
  code: string;
  nameRu: string;
  nameUz: string;
  probabilityDefault: number;
  isFinal: boolean;
  company: { uid: string; code: string; nameRu: string; nameUz: string };
}

export interface CrmDealRow {
  uid: string;
  number: string;
  title: string;
  amount: string;
  currency: string;
  probability: number;
  expectedCloseDate: string | null;
  status: 'open' | 'won' | 'lost';
  version: number;
  stage: { uid: string; name: string; code: string };
  company: { uid: string; code: string };
  partner: { uid: string; name: string } | null;
  manager: { uid: string; name: string } | null;
  lostReason: { uid: string; name: string } | null;
  createdAt: string;
  closedAt: string | null;
  /** Чем закончилась — словами. Список показывает исход, а не только причину. */
  closeComment: string | null;
}

export interface CrmDealCard extends CrmDealRow {
  orders: number;
  history: { at: string; from: string | null; to: string; toCode: string; user: string | null }[];
  permissions: { canEdit: boolean; canMove: boolean; canClose: boolean };
}

export interface CrmBoardColumn extends CrmDealStage {
  count: number;
  amount: string;
  deals: CrmDealRow[];
}

// --- CRM: отчёты (ТЗ 8) ------------------------------------------------------

export type CrmReportKind = 'funnel' | 'managers' | 'sources' | 'marks' | 'lost-reasons';

export interface CrmReport {
  kind: CrmReportKind;
  title: string;
  subtitle: string;
  columns: { title: string; numeric?: boolean; width?: number }[];
  rows: (string | number | null)[][];
  total: number;
  truncated: boolean;
  totals: Record<string, number>;
}

// --- CRM: карточка клиента целиком (ТЗ 8.2) ----------------------------------

export interface CrmCardDeal {
  uid: string;
  number: string;
  title: string;
  amount: string;
  probability: number;
  status: 'open' | 'won' | 'lost';
  stage: { name: string; code: string };
  manager: string | null;
  lostReason: string | null;
  expectedCloseDate: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CrmCardOrder {
  uid: string;
  number: string;
  orderDate: string;
  deliveryDate: string | null;
  paymentDueDate: string | null;
  amountTotal: string;
  paidAmount: string;
  status: string;
  paymentStatus: string;
  shipmentStatus: string;
  currency: string;
  manager: string | null;
}

export interface CrmCardDocument {
  uid: string;
  number: string;
  date: string;
  status: string;
  amountTotal: string | null;
  type: { name: string; code: string };
  currency: string | null;
}

export interface CrmCardPayment {
  uid: string;
  number: string;
  type: string;
  at: string;
  amount: string;
  currency: string;
  status: string;
  account: string;
  comment: string | null;
}

export interface CrmCardFinance {
  debt: string;
  overdue: string;
  debtLimit: string;
  overLimit: boolean;
  paymentDelayDays: number;
  unpaidOrders: number;
  oldestDueDate: string | null;
  maxOverdueDays: number;
  payments: CrmCardPayment[];
}

export interface CrmCardHistoryRow {
  at: string;
  action: string;
  user: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
}

// --- CRM: задачи и активности (ТЗ 8.4) ---------------------------------------

/** Тип задачи — строка справочника (ТЗ 8.4), а не перечисление в коде. */
export interface CrmTaskTypeRef {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
}
export type CrmTaskScope = 'overdue' | 'today' | 'week' | 'open' | 'closed' | 'all';
export type CrmActivityType = 'call' | 'meeting' | 'letter' | 'note';

export interface CrmTaskRow {
  uid: string;
  type: CrmTaskTypeRef;
  title: string;
  description: string | null;
  dueAt: string;
  status: 'open' | 'done' | 'cancelled';
  isOverdue: boolean;
  result: string | null;
  version: number;
  company: { uid: string; code: string };
  assignee: { uid: string; name: string } | null;
  author: { uid: string; name: string } | null;
  partner: { uid: string; name: string } | null;
  deal: { uid: string; number: string; title: string } | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CrmTasksPage {
  rows: CrmTaskRow[];
  total: number;
  counts: { overdue: number; today: number; week: number; open: number; closed: number; all: number };
  scope: CrmTaskScope;
  limit: number;
  offset: number;
}

export interface CrmTaskInput {
  typeUid: string;
  title: string;
  description?: string;
  dueAt: string;
  assigneeUid?: string;
  partnerUid?: string;
  dealUid?: string;
}

export interface CrmActivityRow {
  uid: string;
  type: CrmActivityType;
  direction: 'incoming' | 'outgoing' | null;
  subject: string;
  note: string | null;
  at: string;
  durationSec: number | null;
  company: { uid: string; code: string };
  partner: { uid: string; name: string } | null;
  deal: { uid: string; number: string; title: string } | null;
  task: { uid: string; title: string } | null;
  user: { uid: string; name: string } | null;
  createdAt: string;
}

export interface CrmActivityInput {
  type: CrmActivityType;
  subject: string;
  note?: string;
  at?: string;
  direction?: 'incoming' | 'outgoing';
  durationSec?: number;
  partnerUid?: string;
  dealUid?: string;
}

export interface CrmLostReason {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  company: { uid: string; code: string };
}

// --- CRM: справочники на запись (ТЗ 8.3, 8.4) --------------------------------

export interface CrmRefCompany {
  uid: string;
  code: string;
}

export interface CrmStageRef {
  uid: string;
  seq: number;
  code: string;
  nameRu: string;
  nameUz: string;
  probabilityDefault: number;
  isFinal: boolean;
  isActive: boolean;
  company: CrmRefCompany;
  usage: { deals: number; openDeals: number; events: number };
}

export interface CrmSourceRef {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  channel: string;
  isActive: boolean;
  company: CrmRefCompany;
  usage: { leads: number; partners: number };
}

export interface CrmLostReasonRef {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  isActive: boolean;
  company: CrmRefCompany;
  usage: { deals: number };
}

export interface CrmTaskTypeRow {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  activityKind: CrmActivityType;
  seq: number;
  isActive: boolean;
  company: CrmRefCompany;
  usage: { tasks: number };
}

export interface CrmRefs {
  stages: CrmStageRef[];
  sources: CrmSourceRef[];
  lostReasons: CrmLostReasonRef[];
  taskTypes: CrmTaskTypeRow[];
}

// --- Документы: реестр (ТЗ 7.1, 7.5) -----------------------------------------

export interface DocumentTypeRef {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  numberingMask: string;
  counterScope: 'company' | 'company_period';
  isActive: boolean;
  company: { uid: string; code: string; nameRu: string; nameUz: string };
  /** `documents` — сколько документов этого типа, `issued` — сколько выдано номеров. */
  usage: { documents: number; issued: number };
  /** Каким будет следующий номер. Показ его не занимает. */
  nextNumber: string;
}

/**
 * Формат выгрузки отчёта.
 *
 * `pdf` — то, что печатают и подписывают; Excel и CSV открывают, чтобы
 * считать. Поэтому PDF отдаёт первую тысячу строк и пишет об этом на самой
 * бумаге, а Excel — отчёт целиком.
 */
export type ReportFormat = 'xlsx' | 'csv' | 'pdf';

// --- Документы: согласование и версии (ТЗ 7.4) -------------------------------

/** Действие на маршруте документа. Список приходит с сервера, а не собирается здесь. */
export type DocumentAction = 'submit' | 'approve' | 'return' | 'sign' | 'cancel';

export interface DocumentVersionRow {
  uid: string;
  version: number;
  /** Статус, в котором редакцию застала правка. */
  status: string;
  documentDate: string;
  locale: 'ru' | 'uz';
  amountTotal: string | null;
  linesCount: number;
  /** Печатали ли эту редакцию в PDF: пересобрать его нельзя. */
  hasPdf: boolean;
  /** Есть ли шаблон, которым эту редакцию печатали: без него DOCX не собрать. */
  hasTemplate: boolean;
  replacedAt: string;
  author: string | null;
}

export interface DocumentVersionsPage {
  current: number;
  rows: DocumentVersionRow[];
}

export interface DocumentHistoryRow {
  at: string;
  action: string;
  user: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface DocumentLineInput {
  name: string;
  qty: string;
  price: string;
  unitCode?: string;
  unitName?: string;
  itemCode?: string | null;
  discountPercent?: string;
  vatRate?: string;
}

// --- Документы: шаблоны печатных форм (ТЗ 7.2) -------------------------------

/**
 * Тег, вычитанный из самого файла шаблона.
 *
 * `known: false` — это и есть работа администратора: тег либо правится в
 * файле, либо сопоставляется с полем системы. Пока такой тег остался,
 * шаблон не публикуется: он дал бы в бумаге пустое место, а не ошибку.
 */
export interface DocumentTemplateTag {
  name: string;
  kind: 'text' | 'block';
  known: boolean;
  mappedTo: string | null;
}

export interface DocumentTemplateRow {
  uid: string;
  locale: 'ru' | 'uz';
  version: number;
  fileName: string;
  fileSize: number;
  tags: DocumentTemplateTag[];
  fieldMap: Record<string, string>;
  isPublished: boolean;
  createdAt: string;
  publishedAt: string | null;
  author: string | null;
  /** Сколько документов напечатано этим шаблоном: такой не удаляют. */
  printed: number;
  type: { uid: string; code: string; nameRu: string; nameUz: string };
  company: { uid: string; code: string };
}

export interface DocumentTemplateField {
  name: string;
  kind: 'text' | 'loop' | 'condition';
  /** Подпись уже на языке запроса: язык сервер знает (ТЗ 13.4). */
  title: string;
}

export interface DocumentTemplateFields {
  document: DocumentTemplateField[];
  /** Поля внутри цикла строк. */
  line: DocumentTemplateField[];
}

/** Результат проверки на настоящем документе — до публикации. */
export interface DocumentTemplateCheck {
  ok: boolean;
  unknown: string[];
  tags: DocumentTemplateTag[];
  /** Номер документа, на котором проверяли. `null` — проверять было не на чем. */
  sampleNumber: string | null;
  message: string;
}

/** Строка документа — снимок на момент выписки, а не вид на заказ. */
export interface DocumentLine {
  uid: string;
  seq: number;
  itemCode: string | null;
  name: string;
  qty: string;
  unitCode: string;
  unitName: string;
  price: string;
  discountPercent: string;
  vatRate: string;
  amountNet: string;
  amountVat: string;
  amountTotal: string;
}

/** Реквизиты на момент выписки: банк, адреса, основание, сумма прописью. */
export interface DocumentRequisites {
  company: { name: string; inn: string | null; legalAddress: string | null; bank: unknown };
  partner: {
    name: string;
    inn: string | null;
    legalAddress: string | null;
    actualAddress: string | null;
    bank: unknown;
  } | null;
  basis: string;
  paymentDueDate: string | null;
  paymentDelayDays: number | null;
  deliveryDate: string | null;
  vehicle: string | null;
  driver: string | null;
  netWeightT: string | null;
  grossWeightT: string | null;
  currency: string;
  amountInWords: string;
}

export interface DocumentCard extends DocumentRow {
  lines: DocumentLine[];
  requisites: DocumentRequisites | null;
  /**
   * Что человеку доступно из этого статуса при его правах. Считает сервер:
   * второй перечень правил на фронте однажды разошёлся бы с ним, и экран
   * предлагал бы действие, на которое придёт отказ.
   */
  actions: DocumentAction[];
}

export type DocumentSourceKind =
  | 'sales_order'
  | 'shipment'
  | 'deal'
  | 'finance_operation'
  | 'production_order'
  | 'partner';

export interface DocumentSourceRow {
  uid: string;
  number: string;
  at: string | null;
  partner: string | null;
  amount: string | null;
}

export interface DocumentTypeInput {
  companyUid?: string;
  code: string;
  nameRu: string;
  nameUz: string;
  numberingMask: string;
  counterScope?: 'company' | 'company_period';
}

export type DocumentTypePatch = Partial<DocumentTypeInput> & { isActive?: boolean };

/** Из чего документ сделан. `uid` пуст, если источник уже удалён. */
export interface DocumentSource {
  kind: string;
  uid: string | null;
  number: string | null;
}

export interface DocumentRow {
  uid: string;
  number: string;
  documentDate: string;
  type: { uid: string; code: string; nameRu: string; nameUz: string };
  company: { uid: string; code: string; nameRu: string; nameUz: string };
  partner: { uid: string; name: string; inn: string | null } | null;
  source: DocumentSource | null;
  amountNet: string | null;
  amountVat: string | null;
  amountTotal: string | null;
  currency: string | null;
  locale: 'ru' | 'uz';
  status: DocumentStatus;
  version: number;
  /** Почему документ в этом статусе — показывается рядом со статусом. */
  statusComment: string | null;
  statusAt: string | null;
  statusUser: string | null;
  /** Сколько прежних редакций лежит в архиве. */
  versions: number;
  author: { uid: string; name: string } | null;
  files: number;
  createdAt: string;
}

export interface DocumentsPage {
  rows: DocumentRow[];
  total: number;
  byStatus: Record<string, number>;
  limit: number;
  offset: number;
}

/** Заявка на сброс пароля: очередь администратора, пароль выдаётся руками. */
export interface PasswordResetRequest {
  uid: string;
  login: string;
  contact: string;
  note: string | null;
  status: 'new' | 'done' | 'rejected';
  createdAt: string;
  /** Есть ли на самом деле такая учётка. Наружу этот признак не уходит. */
  known: boolean;
  fullName: string | null;
  active: boolean | null;
  handledBy: string | null;
  handledAt: string | null;
  handledNote: string | null;
}

// --- Администрирование (ТЗ 3.3, 3.4) ---------------------------------------

/** Назначение: роль в компании. У человека их столько, в скольких он работает. */
export interface AdminAssignment {
  role: { code: string; nameRu: string; nameUz: string };
  company: { uid: string; code: string; nameRu: string };
  department: string | null;
  warehouse: string | null;
  scope: string;
}

export interface AdminUser {
  uid: string;
  login: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  locale: 'ru' | 'uz';
  isActive: boolean;
  lastLoginAt: string | null;
  /** Замок после неудачных попыток. Истёкший сервер не присылает. */
  lockedUntil: string | null;
  failedLoginCount: number;
  createdAt: string;
  assignments: AdminAssignment[];
  /**
   * Привязка Telegram (ТЗ 11.2). `codeExpiresAt` — живой код: он выдан, но
   * человек его ещё не ввёл. Самого кода здесь нет и быть не может — он
   * показывается один раз, в ответе на выдачу.
   */
  telegram: {
    linked: boolean;
    userId: string | null;
    linkedAt: string | null;
    codeExpiresAt: string | null;
    /** Привязка есть, но бот человеку написать не может: закрыл бота. */
    blocked: boolean;
    blockedAt: string | null;
  };
}

export interface AdminRole {
  code: string;
  nameRu: string;
  nameUz: string;
  isSystem: boolean;
  company: { uid: string; code: string } | null;
  /** Сколько людей на этой роли: по этому числу видно, что роль живая. */
  users: number;
  permissions: string[];
}

export interface AdminPermissionModule {
  module: string;
  nameRu: string;
  nameUz: string;
  permissions: { code: string; descriptionRu: string; descriptionUz: string }[];
}

export interface AdminAuditRow {
  occurredAt: string;
  entityType: string;
  entityId: string;
  /** Чем предмет зовут в работе: номер, код, имя. null — предмет удалён. */
  entityTitle: string | null;
  action: string;
  actionRu: string;
  actionUz: string;
  /** «Было → стало» по каждому полю; у действий без правки — null. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  source: string;
  ip: string | null;
  company: string;
  user: { uid: string; login: string; fullName: string } | null;
}

export interface AdminLoginRow {
  occurredAt: string;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  failureReason: string | null;
  /** Попытка под несуществующим логином человека не имеет вовсе. */
  login: string | null;
  fullName: string | null;
  reasonRu: string | null;
  reasonUz: string | null;
}

export interface AdminAssignmentInput {
  roleCode: string;
  companyUid: string;
  scope?: 'all' | 'own' | 'department' | 'warehouse';
}

// --- валюты и курсы (ТЗ 6.1-6.3) ---

export interface CurrencyRow {
  code: string;
  nameRu: string;
  nameUz: string;
  symbol: string;
  precision: number;
  /** Загружать курс с ЦБ РУз самостоятельно. */
  autoload: boolean;
  /** Учётная валюта компании: курса у неё нет, она сама себе единица. */
  isBase: boolean;
  rate: string | null;
  rateDate: string | null;
  /** `cbu.uz` — загружен с банка, `manual` — введён руками, `demo` — посев. */
  source: string | null;
  updatedAt: string | null;
  diff: number | null;
  prevDate: string | null;
  /** Курс есть, но не на сегодня: банк не ответил или ещё не опубликовал. */
  stale: boolean;
  operations: number;
}

export interface CurrenciesPage {
  rows: CurrencyRow[];
  today: string;
  checkedAt: string | null;
  sourceError: string | null;
  sourceUrl: string;
}

export interface CurrencyRateRow {
  rate: string;
  rateDate: string;
  source: string | null;
  updatedAt: string;
}

export interface CbuCurrency {
  code: string;
  nameRu: string;
  nameUz: string;
  rate: number;
}

export interface RatesSyncResult {
  saved: number;
  kept: number;
  skipped: number;
  date: string | null;
  error: string | null;
}

/**
 * Поиск по всей системе.
 *
 * `module` — раздел, который открывается по находке; он приходит с сервера, а
 * не выводится на экране по `kind`: правило «где лежит эта запись» одно, и
 * держать его в двух местах значит однажды развести их.
 */
export interface SearchRow {
  uid: string;
  title: string;
  subtitle: string | null;
}

export interface SearchGroup {
  kind: string;
  module: string;
  /** Вкладка внутри раздела: без неё переход попадает на первую попавшуюся. */
  view: string;
  /** Заголовок уже на языке запроса. */
  title: string;
  rows: SearchRow[];
}

export interface SearchResult {
  query: string;
  groups: SearchGroup[];
}

// --- Обменный слой (ТЗ 12) ---------------------------------------------------

/**
 * Подключение внешней системы. Ключа и секрета здесь нет: сервер отдаёт их
 * ровно один раз, в ответе на заведение или перевыпуск (`ExchangeSystemKey`).
 * Дальше остаётся хвост ключа и признак, что подпись настроена.
 */
export interface ExchangeSystem {
  uid: string;
  code: string;
  name: string;
  isActive: boolean;
  keyTail: string;
  hasSecret: boolean;
  allowedIps: string[];
  comment: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  usedCount: number;
  subscriptions: number;
  problems: number;
  companyUid: string;
  companyCode: string;
  companyNameRu: string;
  companyNameUz: string;
}

/** Ответ на заведение и перевыпуск: единственное место, где виден сам ключ. */
export interface ExchangeSystemKey extends ExchangeSystem {
  key: string;
  secret?: string;
}

export interface ExchangeSubscription {
  uid: string;
  event: string;
  nameRu: string;
  nameUz: string;
  url: string;
  isActive: boolean;
  createdAt: string;
  sent: number;
}

/** Событие из каталога: то, что система уже сообщала хоть раз. */
export interface ExchangeEvent {
  value: string;
  nameRu: string;
  nameUz: string;
  count: number;
}

export type ExchangeDirection = 'in' | 'out';
export type ExchangeStatus = 'pending' | 'done' | 'failed' | 'dead';

export interface ExchangeMessage {
  uid: string;
  direction: ExchangeDirection;
  event: string;
  nameRu: string;
  nameUz: string;
  externalId: string | null;
  status: ExchangeStatus;
  statusRu: string;
  statusUz: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  url: string | null;
  httpStatus: number | null;
  requestBody: string | null;
  responseBody: string | null;
  createdAt: string;
  processedAt: string | null;
  systemUid: string;
  systemCode: string;
  systemName: string;
  companyUid: string;
  companyCode: string;
}

export interface ExchangeFacets {
  systems: { uid: string; code: string; name: string; count: number }[];
  statuses: { value: ExchangeStatus; nameRu: string; nameUz: string; count: number }[];
  events: ExchangeEvent[];
}

export interface ExchangeRef {
  uid: string;
  entityType: string;
  externalId: string;
  internalUid: string;
  systemUid: string;
  systemCode: string;
  systemName: string;
  createdAt: string;
}

/** Строка протокола загрузки: номер строки файла и причина на двух языках. */
export interface ExchangeImportLine {
  line: number;
  code: string;
  reasonRu: string;
  reasonUz: string;
}

export interface ExchangeImportReport {
  fileName: string | null;
  dryRun: boolean;
  total: number;
  acceptedCount: number;
  rejectedCount: number;
  accepted: ExchangeImportLine[];
  rejected: ExchangeImportLine[];
}

// --- копии базы (Настройки → Копии базы) -------------------------------------

/** running — делается прямо сейчас; ok — файл есть; failed — причина в `error`. */
export type BackupStatus = 'running' | 'ok' | 'failed';

/** `schedule` — ночная по расписанию, `manual` — кнопкой «Сделать копию сейчас». */
export type BackupSource = 'schedule' | 'manual';

export interface BackupRow {
  uid: string;
  status: BackupStatus;
  source: BackupSource;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  /** Кто нажал кнопку. У ночной копии никого: её не запускает человек. */
  starterName: string | null;
  /** Файл ещё на диске. Вытеснен ротацией — запись осталась, файла нет. */
  onDisk: boolean;
}

/** Что настроено на сервере: куда пишем, во сколько и сколько храним. */
export interface BackupSettings {
  dir: string;
  /** `HH:MM` по времени сервера. */
  at: string;
  keep: number;
  /** Расписание включено. `BACKUP_SCHEDULER=off` его выключает. */
  scheduler: boolean;
}

export interface BackupState {
  settings: BackupSettings;
  rows: BackupRow[];
}
