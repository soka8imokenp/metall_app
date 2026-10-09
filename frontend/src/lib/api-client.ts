/**
 * Клиент API METALL ASIA.
 *
 * Единственная граница между фронтом и бэкендом (04-API-CONTRACT.md).
 * Режим переключается переменными окружения, правки кода не нужны:
 *
 *   VITE_USE_MOCKS="false"
 *   VITE_API_URL="http://127.0.0.1:4000/api/v1"
 *
 * Заголовки X-Company-Id, Authorization, Accept-Language, X-Request-Id и
 * Idempotency-Key проставляются здесь. Ошибку бэкенд отдаёт конвертом
 * { error: { code, message, details, requestId } } — она становится ApiError,
 * у которой есть и код, и HTTP-статус: экран по ним рисует разные состояния.
 */

import {
  AdminUser,
  AdminRole,
  AdminPermissionModule,
  AdminAuditRow,
  AdminLoginRow,
  AdminAssignmentInput,
  ApiResponse,
  ApiErrorResponse,
  DashboardSummary,
  DashboardPeriod,
  DashboardPlanRow,
  DashboardPlanTab,
  AuthSession,
  BackupRow,
  BackupState,
  StockBalance,
  SalesSummary,
  SalesStage,
  SalesOrderRow,
  SalesOrderDetail,
  SalesShipmentRow,
  SalesPartnerRow,
  SalesRefs,
  RefCompanySettings,
  RefPriceType,
  RefPricesPage,
  RefPriceCell,
  RefPartnerPrice,
  SalesPriceHint,
  CrmPartnersPage,
  CrmDealStage,
  CrmDealRow,
  CrmDealCard,
  CrmBoardColumn,
  CrmLostReason,
  CrmTasksPage,
  CrmTaskRow,
  CrmTaskInput,
  CrmTaskScope,
  CrmActivityRow,
  CrmActivityInput,
  CrmRefs,
  DocumentCard,
  DocumentRow,
  DocumentSourceKind,
  DocumentSourceRow,
  DocumentTypeInput,
  DocumentTypePatch,
  DocumentsPage,
  DocumentTypeRef,
  DocumentTemplateRow,
  DocumentTemplateTag,
  DocumentTemplateFields,
  DocumentTemplateCheck,
  DocumentAction,
  DocumentVersionsPage,
  DocumentHistoryRow,
  DocumentLineInput,
  ReportFormat,
  CrmCardDeal,
  CrmCardOrder,
  CrmCardDocument,
  CrmCardFinance,
  CrmCardHistoryRow,
  CrmReport,
  CrmReportKind,
  CrmLeadsPage,
  CrmLeadRow,
  CrmLeadInput,
  CrmLeadPatch,
  CrmConvertInput,
  CrmConvertResult,
  CrmPartnerCard,
  CrmPartnerOptions,
  CrmSiteKey,
  CrmSourceRule,
  CrmPartnerInput,
  CrmContactInput,
  SalesAvailability,
  SalesOrderInput,
  SalesOrderBrief,
  SalesShipmentInput,
  SalesShipmentBrief,
  SalesOrderStatus,
  ProductionSummary,
  ProductionState,
  ProductionOrderRow,
  ProductionOrderDetail,
  ProductionOptions,
  ProductionMaterialBrief,
  ProductionMaterialMoveInput,
  ProductionMaterialPlace,
  ProductionCalendar,
  ProductionCostDetail,
  ProductionCostState,
  ProductionDeviationKind,
  ProductionDeviationRow,
  ProductionDeviations,
  ProductionDowntimeInput,
  ProductionOrdersPage,
  ProductionReport,
  ProductionReportKind,
  ProductionWorkCenter,
  ProductionWorkCenterInput,
  ProductionSchedule,
  ProductionShiftInput,
  ProductionOutputRow,
  ProductionOutputInput,
  ProductionReworkInput,
  ProductionReworkBrief,
  ProductionStageBrief,
  ProductionStageInput,
  ProductionStageMark,
  ProductionOrderInput,
  ProductionOrderBrief,
  ProductionStatus,
  TechCardStatus,
  TechCardRow,
  TechCardDetail,
  TechCardBrief,
  TechCardStageInput,
  TechCardMaterialInput,
  WarehouseSummary,
  PasswordResetRequest,
  WarehouseStockRow,
  WarehouseBatchTrace,
  WarehouseSerialOption,
  WarehouseSerialTrace,
  WarehouseScanHit,
  WarehouseLabelTemplate,
  WarehouseLabelSheet,
  WarehouseRefs,
  WarehouseMoveInput,
  WarehouseMoveBrief,
  WarehouseMovesQuery,
  WarehouseMovesPage,
  WarehouseReservationInput,
  WarehousePurchaseNeeds,
  WarehouseReport,
  WarehouseReportKind,
  WarehouseReservationsPage,
  InventoryStatus,
  InventorySheetInput,
  InventorySheetRow,
  InventorySheetLineRow,
  InventorySheetsPage,
  InventorySheetDetail,
  FinanceSummary,
  FinanceOperationRow,
  FinanceOperationCard,
  FinanceReceivables,
  FinanceBudgetInput,
  FinanceBudgetPatch,
  FinanceBudgetRefs,
  FinancePlanFact,
  FinanceReport,
  FinanceReportKind,
  FinanceMarginBreakdown,
  FinanceAction,
  FinanceActionResult,
  FinanceCreateInput,
  FinancePatchInput,
  FinanceRefs,
  FinanceOperationType,
  FinanceStatus,
  CrmDeal,
  CatalogItem,
  Attachment,
  AttachmentKind,
  AttachmentOwner,
  RefItemRow,
  RefItemInput,
  RefWarehouse,
  RefReason,
  RefStockLevel,
  CbuCurrency,
  CurrenciesPage,
  CurrencyRateRow,
  RatesSyncResult,
  SearchResult,
  ExchangeSystem,
  ExchangeSystemKey,
  ExchangeSubscription,
  ExchangeEvent,
  ExchangeDirection,
  ExchangeStatus,
  ExchangeMessage,
  ExchangeFacets,
  ExchangeRef,
  ExchangeImportReport,
} from '../types/api';
import {
  MOCK_BALANCES,
  MOCK_DASHBOARD,
  MOCK_DASHBOARD_PLAN,
  MOCK_ITEMS,
  MOCK_CRM_DEALS,
} from '../mocks/fixtures';

// Режим и адрес — только из окружения.
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== 'false';
const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export const apiUsesMocks = () => USE_MOCKS;

/** Ошибка бэкенда с кодом из конверта и HTTP-статусом. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Состояние сессии.
let currentCompanyId = 'company_trade';
let currentLocale: 'ru' | 'uz' = 'ru';
let authToken: string | null = null;

/**
 * Фронт знает компании под своими именами, бэкенд — по uid. Таблицу заполняет
 * слой авторизации после входа: uid'ы выдаёт сервер, зашивать их нельзя.
 */
const companyUidByKey = new Map<string, string>();

export function setCompanyUidMap(pairs: Array<{ key: string; uid: string }>) {
  companyUidByKey.clear();
  for (const { key, uid } of pairs) companyUidByKey.set(key, uid);
}

export function setApiCompany(companyId: string) {
  currentCompanyId = companyId;
}

export function setApiLocale(locale: 'ru' | 'uz') {
  currentLocale = locale;
}

export function setApiToken(token: string | null) {
  authToken = token;
}

/**
 * Заголовок компании. 'all' — холдинг: заголовок не шлём вовсе, и бэкенд
 * отдаёт все компании, разрешённые пользователю. Так переключатель не может
 * открыть больше, чем даёт роль.
 */
function companyHeader(): Record<string, string> {
  if (USE_MOCKS) return { 'X-Company-Id': currentCompanyId };
  if (currentCompanyId === 'all') return {};
  const uid = companyUidByKey.get(currentCompanyId);
  return uid ? { 'X-Company-Id': uid } : {};
}

function generateIdempotencyKey(): string {
  return 'idemp_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// Low-level fetch wrapper
async function request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  if (USE_MOCKS) {
    // Artificial latency for authentic UI responsiveness simulation (50-150ms)
    await new Promise((r) => setTimeout(r, 60));
    return handleMockRequest<T>(endpoint, options);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...companyHeader(),
    'Accept-Language': currentLocale,
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(options.method && options.method !== 'GET' ? { 'Idempotency-Key': generateIdempotencyKey() } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });
  } catch (cause) {
    // Сеть не ответила вовсе — это не ошибка бэкенда, и экран должен сказать
    // именно это, а не «неизвестная ошибка».
    throw new ApiError('NETWORK_ERROR', 'Сервер недоступен', 0, undefined, cause);
  }

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const err = (json as ApiErrorResponse | null)?.error;
    throw new ApiError(
      err?.code || 'INTERNAL_ERROR',
      err?.message || `HTTP ${response.status}`,
      response.status,
      (err as { requestId?: string } | undefined)?.requestId,
      err?.details,
    );
  }

  return json as ApiResponse<T>;
}

/**
 * Файл, а не JSON: выгрузка отчёта.
 *
 * Отдельно от `request`, потому что всё остальное в нём про конверт
 * `{data, meta}` — разбор JSON, ApiError из тела ответа. Здесь тело ответа —
 * сам файл, и разбирать его как JSON значит потерять его целиком.
 *
 * Ссылкой это не сделать: на выгрузке стоит право, а заголовок Authorization
 * к `<a href>` не приложить — браузер ушёл бы за файлом без токена и принёс
 * 401 вместо таблицы.
 */
async function requestFile(endpoint: string): Promise<{ blob: Blob; filename: string }> {
  if (USE_MOCKS) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Выгрузка отчётов работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        ...companyHeader(),
        'Accept-Language': currentLocale,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    });
  } catch (cause) {
    throw new ApiError('NETWORK_ERROR', 'Сервер недоступен', 0, undefined, cause);
  }

  if (!response.ok) {
    // Отказ приходит обычным конвертом — его и читаем, чтобы показать причину,
    // а не «не удалось скачать».
    const json = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(
      json?.error?.code || 'INTERNAL_ERROR',
      json?.error?.message || `HTTP ${response.status}`,
      response.status,
    );
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  // Звёздная форма RFC 5987 — первой: в обычной `filename=` небуквенные
  // символы заменены подчёркиваниями, и счёт «СЧ-26/00072.docx» сохранился бы
  // как «___-26_00072.docx».
  const starred = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename = starred
    ? decodeURIComponent(starred)
    : (/filename="([^"]+)"/.exec(disposition)?.[1] ?? 'report');
  return { blob: await response.blob(), filename };
}

/**
 * Вложение: тело запроса — сами байты файла, без multipart.
 *
 * Отдельно от `request`, как и выгрузка отчётов: там конверт `{data, meta}`
 * в ответе, здесь ещё и тело запроса не JSON. Content-Type несёт тип файла —
 * по нему сервер решает, принимать ли его вовсе.
 */
async function requestUpload<T>(
  endpoint: string,
  file: File | Blob,
): Promise<ApiResponse<T>> {
  if (USE_MOCKS) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Вложения работают только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...companyHeader(),
        'Accept-Language': currentLocale,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: file,
    });
  } catch (cause) {
    throw new ApiError('NETWORK_ERROR', 'Сервер недоступен', 0, undefined, cause);
  }

  const json = (await response.json().catch(() => null)) as ApiResponse<T> | ApiErrorResponse | null;
  if (!response.ok) {
    const err = (json as ApiErrorResponse | null)?.error;
    throw new ApiError(
      err?.code || 'INTERNAL_ERROR',
      err?.message || `HTTP ${response.status}`,
      response.status,
      (err as { requestId?: string } | undefined)?.requestId,
      err?.details,
    );
  }
  return json as ApiResponse<T>;
}

// In-memory mock response router
function handleMockRequest<T>(endpoint: string, options: RequestInit): ApiResponse<T> {
  const url = new URL(endpoint, 'http://localhost');
  const path = url.pathname;

  // 1. Вход. В режиме моков пускаем любого, но форму ответа держим ту же,
  //    что у бэкенда: иначе экран входа проверен не будет.
  if (path === '/auth/login') {
    const body = JSON.parse(String(options.body ?? '{}')) as { login?: string };
    return {
      data: {
        token: 'mock_jwt_token_admin_session',
        user: {
          uid: 'mock-user-1',
          login: body.login || 'admin',
          fullName: 'Администратор системы',
          locale: 'ru',
        },
        companies: [
          { uid: 'mock-trade', code: 'trade', nameRu: 'ООО «Металл Азия»', nameUz: '«Metall Asia» MChJ' },
          { uid: 'mock-plant', code: 'plant', nameRu: 'ООО «Ташкентский изоляционный завод»', nameUz: '«Toshkent izolyatsiya zavodi» MChJ' },
        ],
        permissions: [
          'dashboard.view', 'sales.view', 'warehouse.view',
          'production.view', 'finance.view', 'crm.view', 'documents.view',
        ],
      } as unknown as T,
    };
  }

  // 2. Сводка дашборда
  if (path === '/dashboard/summary') {
    const period = (url.searchParams.get('period') || '30d') as '7d' | '30d' | '3m';
    const summary = MOCK_DASHBOARD(period);

    // Мок обязан уважать переключатель предприятий, иначе на нём не видно,
    // что экран вообще реагирует на выбор компании.
    if (currentCompanyId === 'company_trade' || currentCompanyId === 'company_factory') {
      const keep = currentCompanyId === 'company_trade' ? 'trade' : 'plant';
      summary.scope = keep as 'trade' | 'plant';
      summary.companies = summary.companies.filter((c) => c.code === keep);
      for (const point of summary.chart) {
        if (keep === 'trade') {
          point.plantTons = '0.0';
          point.plantRevenue = '0.00';
        } else {
          point.tradeTons = '0.0';
          point.tradeRevenue = '0.00';
        }
        point.totalTons = (Number(point.plantTons) + Number(point.tradeTons)).toFixed(1);
        point.totalRevenue = (Number(point.plantRevenue) + Number(point.tradeRevenue)).toFixed(2);
      }
    }
    return { data: summary as unknown as T };
  }

  // 3. Таблица плана дашборда
  if (path === '/dashboard/plan') {
    const tab = url.searchParams.get('tab') || 'plan';
    const rows = MOCK_DASHBOARD_PLAN.map((r) =>
      tab === 'done' ? { ...r, status: 'done' as const, factQty: r.planQty } : r,
    );
    return { data: rows as unknown as T };
  }

  // 2. Warehouse balances
  if (path === '/warehouse/balances') {
    let balances = [...MOCK_BALANCES];
    if (currentCompanyId !== 'all') {
      balances = balances.filter((b) => b.companyId === currentCompanyId);
    }
    return {
      data: balances as unknown as T,
      meta: { page: 1, pageSize: 50, total: balances.length, totalPages: 1 },
    };
  }

  // 4. Сканер: мока нет. Эндпоинт стал живым (ТЗ 5.9), и отвечает он объектом
  //    с кодом этикетки и контрольной цифрой, а не позицией из фикстуры.
  //    Запрос падает ниже, в общую ветку «Склад: моков нет».

  // 5. Продажи: моков нет.
  //    Экран продаж переведён на живой бэкенд, и форма ответа у него другая.
  //    Оставить старый мок значило бы отдавать в режиме моков данные, которые
  //    экран не умеет читать, — пусть лучше скажет об этом прямо.
  if (path.startsWith('/sales/')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Продажи» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 6. Stock Availability Check
  if (path === '/warehouse/availability') {
    const itemUid = url.searchParams.get('itemUid');
    const requestedQty = parseFloat(url.searchParams.get('qty') || '0');
    const item = MOCK_ITEMS.find((i) => i.uid === itemUid) || MOCK_ITEMS[0];
    const available = parseFloat(item.stock.available);
    const shortage = Math.max(0, requestedQty - available);

    return {
      data: {
        itemUid: item.uid,
        requested: requestedQty.toFixed(6),
        available: available.toFixed(6),
        shortage: shortage.toFixed(6),
        canProduce: item.itemType === 'finished' || item.itemType === 'semi',
      } as unknown as T,
    };
  }

  // Администрирование: моков нет и быть не должно. Матрица прав на выдуманных
  // данных — это ровно тот экран, который мы здесь и заменяем: он показывал
  // настройку, которой в системе нет.
  if (path.startsWith('/admin/')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Настройки» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 7. Производство: моков нет.
  //    Экран переведён на живой бэкенд, и форма ответа у него другая — в ней
  //    есть журнал событий этапа, которого фикстура не знала. Отдавать старый
  //    мок значило бы показывать экрану данные, которые он не умеет читать.
  if (path.startsWith('/production/')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Производство» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 7a. Склад: моков нет по той же причине. Фикстура знала плоский остаток
  //     без партий и без журнала, экран теперь читает партию и её путь.
  if (path.startsWith('/warehouse/')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Склад» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 7b. Финансы: моков нет по той же причине, что у склада и производства.
  //     Фикстура знала плоский список операций без проводок, остатков счетов
  //     и бюджетов; экран читает сальдо, очередь согласования и план-факт.
  if (path.startsWith('/finance/')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Финансы» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 10. Documents
  if (path.startsWith('/documents')) {
    throw new ApiError(
      'MOCKS_NOT_SUPPORTED',
      'Раздел «Документы» работает только с живым бэкендом: VITE_USE_MOCKS="false"',
      501,
    );
  }

  // 11. CRM Deals
  if (path === '/crm/deals') {
    return {
      data: MOCK_CRM_DEALS as unknown as T,
    };
  }

  // Fallback
  return { data: {} as T };
}

/* ------------------- PUBLIC API SERVICE FACADE ------------------- */
export const apiClient = {
  /**
   * Справочники (ТЗ 5.2, 5.3, 5.7, 5.10). Чтение — правом склада, запись —
   * правом `refs.edit`: его проверяет сервер, экран только прячет кнопки.
   */
  /**
   * CRM. Первый этап — клиенты (ТЗ 8.2): список, карточка, запись.
   * Правка требует права `crm.edit` и версии карточки: без версии сервер
   * откажет, чтобы двое не затирали правки друг друга.
   */
  /**
   * Документы (ТЗ 7). Пока только чтение: реестр, карточка и типы. Создание,
   * согласование и файлы идут следующими этапами модуля.
   */
  documents: {
    list: (params: {
      search?: string;
      typeUid?: string;
      typeCode?: string;
      status?: string;
      partnerUid?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.typeUid) q.set('typeUid', params.typeUid);
      if (params.typeCode) q.set('typeCode', params.typeCode);
      if (params.status) q.set('status', params.status);
      if (params.partnerUid) q.set('partnerUid', params.partnerUid);
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      q.set('limit', String(params.limit ?? 50));
      if (params.offset) q.set('offset', String(params.offset));
      return request<DocumentsPage>(`/documents?${q}`);
    },
    one: (uid: string) => request<DocumentCard>(`/documents/${uid}`),
    sources: (kind: DocumentSourceKind, search = '') => {
      const q = new URLSearchParams({ kind, search });
      return request<{ rows: DocumentSourceRow[] }>(`/documents/sources?${q}`);
    },
    createFromSource: (body: {
      documentTypeUid: string;
      sourceType: DocumentSourceKind;
      sourceUid: string;
      locale?: 'ru' | 'uz';
      documentDate?: string;
    }) =>
      request<{ uid: string; number: string }>('/documents/from-source', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    types: (all = false) =>
      request<{ rows: DocumentTypeRef[] }>(`/documents/types${all ? '?all=true' : ''}`),
    createType: (body: DocumentTypeInput) =>
      request<{ uid: string }>('/documents/types', { method: 'POST', body: JSON.stringify(body) }),
    patchType: (uid: string, body: DocumentTypePatch) =>
      request<{ uid: string }>(`/documents/types/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    removeType: (uid: string) =>
      request<{ uid: string }>(`/documents/types/${uid}`, { method: 'DELETE' }),
    // Пример номера считает сервер: правила разбора маски живут в одном месте,
    // иначе подсказка в форме разойдётся с тем, что напечатается.
    sampleNumber: (mask: string, counterScope: string, code: string, typeUid?: string) => {
      const q = new URLSearchParams({ mask, counterScope, code });
      if (typeUid) q.set('typeUid', typeUid);
      return request<{ sample: string }>(`/documents/types/sample?${q}`);
    },

    /** Движение по маршруту согласования (ТЗ 7.4). */
    act: (uid: string, action: DocumentAction, comment?: string) =>
      request<{ uid: string; status: string; comment: string | null }>(
        `/documents/${uid}/actions`,
        { method: 'POST', body: JSON.stringify({ action, ...(comment ? { comment } : {}) }) },
      ),

    /**
     * Правка документа. `version` обязательна: двое открыли документ, один
     * сохранил — второй не должен затереть чужое молча.
     */
    patch: (
      uid: string,
      body: {
        version: number;
        documentDate?: string;
        locale?: 'ru' | 'uz';
        lines?: DocumentLineInput[];
      },
    ) =>
      request<{ uid: string; version: number; status: string }>(`/documents/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    versions: (uid: string) => request<DocumentVersionsPage>(`/documents/${uid}/versions`),
    history: (uid: string) =>
      request<{ rows: DocumentHistoryRow[]; total: number }>(`/documents/${uid}/history`),

    /** Печатная форма прежней редакции — та самая, которой её печатали. */
    versionFile: (uid: string, version: number, format: 'docx' | 'pdf' = 'docx') =>
      requestFile(`/documents/${uid}/versions/${version}/file?format=${format}`),

    /**
     * Печатная форма (ТЗ 7.2, 7.5): DOCX — то, что ещё правят, PDF — то,
     * что отправляют и подписывают.
     */
    file: (uid: string, format: 'docx' | 'pdf' = 'docx') =>
      requestFile(`/documents/${uid}/file?format=${format}`),

    templates: {
      list: (typeUid?: string) =>
        request<{ rows: DocumentTemplateRow[] }>(
          `/documents/templates${typeUid ? `?typeUid=${typeUid}` : ''}`,
        ),
      /** Список полей системы — то, с чем сопоставляют теги файла. */
      fields: () => request<DocumentTemplateFields>('/documents/templates/fields'),
      upload: (documentTypeUid: string, locale: 'ru' | 'uz', file: File) => {
        const q = new URLSearchParams({ documentTypeUid, locale, name: file.name });
        return requestUpload<{ uid: string; version: number; tags: DocumentTemplateTag[] }>(
          `/documents/templates/upload?${q}`,
          file,
        );
      },
      setFieldMap: (uid: string, fieldMap: Record<string, string>) =>
        request<{ uid: string; tags: DocumentTemplateTag[] }>(
          `/documents/templates/${uid}/field-map`,
          { method: 'PATCH', body: JSON.stringify({ fieldMap }) },
        ),
      check: (uid: string) =>
        request<DocumentTemplateCheck>(`/documents/templates/${uid}/check`, { method: 'POST' }),
      publish: (uid: string) =>
        request<{ uid: string; published: boolean }>(`/documents/templates/${uid}/publish`, {
          method: 'POST',
        }),
      unpublish: (uid: string) =>
        request<{ uid: string; published: boolean }>(`/documents/templates/${uid}/unpublish`, {
          method: 'POST',
        }),
      file: (uid: string) => requestFile(`/documents/templates/${uid}/file`),
      remove: (uid: string) =>
        request<{ uid: string }>(`/documents/templates/${uid}`, { method: 'DELETE' }),
    },
  },

  crm: {
    partners: (params: {
      search?: string;
      managerUid?: string;
      sourceUid?: string;
      role?: 'any' | 'client' | 'supplier';
      all?: boolean;
      limit?: number;
      offset?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.managerUid) q.set('managerUid', params.managerUid);
      if (params.sourceUid) q.set('sourceUid', params.sourceUid);
      if (params.role && params.role !== 'any') q.set('role', params.role);
      if (params.all) q.set('all', 'true');
      q.set('limit', String(params.limit ?? 50));
      if (params.offset) q.set('offset', String(params.offset));
      return request<CrmPartnersPage>(`/crm/partners?${q}`);
    },
    partner: (uid: string) => request<CrmPartnerCard>(`/crm/partners/${uid}`),
    partnerOptions: () => request<CrmPartnerOptions>('/crm/partners/options'),
    siteKeys: () => request<{ rows: CrmSiteKey[] }>('/crm/site-keys'),
    createSiteKey: (input: { companyUid?: string; name: string; origins?: string[] }) =>
      request<CrmSiteKey>('/crm/site-keys', { method: 'POST', body: JSON.stringify(input) }),
    updateSiteKey: (uid: string, input: { name?: string; origins?: string[]; isActive?: boolean }) =>
      request<CrmSiteKey>(`/crm/site-keys/${uid}`, { method: 'PATCH', body: JSON.stringify(input) }),
    sourceRules: () => request<{ rows: CrmSourceRule[] }>('/crm/source-rules'),
    createPartner: (input: CrmPartnerInput) =>
      request<CrmPartnerCard>('/crm/partners', { method: 'POST', body: JSON.stringify(input) }),
    updatePartner: (uid: string, input: Partial<CrmPartnerInput> & { version: number; isActive?: boolean }) =>
      request<CrmPartnerCard>(`/crm/partners/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deletePartner: (uid: string) =>
      request<{ deleted: boolean }>(`/crm/partners/${uid}`, { method: 'DELETE' }),
    addContact: (partnerUid: string, input: CrmContactInput) =>
      request<CrmPartnerCard>(`/crm/partners/${partnerUid}/contacts`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateContact: (uid: string, input: Partial<CrmContactInput>) =>
      request<CrmPartnerCard>(`/crm/contacts/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteContact: (uid: string) =>
      request<CrmPartnerCard>(`/crm/contacts/${uid}`, { method: 'DELETE' }),
    leads: (params: {
      search?: string;
      status?: string;
      sourceUid?: string;
      managerUid?: string;
      limit?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.status) q.set('status', params.status);
      if (params.sourceUid) q.set('sourceUid', params.sourceUid);
      if (params.managerUid) q.set('managerUid', params.managerUid);
      q.set('limit', String(params.limit ?? 50));
      return request<CrmLeadsPage>(`/crm/leads?${q}`);
    },
    createLead: (input: CrmLeadInput) =>
      request<CrmLeadRow>('/crm/leads', { method: 'POST', body: JSON.stringify(input) }),
    updateLead: (uid: string, input: CrmLeadPatch) =>
      request<CrmLeadRow>(`/crm/leads/${uid}`, { method: 'PATCH', body: JSON.stringify(input) }),
    convertLead: (uid: string, input: CrmConvertInput) =>
      request<CrmConvertResult>(`/crm/leads/${uid}/convert`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    dealStages: () => request<{ rows: CrmDealStage[] }>('/crm/deal-stages'),
    lostReasons: () => request<{ rows: CrmLostReason[] }>('/crm/lost-reasons'),
    board: (params: { managerUid?: string; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.managerUid) q.set('managerUid', params.managerUid);
      if (params.search) q.set('search', params.search);
      return request<{ stages: CrmBoardColumn[] }>(`/crm/deals/board?${q}`);
    },
    deals: (
      params: {
        search?: string;
        status?: string;
        companyUid?: string;
        managerUid?: string;
        sort?: string;
        dir?: 'asc' | 'desc';
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.status) q.set('status', params.status);
      if (params.companyUid) q.set('companyUid', params.companyUid);
      if (params.managerUid) q.set('managerUid', params.managerUid);
      if (params.sort) q.set('sort', params.sort);
      if (params.dir) q.set('dir', params.dir);
      q.set('limit', String(params.limit ?? 50));
      if (params.offset) q.set('offset', String(params.offset));
      return request<{ rows: CrmDealRow[]; total: number; limit: number; offset: number }>(
        `/crm/deals?${q}`,
      );
    },
    deal: (uid: string) => request<CrmDealCard>(`/crm/deals/${uid}`),
    moveDeal: (uid: string, stageUid: string, version: number) =>
      request<CrmDealCard>(`/crm/deals/${uid}/move`, {
        method: 'POST',
        body: JSON.stringify({ stageUid, version }),
      }),
    winDeal: (uid: string, version: number, comment: string) =>
      request<CrmDealCard>(`/crm/deals/${uid}/win`, {
        method: 'POST',
        body: JSON.stringify({ version, comment }),
      }),
    loseDeal: (uid: string, version: number, reasonUid: string, comment: string) =>
      request<CrmDealCard>(`/crm/deals/${uid}/lose`, {
        method: 'POST',
        body: JSON.stringify({ version, reasonUid, comment }),
      }),
    tasks: (params: {
      scope?: CrmTaskScope;
      assigneeUid?: string;
      partnerUid?: string;
      dealUid?: string;
      typeUid?: string;
      limit?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.scope) q.set('scope', params.scope);
      if (params.assigneeUid) q.set('assigneeUid', params.assigneeUid);
      if (params.partnerUid) q.set('partnerUid', params.partnerUid);
      if (params.dealUid) q.set('dealUid', params.dealUid);
      if (params.typeUid) q.set('typeUid', params.typeUid);
      q.set('limit', String(params.limit ?? 100));
      return request<CrmTasksPage>(`/crm/tasks?${q}`);
    },
    createTask: (input: CrmTaskInput) =>
      request<CrmTaskRow>('/crm/tasks', { method: 'POST', body: JSON.stringify(input) }),
    updateTask: (uid: string, input: Partial<CrmTaskInput> & { version: number }) =>
      request<CrmTaskRow>(`/crm/tasks/${uid}`, { method: 'PATCH', body: JSON.stringify(input) }),
    completeTask: (uid: string, version: number, result: string) =>
      request<CrmTaskRow>(`/crm/tasks/${uid}/complete`, {
        method: 'POST',
        body: JSON.stringify({ version, result }),
      }),
    cancelTask: (uid: string, version: number, result: string) =>
      request<CrmTaskRow>(`/crm/tasks/${uid}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ version, result }),
      }),
    activities: (params: { partnerUid?: string; dealUid?: string; type?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.partnerUid) q.set('partnerUid', params.partnerUid);
      if (params.dealUid) q.set('dealUid', params.dealUid);
      if (params.type) q.set('type', params.type);
      q.set('limit', String(params.limit ?? 50));
      return request<{ rows: CrmActivityRow[]; total: number }>(`/crm/activities?${q}`);
    },
    /**
     * Справочники CRM одним запросом: экран показывает их вместе, и четыре
     * отдельных вызова дали бы четыре разных момента времени.
     */
    refs: (all = false) => request<CrmRefs>(`/crm/refs${all ? '?all=true' : ''}`),
    createStage: (input: {
      companyUid?: string;
      code: string;
      nameRu: string;
      nameUz?: string;
      probabilityDefault?: number;
    }) => request<{ uid: string }>('/crm/refs/stages', { method: 'POST', body: JSON.stringify(input) }),
    updateStage: (
      uid: string,
      input: {
        code?: string;
        nameRu?: string;
        nameUz?: string;
        probabilityDefault?: number;
        isActive?: boolean;
      },
    ) =>
      request<{ uid: string; updated: true }>(`/crm/refs/stages/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteStage: (uid: string) =>
      request<{ uid: string; removed: true }>(`/crm/refs/stages/${uid}`, { method: 'DELETE' }),
    reorderStages: (companyUid: string, uids: string[]) =>
      request<{ reordered: number }>('/crm/refs/stages/order', {
        method: 'POST',
        body: JSON.stringify({ companyUid, uids }),
      }),
    createSource: (input: {
      companyUid?: string;
      code: string;
      nameRu: string;
      nameUz?: string;
      channel: string;
    }) => request<{ uid: string }>('/crm/refs/sources', { method: 'POST', body: JSON.stringify(input) }),
    updateSource: (
      uid: string,
      input: { code?: string; nameRu?: string; nameUz?: string; channel?: string; isActive?: boolean },
    ) =>
      request<{ uid: string; updated: true }>(`/crm/refs/sources/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteSource: (uid: string) =>
      request<{ uid: string; removed: true }>(`/crm/refs/sources/${uid}`, { method: 'DELETE' }),
    createLostReason: (input: { companyUid?: string; code: string; nameRu: string; nameUz?: string }) =>
      request<{ uid: string }>('/crm/refs/lost-reasons', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateLostReason: (
      uid: string,
      input: { code?: string; nameRu?: string; nameUz?: string; isActive?: boolean },
    ) =>
      request<{ uid: string; updated: true }>(`/crm/refs/lost-reasons/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteLostReason: (uid: string) =>
      request<{ uid: string; removed: true }>(`/crm/refs/lost-reasons/${uid}`, { method: 'DELETE' }),
    createTaskType: (input: {
      companyUid?: string;
      code: string;
      nameRu: string;
      nameUz?: string;
      activityKind: string;
    }) =>
      request<{ uid: string }>('/crm/refs/task-types', { method: 'POST', body: JSON.stringify(input) }),
    updateTaskType: (
      uid: string,
      input: {
        code?: string;
        nameRu?: string;
        nameUz?: string;
        activityKind?: string;
        seq?: number;
        isActive?: boolean;
      },
    ) =>
      request<{ uid: string; updated: true }>(`/crm/refs/task-types/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteTaskType: (uid: string) =>
      request<{ uid: string; removed: true }>(`/crm/refs/task-types/${uid}`, { method: 'DELETE' }),

    createActivity: (input: CrmActivityInput) =>
      request<CrmActivityRow>('/crm/activities', { method: 'POST', body: JSON.stringify(input) }),

    partnerDeals: (uid: string) =>
      request<{ rows: CrmCardDeal[]; total: number }>(`/crm/partners/${uid}/deals`),
    partnerOrders: (uid: string) =>
      request<{ rows: CrmCardOrder[]; total: number }>(`/crm/partners/${uid}/orders`),
    partnerDocuments: (uid: string) =>
      request<{ rows: CrmCardDocument[]; total: number; readOnly: boolean }>(
        `/crm/partners/${uid}/documents`,
      ),
    partnerFinance: (uid: string) => request<CrmCardFinance>(`/crm/partners/${uid}/finance`),
    partnerHistory: (uid: string) =>
      request<{ rows: CrmCardHistoryRow[]; total: number }>(`/crm/partners/${uid}/history`),

    report: (params: { kind: CrmReportKind; from?: string; to?: string; limit?: number }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 500) });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return request<CrmReport>(`/crm/reports/${params.kind}?${q}`);
    },

    /** Тот же отчёт файлом: `csv` для чужих программ, `xlsx` для человека. */
    downloadReport: (params: {
      kind: CrmReportKind;
      format: ReportFormat;
      from?: string;
      to?: string;
    }) => {
      const q = new URLSearchParams({ format: params.format });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return requestFile(`/crm/reports/${params.kind}/file?${q}`);
    },
  },

  refs: {
    items: (params: { search?: string; all?: boolean; limit?: number } = {}) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 200) });
      if (params.search?.trim()) q.set('search', params.search.trim());
      if (params.all) q.set('all', 'true');
      return request<{ rows: RefItemRow[] }>(`/refs/items?${q}`);
    },
    createItem: (input: RefItemInput) =>
      request<{ uid: string; code: string }>('/refs/items', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateItem: (uid: string, input: RefItemInput) =>
      request<{ uid: string }>(`/refs/items/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteItem: (uid: string) =>
      request<{ uid: string }>(`/refs/items/${uid}`, { method: 'DELETE' }),

    settings: (companyUid?: string) =>
      request<{ rows: RefCompanySettings[] }>(
        `/refs/settings${companyUid ? `?companyUid=${companyUid}` : ''}`,
      ),
    setSettings: (input: {
      companyUid?: string;
      costingMethod?: string;
      belowCostMode?: string;
      // `null` снимает порог, `undefined` — поле не трогали. Различие держит
      // сервер, и клиент обязан передавать его как есть.
      approvalLimitSingle?: number | null;
      approvalLimitPeriod?: number | null;
      approvalPeriodDays?: number;
    }) =>
      request<RefCompanySettings>('/refs/settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    // --- валюты и курсы (ТЗ 6.1-6.3) ---
    //
    // Курс читает каждый, кто работает с деньгами; пишет — право `refs.edit`.
    // Обновление с ЦБ РУз сервер делает и сам, кнопка — для «прямо сейчас».
    currencies: () => request<CurrenciesPage>('/refs/currencies'),
    currencyRates: (code: string, limit = 30) =>
      request<{ rows: CurrencyRateRow[] }>(`/refs/currencies/${code}/rates?limit=${limit}`),
    syncCurrencies: (force = true) =>
      request<RatesSyncResult>('/refs/currencies/sync', {
        method: 'POST',
        body: JSON.stringify({ force }),
      }),
    setCurrencyRate: (code: string, input: { rateDate: string; rate: number }) =>
      request<{ code: string; rateDate: string; rate: string; source: string }>(
        `/refs/currencies/${code}/rates`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    addCurrency: (code: string) =>
      request<{ code: string; nameRu: string; rate: string }>('/refs/currencies', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    setCurrencyAutoload: (code: string, autoload: boolean) =>
      request<{ code: string; autoload: boolean }>(`/refs/currencies/${code}`, {
        method: 'PATCH',
        body: JSON.stringify({ autoload }),
      }),
    availableCurrencies: () =>
      request<{ rows: CbuCurrency[]; error: string | null }>('/refs/currencies/available'),

    // --- прайс-лист и цены клиентов (ТЗ 9.2) ---

    priceTypes: (companyUid?: string) =>
      request<{ rows: RefPriceType[] }>(
        `/refs/price-types${companyUid ? `?companyUid=${companyUid}` : ''}`,
      ),
    createPriceType: (input: {
      companyUid?: string;
      code: string;
      nameRu: string;
      nameUz?: string;
      kind: string;
    }) =>
      request<{ uid: string; code: string }>('/refs/price-types', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updatePriceType: (uid: string, input: { nameRu?: string; nameUz?: string; kind?: string }) =>
      request<{ uid: string }>(`/refs/price-types/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deletePriceType: (uid: string) =>
      request<{ uid: string }>(`/refs/price-types/${uid}`, { method: 'DELETE' }),

    prices: (params: {
      companyUid?: string;
      search?: string;
      onDate?: string;
      limit?: number;
      offset?: number;
    } = {}) => {
      const q = new URLSearchParams({
        limit: String(params.limit ?? 50),
        offset: String(params.offset ?? 0),
      });
      if (params.companyUid) q.set('companyUid', params.companyUid);
      if (params.search?.trim()) q.set('search', params.search.trim());
      if (params.onDate) q.set('onDate', params.onDate);
      return request<RefPricesPage>(`/refs/prices?${q}`);
    },
    priceHistory: (itemUid: string, priceTypeUid: string) =>
      request<{ rows: RefPriceCell[] }>(
        `/refs/prices/history?itemUid=${itemUid}&priceTypeUid=${priceTypeUid}`,
      ),
    setPrice: (input: {
      companyUid?: string;
      itemCode: string;
      priceTypeCode: string;
      price: number;
      validFrom?: string;
    }) =>
      request<{ uid: string; price: number; validFrom: string; closedPrevious: boolean }>(
        '/refs/prices',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    deletePrice: (uid: string) =>
      request<{ uid: string }>(`/refs/prices/${uid}`, { method: 'DELETE' }),

    partnerPrices: (partnerUid: string, onDate?: string) =>
      request<{ onDate: string; rows: RefPartnerPrice[] }>(
        `/refs/partner-prices?partnerUid=${partnerUid}${onDate ? `&onDate=${onDate}` : ''}`,
      ),
    setPartnerPrice: (input: {
      companyUid?: string;
      partnerUid: string;
      itemCode: string;
      price: number;
      validFrom?: string;
    }) =>
      request<{ uid: string; price: number; validFrom: string }>('/refs/partner-prices', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    deletePartnerPrice: (uid: string) =>
      request<{ uid: string }>(`/refs/partner-prices/${uid}`, { method: 'DELETE' }),

    places: (all = false) =>
      request<{ rows: RefWarehouse[] }>(`/refs/places${all ? '?all=true' : ''}`),
    createWarehouse: (input: { code: string; nameRu: string; address?: string }) =>
      request<{ uid: string }>('/refs/warehouses', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateWarehouse: (uid: string, input: { code?: string; nameRu?: string; address?: string; isActive?: boolean }) =>
      request<{ uid: string }>(`/refs/warehouses/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    createZone: (input: { warehouseUid: string; code: string; nameRu: string }) =>
      request<{ uid: string }>('/refs/zones', { method: 'POST', body: JSON.stringify(input) }),
    createLocation: (input: { zoneUid: string; code: string; barcode?: string }) =>
      request<{ uid: string }>('/refs/locations', { method: 'POST', body: JSON.stringify(input) }),
    updateLocation: (uid: string, input: { code?: string; barcode?: string; isActive?: boolean }) =>
      request<{ uid: string }>(`/refs/locations/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteLocation: (uid: string) =>
      request<{ uid: string }>(`/refs/locations/${uid}`, { method: 'DELETE' }),

    reasons: (all = false) =>
      request<{ rows: RefReason[] }>(`/refs/reasons${all ? '?all=true' : ''}`),
    createReason: (input: { kind: string; nameRu: string }) =>
      request<{ uid: string }>('/refs/reasons', { method: 'POST', body: JSON.stringify(input) }),
    updateReason: (uid: string, input: { nameRu?: string; isActive?: boolean }) =>
      request<{ uid: string }>(`/refs/reasons/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteReason: (uid: string) =>
      request<{ uid: string }>(`/refs/reasons/${uid}`, { method: 'DELETE' }),

    levels: () => request<{ rows: RefStockLevel[] }>('/refs/stock-levels'),
    setLevel: (input: {
      itemUid: string;
      warehouseUid: string;
      minQty: number;
      criticalQty: number;
      comment?: string;
    }) =>
      request<{ uid: string }>('/refs/stock-levels', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    deleteLevel: (uid: string) =>
      request<{ uid: string }>(`/refs/stock-levels/${uid}`, { method: 'DELETE' }),
  },

  /**
   * Вложения к операциям (ТЗ 5.4, 5.6, 6.3). Один набор методов на все
   * владельцы: право спрашивает сервер по тому, к чему приложен файл.
   */
  attachments: {
    list: (owner: AttachmentOwner, uid: string) => {
      if (USE_MOCKS) return Promise.resolve({ data: [] as Attachment[] });
      return request<Attachment[]>(`/attachments?owner=${owner}&uid=${uid}`);
    },

    upload: (
      params: { owner: AttachmentOwner; uid: string; kind?: AttachmentKind; comment?: string },
      file: File,
    ) => {
      const q = new URLSearchParams({
        owner: params.owner,
        uid: params.uid,
        name: file.name || 'vlozhenie',
      });
      if (params.kind) q.set('kind', params.kind);
      if (params.comment?.trim()) q.set('comment', params.comment.trim());
      return requestUpload<Attachment>(`/attachments?${q}`, file);
    },

    /** Байты вложения. Ссылкой не открыть: на выдаче стоит право и токен. */
    file: (uid: string) => requestFile(`/attachments/${uid}/file`),

    remove: (uid: string) =>
      request<{ uid: string; removed: true }>(`/attachments/${uid}`, { method: 'DELETE' }),
  },

  auth: {
    login: (login: string, password: string) =>
      request<AuthSession>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      }),
    me: () => request<Omit<AuthSession, 'token'>>('/auth/me'),
    // Язык — настройка человека, а не состояние вкладки: тот же, что в боте.
    setLocale: (locale: 'ru' | 'uz') =>
      request<{ ok: boolean }>('/auth/me/locale', {
        method: 'POST',
        body: JSON.stringify({ locale }),
      }),
    // «Забыли пароль» — заявка администратору, а не сброс: см. auth.service.
    requestPasswordReset: (login: string, contact: string, note?: string) =>
      request<{ accepted: boolean }>('/auth/password-reset-request', {
        method: 'POST',
        body: JSON.stringify({ login, contact, ...(note ? { note } : {}) }),
      }),
    /**
     * Своя смена пароля. Единственная дверь, кроме чтения профиля, которая
     * работает с временным паролем, — ею и снимается признак.
     */
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('/auth/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    resetRequests: (status: 'new' | 'all' = 'new') =>
      request<{ rows: PasswordResetRequest[] }>(`/auth/password-reset-requests?status=${status}`),
    /**
     * Разбор заявки. При `done` в ответе приходит временный пароль — его
     * показывают один раз тому, кто сбросил, и больше он не выдаётся нигде.
     */
    handleResetRequest: (uid: string, action: 'done' | 'rejected', note?: string) =>
      request<{ ok: boolean; password: string | null }>(`/auth/password-reset-requests/${uid}`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      }),
  },
  admin: {
    users: (params: { search?: string; includeInactive?: boolean; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.includeInactive === false) q.set('includeInactive', 'false');
      q.set('limit', String(params.limit ?? 200));
      return request<{ total: number; rows: AdminUser[] }>(`/admin/users?${q}`);
    },
    createUser: (input: {
      login: string;
      fullName: string;
      password: string;
      email?: string;
      phone?: string;
      locale?: 'ru' | 'uz';
      assignments: AdminAssignmentInput[];
    }) =>
      request<{ uid: string }>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    patchUser: (
      uid: string,
      input: {
        fullName?: string;
        email?: string | null;
        phone?: string | null;
        locale?: 'ru' | 'uz';
        isActive?: boolean;
      },
    ) =>
      request<{ uid: string }>(`/admin/users/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Пароль уходит на сервер и назад не возвращается ни в каком виде.
    setPassword: (uid: string, password: string) =>
      request<{ passwordChanged: boolean }>(`/admin/users/${uid}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    unlock: (uid: string) =>
      request<{ uid: string }>(`/admin/users/${uid}/unlock`, { method: 'POST' }),

    /**
     * Код привязки Telegram. Ответ — единственное место, где код виден: в базе
     * лежит хеш, в журнале только факт выдачи и срок.
     */
    telegramCode: (uid: string) =>
      request<{ code: string; expiresAt: string; ttlMinutes: number; login: string }>(
        `/admin/users/${uid}/telegram/code`,
        { method: 'POST' },
      ),
    telegramUnlink: (uid: string) =>
      request<{ uid: string; linked: boolean }>(`/admin/users/${uid}/telegram`, {
        method: 'DELETE',
      }),
    setRoles: (uid: string, assignments: AdminAssignmentInput[]) =>
      request<{ uid: string }>(`/admin/users/${uid}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ assignments }),
      }),
    permissions: () => request<{ modules: AdminPermissionModule[] }>('/admin/permissions'),
    roles: () => request<{ rows: AdminRole[] }>('/admin/roles'),
    createRole: (input: {
      code: string;
      nameRu: string;
      nameUz: string;
      permissions: string[];
    }) => request<AdminRole>('/admin/roles', { method: 'POST', body: JSON.stringify(input) }),
    patchRole: (code: string, input: { nameRu?: string; nameUz?: string }) =>
      request<AdminRole>(`/admin/roles/${code}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    setRolePermissions: (code: string, permissions: string[]) =>
      request<AdminRole>(`/admin/roles/${code}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      }),
    removeRole: (code: string) =>
      request<{ deleted: boolean }>(`/admin/roles/${code}`, { method: 'DELETE' }),
    audit: (
      params: {
        entityType?: string;
        action?: string;
        userUid?: string;
        from?: string;
        to?: string;
        search?: string;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') q.set(k, String(v));
      }
      if (!q.has('limit')) q.set('limit', '50');
      return request<{
        total: number;
        limit: number;
        offset: number;
        rows: AdminAuditRow[];
      }>(`/admin/audit?${q}`);
    },
    auditFacets: () =>
      request<{
        entities: { value: string; count: number }[];
        actions: { value: string; nameRu: string; nameUz: string; count: number }[];
      }>('/admin/audit/facets'),
    logins: (params: { onlyFailed?: boolean; limit?: number; offset?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.onlyFailed) q.set('onlyFailed', 'true');
      q.set('limit', String(params.limit ?? 50));
      if (params.offset) q.set('offset', String(params.offset));
      return request<{
        total: number;
        limit: number;
        offset: number;
        rows: AdminLoginRow[];
      }>(`/admin/logins?${q}`);
    },

    /**
     * Копии базы: что настроено и что уже сделано.
     *
     * Право то же, что у остального раздела, — `admin.users`. Отдельного права
     * под бэкап не заведено: RBAC этой задачей не менялся.
     */
    backups: () => request<BackupState>('/admin/backups'),

    /**
     * «Сделать копию сейчас». Ответ — строка журнала, и у неё может быть
     * `status: 'failed'`: отказ `pg_dump` приходит не ошибкой HTTP, а записью с
     * причиной. Иначе экран сказал бы «не удалось» без объяснения, а разбирать
     * пришлось бы по журналу службы.
     */
    runBackup: () => request<BackupRow>('/admin/backups', { method: 'POST' }),

    /** Файл копии. Через `requestFile`: на маршруте право, а `<a href>` токена не несёт. */
    downloadBackup: (uid: string) => requestFile(`/admin/backups/${uid}/file`),
  },
  dashboard: {
    getSummary: (period: DashboardPeriod) =>
      request<DashboardSummary>(`/dashboard/summary?period=${period}`),
    getPlan: (tab: DashboardPlanTab, limit = 50) =>
      request<DashboardPlanRow[]>(`/dashboard/plan?tab=${tab}&limit=${limit}`),
  },
  warehouse: {
    getSummary: (period: DashboardPeriod) =>
      request<WarehouseSummary>(`/warehouse/summary?period=${period}`),
    getStock: (params: { warehouse?: string; search?: string; critical?: boolean; limit?: number }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 100) });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.search?.trim()) q.set('search', params.search.trim());
      if (params.critical) q.set('critical', 'true');
      return request<{ rows: WarehouseStockRow[] }>(`/warehouse/stock?${q}`);
    },
    getBatch: (uid: string) => request<WarehouseBatchTrace>(`/warehouse/batches/${uid}`),

    /**
     * Номера, лежащие на складе, — для подбора в форме операции. Склад
     * передаётся, когда он в форме уже выбран: предложить трубу с другого
     * склада значит подставить человеку отказ на сохранении.
     */
    getSerials: (params: { itemCode: string; warehouseCode?: string; limit?: number }) => {
      const q = new URLSearchParams({ itemCode: params.itemCode });
      if (params.warehouseCode) q.set('warehouseCode', params.warehouseCode);
      if (params.limit) q.set('limit', String(params.limit));
      return request<{ rows: WarehouseSerialOption[] }>(`/warehouse/serials?${q}`);
    },
    /** Путь одной штуки: состояние, место сейчас и все её движения. */
    getSerial: (number: string) =>
      request<WarehouseSerialTrace>(`/warehouse/serials/${encodeURIComponent(number)}`),

    /**
     * Журнал движений с фильтрами. Незаполненное поле не отправляется вовсе:
     * сервер отвергает негодное значение целиком, и пустая строка от пустого
     * фильтра превратила бы «показать всё» в 400.
     */
    getMoves: (params: WarehouseMovesQuery = {}) => {
      const q = new URLSearchParams({
        limit: String(params.limit ?? 50),
        offset: String(params.offset ?? 0),
      });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.operationType) q.set('operationType', params.operationType);
      if (params.itemCode) q.set('itemCode', params.itemCode);
      if (params.batchNumber) q.set('batchNumber', params.batchNumber);
      if (params.partner) q.set('partner', params.partner);
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      if (params.search?.trim()) q.set('search', params.search.trim());
      return request<WarehouseMovesPage>(`/warehouse/moves?${q}`);
    },

    /** Справочники формы движения: склады, номенклатура, причины, поставщики. */
    getRefs: () => request<WarehouseRefs>('/warehouse/refs'),

    /**
     * Приход, списание или перемещение. Ключ идемпотентности живёт, пока форма
     * не сохранена: двойное нажатие иначе заведёт два движения, а журнал
     * движений не правят — только пополняют.
     */
    createMove: (input: WarehouseMoveInput, idempotencyKey: string) =>
      request<WarehouseMoveBrief>('/warehouse/moves', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),

    /** Отмена движения зеркальным движением: строку журнала не удаляют. */
    reverseMove: (uid: string, comment?: string) =>
      request<WarehouseMoveBrief>(`/warehouse/moves/${uid}/reverse`, {
        method: 'POST',
        body: JSON.stringify(comment ? { comment } : {}),
      }),

    /** Активные резервы. Снятые сервер не отдаёт: снятый ничего не держит. */
    getReservations: (params: { warehouse?: string; itemCode?: string; limit?: number } = {}) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 50) });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.itemCode?.trim()) q.set('itemCode', params.itemCode.trim());
      return request<WarehouseReservationsPage>(`/warehouse/reservations?${q}`);
    },

    /**
     * Постановка резерва. Ключ идемпотентности здесь не нужен: лишний резерв
     * снимают снятием, а не сторно, и журнал от этого не пухнет.
     */
    createReservation: (input: WarehouseReservationInput) =>
      request<{ uid: string }>('/warehouse/reservations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Снятие резерва: строка остаётся в истории со статусом «снят». */
    releaseReservation: (uid: string) =>
      request<{ uid: string }>(`/warehouse/reservations/${uid}`, { method: 'DELETE' }),

    /**
     * Потребность в закупке (ТЗ 5.10). По умолчанию сервер отдаёт только то,
     * что требует закупки; `all` показывает и позиции без нехватки.
     */
    getPurchaseNeeds: (
      params: {
        warehouse?: string;
        state?: 'critical' | 'below_min';
        all?: boolean;
        limit?: number;
      } = {},
    ) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 200) });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.state) q.set('state', params.state);
      if (params.all) q.set('all', 'true');
      return request<WarehousePurchaseNeeds>(`/warehouse/purchase-needs?${q}`);
    },

    /**
     * Отчёты склада (ТЗ 5.1). Период понимают движения, оборачиваемость и
     * расхождения; остаткам и доступности он не нужен — они про «сейчас».
     */
    getReport: (params: {
      kind: WarehouseReportKind;
      warehouse?: string;
      from?: string;
      to?: string;
      limit?: number;
    }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 500) });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return request<WarehouseReport>(`/warehouse/reports/${params.kind}?${q}`);
    },

    /** Тот же отчёт файлом: `csv` для чужих программ, `xlsx` для человека. */
    downloadReport: (params: {
      kind: WarehouseReportKind;
      format: ReportFormat;
      warehouse?: string;
      from?: string;
      to?: string;
    }) => {
      const q = new URLSearchParams({ format: params.format });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return requestFile(`/warehouse/reports/${params.kind}/file?${q}`);
    },

    /** Листы инвентаризации (ТЗ 5.8). */
    getSheets: (params: { warehouse?: string; status?: InventoryStatus; limit?: number } = {}) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 50) });
      if (params.warehouse) q.set('warehouse', params.warehouse);
      if (params.status) q.set('status', params.status);
      return request<InventorySheetsPage>(`/warehouse/inventory?${q}`);
    },

    /** Лист со строками: то, с чем человек стоит у полки. */
    getSheet: (uid: string) => request<InventorySheetDetail>(`/warehouse/inventory/${uid}`),

    /**
     * Новый лист: сервер сам снимает учётные количества по складу или зоне.
     * Ключ идемпотентности не нужен — второй лист по тому же месту сервер
     * отвергает сам, иначе получилось бы два разных «правильных» количества.
     */
    createSheet: (input: InventorySheetInput) =>
      request<InventorySheetRow>('/warehouse/inventory', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Факт по строке. Ноль — законный результат: «на полке пусто». */
    countLine: (uid: string, qty: string, comment?: string) =>
      request<InventorySheetLineRow>(`/warehouse/inventory/lines/${uid}/count`, {
        method: 'POST',
        body: JSON.stringify(comment ? { qty, comment } : { qty }),
      }),

    /** Считать закончили: лист уходит на утверждение. */
    finishSheet: (uid: string) =>
      request<InventorySheetRow>(`/warehouse/inventory/${uid}/finish`, { method: 'POST' }),

    /** Утверждение: недостачи и излишки уходят в журнал движениями. */
    approveSheet: (uid: string) =>
      request<InventorySheetRow>(`/warehouse/inventory/${uid}/approve`, { method: 'POST' }),

    /** Отмена листа. Остаток не меняется: считать — не значит поправить. */
    cancelSheet: (uid: string) =>
      request<InventorySheetRow>(`/warehouse/inventory/${uid}`, { method: 'DELETE' }),

    /**
     * Что принёс сканер (ТЗ 5.9). Разбирает сервер: у нашего кода есть
     * контрольная цифра, и проверять её на экране значило бы держать вторую
     * реализацию того же правила.
     */
    scanCode: (code: string) =>
      request<WarehouseScanHit>(`/warehouse/scan?code=${encodeURIComponent(code)}`),

    /** Шаблоны этикеток: размер листа, сетка и симвология — настройка. */
    getLabelTemplates: () =>
      request<{ rows: WarehouseLabelTemplate[] }>('/warehouse/labels/templates'),

    /**
     * Лист этикеток к печати. Экран отдаёт коды, а не строки остатка: одна
     * этикетка клеится на объект, и объект в ней определён кодом целиком.
     */
    buildLabels: (input: { templateUid: string; codes: string[]; copies?: number }) =>
      request<WarehouseLabelSheet>('/warehouse/labels', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    // Ниже — вызовы, оставшиеся от импортированного макета: модалка
    // прослеживаемости и проверка доступности. Живых эндпоинтов под ними нет,
    // работают только на фикстурах. Их зовут дашборд и поиск; убираются
    // вместе с этими экранами, а не здесь.
    getBalances: () => request<StockBalance[]>('/warehouse/balances'),
    checkAvailability: (itemUid: string, qty: number) =>
      request<{ itemUid: string; requested: string; available: string; shortage: string; canProduce: boolean }>(
        `/warehouse/availability?itemUid=${itemUid}&qty=${qty}`
      ),
  },
  sales: {
    getSummary: (period: DashboardPeriod) =>
      request<SalesSummary>(`/sales/summary?period=${period}`),
    getOrders: (stage: SalesStage = 'all', search = '', limit = 50) =>
      request<SalesOrderRow[]>(
        `/sales/orders?stage=${stage}&limit=${limit}` +
          (search ? `&search=${encodeURIComponent(search)}` : ''),
      ),
    getOrder: (uid: string) => request<SalesOrderDetail>(`/sales/orders/${uid}`),
    getShipments: (limit = 50) => request<SalesShipmentRow[]>(`/sales/shipments?limit=${limit}`),
    getPartners: (limit = 50) => request<SalesPartnerRow[]>(`/sales/partners?limit=${limit}`),

    /** Справочники формы заказа: компании, покупатели, номенклатура, склады. */
    getRefs: () => request<SalesRefs>('/sales/refs'),

    /** Что система предложит за позицию этому клиенту (ТЗ 9.2). */
    priceHint: (partnerUid: string, itemCode: string, onDate?: string) =>
      request<SalesPriceHint>(
        `/sales/price?partnerUid=${partnerUid}&itemCode=${encodeURIComponent(itemCode)}` +
          (onDate ? `&onDate=${onDate}` : ''),
      ),

    /** Что по заказу осталось отгрузить и из каких партий. */
    getAvailability: (uid: string) =>
      request<SalesAvailability>(`/sales/orders/${uid}/availability`),

    /** Новый заказ со спецификацией. Суммы считает сервер. */
    createOrder: (input: SalesOrderInput) =>
      request<SalesOrderBrief>('/sales/orders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Смена статуса. В «отгружен» заказ переводит только ТТН. */
    setOrderStatus: (uid: string, status: SalesOrderStatus, comment?: string) =>
      request<SalesOrderBrief>(`/sales/orders/${uid}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
      }),

    /**
     * ТТН. Ключ идемпотентности живёт, пока форма не сохранена: двойное
     * нажатие иначе выпишет вторую накладную, и со склада уедет вдвое больше
     * товара, чем погрузили.
     */
    createShipment: (orderUid: string, input: SalesShipmentInput, idempotencyKey: string) =>
      request<SalesShipmentBrief>(`/sales/orders/${orderUid}/shipments`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
  },
  production: {
    getSummary: (period: DashboardPeriod) =>
      request<ProductionSummary>(`/production/summary?period=${period}`),
    getOrders: (state: ProductionState = 'all', search = '', limit = 50, offset = 0) =>
      request<ProductionOrdersPage>(
        `/production/orders?state=${state}&limit=${limit}&offset=${offset}` +
          (search ? `&search=${encodeURIComponent(search)}` : ''),
      ),
    getOrder: (uid: string) => request<ProductionOrderDetail>(`/production/orders/${uid}`),

    /** Продукция, ответственные и заказы продаж для формы заведения. */
    getOptions: () => request<ProductionOptions>('/production/options'),

    /** Новый заказ цеха. Рождается черновиком: его ещё не видел участок. */
    createOrder: (input: ProductionOrderInput) =>
      request<ProductionOrderBrief>('/production/orders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Правка заказа. Сервер примет её только в черновике. */
    updateOrder: (uid: string, input: Partial<ProductionOrderInput>) =>
      request<ProductionOrderBrief>(`/production/orders/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    /**
     * Переход по статусам. Причина обязательна для паузы и отмены — её
     * спрашивает форма, а проверяет всё равно сервер.
     */
    setOrderStatus: (uid: string, status: ProductionStatus, comment?: string) =>
      request<ProductionOrderBrief>(`/production/orders/${uid}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
      }),

    // --- Этапы заказа и отметки цеха ----------------------------------------

    /** Развернуть этапы из техкарты той версии, которую помнит заказ. */
    planStagesFromCard: (uid: string) =>
      request<ProductionStageBrief[]>(`/production/orders/${uid}/stages/from-card`, {
        method: 'POST',
      }),

    /** Задать этапы руками — списком целиком, а не по строке. */
    setStages: (uid: string, stages: ProductionStageInput[]) =>
      request<ProductionStageBrief[]>(`/production/orders/${uid}/stages`, {
        method: 'PUT',
        body: JSON.stringify({ stages }),
      }),

    /**
     * Отметка по этапу. Причина нужна паузе: из неё растёт журнал простоев, и
     * спрашивает её экран, а проверяет всё равно сервер.
     */
    markStage: (
      uid: string,
      seq: number,
      kind: ProductionStageMark,
      input: { reasonUid?: string; comment?: string } = {},
    ) =>
      request<ProductionStageBrief>(`/production/orders/${uid}/stages/${seq}/mark`, {
        method: 'POST',
        body: JSON.stringify({ kind, ...input }),
      }),

    // --- Материалы заказа: план, выдача в цех, возврат, расход ---------------

    /** План расхода из техкарты: норма на количество заказа и отход этапа. */
    planMaterialsFromCard: (uid: string) =>
      request<ProductionMaterialBrief[]>(`/production/orders/${uid}/materials/from-card`, {
        method: 'POST',
      }),

    /** Где взять материал: склад, ячейка, партия и свободный остаток. */
    getMaterialStock: (uid: string, itemCode: string) =>
      request<{ itemCode: string; rows: ProductionMaterialPlace[] }>(
        `/production/orders/${uid}/materials/stock?itemCode=${encodeURIComponent(itemCode)}`,
      ),

    issueMaterial: (uid: string, input: ProductionMaterialMoveInput) =>
      request<ProductionMaterialBrief>(`/production/orders/${uid}/materials/issue`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    returnMaterial: (uid: string, input: ProductionMaterialMoveInput) =>
      request<ProductionMaterialBrief>(`/production/orders/${uid}/materials/return`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Сколько материала ушло в работу. Склада не касается — только заказа. */
    useMaterial: (uid: string, input: { itemCode: string; qty: string; comment?: string }) =>
      request<ProductionMaterialBrief>(`/production/orders/${uid}/materials/use`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    // --- Выпуск заказа: годное, брак, отход, переделка -----------------------

    /** Отчёты производства (Э8): на экран — первые строки, в файл — весь. */
    getReport: (params: {
      kind: ProductionReportKind;
      from?: string;
      to?: string;
      limit?: number;
    }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 500) });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return request<ProductionReport>(`/production/reports/${params.kind}?${q}`);
    },

    downloadReport: (params: {
      kind: ProductionReportKind;
      format: ReportFormat;
      from?: string;
      to?: string;
    }) => {
      const q = new URLSearchParams({ format: params.format });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      return requestFile(`/production/reports/${params.kind}/file?${q}`);
    },

    /** Справочник участков: сменная мощность и ставка часа (Э8). */
    getWorkCenters: () => request<ProductionWorkCenter[]>('/production/work-centers'),

    saveWorkCenter: (input: ProductionWorkCenterInput, code?: string) =>
      request<ProductionWorkCenter[]>(
        code ? `/production/work-centers/${code}` : '/production/work-centers',
        { method: code ? 'PATCH' : 'POST', body: JSON.stringify(input) },
      ),

    /** Календарь завода: смены, рабочая неделя и выходные (Э7). */
    getCalendar: (from?: string, to?: string) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const tail = q.toString();
      return request<ProductionCalendar>(`/production/calendar${tail ? `?${tail}` : ''}`);
    },

    setWorkWeek: (days: number[]) =>
      request<ProductionCalendar>('/production/calendar/week', {
        method: 'POST',
        body: JSON.stringify({ days }),
      }),

    setCalendarDay: (day: string, isWorking: boolean, comment?: string) =>
      request<ProductionCalendar>('/production/calendar/days', {
        method: 'POST',
        body: JSON.stringify({ day, isWorking, ...(comment ? { comment } : {}) }),
      }),

    clearCalendarDay: (day: string) =>
      request<ProductionCalendar>(`/production/calendar/days/${day}/clear`, { method: 'POST' }),

    saveShift: (input: ProductionShiftInput, uid?: string) =>
      request<ProductionCalendar>(
        uid ? `/production/calendar/shifts/${uid}` : '/production/calendar/shifts',
        { method: uid ? 'PATCH' : 'POST', body: JSON.stringify(input) },
      ),

    /** Журнал отклонений: простои, перерасход, брак, срыв срока (Э7). */
    getDeviations: (period: DashboardPeriod, kind?: ProductionDeviationKind, limit = 100) => {
      const q = new URLSearchParams({ period, limit: String(limit) });
      if (kind) q.set('kind', kind);
      return request<ProductionDeviations>(`/production/deviations?${q.toString()}`);
    },

    registerDowntime: (input: ProductionDowntimeInput) =>
      request<ProductionDeviationRow>('/production/deviations/downtime', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Разложить этапы заказа по сменам календаря. */
    scheduleStages: (uid: string) =>
      request<ProductionSchedule>(`/production/orders/${uid}/stages/schedule`, { method: 'POST' }),

    /** Расчёт себестоимости заказа: текущий со строками и история (ТЗ 4.7). */
    getCost: (uid: string) => request<ProductionCostState>(`/production/orders/${uid}/cost`),

    calculateCost: (uid: string) =>
      request<ProductionCostDetail>(`/production/orders/${uid}/cost`, { method: 'POST' }),

    /** Что цех сдал по заказу. Та же лента, что в карточке. */
    getOutputs: (uid: string) =>
      request<ProductionOutputRow[]>(`/production/orders/${uid}/outputs`),

    /** Записать выпуск: годное и полуфабрикат уходят на склад тем же действием. */
    registerOutput: (uid: string, input: ProductionOutputInput) =>
      request<ProductionOutputRow[]>(`/production/orders/${uid}/output`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Переделка брака — дочерний заказ, а не правка этого. */
    reworkOrder: (uid: string, input: ProductionReworkInput) =>
      request<ProductionReworkBrief>(`/production/orders/${uid}/rework`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    // --- Техкарты: норма, по которой считают заказ ---------------------------

    getTechCards: (params: { status?: TechCardStatus | null; itemCode?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.status) q.set('status', params.status);
      if (params.itemCode) q.set('itemCode', params.itemCode);
      return request<{ rows: TechCardRow[] }>(`/production/tech-cards?${q.toString()}`);
    },

    getTechCard: (uid: string) => request<TechCardDetail>(`/production/tech-cards/${uid}`),

    createTechCard: (input: {
      itemCode: string;
      nameRu: string;
      nameUz: string;
      stages?: TechCardStageInput[];
      materials?: TechCardMaterialInput[];
    }) =>
      request<TechCardBrief>('/production/tech-cards', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** Правку сервер примет только в черновике — у действующей поднимают версию. */
    updateTechCard: (
      uid: string,
      input: {
        nameRu?: string;
        nameUz?: string;
        stages?: TechCardStageInput[];
        materials?: TechCardMaterialInput[];
      },
    ) =>
      request<TechCardBrief>(`/production/tech-cards/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    newTechCardVersion: (uid: string) =>
      request<TechCardBrief>(`/production/tech-cards/${uid}/new-version`, { method: 'POST' }),

    activateTechCard: (uid: string) =>
      request<TechCardBrief>(`/production/tech-cards/${uid}/activate`, { method: 'POST' }),

    archiveTechCard: (uid: string) =>
      request<TechCardBrief>(`/production/tech-cards/${uid}/archive`, { method: 'POST' }),
  },
  finance: {
    getSummary: (period: DashboardPeriod) =>
      request<FinanceSummary>(`/finance/summary?period=${period}`),
    getOperations: (params: {
      status?: FinanceStatus | null;
      type?: FinanceOperationType | null;
      search?: string;
      limit?: number;
    }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 100) });
      if (params.status) q.set('status', params.status);
      if (params.type) q.set('type', params.type);
      if (params.search?.trim()) q.set('search', params.search.trim());
      return request<{ rows: FinanceOperationRow[] }>(`/finance/operations?${q}`);
    },
    getOperation: (uid: string) => request<FinanceOperationCard>(`/finance/operations/${uid}`),
    getReceivables: (params: { overdueOnly?: boolean; limit?: number }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 100) });
      if (params.overdueOnly) q.set('overdueOnly', 'true');
      return request<FinanceReceivables>(`/finance/receivables?${q}`);
    },
    getPlanFact: () => request<FinancePlanFact>('/finance/budgets/plan-fact'),

    /**
     * Отчёты финансов (ТЗ 6.9). Разрез `by` понимает только отчёт по марже;
     * остальным он не нужен, и слать его им значило бы делать вид, что у них
     * есть разрез, которого нет.
     */
    getReport: (params: {
      kind: FinanceReportKind;
      from?: string;
      to?: string;
      by?: FinanceMarginBreakdown;
      limit?: number;
    }) => {
      const q = new URLSearchParams({ limit: String(params.limit ?? 500) });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      if (params.by) q.set('by', params.by);
      return request<FinanceReport>(`/finance/reports/${params.kind}?${q}`);
    },

    /** Тот же отчёт файлом: `csv` для чужих программ, `xlsx` и `pdf` для человека. */
    downloadReport: (params: {
      kind: FinanceReportKind;
      format: ReportFormat;
      from?: string;
      to?: string;
      by?: FinanceMarginBreakdown;
    }) => {
      const q = new URLSearchParams({ format: params.format });
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      if (params.by) q.set('by', params.by);
      return requestFile(`/finance/reports/${params.kind}/file?${q}`);
    },

    /**
     * Бюджеты (ТЗ 6.6). Чтение плана-факта — право `finance.view`, запись —
     * `finance.approve`: сколько можно потратить за период, решает тот, кто
     * согласовывает платежи, а не тот, кто их проводит.
     */
    getBudgetRefs: () => request<FinanceBudgetRefs>('/finance/budgets/refs'),
    createBudget: (input: FinanceBudgetInput) =>
      request<{ uid: string; period: string }>('/finance/budgets', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    patchBudget: (uid: string, input: FinanceBudgetPatch) =>
      request<{ uid: string }>(`/finance/budgets/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteBudget: (uid: string) =>
      request<{ uid: string; deleted: boolean }>(`/finance/budgets/${uid}`, { method: 'DELETE' }),

    /**
     * Действие над операцией: отправить, утвердить, отклонить, провести.
     *
     * `version` берётся из карточки, которую человек видит на экране, и уходит
     * в тело запроса. Сервер пишет условием `version = присланная`, поэтому
     * второе нажатие той же кнопки и правка из соседней вкладки возвращают
     * 409, а не второй комплект проводок.
     */
    act: (uid: string, action: FinanceAction, version: number, comment?: string) =>
      request<FinanceActionResult>(`/finance/operations/${uid}/${action}`, {
        method: 'POST',
        body: JSON.stringify(comment ? { version, comment } : { version }),
      }),

    /** Справочники формы: счета, статьи ДДС, валюты, контрагенты. */
    getRefs: () => request<FinanceRefs>('/finance/refs'),

    /**
     * Заведение операции. Ключ идемпотентности приходит снаружи и живёт,
     * пока открыта форма: общая обвязка генерирует его на каждый запрос, и
     * двойное нажатие «Сохранить» завело бы две одинаковые заявки.
     */
    create: (input: FinanceCreateInput, idempotencyKey: string) =>
      request<FinanceActionResult>('/finance/operations', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),

    patch: (uid: string, input: FinancePatchInput) =>
      request<FinanceActionResult>(`/finance/operations/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    reverse: (uid: string, version: number, comment?: string) =>
      request<FinanceActionResult>(`/finance/operations/${uid}/reverse`, {
        method: 'POST',
        body: JSON.stringify(comment ? { version, comment } : { version }),
      }),
  },
  /**
   * Поиск по всей системе (одно окно на данные, а не на названия разделов).
   * Группы приходят уже отфильтрованными по правам: что человеку не положено,
   * сервер не присылает вовсе, и прятать на экране нечего.
   */
  search: {
    find: (q: string, limit = 5) =>
      request<SearchResult>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  },
  /**
   * Обмен с внешними системами (ТЗ 12).
   *
   * Ключ подключения приходит только из `createSystem` и `rotateKey` — в списке
   * его нет вовсе. Поэтому экран обязан показать его сразу: второй раз спросить
   * будет уже не у кого.
   */
  exchange: {
    systems: () => request<{ rows: ExchangeSystem[] }>('/exchange/systems'),
    createSystem: (input: {
      code: string;
      name: string;
      companyUid?: string;
      allowedIps?: string[];
      comment?: string;
      withSecret?: boolean;
    }) =>
      request<ExchangeSystemKey>('/exchange/systems', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    patchSystem: (
      uid: string,
      input: { name?: string; isActive?: boolean; allowedIps?: string[]; comment?: string },
    ) =>
      request<ExchangeSystem>(`/exchange/systems/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    rotateKey: (uid: string, withSecret?: boolean) =>
      request<ExchangeSystemKey>(`/exchange/systems/${uid}/key`, {
        method: 'POST',
        body: JSON.stringify(withSecret === undefined ? {} : { withSecret }),
      }),

    subscriptions: (systemUid: string) =>
      request<{ rows: ExchangeSubscription[] }>(`/exchange/systems/${systemUid}/subscriptions`),
    putSubscription: (
      systemUid: string,
      input: { event: string; url: string; isActive?: boolean },
    ) =>
      request<{ uid: string; event: string; url: string }>(
        `/exchange/systems/${systemUid}/subscriptions`,
        { method: 'PUT', body: JSON.stringify(input) },
      ),
    removeSubscription: (uid: string) =>
      request<{ uid: string; deleted: true }>(`/exchange/subscriptions/${uid}`, {
        method: 'DELETE',
      }),
    events: () => request<{ rows: ExchangeEvent[] }>('/exchange/events'),

    messages: (
      params: {
        systemUid?: string;
        direction?: ExchangeDirection;
        status?: ExchangeStatus;
        event?: string;
        search?: string;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      if (params.systemUid) q.set('systemUid', params.systemUid);
      if (params.direction) q.set('direction', params.direction);
      if (params.status) q.set('status', params.status);
      if (params.event) q.set('event', params.event);
      if (params.search) q.set('search', params.search);
      q.set('limit', String(params.limit ?? 50));
      q.set('offset', String(params.offset ?? 0));
      return request<{ total: number; limit: number; offset: number; rows: ExchangeMessage[] }>(
        `/exchange/messages?${q}`,
      );
    },
    facets: () => request<ExchangeFacets>('/exchange/messages/facets'),
    retry: (uid: string) =>
      request<{ uid: string; status: string }>(`/exchange/messages/${uid}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),

    refs: (params: { systemUid?: string; entityType?: string; search?: string } = {}) => {
      const q = new URLSearchParams();
      if (params.systemUid) q.set('systemUid', params.systemUid);
      if (params.entityType) q.set('entityType', params.entityType);
      if (params.search) q.set('search', params.search);
      return request<{ rows: ExchangeRef[] }>(`/exchange/refs?${q}`);
    },
    putRef: (input: {
      systemUid: string;
      entityType: string;
      externalId: string;
      internalUid: string;
    }) => request<ExchangeRef>('/exchange/refs', { method: 'PUT', body: JSON.stringify(input) }),
    removeRef: (uid: string) =>
      request<{ uid: string; deleted: true }>(`/exchange/refs/${uid}`, { method: 'DELETE' }),

    itemsFile: (format: 'xlsx' | 'csv') => requestFile(`/exchange/items/file?format=${format}`),
    /**
     * Загрузка номенклатуры. `dryRun` — проверочный прогон: протокол тот же,
     * в базу не пишется ничего. Он и предлагается первым: человек сначала
     * смотрит, что система поняла, и только потом применяет.
     */
    importItems: (file: File, params: { dryRun?: boolean; systemUid?: string } = {}) => {
      const q = new URLSearchParams();
      q.set('name', file.name);
      if (params.dryRun) q.set('dryRun', 'true');
      if (params.systemUid) q.set('systemUid', params.systemUid);
      return requestUpload<ExchangeImportReport>(`/exchange/items/import?${q}`, file);
    },
  },
};
