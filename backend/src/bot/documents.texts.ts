/**
 * Слова раздела «Документы» в боте.
 *
 * Здесь объяснение важнее, чем в остальных разделах: человек утверждает бумагу,
 * по которой платят, и должен понимать, что произойдёт после нажатия. Поэтому у
 * каждого статуса сказано, где документ находится, а у каждого действия — что
 * оно изменит и кто это увидит (решение заказчика 02.10).
 */
import { bullets, fields } from './section.js';
import type { DocumentAction, DocumentStatus } from '../documents/workflow.js';

/** Статус документа человеку: где бумага сейчас и чего от неё ждать. */
export const STATUS: Record<
  DocumentStatus,
  { ru: string; uz: string; mark: string; helpRu: string; helpUz: string }
> = {
  draft: {
    ru: 'Черновик',
    uz: 'Qoralama',
    mark: '📝',
    helpRu: 'Документ ещё никто не смотрел. Его можно править и отправить на согласование.',
    helpUz: 'Hujjatni hali hech kim ko‘rmagan. Uni tuzatish va tasdiqlashga yuborish mumkin.',
  },
  pending_approval: {
    ru: 'На согласовании',
    uz: 'Tasdiqlashda',
    mark: '🕓',
    helpRu: 'Документ ждёт решения. Пока его смотрят, цифры в нём не меняют.',
    helpUz: 'Hujjat qarorni kutmoqda. Ko‘rib chiqilayotganda raqamlar o‘zgartirilmaydi.',
  },
  approved: {
    ru: 'Утверждён',
    uz: 'Tasdiqlangan',
    mark: '✅',
    helpRu: 'Документ утверждён: его можно отправлять клиенту и отмечать подписанным.',
    helpUz: 'Hujjat tasdiqlandi: mijozga yuborish va imzolangan deb belgilash mumkin.',
  },
  signed: {
    ru: 'Подписан',
    uz: 'Imzolangan',
    mark: '🖋',
    helpRu: 'Бумага подписана сторонами. Правка такого документа заведёт новую редакцию.',
    helpUz: 'Qog‘oz imzolangan. Uni tuzatish yangi tahrir yaratadi.',
  },
  returned: {
    ru: 'Возвращён',
    uz: 'Qaytarilgan',
    mark: '↩️',
    helpRu: 'Документ вернули на доработку. Что переделать — написано в причине ниже.',
    helpUz: 'Hujjat qayta ishlashga qaytarildi. Nimani tuzatish kerakligi sababda yozilgan.',
  },
  cancelled: {
    ru: 'Отменён',
    uz: 'Bekor qilingan',
    mark: '🚫',
    helpRu: 'Документ отменён и больше не действует. Вместо него выписывают новый.',
    helpUz: 'Hujjat bekor qilindi va endi kuchda emas. Uning o‘rniga yangisi yoziladi.',
  },
};

/** Действие маршрута: как называется и что изменит. */
export const ACTION: Record<
  DocumentAction,
  {
    ru: string;
    uz: string;
    mark: string;
    askRu: string;
    askUz: string;
    doneRu: string;
    doneUz: string;
  }
> = {
  submit: {
    ru: 'На согласование',
    uz: 'Tasdiqlashga',
    mark: '📨',
    askRu:
      'Документ уйдёт на согласование: его увидит тот, кто утверждает, а править цифры ' +
      'после этого будет нельзя.',
    askUz:
      'Hujjat tasdiqlashga ketadi: tasdiqlovchi uni ko‘radi, shundan keyin raqamlarni ' +
      'o‘zgartirib bo‘lmaydi.',
    doneRu: 'Отправлено на согласование.',
    doneUz: 'Tasdiqlashga yuborildi.',
  },
  approve: {
    ru: 'Утвердить',
    uz: 'Tasdiqlash',
    mark: '✅',
    askRu:
      'Вы соглашаетесь с тем, что в документе написано. После этого его отправляют ' +
      'клиенту и отмечают подписанным.',
    askUz: 'Hujjatda yozilganiga rozilik bildirasiz. Shundan keyin u mijozga yuboriladi.',
    doneRu: 'Утверждён.',
    doneUz: 'Tasdiqlandi.',
  },
  return: {
    ru: 'Вернуть',
    uz: 'Qaytarish',
    mark: '↩️',
    askRu:
      'Документ вернётся автору на доработку. Напишите, что именно переделать — без ' +
      'этого он не узнает, в чём дело.',
    askUz:
      'Hujjat muallifga qaytadi. Nimani tuzatish kerakligini yozing — aks holda u ' + 'bilmaydi.',
    doneRu: 'Возвращён на доработку.',
    doneUz: 'Qayta ishlashga qaytarildi.',
  },
  sign: {
    ru: 'Подписан',
    uz: 'Imzolangan',
    mark: '🖋',
    askRu:
      'Отметка о том, что бумагу подписали. Сам документ при этом не меняется — ' +
      'меняется его состояние в системе.',
    askUz:
      'Qog‘oz imzolangani haqida belgi. Hujjatning o‘zi o‘zgarmaydi — tizimdagi holati ' +
      'o‘zgaradi.',
    doneRu: 'Отмечен подписанным.',
    doneUz: 'Imzolangan deb belgilandi.',
  },
  cancel: {
    ru: 'Отменить',
    uz: 'Bekor qilish',
    mark: '🚫',
    askRu:
      'Документ перестанет действовать. Напишите причину: она останется в журнале, и по ' +
      'ней потом объясняют клиенту, почему бумага отменена.',
    askUz:
      'Hujjat kuchini yo‘qotadi. Sababini yozing: u jurnalda qoladi va keyin mijozga ' +
      'shu bilan tushuntiriladi.',
    doneRu: 'Отменён.',
    doneUz: 'Bekor qilindi.',
  },
};

export const D = {
  home: (uz: boolean) =>
    uz
      ? '<b>📄 Hujjatlar</b>\n\nBu yerda hisob-fakturalar, shartnomalar va dalolatnomalar. ' +
        'Nima qilish mumkin:\n' +
        bullets([
          'qarorni kutayotganlarni ko‘rish',
          'tasdiqlash yoki sabab bilan qaytarish',
          'imzolangan deb belgilash',
          'faylni olish — mijozga PDF, tahrirga DOCX',
        ]) +
        '\n\n<blockquote>Bu — pul to‘lanadigan qog‘oz. Shuning uchun har bir amalni ' +
        'alohida tasdiqlashni so‘rayman.</blockquote>'
      : '<b>📄 Документы</b>\n\nЗдесь счёта, договоры и акты. Что можно сделать:\n' +
        bullets([
          'посмотреть, что ждёт решения',
          'согласовать или вернуть с причиной',
          'отметить подписанным',
          'получить файл — клиенту PDF, на правку DOCX',
        ]) +
        '\n\n<blockquote>Это бумага, по которой платят. Поэтому каждое действие ' +
        'спрошу отдельно.</blockquote>',

  list: (uz: boolean, title: string, lines: string[]) =>
    lines.length === 0
      ? `${title}\n\n${uz ? 'Bu ro‘yxat bo‘sh.' : 'Этот список пуст.'}`
      : `${title}\n<blockquote>${lines.join('\n')}</blockquote>`,

  askSearch: (uz: boolean) =>
    uz
      ? '<b>🔍 Hujjat qidirish</b>\n\nRaqamini yozing.\n\n' +
        '<blockquote>Masalan: <code>СЧ-000123</code> yoki <code>000123</code></blockquote>'
      : '<b>🔍 Поиск документа</b>\n\nНапишите номер.\n\n' +
        '<blockquote>Например: <code>СЧ-000123</code> или <code>000123</code></blockquote>',
  searchEmpty: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha hujjat topilmadi. Raqamning bir qismini yozib ko‘ring.`
      : `По «${query}» документов не нашёл. Попробуйте часть номера.`,

  /**
   * Карточка документа: номер и статус строкой, реквизиты пунктами, строки
   * документа отдельным блоком, объяснение статуса и причина возврата —
   * последними абзацами.
   */
  card: (uz: boolean, lines: string[], items: string[], help: string, why: string | null) => {
    const [head, ...rest] = lines;
    const body =
      items.length > 0
        ? `\n\n<b>${uz ? 'Hujjatda' : 'В документе'}</b>\n<blockquote>${items.join('\n')}</blockquote>`
        : '';
    return `${head}\n\n${fields(rest)}${body}\n\n${help}` + (why ? `\n\n${why}` : '');
  },
  why: (uz: boolean, who: string, comment: string) =>
    uz ? `<b>Sabab</b> (${who}): ${comment}` : `<b>Причина</b> (${who}): ${comment}`,
  nothingToDo: (uz: boolean) =>
    uz
      ? 'Bu hujjat bo‘yicha sizga amal yo‘q: holati yoki huquqingiz yo‘l bermaydi.'
      : 'Действий по этому документу у вас нет: не позволяет статус или права.',

  ask: (uz: boolean, number: string, action: DocumentAction) =>
    uz
      ? `<b>${ACTION[action].uz}</b> — «${number}»?\n\n${ACTION[action].askUz}`
      : `<b>${ACTION[action].ru}</b> — «${number}»?\n\n${ACTION[action].askRu}`,
  askComment: (uz: boolean, number: string, action: DocumentAction) =>
    uz
      ? `<b>${ACTION[action].uz}</b> — «${number}»\n\n${ACTION[action].askUz}\n\n` +
        'Sababni yozib yuboring.'
      : `<b>${ACTION[action].ru}</b> — «${number}»\n\n${ACTION[action].askRu}\n\n` +
        'Напишите причину сообщением.',
  shortComment: (uz: boolean) =>
    uz
      ? 'Juda qisqa. Bir gap yozing: nimani tuzatish kerak.'
      : 'Слишком коротко. Напишите одной фразой, что именно не так.',
  done: (uz: boolean, action: DocumentAction) =>
    uz ? ACTION[action].doneUz : ACTION[action].doneRu,

  files: (uz: boolean) =>
    uz
      ? 'PDF — chop etish va mijozga yuborish uchun. DOCX — tuzatish kerak bo‘lsa.'
      : 'PDF — чтобы распечатать и отправить клиенту. DOCX — если нужно поправить.',
  fileSending: (uz: boolean, number: string, format: string) =>
    uz
      ? `«${number}» ${format} tayyorlanmoqda — bir necha soniya.`
      : `Готовлю «${number}» в ${format} — несколько секунд.`,
  fileSent: (uz: boolean, number: string) =>
    uz ? `Fayl yuborildi: <b>${number}</b>.` : `Файл отправлен: <b>${number}</b>.`,

  // --- выписка документа из заказа -------------------------------------
  // Человек стоит в заказе и говорит «надо счёт». Больше он ничего знать не
  // обязан: тип документа выбирается кнопкой, а что попадёт в бумагу, бот
  // показывает до нажатия — потому что это бумага для клиента.

  newAskType: (uz: boolean, order: string) =>
    uz
      ? `<b>${order}</b> buyurtmasi bo‘yicha qanday hujjat kerak?\n\n` +
        'Hujjat tayyor holda chiqadi: rekvizitlar, qatorlar, summa va summa so‘z bilan — ' +
        'hammasi buyurtmadan olinadi, qo‘lda hech nima yozilmaydi.\n\n' +
        '<blockquote>To‘lov uchun hisob — mijoz shu bo‘yicha to‘laydi.\n' +
        'Spetsifikatsiya — shartnomaga qatorlar ro‘yxati.\n' +
        'Shartnoma — yetkazib berish shartlari.</blockquote>'
      : `Какой документ нужен по заказу <b>${order}</b>?\n\n` +
        'Документ выйдет уже заполненным: реквизиты, строки, сумма и сумма прописью — ' +
        'всё берётся из заказа, руками ничего вписывать не нужно.\n\n' +
        '<blockquote>Счёт на оплату — по нему клиент платит.\n' +
        'Спецификация — список строк к договору.\n' +
        'Договор поставки — условия поставки.</blockquote>',

  newConfirm: (uz: boolean, type: string, lines: string[]) =>
    uz
      ? `<b>${type}</b> tayyorlaymiz.\n${fields(lines)}\n\n` +
        'Hujjat — buyurtmaning hozirgi holatidan olingan nusxa: raqamlar shu holatda ' +
        'qoladi, keyin buyurtma o‘zgarsa ham. Mijoz shu qog‘oz bo‘yicha to‘laydi.\n' +
        'Qoralama bo‘lib chiqadi — tasdiqlashga keyin yuborasiz.'
      : `Готовим <b>${type}</b>.\n${fields(lines)}\n\n` +
        'Документ — снимок заказа на сейчас: цифры останутся такими, даже если заказ ' +
        'потом поменяют. По этой бумаге клиент платит.\n' +
        'Выйдет черновик — на согласование отправите отдельно.',

  newSaved: (uz: boolean, number: string) =>
    uz
      ? `Hujjat tayyor: <b>${number}</b> — qoralama.\n\nPastda PDF bor: mijozga yuborish ` +
        'mumkin. Tasdiqlashga yuborish — alohida tugma.'
      : `Документ готов: <b>${number}</b> — черновик.\n\nНиже есть PDF — его можно ` +
        'отправить клиенту. Отправить на согласование — отдельная кнопка.',

  newNoTypes: (uz: boolean) =>
    uz
      ? 'Bu kompaniyada hujjat turlari sozlanmagan. Buni administrator tuzatadi.'
      : 'В этой компании не настроены типы документов. Это поправит администратор.',

  noRight: (uz: boolean) =>
    uz
      ? 'Bu amalni bajarish huquqi sizga berilmagan. Administrator rol bersin.'
      : 'Права на это действие вам не выдано. Попросите администратора.',
  stale: (uz: boolean) =>
    uz
      ? 'Bu tugma o‘tgan qadamdan qolgan. Hozirgi savol quyida.'
      : 'Эта кнопка осталась с прошлого шага. Текущий вопрос ниже.',
  cancelled: (uz: boolean) =>
    uz ? 'Bekor qildim, hech nima o‘zgarmadi.' : 'Отменил, ничего не изменилось.',
  refused: (uz: boolean, message: string) =>
    uz ? `Bo‘lmadi: ${message}` : `Не получилось: ${message}`,
} as const;

/** Вкладки реестра. Те же, что на экране в браузере. */
export const TAB: { key: string; status: string; ru: string; uz: string; mark: string }[] = [
  {
    key: 'wait',
    status: 'pending_approval',
    ru: 'Ждут решения',
    uz: 'Qarorni kutmoqda',
    mark: '🕓',
  },
  { key: 'draft', status: 'draft', ru: 'Черновики', uz: 'Qoralamalar', mark: '📝' },
  { key: 'back', status: 'returned', ru: 'Возвращённые', uz: 'Qaytarilgan', mark: '↩️' },
  { key: 'all', status: '', ru: 'Все документы', uz: 'Barcha hujjatlar', mark: '📄' },
];
