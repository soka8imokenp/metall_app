/**
 * О чём бот пишет сам (ТЗ 11.1). Вид события — в одном месте, потому что его
 * знают трое: сборщик событий, экран настроек в боте и список в «Настройки →
 * Люди». Разойдутся — человек будет выключать не то, что приходит.
 *
 * Текст уведомления пишется так, как его прочитает человек, который системой не
 * пользуется: что случилось, с чем именно и что теперь сделать. Без кодов,
 * сокращений и слова «статус».
 *
 * Поводы делятся на три рода, и это не оформление, а разные адресаты:
 * 1. **ждёт решения** — у человека есть право сказать «да» или «нет»
 *    (`finance_pending`, `document_pending`, `finance_to_post`);
 * 2. **решение по вашему** — ответ тому, кто завёл запись, о том, что с ней
 *    стало (`finance_decided`, `document_decided`): без него человек не узнает
 *    об отказе, пока сам не откроет карточку;
 * 3. **просрочено и на исходе** — состояние дел, за которым никто не нажимал
 *    кнопку (остальные).
 */
export type NotificationKind =
  | 'payment_overdue'
  | 'order_assigned'
  | 'order_moved'
  | 'stock_reserved'
  | 'inventory_variance'
  | 'finance_pending'
  | 'finance_big_pending'
  | 'finance_to_post'
  | 'finance_decided'
  | 'document_pending'
  | 'document_decided'
  | 'stock_critical'
  | 'stage_overdue'
  | 'task_overdue'
  | 'deal_overdue'
  | 'backup_failed';

/**
 * Экран уведомлений делится на части. Поводов стало пятнадцать, и причина не
 * только в подписи панели (1024 знака): пятнадцать переключателей одним
 * списком человек не читает, он их пролистывает. «Деньги и документы» — то,
 * где он решает; «работа» — то, что происходит на складе и в заказах;
 * «система» — то, что сломалось в самой системе и чего в её экранах не видно.
 *
 * Третья группа заведена под неудачную копию базы, а не дописана в «работу»:
 * «📦 Работа: склад и заказы» для сообщения о бэкапе — ложная подпись, по ней
 * администратор выключил бы его, думая, что гасит напоминания склада.
 */
export type KindGroup = 'money' | 'work' | 'system';

export interface KindInfo {
  kind: NotificationKind;
  group: KindGroup;
  /** Без этого права уведомление не собирается и в настройках не показывается. */
  permission: string;
  ru: string;
  uz: string;
  /** Зачем это человеку — строка под названием в настройках. */
  aboutRu: string;
  aboutUz: string;
}

export const KINDS: KindInfo[] = [
  {
    kind: 'finance_pending',
    group: 'money',
    // Право согласования, а не просмотра: «нажмите Согласовать» тому, у кого
    // этой кнопки нет, — обман. Он откроет карточку и не найдёт её.
    permission: 'finance.approve',
    ru: 'Деньги ждут согласования',
    uz: 'Pul tasdiqlashni kutmoqda',
    aboutRu: 'платёж стоит, пока вы не нажмёте',
    aboutUz: 'siz bosmaguningizcha to‘lov turadi',
  },
  {
    // Требование заказчика со встречи 07.10: «при формировании платёжки на
    // крупную сумму система должна прислать уведомление для подтверждения».
    //
    // Отдельный повод, а не тот же `finance_pending`: адресат другой. Обычную
    // заявку зовут согласовать финансиста, крупную — того, у кого есть право
    // на крупные платежи, и в тексте ему нужно то, чего нет в обычном: кому
    // платят, кто завёл и сколько этому получателю уже ушло за период. Без
    // последнего числа подтверждение вслепую: десять мелких платежей по
    // отдельности выглядят безобидно.
    kind: 'finance_big_pending',
    group: 'money',
    permission: 'finance.approve.large',
    ru: 'Крупный платёж ждёт подтверждения',
    uz: 'Yirik to‘lov tasdiqlashni kutmoqda',
    aboutRu: 'платёж вышел за порог — решение ваше',
    aboutUz: 'to‘lov chegaradan oshdi — qaror sizda',
  },
  {
    kind: 'finance_to_post',
    group: 'money',
    permission: 'finance.post',
    ru: 'Согласовано, можно проводить',
    uz: 'Tasdiqlandi, o‘tkazish mumkin',
    aboutRu: 'согласовано — провести надо вам',
    aboutUz: 'tasdiqlandi — o‘tkazish sizdan',
  },
  {
    kind: 'finance_decided',
    group: 'money',
    permission: 'finance.view',
    ru: 'Решение по вашей операции',
    uz: 'Amalingiz bo‘yicha qaror',
    aboutRu: 'что стало с вашей записью о деньгах',
    aboutUz: 'pul yozuvingiz bilan nima bo‘ldi',
  },
  {
    kind: 'document_pending',
    group: 'money',
    permission: 'documents.approve',
    ru: 'Документ ждёт согласования',
    uz: 'Hujjat tasdiqlashni kutmoqda',
    aboutRu: 'документ стоит, пока вы не решите',
    aboutUz: 'siz hal qilmaguningizcha hujjat turadi',
  },
  {
    kind: 'document_decided',
    group: 'money',
    permission: 'documents.view',
    ru: 'Решение по вашему документу',
    uz: 'Hujjatingiz bo‘yicha qaror',
    aboutRu: 'что стало с вашим документом',
    aboutUz: 'hujjatingiz bilan nima bo‘ldi',
  },
  {
    kind: 'payment_overdue',
    group: 'money',
    permission: 'finance.view',
    ru: 'Просроченная оплата',
    uz: 'Muddati o‘tgan to‘lov',
    aboutRu: 'клиент не заплатил в срок',
    aboutUz: 'mijoz muddatda to‘lamadi',
  },
  {
    kind: 'stock_critical',
    group: 'work',
    permission: 'warehouse.view',
    ru: 'Критический остаток',
    uz: 'Kritik qoldiq',
    aboutRu: 'товара меньше крайнего запаса',
    aboutUz: 'tovar eng kam zaxiradan kam',
  },
  {
    kind: 'stage_overdue',
    group: 'work',
    permission: 'production.view',
    ru: 'Просроченный этап производства',
    uz: 'Muddati o‘tgan bosqich',
    aboutRu: 'этап должен был закончиться',
    aboutUz: 'bosqich tugashi kerak edi',
  },
  {
    kind: 'task_overdue',
    group: 'work',
    permission: 'crm.view',
    ru: 'Ваша просроченная задача',
    uz: 'Muddati o‘tgan vazifangiz',
    aboutRu: 'поручили вам, срок прошёл',
    aboutUz: 'sizga topshirilgan, muddat o‘tdi',
  },
  {
    kind: 'deal_overdue',
    group: 'work',
    permission: 'crm.view',
    ru: 'Сделка стоит',
    uz: 'Bitim to‘xtab qoldi',
    aboutRu: 'ждали закрыть, она открыта',
    aboutUz: 'yopish kutilgan, hali ochiq',
  },
  {
    kind: 'order_assigned',
    group: 'work',
    // Право просмотра, а не правки: заказ назначен человеку, и узнать об этом
    // он должен, даже если менять его будет не он.
    permission: 'sales.view',
    ru: 'Новый заказ на вас',
    uz: 'Sizga yangi buyurtma',
    aboutRu: 'заказ завели и назначили вам',
    aboutUz: 'buyurtma sizga tayinlandi',
  },
  {
    kind: 'order_moved',
    group: 'work',
    permission: 'sales.view',
    ru: 'Заказ сдвинулся',
    uz: 'Buyurtma o‘zgardi',
    aboutRu: 'ваш заказ двинул кто-то другой',
    aboutUz: 'buyurtmangizni boshqa kishi siljitdi',
  },
  {
    kind: 'stock_reserved',
    group: 'work',
    permission: 'warehouse.move',
    ru: 'Товар под заказ зарезервирован',
    uz: 'Tovar buyurtma uchun band qilindi',
    aboutRu: 'можно собирать и отгружать',
    aboutUz: 'yig‘ib jo‘natish mumkin',
  },
  {
    kind: 'inventory_variance',
    group: 'work',
    permission: 'warehouse.inventory',
    ru: 'Расхождения в пересчёте',
    uz: 'Qayta hisobda farq',
    aboutRu: 'пересчёт показал разницу, лист открыт',
    aboutUz: 'hisobda farq chiqdi, varaq ochiq',
  },
  {
    kind: 'backup_failed',
    group: 'system',
    // Право на «Настройки», то же, что у экрана копий: кому нечего делать с
    // копией базы, тому и сообщение о ней — шум.
    permission: 'admin.users',
    ru: 'Копия базы не сделалась',
    uz: 'Baza nusxasi olinmadi',
    aboutRu: 'ночная копия упала — данные без защиты',
    aboutUz: 'tungi nusxa yiqildi — ma’lumot himoyasiz',
  },
];

export const KIND_BY_CODE = new Map(KINDS.map((k) => [k.kind as string, k]));
