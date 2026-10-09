/**
 * Сводка руководителя в боте (ТЗ 11.1, решение заказчика 02.10).
 *
 * Руководитель заходит за двумя ответами: как идут дела и что без него стоит.
 * Проверяется и то, и другое на живых данных: цифры за срок с объяснением и
 * сравнением, переключение срока, список ждущих решения с переходом прямо в
 * карточку нужного раздела, полный список отклонений.
 *
 * И отдельно то, без чего раздел нельзя показывать: у кого нет права
 * согласовывать — тому список решений пуст и чужих переходов не предлагают.
 * Весь прогон — только чтение: сводка ничего не меняет.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DashboardModule } from '../src/dashboard/dashboard.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { BotChief } from '../src/bot/chief.bot.js';
import { DigestService, pick } from '../src/bot/digest.service.js';
import { asUser, type Me, type Screen, type SectionFlow } from '../src/bot/section.js';
import { DashboardService } from '../src/dashboard/dashboard.service.js';

/** Директор: у него и сводка, и согласование денег, и документы. */
const BOSS = 's.radjabov';

let chief: BotChief;
let authService: AuthService;
let db: Client;
let boss: Me;
let digest: DigestService;
let dashboard: DashboardService;

const norm = (v: string) => v.replace(/[\u00a0\u202f]/g, ' ');
const plain = (s: Screen) =>
  norm((s.text ?? '').replace(/<blockquote>|<\/blockquote>/g, '').replace(/<[^>]+>/g, ''));
const buttons = (s: Screen) => s.keyboard.flat().map((b) => norm(b.text));

class Talk {
  flow: SectionFlow | null = null;
  screen!: Screen;

  constructor(private readonly me: Me) {}

  async press(data: string) {
    this.screen = await chief.route(this.me, this.flow, data, false);
    if (this.screen.flow !== undefined) this.flow = this.screen.flow;
    return this.screen;
  }

  async tap(prefix: string) {
    const all = this.screen.keyboard.flat();
    const hit =
      all.find((b) => norm(b.text).startsWith(prefix)) ??
      all.find((b) => norm(b.text).includes(prefix));
    expect(hit, `кнопки «${prefix}» нет: ${all.map((b) => norm(b.text)).join(' | ')}`).toBeTruthy();
    return this.press(hit!.data);
  }
}

async function profile(login: string): Promise<Me> {
  const row = await db.query('SELECT id FROM user_account WHERE login = $1', [login]);
  const userId = BigInt(row.rows[0].id);
  const auth = await authService.loadProfile(userId);
  const companies = await authService.companies(auth.companyIds);
  return {
    userId,
    permissions: auth.permissions,
    companyIds: auth.companyIds,
    companies: companies.map((c) => ({
      id: BigInt(c.id),
      uid: c.uid,
      nameRu: c.nameRu,
      nameUz: c.nameUz,
    })),
  };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      DashboardModule,
      FinanceModule,
      DocumentsModule,
      WarehouseModule,
    ],
    providers: [BotChief, DigestService],
  }).compile();
  chief = moduleRef.get(BotChief);
  digest = moduleRef.get(DigestService);
  dashboard = moduleRef.get(DashboardService);
  authService = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  boss = await profile(BOSS);
}, 60_000);

afterAll(async () => {
  await db.end();
});

describe('сводка в боте: цифры', () => {
  it('открывается цифрами за 30 дней и объясняет, с чем они сравниваются', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    const text = plain(talk.screen);
    expect(text).toMatch(/Сводка · за 30 дней/);
    expect(text, 'нет выручки').toMatch(/Выручка/);
    expect(text, 'нет отгрузок').toMatch(/отгруз/i);
    expect(text, 'нет запаса на складе').toMatch(/запас|Сырьё/);
    expect(text, 'не сказано, с чем сравниваются цифры').toMatch(/сравнение с таким же сроком/);
    expect(text, 'не видно, когда собрана сводка').toMatch(/Обновлено \d\d:\d\d/);
    // Руководитель должен видеть динамику словами, а не только число.
    expect(text).toMatch(/больше, чем в прошлые|меньше, чем в прошлые|столько же|срез на сегодня/);

    const labels = buttons(talk.screen).join(' | ');
    expect(labels, 'выбранный срок не помечен').toMatch(/✅ 30 дней/);
    expect(labels).toMatch(/7 дней/);
    expect(labels).toMatch(/3 месяца/);
    expect(labels).toMatch(/Ждут решения/);
    expect(labels).toMatch(/На что смотреть/);
  });

  it('переключает срок и запоминает его в разговоре', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('7 дней');
    expect(plain(talk.screen)).toMatch(/за 7 дней/);
    expect(buttons(talk.screen).join(' | '), 'галочка осталась на прошлом сроке').toMatch(
      /✅ 7 дней/,
    );
    expect((talk.flow as { period?: string } | null)?.period).toBe('7');

    // Из подраздела «⬅️ Сводка» должна вернуть на выбранный срок, а не на 30 дней.
    await talk.tap('🕓 Ждут решения');
    const back = talk.screen.keyboard.flat().find((b) => norm(b.text).includes('⬅️ Сводка'))!;
    expect(back.data, 'возврат ведёт не на выбранный срок').toBe('c:p:7');
  });

  it('цифры те же, что отдаёт служба сводки системе', async () => {
    // Бот не считает сам. Сверяем экран с той же службой, что рисует сводку в
    // браузере, а не со своим запросом к базе: соседние проверки в полном
    // прогоне заводят заказы, и собственный счёт разошёлся бы с обоими.
    const revenue = async () => {
      const out = await asUser(boss, false, () => dashboard.summary('30d'));
      return out.kpis.find((k) => k.key === 'revenue')!.value;
    };

    const talk = new Talk(boss);
    await talk.press('c');
    const shown = plain(talk.screen);
    const expected = (await revenue()).replace('.', ',');

    if (!shown.includes(expected)) {
      // Между отрисовкой и сверкой кто-то завёл заказ — перечитываем оба.
      await talk.press('c');
      const again = await revenue();
      expect(plain(talk.screen), 'выручка на экране не совпала со службой').toContain(
        again.replace('.', ','),
      );
    } else {
      expect(shown).toContain(expected);
    }
  });
});

describe('сводка в боте: как выглядит экран', () => {
  /**
   * У показателя три строки: цифра, сравнение и пояснение. Двенадцать строк
   * подряд — стена, в которой не видно, где кончился один показатель и начался
   * другой. Поэтому между показателями пустая строка, а пояснение всего экрана
   * отделено от цитаты.
   */
  it('показатели отделены друг от друга и от пояснения', async () => {
    const talk = new Talk(boss);
    const screen = await talk.press('c');
    const text = screen.text ?? '';
    expect(text, 'заголовок слипся с цифрами').toMatch(/<\/b>\n\n<blockquote>/);
    expect(text, 'показатели снова идут слитым списком').toMatch(/\n\n[💰🚚📦ℹ️]/u);
    expect(text, 'пояснение слиплось с цифрами').toMatch(/<\/blockquote>\n\n/);
  });
});

describe('сводка в боте: что ждёт решения', () => {
  it('собирает деньги и документы одним списком и ведёт прямо в карточку', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('🕓 Ждут решения');
    const text = plain(talk.screen);
    expect(text).toMatch(/Ждут вашего решения/);
    expect(text, 'не сказано, что будет после нажатия').toMatch(/откроется карточка с кнопками/);
    expect(text, 'нет группы операций с деньгами').toMatch(/Операции с деньгами/);
    expect(text, 'нет группы документов').toMatch(/Документы/);

    const data = talk.screen.keyboard.flat().map((b) => b.data);
    // Переход межразделовый: кнопка открывает карточку в «Финансах» и в
    // «Документах», где для решения есть кнопки.
    expect(
      data.some((d) => d.startsWith('f:o:')),
      'нет перехода в карточку операции',
    ).toBe(true);
    expect(
      data.some((d) => d.startsWith('d:c:')),
      'нет перехода в карточку документа',
    ).toBe(true);
  });

  it('у кого нет права согласовывать — список пуст, и это сказано словами', async () => {
    const watcher: Me = { ...boss, permissions: new Set(['dashboard.view']) };
    const talk = new Talk(watcher);
    await talk.press('c');
    await talk.tap('🕓 Ждут решения');
    expect(plain(talk.screen), 'не объяснено, почему список пуст').toMatch(
      /Права согласовывать вам не выдано/,
    );
    const data = talk.screen.keyboard.flat().map((b) => b.data);
    expect(
      data.some((d) => d.startsWith('f:o:') || d.startsWith('d:c:')),
      'без права предложили переход в чужую карточку',
    ).toBe(false);
  });
});

describe('сводка в боте: отклонения', () => {
  it('показывает все тревоги с пояснением значков и переходами в разделы', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('⚠️ На что смотреть');
    const text = plain(talk.screen);
    expect(text).toMatch(/На что смотреть/);
    expect(text, 'нет пояснения значков').toMatch(/🔴 просрочено/);
    expect(text, 'ни одной тревоги на демо-данных').toMatch(/🔴|🟡/);

    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/Долги/);
    expect(labels).toMatch(/Чего не хватает/);
    expect(labels).toMatch(/Ждут согласования/);
  });

  it('показывает все тревоги, а не пять, как в приветствии', async () => {
    // В приветствии пять строк — это предел одного взгляда (`pick`). Экран
    // открывают намеренно, и прятать там половину тревог незачем.
    const all = await digest.all(boss.userId, boss.companyIds, boss.permissions);
    const alarms = all.filter((l) => l.severity !== 'info');
    const shown = pick(all).filter((l) => l.severity !== 'info');

    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('⚠️ На что смотреть');
    const screen = plain(talk.screen);
    const rows = screen
      .split('\n')
      // Строка-пояснение значков начинается с того же 🔴 — она не тревога.
      .filter((l) => /^(🔴|🟡)/.test(l.trim()) && !l.includes('как идут дела'));

    expect(rows.length, 'экран показал не все тревоги').toBe(alarms.length);
    for (const alarm of alarms) {
      // Разряды в суммах — неразрывный пробел, на экране он тот же.
      expect(screen, `тревога «${alarm.ru}» на экран не попала`).toContain(norm(alarm.ru));
    }
    expect(alarms.length, 'на демо-данных тревог меньше, чем мест в приветствии').toBeGreaterThan(
      shown.length,
    );
  });

  it('чужих переходов не предлагает: нет права на раздел — нет кнопки', async () => {
    const watcher: Me = { ...boss, permissions: new Set(['dashboard.view']) };
    const talk = new Talk(watcher);
    await talk.press('c');
    await talk.tap('⚠️ На что смотреть');
    const labels = buttons(talk.screen).join(' | ');
    expect(labels, 'долги показали без права на финансы').not.toMatch(/Долги/);
    expect(labels, 'склад показали без права на склад').not.toMatch(/Чего не хватает/);
    expect(labels, 'документы показали без права').not.toMatch(/Ждут согласования/);
  });
});

/**
 * Сравнение завода и торгового дома (ТЗ 11.1).
 *
 * В общей сумме холдинга обе половины невидимы: руководитель смотрит не
 * «сколько у холдинга», а «кто из двух тянет». Цифры собираются по каждой
 * компании отдельно — и той же службой, что рисует сводку, иначе в телефоне и
 * в браузере сошлись бы разные выручки.
 */
describe('сводка в боте: завод и торговый дом рядом', () => {
  it('ставит выручку и отгрузки обеих компаний рядом', async () => {
    expect(boss.companies.length, 'проверка имеет смысл на двух компаниях').toBeGreaterThan(1);

    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('⚖️ Сравнить компании');
    const text = plain(talk.screen);

    expect(text).toMatch(/Завод и торговый дом · 30 дней/);
    expect(text, 'нет общей строки выручки').toMatch(/Выручка/);
    expect(text, 'нет общей строки отгрузок').toMatch(/Отгрузки/);
    for (const company of boss.companies) {
      expect(text, `компании «${company.nameRu}» на экране нет`).toContain(norm(company.nameRu));
    }
    // Своё у каждого — не сводится в одну строку: тонны сырья и процент
    // исполнения заказов сравнивать между собой нельзя.
    expect(text, 'не выделено то, что есть только у одной компании').toMatch(/Своё у каждого/);
    expect(text, 'не объяснено, зачем экран').toMatch(/кто чем закрывает период/);
  });

  it('цифры по компании те же, что у службы сводки для этой компании', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('⚖️ Сравнить компании');
    const text = plain(talk.screen);

    // Считаем службой, сузив контекст до одной компании: бот обязан показать
    // ровно это. Своё округление или своя выборка разошлись бы с браузером.
    for (const company of boss.companies) {
      const one: Me = { ...boss, companyIds: [company.id], companies: [company] };
      const out = await asUser(one, false, () => dashboard.summary('30d'));
      const revenue = out.kpis.find((k) => k.key === 'revenue')!;
      const grouped = new Intl.NumberFormat('ru-RU').format(Number(revenue.value.split('.')[0]));
      const fraction = revenue.value.split('.')[1];
      const shown = fraction === undefined ? grouped : `${grouped},${fraction}`;
      expect(text, `выручка «${company.nameRu}» на экране не совпала со службой`).toContain(
        norm(`${company.nameRu}: ${shown} ${revenue.unit}`),
      );
    }
  });

  it('срок переключается и на сравнении', async () => {
    const talk = new Talk(boss);
    await talk.press('c');
    await talk.tap('⚖️ Сравнить компании');
    await talk.tap('7 дней');
    expect(buttons(talk.screen).join(' | ')).toMatch(/✅ 7 дней/);
    expect(talk.flow).toMatchObject({ kind: 'chief', period: '7' });

    // Сравнение открывается на выбранном сроке, а не на своём: кнопка срока
    // ведёт в сводку, и возврат к сравнению должен попасть в те же дни.
    await talk.press('c:cc');
    expect(plain(talk.screen), 'сравнение открылось не на выбранном сроке').toMatch(
      /Завод и торговый дом · 7 дней/,
    );
    // И обратно: со сравнения срок не теряется.
    await talk.press('c');
    expect(plain(talk.screen), 'со сравнения срок не вернулся').toMatch(/Сводка · за 7 дней/);
  });

  it('с одной компанией сравнивать не предлагает', async () => {
    const alone: Me = {
      ...boss,
      companyIds: [boss.companyIds[0]!],
      companies: [boss.companies[0]!],
    };
    const talk = new Talk(alone);
    await talk.press('c');
    expect(
      buttons(talk.screen).join(' | '),
      'кнопку сравнения показали тому, кому сравнивать не с чем',
    ).not.toMatch(/Сравнить компании/);

    // Нажатие кнопкой со старого экрана тоже не должно открывать пустое
    // сравнение: кнопка остаётся в чате, а права и компании меняются.
    const screen = await chief.route(alone, null, 'c:cc', false);
    expect(screen.toast, 'не сказано, почему сравнения нет').toMatch(/одна компания/);
  });
});
