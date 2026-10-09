/**
 * Права и системные роли. Вынесены из `seed.ts` отдельным модулем, чтобы их
 * можно было проверять тестом, не поднимая базу: сид — это скрипт с побочными
 * эффектами, а набор прав роли — обычные данные.
 */

/** Код, модуль, описание на русском, описание на узбекском. */
export type PermissionDef = [string, string, string, string];

export type RoleDef = { code: string; ru: string; uz: string; perms: string[] };

export const permissionDefs: PermissionDef[] = [
  ['dashboard.view', 'dashboard', 'Просмотр дашборда', 'Boshqaruv panelini ko‘rish'],
  ['sales.view', 'sales', 'Просмотр продаж', 'Sotuvlarni ko‘rish'],
  ['sales.edit', 'sales', 'Создание и правка заказов', 'Buyurtmalarni yaratish va tahrirlash'],
  ['sales.delete', 'sales', 'Отмена заказов', 'Buyurtmalarni bekor qilish'],
  ['sales.price', 'sales', 'Изменение цены вручную', 'Narxni qo‘lda o‘zgartirish'],
  // ТЗ 5.5: пообещать товар, которого на складе нет. Резерв сверх свободного
  // держат под поставку в пути, и отвечает за это не тот, кто ведёт заказ.
  ['sales.order.oversell', 'sales', 'Резерв сверх доступного', 'Mavjuddan ortiq zaxira'],
  // ТЗ 9.2: продажа дешевле себестоимости. Действует, когда компания выбрала
  // режим `approve`: при `block` не поможет никому. Менеджеру по умолчанию не
  // даём — убыток по сделке это решение руководителя, а не продавца.
  ['sales.below_cost', 'sales', 'Продажа ниже себестоимости', 'Tannarxdan past sotish'],
  ['warehouse.view', 'warehouse', 'Просмотр склада', 'Omborni ko‘rish'],
  ['warehouse.move', 'warehouse', 'Складские операции', 'Ombor operatsiyalari'],
  ['warehouse.writeoff', 'warehouse', 'Списание', 'Hisobdan chiqarish'],
  // ТЗ 5.8. Считать и утверждать — разные права: подсчёт делает тот, кто стоит
  // у полки, а утверждение списывает недостачу на компанию, и это решение не
  // кладовщика — он в этой недостаче и виноват.
  ['warehouse.inventory', 'warehouse', 'Инвентаризация', 'Inventarizatsiya'],
  [
    'warehouse.inventory.approve',
    'warehouse',
    'Утверждение инвентаризации',
    'Inventarizatsiyani tasdiqlash',
  ],
  ['production.view', 'production', 'Просмотр производства', 'Ishlab chiqarishni ko‘rish'],
  ['production.manage', 'production', 'Управление заказами на производство', 'Ishlab chiqarishni boshqarish'],
  // ТЗ 4.1: отметки по этапу делает тот, кто у станка, а не тот, кто планирует.
  // Право отдельное от `production.manage`, потому что рабочий не должен уметь
  // заводить заказы и менять нормы — он отмечает, что начал и что закончил, и
  // только по своим этапам.
  ['production.work', 'production', 'Отметки по своим этапам', 'O‘z bosqichlari bo‘yicha belgilar'],
  ['finance.view', 'finance', 'Просмотр финансов', 'Moliyani ko‘rish'],
  ['finance.post', 'finance', 'Проведение операций', 'Operatsiyalarni o‘tkazish'],
  ['finance.approve', 'finance', 'Согласование платежей', 'To‘lovlarni tasdiqlash'],
  // Требование заказчика со встречи 07.10: платёжку на крупную сумму
  // подтверждает владелец, а не тот, кто утверждает обычные платежи. Причина
  // названа прямо: «не могу слепо доверять бухгалтерам, у знакомого бухгалтер
  // украл до миллиарда мелкими транзакциями».
  //
  // Право отдельное именно потому, что в этом вся мера: у финансиста остаётся
  // `finance.approve` и обычные платежи он проводит как раньше, а крупный
  // упирается в право, которого у него нет. Порог и предел за период — в
  // настройках компании, числа заказчик называет сам.
  //
  // Имя сознательно НЕ кончается на `.view`: собственник набирает права
  // правилом «все `.view`», и право на решение о деньгах не должно достаться
  // ему молча — роль заведена как «смотрит и ничего не делает». Кому его
  // выдать, решает заказчик на экране «Роли и права»; там правятся права и
  // системных ролей, так что владельцу его выдают явно.
  [
    'finance.approve.large',
    'finance',
    'Подтверждение крупных платежей',
    'Yirik to‘lovlarni tasdiqlash',
  ],
  // Требование заказчика со встречи 07.10: финансист видит финансовую
  // аналитику, но не чистую прибыль учредителей. До этого `finance.view`
  // отдавал все восемь отчётов целиком — вместе с «Прибылями и убытками».
  //
  // Право названо `.view`, и это не косметика: собственник набирает права
  // правилом «все, что кончается на .view», и прибыль обязана достаться ему
  // сама. Назови его `finance.profit` — и учредитель остался бы без того
  // единственного числа, ради которого в систему и заходит.
  [
    'finance.profit.view',
    'finance',
    'Финансовый результат: прибыль и маржа',
    'Moliyaviy natija: foyda va marja',
  ],
  ['crm.view', 'crm', 'Просмотр CRM', 'CRM ko‘rish'],
  ['crm.edit', 'crm', 'Работа со сделками', 'Bitimlar bilan ishlash'],
  ['documents.view', 'documents', 'Просмотр документов', 'Hujjatlarni ko‘rish'],
  // ТЗ 7.1: вести документ — заполнять, формировать, прикладывать сканы. Это
  // не то же, что его согласовать: согласование — решение, и право под него
  // своё.
  ['documents.edit', 'documents', 'Работа с документами', 'Hujjatlar bilan ishlash'],
  ['documents.approve', 'documents', 'Согласование документов', 'Hujjatlarni tasdiqlash'],
  // ТЗ 5.2, 5.3, 5.10: справочники на запись. Отдельное право, а не
  // `warehouse.move`: движение делает кладовщик у полки, а номенклатуру и
  // склады заводит тот, кто отвечает за то, как это всё названо и посчитано.
  ['refs.edit', 'refs', 'Правка справочников', 'Ma’lumotnomalarni tahrirlash'],
  // ТЗ 5.7: метод списания. Не правка справочника, а правило, по которому
  // считается себестоимость: его выбирает тот, кто отвечает за цифры в
  // отчётности, а не тот, кто ведёт названия позиций.
  ['settings.edit', 'settings', 'Настройки учёта компании', 'Kompaniya hisob sozlamalari'],
  ['admin.users', 'admin', 'Управление пользователями', 'Foydalanuvchilarni boshqarish'],
  ['admin.roles', 'admin', 'Управление ролями', 'Rollarni boshqarish'],
];

const codes = permissionDefs.map((p) => p[0]);

export const roleDefs: RoleDef[] = [
  { code: 'admin', ru: 'Администратор', uz: 'Administrator', perms: codes },
  {
    code: 'director',
    ru: 'Директор',
    uz: 'Direktor',
    perms: codes.filter((c) => !c.startsWith('admin.')),
  },
  {
    // ТЗ 3.2: «настраивать отдельные уровни доступа для учредителей и
    // руководителей». Собственник смотрит свои компании целиком — продажи,
    // склад, производство, финансы, документы, отчёты — и не делает в них
    // ничего: не администрирует и не проводит.
    //
    // Набор задан правилом, а не списком. Появится новый раздел — право на его
    // просмотр достанется собственнику само, а право на запись не достанется
    // никогда, даже если про эту роль забудут. Сторож — test/rbac-roles.spec.ts.
    //
    // Компаниями роль ограничена не правами, а назначением — тем же, что у
    // остальных людей: `owner1` назначен в оба бизнеса, `owner2` — только на
    // завод. «Более крутой собственник» — это строка в назначениях, а не вторая
    // роль и не ветка в коде. Дальше разрез держат RLS и пересечение с
    // X-Company-Id в auth.guard, сторож — test/owner-companies.e2e.spec.ts.
    code: 'owner',
    ru: 'Собственник',
    uz: 'Mulkdor',
    perms: codes.filter((c) => c.endsWith('.view')),
  },
  {
    code: 'sales_manager',
    ru: 'Менеджер по продажам',
    uz: 'Savdo menejeri',
    perms: [
      'dashboard.view',
      'sales.view',
      'sales.edit',
      'crm.view',
      'crm.edit',
      'warehouse.view',
      'documents.view',
      'documents.edit',
    ],
  },
  {
    code: 'warehouse_keeper',
    ru: 'Кладовщик',
    uz: 'Omborchi',
    perms: [
      'dashboard.view',
      'warehouse.view',
      'warehouse.move',
      'warehouse.writeoff',
      'warehouse.inventory',
      'sales.view',
      // ТЗ 4.1: материал в цех выдаёт кладовщик, и выдаёт по заказу — значит
      // заказ он должен видеть. Только смотреть: заводить и вести заказы
      // производства он не может.
      'production.view',
    ],
  },
  {
    code: 'production_master',
    ru: 'Начальник производства',
    uz: 'Ishlab chiqarish boshlig‘i',
    perms: [
      'dashboard.view',
      'production.view',
      'production.manage',
      'production.work',
      'warehouse.view',
      'sales.view',
    ],
  },
  {
    // ТЗ 4.1, 5.1: рабочий цеха. Видит производство и отмечает свои этапы —
    // больше ничего. Ни склада, ни продаж: он и не заходил бы туда, а права,
    // выданные «на всякий случай», однажды объясняют, как списание сделал
    // человек, который к складу отношения не имеет.
    code: 'production_worker',
    ru: 'Сотрудник производства',
    uz: 'Ishlab chiqarish xodimi',
    perms: ['dashboard.view', 'production.view', 'production.work'],
  },
  {
    code: 'accountant',
    ru: 'Бухгалтер',
    uz: 'Buxgalter',
    perms: [
      'dashboard.view',
      'finance.view',
      'finance.post',
      'documents.view',
      'documents.edit',
      'documents.approve',
      'sales.view',
    ],
  },
];
