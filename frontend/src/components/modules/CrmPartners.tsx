/**
 * CRM Э1 — клиенты и поставщики (ТЗ 8.2).
 *
 * Список слева, карточка справа. Не две страницы: менеджер ищет клиента и
 * тут же звонит или правит отсрочку, и уход со списка на отдельный экран
 * заставлял бы искать заново после каждой правки.
 *
 * Один контрагент на обе роли: «клиент» и «поставщик» — признаки в карточке,
 * а не два справочника. Завод и покупает у нас, и возит нам трубу; заведённый
 * дважды, он дал бы две задолженности по одному ИНН.
 *
 * Экран ничего не пересчитывает и ничего не решает: где клиент уже участвует,
 * можно ли его удалить и какая у карточки версия — говорит сервер. Кнопки
 * строятся по `permissions` записи, а сервер проверяет право повторно.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Phone, Plus, Search, Trash2, User, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  CrmPartnerCard,
  CrmPartnerOptions,
  CrmPartnerRow,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { CrmPartnerFull } from './CrmPartnerFull';
import { refName } from '../../lib/formatters';
import { useSearchJump } from '../../lib/use-search-jump';

const ROLES = [
  { value: 'any', ru: 'Все', uz: 'Hammasi' },
  { value: 'client', ru: 'Клиенты', uz: 'Mijozlar' },
  { value: 'supplier', ru: 'Поставщики', uz: 'Yetkazuvchilar' },
] as const;

type Role = (typeof ROLES)[number]['value'];

const money = (v: string) => Number(v || 0).toLocaleString('ru-RU');

export const CrmPartners: React.FC = () => {
  const { locale, company } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const canEdit = can('crm.edit');

  const [rows, setRows] = useState<CrmPartnerRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState<ApiError | null>(null);

  const [search, setSearch] = useState('');
  useSearchJump('crm', setSearch, 'partners');
  const [role, setRole] = useState<Role>('any');
  const [showOff, setShowOff] = useState(false);

  const [card, setCard] = useState<CrmPartnerCard | null>(null);
  const [cardError, setCardError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<CrmPartnerOptions | null>(null);
  const [creating, setCreating] = useState(false);
  /** Карточка целиком: у неё девять вкладок, в колонку 22rem они не влезают. */
  const [full, setFull] = useState(false);

  const load = useCallback(async () => {
    setListError(null);
    try {
      const res = await apiClient.crm.partners({
        search: search.trim() || undefined,
        role,
        all: showOff,
        limit: 100,
      });
      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch (e) {
      setRows([]);
      setListError(e as ApiError);
    }
  }, [search, role, showOff, company]);

  // Поиск не дёргает сервер на каждой букве: человек печатает ИНН девятью
  // нажатиями, и это девять запросов, из которых нужен последний.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!options) {
      apiClient.crm
        .partnerOptions()
        .then((r) => setOptions(r.data))
        .catch(() => setOptions({ managers: [], sources: [], priceTypes: [], companies: [] }));
    }
  }, [options]);

  const open = async (uid: string) => {
    setCreating(false);
    setCardError(null);
    try {
      const res = await apiClient.crm.partner(uid);
      setCard(res.data);
    } catch (e) {
      setCard(null);
      setCardError(e as ApiError);
    }
  };

  const save = async (patch: Record<string, unknown>) => {
    if (!card) return;
    setBusy(true);
    setCardError(null);
    try {
      const res = await apiClient.crm.updatePartner(card.uid, {
        ...patch,
        version: card.version,
      } as never);
      setCard(res.data);
      await load();
    } catch (e) {
      setCardError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (full && card) {
    return <CrmPartnerFull card={card} onBack={() => setFull(false)} />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-4 items-start">
      <div className={`${CARD} flex flex-col min-w-0`}>
        <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isUz ? 'Nomi, INN, aloqa shaxsi' : 'Название, ИНН, контактное лицо или телефон'
              }
              aria-label={isUz ? 'Mijozlarni qidirish' : 'Поиск клиентов'}
              className={`${FIELD} pl-9`}
            />
          </div>
          <div className="w-32 shrink-0">
            <CustomSelect
              ariaLabel={isUz ? 'Rol' : 'Роль контрагента'}
              value={role}
              onChange={(v) => setRole(v as Role)}
              options={ROLES.map((r) => ({ value: r.value, label: isUz ? r.uz : r.ru }))}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 whitespace-nowrap shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={showOff}
              onChange={(e) => setShowOff(e.target.checked)}
              className="w-3.5 h-3.5 cursor-pointer"
            />
            {isUz ? 'O‘chirilganlar' : 'Выключенные'}
          </label>
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setCard(null);
                setCardError(null);
                setCreating(true);
              }}
              className={`${BTN_PRIMARY} inline-flex items-center gap-1.5 whitespace-nowrap shrink-0`}
            >
              <Plus className="w-3.5 h-3.5" />
              {isUz ? 'Mijoz qo‘shish' : 'Добавить клиента'}
            </button>
          )}
        </div>

        {listError ? (
          <ErrorBox text={errorText(listError, isUz)} onRetry={() => void load()} isUz={isUz} />
        ) : rows === null ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty text={isUz ? 'Mijozlar topilmadi' : 'Клиентов не найдено'} />
        ) : (
          <>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {rows.map((r) => (
                <li key={r.uid}>
                  <button
                    type="button"
                    onClick={() => void open(r.uid)}
                    className={`w-full text-left px-4 py-2.5 flex flex-col gap-1 transition-colors cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${
                      card?.uid === r.uid ? 'bg-zinc-100/70 dark:bg-zinc-800/60' : ''
                    } ${r.isActive ? '' : 'opacity-60'}`}
                  >
                    <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                      {r.partnerType === 'person' ? (
                        <User className="w-3.5 h-3.5 text-zinc-400 shrink-0 self-center" />
                      ) : (
                        <Building2 className="w-3.5 h-3.5 text-zinc-400 shrink-0 self-center" />
                      )}
                      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                        {refName(r, isUz)}
                      </span>
                      {r.inn && (
                        <span className="text-[10px] font-mono text-zinc-400">{isUz ? 'STIR' : 'ИНН'} {r.inn}</span>
                      )}
                      {!r.isActive && (
                        <span className="text-[10px] text-amber-700 dark:text-amber-400">
                          {isUz ? 'o‘chirilgan' : 'выключен'}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
                      {/* Компания в строке нужна, только когда открыты обе:
                          иначе одно и то же имя стоит у каждого клиента. */}
                      {(options?.companies.length ?? 0) > 1 && (
                        <span>{refName(r.company, isUz)}</span>
                      )}
                      {r.manager && <span>{r.manager.name}</span>}
                      {r.phone && (
                        <span className="inline-flex items-center gap-1 font-mono">
                          <Phone className="w-3 h-3" />
                          {r.phone}
                        </span>
                      )}
                      {r.isSupplier && <span>{isUz ? 'yetkazuvchi' : 'поставщик'}</span>}
                      {r.tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-4 py-2 text-[11px] text-zinc-400 border-t border-zinc-200 dark:border-zinc-800">
              {isUz ? 'Ko‘rsatilgan' : 'Показано'} {rows.length} {isUz ? 'dan' : 'из'} {total}
            </div>
          </>
        )}
      </div>

      <div className={`${CARD} p-4 flex flex-col gap-3 min-w-0`}>
        {creating ? (
          <PartnerForm
            isUz={isUz}
            options={options}
            onCancel={() => setCreating(false)}
            onDone={async (uid) => {
              setCreating(false);
              await load();
              await open(uid);
            }}
          />
        ) : card ? (
          <PartnerCard
            card={card}
            isUz={isUz}
            canEdit={canEdit}
            busy={busy}
            options={options}
            error={cardError}
            onSave={save}
            onReload={() => void open(card.uid)}
            onOpenFull={() => setFull(true)}
            onDeleted={async () => {
              setCard(null);
              await load();
            }}
          />
        ) : cardError ? (
          <ErrorBox text={errorText(cardError, isUz)} isUz={isUz} />
        ) : (
          <p className="text-[11px] text-zinc-500 break-words">
            {isUz
              ? 'Ro‘yxatdan mijozni tanlang: kartochka shu yerda ochiladi.'
              : 'Выберите клиента в списке — карточка откроется здесь.'}
          </p>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Карточка                                                            */
/* ------------------------------------------------------------------ */

const USAGE_TEXT: Record<string, { ru: string; uz: string }> = {
  deals: { ru: 'сделки', uz: 'bitimlar' },
  leads: { ru: 'лиды', uz: 'lidlar' },
  orders: { ru: 'заказы', uz: 'buyurtmalar' },
  moves: { ru: 'движения склада', uz: 'ombor harakatlari' },
  payments: { ru: 'платежи', uz: 'to‘lovlar' },
  batches: { ru: 'партии', uz: 'partiyalar' },
  documents: { ru: 'документы', uz: 'hujjatlar' },
  prices: { ru: 'цены', uz: 'narxlar' },
  tasks: { ru: 'задачи', uz: 'vazifalar' },
  activities: { ru: 'активности', uz: 'faoliyatlar' },
  files: { ru: 'файлы', uz: 'fayllar' },
};

const PartnerCard: React.FC<{
  card: CrmPartnerCard;
  isUz: boolean;
  canEdit: boolean;
  busy: boolean;
  options: CrmPartnerOptions | null;
  error: ApiError | null;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onReload: () => void;
  onOpenFull: () => void;
  onDeleted: () => Promise<void>;
}> = ({ card, isUz, canEdit, busy, options, error, onSave, onReload, onOpenFull, onDeleted }) => {
  const [contactOpen, setContactOpen] = useState(false);
  const used = useMemo(
    () =>
      Object.entries(card.usage)
        .filter(([k, v]) => k !== 'total' && Number(v) > 0)
        // Подпись ищется с запасным вариантом: новый счётчик на сервере не
        // должен ронять карточку, пока ему не завели перевод. Ровно это и
        // случилось, когда в Э4 к счётчикам добавились задачи.
        .map(([k, v]) => `${(isUz ? USAGE_TEXT[k]?.uz : USAGE_TEXT[k]?.ru) ?? k} — ${v}`),
    [card.usage, isUz],
  );

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-words">
            {refName(card, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500 font-mono">
            {card.inn ? `ИНН ${card.inn}` : isUz ? 'INN ko‘rsatilmagan' : 'ИНН не указан'}
          </span>
        </div>
        {!card.isActive && (
          <span className="text-[10px] text-amber-700 dark:text-amber-400 shrink-0">
            {isUz ? 'o‘chirilgan' : 'выключен'}
          </span>
        )}
      </div>

      {/* Карточку целиком открываем отдельно: сделки, заказы, платежи и журнал
          в колонку рядом со списком не помещаются, а резать их нельзя — ТЗ 8.2
          называет их содержимым карточки. */}
      <button
        type="button"
        onClick={onOpenFull}
        className={`${BTN_PRIMARY} inline-flex items-center justify-center gap-1.5 whitespace-nowrap`}
      >
        {isUz ? 'Kartochkani to‘liq ochish' : 'Открыть карточку целиком'}
      </button>

      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-zinc-500">{isUz ? 'Kompaniya' : 'Компания'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 break-words">
          {refName(card.company, isUz)}
        </dd>
        <dt className="text-zinc-500">{isUz ? 'Menejer' : 'Менеджер'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 break-words">
          {card.manager?.name ?? '—'}
        </dd>
        <dt className="text-zinc-500">{isUz ? 'Manba' : 'Источник'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 break-words">{card.source?.name ?? '—'}</dd>
        <dt className="text-zinc-500">{isUz ? 'Narx turi' : 'Тип цены'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 break-words">
          {card.priceType?.name ?? '—'}
        </dd>
        <dt className="text-zinc-500">{isUz ? 'To‘lov muddati' : 'Отсрочка'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 tabular-nums">
          {card.paymentDelayDays} {isUz ? 'kun' : 'дн.'}
        </dd>
        <dt className="text-zinc-500">{isUz ? 'Qarz chegarasi' : 'Лимит долга'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 font-mono tabular-nums">
          {money(card.debtLimit)} UZS
        </dd>
        <dt className="text-zinc-500">{isUz ? 'Yuridik manzil' : 'Юр. адрес'}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200 break-words">
          {card.legalAddress || '—'}
        </dd>
      </dl>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">
          {isUz ? 'Aloqa shaxslari' : 'Контактные лица'}
        </span>
        {card.contacts.length === 0 ? (
          <span className="text-[11px] text-zinc-400">
            {isUz ? 'Kiritilmagan' : 'Не заведены'}
          </span>
        ) : (
          <ul className="flex flex-col gap-1">
            {card.contacts.map((c) => (
              <li
                key={c.uid}
                className="flex items-start justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-2 py-1.5"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-[11px] text-zinc-900 dark:text-zinc-100 break-words">
                    {c.fullName}
                    {c.isPrimary && (
                      <span className="ml-1.5 text-[10px] text-zinc-400">
                        {isUz ? 'asosiy' : 'главный'}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono break-words">
                    {[c.position, c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`${isUz ? 'Aloqa shaxsini o‘chirish' : 'Удалить контакт'}: ${c.fullName}`}
                    onClick={async () => {
                      await apiClient.crm.deleteContact(c.uid);
                      onReload();
                    }}
                    className="p-1 rounded-md text-zinc-400 hover:text-red-600 shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && !contactOpen && (
          <button
            type="button"
            onClick={() => setContactOpen(true)}
            className={`${BTN_GHOST} self-start inline-flex items-center gap-1.5 whitespace-nowrap`}
          >
            <Plus className="w-3.5 h-3.5" />
            {isUz ? 'Aloqa shaxsi qo‘shish' : 'Добавить контакт'}
          </button>
        )}
        {contactOpen && (
          <ContactForm
            isUz={isUz}
            partnerUid={card.uid}
            onDone={() => {
              setContactOpen(false);
              onReload();
            }}
            onCancel={() => setContactOpen(false)}
          />
        )}
      </div>

      {/* Только факты: где клиент уже участвует и сколько раз. Правило,
          почему его нельзя удалить, стоит на самой кнопке удаления —
          там, где человек в него упирается, а не абзацем на каждой карточке. */}
      {used.length > 0 && (
        <p className="text-[11px] text-zinc-500 break-words">
          {isUz ? 'Qayerda uchraydi' : 'Где участвует'}: {used.join(', ')}
        </p>
      )}

      {error && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(error, isUz)}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            title={
              card.isActive
                ? isUz
                  ? 'O‘chirish: mijoz ro‘yxatlarda va tanlovlarda ko‘rinmaydi, tarixi va hujjatlari joyida qoladi. Istalgan vaqtda qayta yoqiladi'
                  : 'Выключить: клиент исчезнет из списков и из выбора при выписке, его история, заказы и документы останутся. Включить можно обратно'
                : isUz
                  ? 'Yoqish: mijoz yana ro‘yxatlarda va tanlovlarda ko‘rinadi'
                  : 'Включить: клиент снова появится в списках и в выборе при выписке'
            }
            onClick={() => void onSave({ isActive: !card.isActive })}
            className={`${BTN_GHOST} whitespace-nowrap`}
          >
            {card.isActive
              ? isUz
                ? 'O‘chirish'
                : 'Выключить'
              : isUz
                ? 'Yoqish'
                : 'Включить'}
          </button>
          {/* Кнопку не прячем: исчезнувшая кнопка не объясняет, почему её нет.
              Погашенная называет причину числами из карточки. */}
          <button
            type="button"
            disabled={busy || !card.permissions.canDelete}
            title={
              card.permissions.canDelete
                ? isUz
                  ? 'Butunlay o‘chirish: mijoz bo‘yicha hali hech narsa yozilmagan, shuning uchun mumkin'
                  : 'Удалить насовсем: по клиенту ещё ничего не записано, поэтому это возможно'
                : isUz
                  ? `O‘chirib bo‘lmaydi: mijoz bo‘yicha allaqachon yozilgan — ${used.join(', ')}. Tarix nomsiz qolardi, bunday mijozni o‘chirib qo‘yadilar`
                  : `Удалить нельзя: по клиенту уже записаны ${used.join(', ')}. Иначе история осталась бы без имени — такого клиента выключают`
            }
            onClick={async () => {
              await apiClient.crm.deletePartner(card.uid);
              await onDeleted();
            }}
            className={`${BTN_GHOST} whitespace-nowrap text-red-700 dark:text-red-400`}
          >
            {isUz ? 'O‘chirib tashlash' : 'Удалить'}
          </button>
          <DelayEditor card={card} isUz={isUz} busy={busy} onSave={onSave} />
        </div>
      )}
      {options === null && <span className="sr-only">options</span>}
    </>
  );
};

/** Отсрочка и лимит долга правятся прямо в карточке: их меняют чаще всего. */
const DelayEditor: React.FC<{
  card: CrmPartnerCard;
  isUz: boolean;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}> = ({ card, isUz, busy, onSave }) => {
  const [days, setDays] = useState(String(card.paymentDelayDays));
  useEffect(() => setDays(String(card.paymentDelayDays)), [card.paymentDelayDays, card.uid]);

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 whitespace-nowrap">
      {isUz ? 'To‘lov muddati' : 'Отсрочка, дн.'}
      <input
        type="number"
        min={0}
        max={365}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        aria-label={isUz ? 'To‘lov muddati, kun' : 'Отсрочка платежа, дней'}
        className={`${FIELD} w-16`}
      />
      <button
        type="button"
        disabled={busy || Number(days) === card.paymentDelayDays}
        onClick={() => void onSave({ paymentDelayDays: Number(days) })}
        className={`${BTN_GHOST} whitespace-nowrap`}
      >
        {isUz ? 'Saqlash' : 'Сохранить'}
      </button>
    </label>
  );
};

/* ------------------------------------------------------------------ */
/* Формы                                                               */
/* ------------------------------------------------------------------ */

const PartnerForm: React.FC<{
  isUz: boolean;
  options: CrmPartnerOptions | null;
  onCancel: () => void;
  onDone: (uid: string) => Promise<void>;
}> = ({ isUz, options, onCancel, onDone }) => {
  const companies = options?.companies ?? [];
  const [nameRu, setNameRu] = useState('');
  const [inn, setInn] = useState('');
  // Компания одна — выбирать нечего, но она обязана быть в запросе: сервер не
  // угадывает, в чьей базе заводить клиента, когда открыты обе.
  const [companyUid, setCompanyUid] = useState('');
  const [managerUid, setManagerUid] = useState('');
  const [sourceUid, setSourceUid] = useState('');
  const [priceTypeUid, setPriceTypeUid] = useState('');
  const [delay, setDelay] = useState('0');
  const [debtLimit, setDebtLimit] = useState('0');
  const [legalAddress, setLegalAddress] = useState('');
  const [isSupplier, setIsSupplier] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyUid && companies.length > 0) setCompanyUid(companies[0]!.uid);
  }, [companies, companyUid]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.crm.createPartner({
        nameRu: nameRu.trim(),
        inn: inn.trim() || undefined,
        companyUid: companyUid || undefined,
        managerUid: managerUid || undefined,
        sourceUid: sourceUid || undefined,
        priceTypeUid: priceTypeUid || undefined,
        paymentDelayDays: Number(delay) || 0,
        debtLimit: Number(debtLimit) || 0,
        legalAddress: legalAddress.trim() || undefined,
        isClient: true,
        isSupplier,
      });
      await onDone(res.data.uid);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {isUz ? 'Yangi mijoz' : 'Новый клиент'}
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label={isUz ? 'Bekor qilish' : 'Отменить заведение клиента'}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Nomi' : 'Наименование'}</span>
        <input value={nameRu} onChange={(e) => setNameRu(e.target.value)} className={FIELD} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'STIR' : 'ИНН'}</span>
        <input
          value={inn}
          onChange={(e) => setInn(e.target.value)}
          className={`${FIELD} font-mono`}
          placeholder={isUz ? 'majburiy emas' : 'необязательно'}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Kompaniya' : 'Компания'}</span>
        <CustomSelect
          ariaLabel={isUz ? 'Qaysi kompaniya bazasida' : 'В чьей базе заводим клиента'}
          value={companyUid}
          onChange={setCompanyUid}
          options={companies.map((c) => ({ value: c.uid, label: refName(c, isUz) }))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Menejer' : 'Менеджер'}</span>
        <CustomSelect
          ariaLabel={isUz ? 'Mas’ul menejer' : 'Ответственный менеджер'}
          value={managerUid}
          onChange={setManagerUid}
          options={[
            { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
            ...(options?.managers ?? []).map((m) => ({ value: m.uid, label: m.name })),
          ]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Manba' : 'Источник'}</span>
        <CustomSelect
          ariaLabel={isUz ? 'Mijoz manbasi' : 'Источник клиента'}
          value={sourceUid}
          onChange={setSourceUid}
          options={[
            { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
            ...(options?.sources ?? []).map((s) => ({
              value: s.uid,
              label: refName(s, isUz),
            })),
          ]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Narx turi' : 'Тип цены'}</span>
        <CustomSelect
          ariaLabel={isUz ? 'Narx turi' : 'Тип цены клиента'}
          value={priceTypeUid}
          onChange={setPriceTypeUid}
          options={[
            { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
            ...(options?.priceTypes ?? []).map((p) => ({ value: p.uid, label: p.name })),
          ]}
        />
      </div>

      {/* Отсрочка и лимит долга — не украшение карточки: по ним финансы считают
          просрочку и решают, отгружать ли ещё. Заводятся вместе с клиентом. */}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'To‘lov muddati, kun' : 'Отсрочка, дн.'}
          </span>
          <input
            type="number"
            min={0}
            max={365}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            className={`${FIELD} tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Qarz chegarasi, UZS' : 'Лимит долга, UZS'}
          </span>
          <input
            type="number"
            min={0}
            step={1000}
            value={debtLimit}
            onChange={(e) => setDebtLimit(e.target.value)}
            className={`${FIELD} font-mono tabular-nums`}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Yuridik manzil' : 'Юр. адрес'}</span>
        <input
          value={legalAddress}
          onChange={(e) => setLegalAddress(e.target.value)}
          className={FIELD}
          placeholder={isUz ? 'hujjatlar uchun' : 'печатается в документах'}
        />
      </label>

      <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
        <input
          type="checkbox"
          checked={isSupplier}
          onChange={(e) => setIsSupplier(e.target.checked)}
          className="w-3.5 h-3.5 cursor-pointer"
        />
        {isUz ? 'Yetkazuvchi ham' : 'Он же поставщик'}
      </label>

      {error && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(error, isUz)}
        </p>
      )}

      <button
        type="button"
        disabled={busy || nameRu.trim().length < 2}
        onClick={() => void submit()}
        className={`${BTN_PRIMARY} self-start whitespace-nowrap`}
      >
        {isUz ? 'Saqlash' : 'Завести'}
      </button>
    </div>
  );
};

const ContactForm: React.FC<{
  isUz: boolean;
  partnerUid: string;
  onDone: () => void;
  onCancel: () => void;
}> = ({ isUz, partnerUid, onDone, onCancel }) => {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-2">
      <input
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder={isUz ? 'F.I.Sh.' : 'Имя и фамилия'}
        aria-label={isUz ? 'Aloqa shaxsi ismi' : 'Имя контактного лица'}
        className={FIELD}
      />
      <input
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        placeholder={isUz ? 'Lavozimi' : 'Должность'}
        aria-label={isUz ? 'Lavozimi' : 'Должность контактного лица'}
        className={FIELD}
      />
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="+998 90 000 00 00"
        aria-label={isUz ? 'Telefon' : 'Телефон контактного лица'}
        className={`${FIELD} font-mono`}
      />
      <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
          className="w-3.5 h-3.5 cursor-pointer"
        />
        {isUz ? 'Asosiy aloqa' : 'Главный контакт'}
      </label>
      {error && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(error, isUz)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={fullName.trim().length < 2}
          onClick={async () => {
            try {
              await apiClient.crm.addContact(partnerUid, {
                fullName: fullName.trim(),
                position: position.trim() || undefined,
                phone: phone.trim() || undefined,
                isPrimary,
              });
              onDone();
            } catch (e) {
              setError(e as ApiError);
            }
          }}
          className={`${BTN_PRIMARY} whitespace-nowrap`}
        >
          {isUz ? 'Qo‘shish' : 'Добавить'}
        </button>
        <button type="button" onClick={onCancel} className={`${BTN_GHOST} whitespace-nowrap`}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};
