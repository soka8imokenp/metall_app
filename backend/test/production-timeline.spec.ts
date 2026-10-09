/**
 * Фактическое время этапа выводится из событий, а не приписывается.
 *
 * Так записано в самой модели: `production_stage_event` объявлен журналом,
 * по которому восстанавливают ход этапа, «иначе после пауз не восстановить,
 * сколько этап шёл на самом деле». Пока журнал пуст, а `actual_duration_min`
 * заполнен, это правило существует только на словах: цифра в колонке ничем
 * не подтверждена, и экран производства покажет длительность, за которой
 * нет ни одного события.
 *
 * Проверка ходит ролью владельца: она смотрит согласованность данных, а не
 * изоляцию компаний — для изоляции есть `db-invariants` и `runtime-privileges`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let owner: Client;

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL! });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

describe('журнал этапов производства', () => {
  it('у каждого начатого этапа есть событие начала', () => {
    // Этап в работе, на паузе или завершённый когда-то был запущен.
    // Без события `start` непонятно даже, когда он начался.
    return owner
      .query(
        `SELECT count(*)::int AS n
           FROM production_stage s
          WHERE s.status IN ('running', 'paused', 'done')
            AND NOT EXISTS (
              SELECT 1 FROM production_stage_event e
               WHERE e.stage_id = s.id AND e.event = 'start')`,
      )
      .then(({ rows }) => expect(rows[0].n, 'этапов без события начала').toBe(0));
  });

  it('у каждого завершённого этапа есть событие завершения', () =>
    owner
      .query(
        `SELECT count(*)::int AS n
           FROM production_stage s
          WHERE s.status = 'done'
            AND NOT EXISTS (
              SELECT 1 FROM production_stage_event e
               WHERE e.stage_id = s.id AND e.event = 'finish')`,
      )
      .then(({ rows }) => expect(rows[0].n, 'завершённых этапов без события finish').toBe(0)));

  it('не ставит событий этапам, которые ещё не начинали', () =>
    owner
      .query(
        `SELECT count(*)::int AS n
           FROM production_stage s
          WHERE s.status = 'pending'
            AND EXISTS (SELECT 1 FROM production_stage_event e WHERE e.stage_id = s.id)`,
      )
      .then(({ rows }) => expect(rows[0].n, 'события у неначатых этапов').toBe(0)));

  it('события идут по времени в допустимом порядке', async () => {
    // Первое событие этапа — только `start`, и второго `start` быть не может.
    const { rows } = await owner.query(
      `WITH ordered AS (
         SELECT stage_id, event,
                row_number() OVER (PARTITION BY stage_id ORDER BY occurred_at, id) AS rn
           FROM production_stage_event)
       SELECT
         (SELECT count(*) FROM ordered WHERE rn = 1 AND event <> 'start')::int AS bad_first,
         (SELECT count(*) FROM ordered WHERE rn > 1 AND event = 'start')::int AS repeated_start`,
    );
    expect(rows[0].bad_first, 'этапы, начатые не событием start').toBe(0);
    expect(rows[0].repeated_start, 'повторные start').toBe(0);
  });

  it('фактическая длительность сходится с журналом', async () => {
    // Сумма промежутков «работал» между start/resume и следующим pause/finish.
    // Расхождение допускаем в минуту: в журнале секунды, в колонке минуты.
    const { rows } = await owner.query(
      `WITH spans AS (
         SELECT e.stage_id,
                e.event,
                e.occurred_at,
                lead(e.occurred_at) OVER (PARTITION BY e.stage_id ORDER BY e.occurred_at, e.id) AS next_at
           FROM production_stage_event e),
       worked AS (
         SELECT stage_id,
                sum(EXTRACT(EPOCH FROM (next_at - occurred_at)) / 60) AS minutes
           FROM spans
          WHERE event IN ('start', 'resume') AND next_at IS NOT NULL
          GROUP BY stage_id)
       SELECT s.id::text, s.actual_duration_min, round(w.minutes)::int AS from_log
         FROM production_stage s
         JOIN worked w ON w.stage_id = s.id
        WHERE abs(s.actual_duration_min - w.minutes) > 1
        LIMIT 5`,
    );
    expect(rows, 'этапы, где колонка расходится с журналом').toEqual([]);
  });

  it('на паузе стоит ровно тот этап, у которого последнее событие — пауза', async () => {
    // Проверка в обе стороны. Односторонняя пропускает худший случай: этап
    // числится идущим, а последним событием висит пауза — мастер видит работу,
    // которой нет.
    const { rows } = await owner.query(
      `WITH last_event AS (
         SELECT DISTINCT ON (stage_id) stage_id, event
           FROM production_stage_event
          ORDER BY stage_id, occurred_at DESC, id DESC)
       SELECT
         (SELECT count(*) FROM production_stage s
            LEFT JOIN last_event l ON l.stage_id = s.id
           WHERE s.status = 'paused' AND l.event IS DISTINCT FROM 'pause')::int AS paused_without_pause,
         (SELECT count(*) FROM production_stage s
            JOIN last_event l ON l.stage_id = s.id
           WHERE l.event = 'pause' AND s.status <> 'paused')::int AS pause_without_paused,
         (SELECT count(*) FROM production_stage_event
           WHERE event = 'pause' AND reason_id IS NULL)::int AS pause_without_reason`,
    );
    expect(rows[0].paused_without_pause, 'этапы на паузе с другим последним событием').toBe(0);
    expect(rows[0].pause_without_paused, 'этапы не на паузе с паузой последним событием').toBe(0);
    expect(rows[0].pause_without_reason, 'паузы без причины').toBe(0);
  });

  it('статус заказа согласован с состоянием его этапов', async () => {
    // Заказ «запланирован», у которого этап уже идёт, — это не редкий случай
    // из жизни цеха, а несогласованные данные: по такому экрану нельзя понять,
    // начали работу или нет.
    const { rows } = await owner.query(
      `SELECT
         (SELECT count(*) FROM production_order o
           WHERE o.status IN ('draft', 'planned')
             AND EXISTS (SELECT 1 FROM production_stage s
                          WHERE s.production_order_id = o.id AND s.status <> 'pending'))::int AS planned_but_started,
         (SELECT count(*) FROM production_order o
           WHERE o.status IN ('in_progress', 'paused')
             AND NOT EXISTS (SELECT 1 FROM production_stage s
                              WHERE s.production_order_id = o.id AND s.status <> 'pending'))::int AS started_but_idle,
         (SELECT count(*) FROM production_order o
           WHERE o.status IN ('produced', 'closed')
             AND EXISTS (SELECT 1 FROM production_stage s
                          WHERE s.production_order_id = o.id AND s.status NOT IN ('done', 'skipped')))::int AS done_but_open`,
    );
    expect(rows[0].planned_but_started, 'запланированные заказы с начатыми этапами').toBe(0);
    expect(rows[0].started_but_idle, 'заказы в работе без единого начатого этапа').toBe(0);
    expect(rows[0].done_but_open, 'выпущенные заказы с незакрытыми этапами').toBe(0);
  });

  it('каждая пауза попала в журнал отклонений', async () => {
    // Простой — это отклонение. Если он виден только в событиях этапа,
    // отчёт по отклонениям покажет ноль там, где простои были.
    const { rows } = await owner.query(
      `SELECT
         (SELECT count(*) FROM production_stage_event WHERE event = 'pause')::int AS pauses,
         (SELECT count(*) FROM deviation_log WHERE kind = 'downtime')::int AS downtimes`,
    );
    expect(rows[0].pauses, 'пауз в журнале этапов').toBeGreaterThan(0);
    expect(rows[0].downtimes, 'простоев в журнале отклонений').toBe(rows[0].pauses);
  });
});
