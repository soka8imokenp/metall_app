import { say } from './say.js';

/**
 * Отказы, повторяющиеся во многих службах.
 *
 * «Компания не выбрана» стояла в девятнадцати местах, «Заказ не найден» — в
 * пятнадцати. Переводить каждую копию отдельно значит однажды получить две
 * разные формулировки одного отказа на одном языке. Здесь по одной на текст,
 * и правка видна всем службам сразу.
 *
 * Функции, а не константы: язык берётся из текущего запроса, а константа
 * посчиталась бы один раз при загрузке модуля.
 */
export const MSG = {
  noCompany: () => say('Компания не выбрана', 'Kompaniya tanlanmagan'),
  companyNotFound: () => say('Компания не найдена', 'Kompaniya topilmadi'),
  companyUnavailable: () => say('Компания недоступна', 'Kompaniya mavjud emas'),
  pickCompany: () =>
    say(
      'Укажите компанию: у вас их несколько, и по умолчанию выбирать за вас нельзя',
      'Kompaniyani ko‘rsating: sizda bir nechta, siz uchun o‘zimiz tanlay olmaymiz',
    ),
  bothCompanies: () =>
    say(
      'Выбраны обе компании: укажите, в чей справочник пишем',
      'Ikkala kompaniya tanlangan: qaysi birining ma’lumotnomasiga yozilishini ko‘rsating',
    ),
  noRight: (code: string) => say(`Нет права «${code}»`, `«${code}» huquqi yo‘q`),

  orderNotFound: () => say('Заказ не найден', 'Buyurtma topilmadi'),
  partnerNotFound: () => say('Клиент не найден', 'Mijoz topilmadi'),
  buyerNotFound: () => say('Покупатель не найден', 'Xaridor topilmadi'),
  warehouseNotFound: () => say('Склад не найден', 'Ombor topilmadi'),
  locationNotFound: () => say('Ячейка не найдена', 'Yacheyka topilmadi'),
  reasonNotFound: () => say('Причина не найдена', 'Sabab topilmadi'),
  operationNotFound: () => say('Операция не найдена', 'Operatsiya topilmadi'),
  documentNotFound: () => say('Документ не найден', 'Hujjat topilmadi'),
  documentTypeNotFound: () => say('Тип документа не найден', 'Hujjat turi topilmadi'),
  dealNotFound: () => say('Сделка не найдена', 'Bitim topilmadi'),
  leadNotFound: () => say('Обращение не найдено', 'Murojaat topilmadi'),
  stageNotFound: () => say('Стадия не найдена', 'Bosqich topilmadi'),
  taskTypeNotFound: () => say('Тип задачи не найден', 'Vazifa turi topilmadi'),
  priceTypeNotFound: () => say('Тип цены не найден', 'Narx turi topilmadi'),
  techCardNotFound: () => say('Техкарта не найдена', 'Texkarta topilmadi'),
  lineNotFound: () => say('Позиция не найдена', 'Pozitsiya topilmadi'),
  managerNotFound: () => say('Менеджер не найден', 'Menejer topilmadi'),
  personNotFound: () => say('Человек не найден', 'Xodim topilmadi'),
  departmentNotFound: () => say('Подразделение не найдено', 'Bo‘lim topilmadi'),

  itemNotFound: (code: string) =>
    say(`Номенклатура ${code} не найдена`, `${code} nomenklaturasi topilmadi`),
  itemArchived: (code: string) =>
    say(`Номенклатура ${code} убрана из работы`, `${code} nomenklaturasi ishdan chiqarilgan`),
  materialNotFound: (code: string) =>
    say(`Материал ${code} не найден`, `${code} materiali topilmadi`),
  materialArchived: (code: string) =>
    say(`Материал ${code} убран из работы`, `${code} materiali ishdan chiqarilgan`),
  warehouseCodeNotFound: (code: string) =>
    say(`Склад ${code} не найден`, `${code} ombori topilmadi`),
  workCenterNotFound: (code: string) =>
    say(`Участок ${code} не найден`, `${code} uchastkasi topilmadi`),
  currencyNotFound: (code: string) =>
    say(`Валюта ${code} не заведена`, `${code} valyutasi kiritilmagan`),

  qtyPositive: () =>
    say('Количество должно быть числом больше нуля', 'Miqdor noldan katta son bo‘lishi kerak'),
  qtyTooBig: () => say('Количество слишком велико', 'Miqdor juda katta'),
  ratePositive: () => say('Курс должен быть больше нуля', 'Kurs noldan katta bo‘lishi kerak'),
  commentTooLong: () =>
    say('Примечание длиннее 500 знаков', 'Izoh 500 belgidan uzun'),
  tooOften: () => say('Слишком часто: попробуйте через минуту', 'Juda tez-tez: bir daqiqadan keyin urinib ko‘ring'),
  stale: () =>
    say(
      'Операцию уже изменили: обновите страницу и повторите',
      'Operatsiya allaqachon o‘zgargan: sahifani yangilab, qaytadan urinib ko‘ring',
    ),
  emptyBody: () => say('Тело запроса пустое: файл не пришёл', 'So‘rov tanasi bo‘sh: fayl kelmadi'),
};
