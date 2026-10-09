import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import {
  ALLOWED_MIME,
  MAX_BYTES,
  OWNER_KINDS,
  PERMISSION_BY_OWNER,
  dispositionOf,
  safeFileName,
  storageKey,
  type AttachmentKindName,
  type OwnerKind,
} from './attachments.js';
import { LocalDiskStorage, defaultStorageRoot, sha256, type FileStorage } from './storage.js';
import { say } from '../common/say.js';
import { MSG } from '../common/messages.js';

/**
 * Таблица владельца: имя таблицы в базе и столбец ссылки в `attachment`.
 *
 * `from` стоит только там, где компания лежит не в самой таблице: у этапа
 * своего `company_id` нет, он изолирован политикой через заказ. Прописывать
 * `from` всем подряд значило бы повторить `FROM stock_move` рядом с
 * `table: 'stock_move'` ещё пять раз.
 */
const OWNER_TABLE: Record<
  OwnerKind,
  { table: string; column: string; missing: string; from?: string }
> = {
  stock_move: { table: 'stock_move', column: 'stock_move_id', missing: 'Движение не найдено' },
  batch: { table: 'batch', column: 'batch_id', missing: 'Партия не найдена' },
  finance_operation: {
    table: 'finance_operation',
    column: 'finance_operation_id',
    missing: 'Финансовая операция не найдена',
  },
  production_order: {
    table: 'production_order',
    column: 'production_order_id',
    missing: 'Производственное задание не найдено',
  },
  production_stage: {
    table: 'production_stage',
    column: 'production_stage_id',
    missing: 'Этап задания не найден',
    // Компания этапа — компания его заказа. Соединение изоляцию не ослабляет:
    // RLS этапа устроен тем же `EXISTS` по заказу, и чужой этап не доедет ни
    // этим запросом, ни любым другим.
    from: 'production_stage s JOIN production_order p ON p.id = s.production_order_id',
  },
  document: { table: 'document', column: 'document_id', missing: 'Документ не найден' },
  partner: { table: 'partner', column: 'partner_id', missing: 'Клиент не найден' },
};

/**
 * Вид владельца по заполненной ссылке, выражением SQL.
 *
 * Собирается из той же таблицы владельцев, а не пишется руками у каждого
 * запроса: забытый в одном месте новый вид означал бы, что файл отдают,
 * спросив право у чужого владельца.
 */
const ownerCase = (prefix = ''): string =>
  'CASE ' +
  OWNER_KINDS.map(
    (k) => `WHEN ${prefix}${OWNER_TABLE[k].column} IS NOT NULL THEN '${k}'`,
  ).join(' ') +
  ' END';

interface Row {
  uid: string;
  kind: AttachmentKindName;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  comment: string | null;
  created_at: Date;
  author: string | null;
}

export interface AttachmentView {
  uid: string;
  kind: AttachmentKindName;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  comment: string | null;
  createdAt: string;
  author: string | null;
  /** Как показывать: картинку — в странице, остальное — файлом. */
  disposition: 'inline' | 'attachment';
}

export interface AddInput {
  owner: OwnerKind;
  ownerUid: string;
  fileName: string;
  mimeType: string;
  kind: AttachmentKindName;
  comment?: string;
  bytes: Buffer;
}

const view = (r: Row): AttachmentView => ({
  uid: r.uid,
  kind: r.kind,
  fileName: r.file_name,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  comment: r.comment,
  createdAt: r.created_at.toISOString(),
  author: r.author,
  disposition: dispositionOf(r.mime_type),
});

/**
 * Вложения к операциям: фото, сканы, сертификат качества партии
 * (ТЗ 5.4, 5.6, 6.3).
 *
 * Байты — на диске через `FileStorage`, описание — в таблице `attachment` под
 * той же изоляцией по компании, что и сама операция. Право спрашивается по
 * владельцу: вложение к движению — правом склада, к финансовой операции —
 * правом финансов. Отдельного права «вложения» нет сознательно, иначе кладовщик
 * со своим складским правом не приложил бы фото к собственному списанию.
 *
 * Порядок записи: сначала строка в транзакции, потом файл на диск. Обратный
 * порядок оставлял бы на диске файлы, про которые база ничего не знает, —
 * их никто никогда не найдёт и не удалит. Если запись файла упала, строка
 * откатывается тем же обращением.
 */
@Injectable()
export class AttachmentsService {
  private readonly storage: FileStorage;

  constructor(private readonly prisma: PrismaService) {
    this.storage = new LocalDiskStorage(defaultStorageRoot());
  }

  private need(owner: OwnerKind, action: 'view' | 'edit') {
    const code = PERMISSION_BY_OWNER[owner][action];
    const ctx = currentContext();
    if (!ctx?.permissions.has(code)) throw new ForbiddenException(say(`Нет права «${code}»`, MSG.noRight(code)));
  }

  /**
   * Владелец по uid, уже под RLS: чужая компания сюда не доедет.
   *
   * Где у владельца есть свой `company_id`, запрос идёт по одной таблице. Где
   * его нет (этап задания), берётся `from` с соединением, и тогда сам владелец
   * — это `s`, а компанию даёт `p`.
   */
  private async resolveOwner(tx: Tx, owner: OwnerKind, uid: string) {
    const { table, missing, from } = OWNER_TABLE[owner];
    const rows = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint }[]>(
      from
        ? `SELECT s.id, p.company_id FROM ${from} WHERE s.uid = $1::uuid`
        : `SELECT id, company_id FROM ${table} WHERE uid = $1::uuid`,
      uid,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(missing);
    return row;
  }

  async list(owner: OwnerKind, ownerUid: string): Promise<AttachmentView[]> {
    this.need(owner, 'view');
    const { column } = OWNER_TABLE[owner];

    return this.prisma.withTenant(async (tx) => {
      const o = await this.resolveOwner(tx, owner, ownerUid);
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT a.uid, a.kind, a.file_name, a.mime_type, a.size_bytes, a.sha256,
                a.comment, a.created_at, u.full_name AS author
           FROM attachment a
           LEFT JOIN user_account u ON u.id = a.created_by
          WHERE a.${column} = $1
          ORDER BY a.created_at, a.id`,
        o.id,
      );
      return rows.map(view);
    });
  }

  async add(input: AddInput): Promise<AttachmentView> {
    this.need(input.owner, 'edit');

    if (!ALLOWED_MIME[input.mimeType]) {
      throw new UnprocessableEntityException(say(`Тип файла «${input.mimeType}» не принимаем: только jpeg, png, webp, heic и pdf`, `«${input.mimeType}» fayl turini qabul qilmaymiz: faqat jpeg, png, webp, heic va pdf`));
    }
    if (input.bytes.length === 0) {
      throw new UnprocessableEntityException(say('Пустой файл', 'Bo‘sh fayl'));
    }
    if (input.bytes.length > MAX_BYTES) {
      const mb = (input.bytes.length / 1024 / 1024).toFixed(1);
      throw new UnprocessableEntityException(say(`Файл ${mb} МБ, предел 20 МБ`, `Fayl ${mb} MB, cheklov 20 MB`));
    }

    const userId = currentContext()?.userId ?? null;
    const fileName = safeFileName(input.fileName, input.mimeType);
    const digest = sha256(input.bytes);
    const { column } = OWNER_TABLE[input.owner];

    const row = await this.prisma.withTenant(async (tx) => {
      const o = await this.resolveOwner(tx, input.owner, input.ownerUid);

      const inserted = await tx.$queryRawUnsafe<{ uid: string; id: bigint }[]>(
        `INSERT INTO attachment (company_id, ${column}, kind, file_name, mime_type,
                                 size_bytes, sha256, storage_key, comment, created_by)
         VALUES ($1, $2, $3::"AttachmentKind", $4, $5, $6, $7, 'pending:' || gen_random_uuid()::text, $8, $9)
         RETURNING uid, id`,
        o.company_id,
        o.id,
        input.kind,
        fileName,
        input.mimeType,
        input.bytes.length,
        digest,
        input.comment ?? null,
        userId,
      );
      const created = inserted[0]!;

      // Ключ считается от uid, а uid выдаёт база — поэтому вставка и правка
      // ключа идут одной транзакцией, а не двумя обращениями.
      const key = storageKey(o.company_id, created.uid, input.mimeType);
      await tx.$queryRawUnsafe(
        `UPDATE attachment SET storage_key = $1 WHERE id = $2`,
        key,
        created.id,
      );

      await this.storage.put(key, input.bytes);

      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT a.uid, a.kind, a.file_name, a.mime_type, a.size_bytes, a.sha256,
                a.comment, a.created_at, u.full_name AS author
           FROM attachment a
           LEFT JOIN user_account u ON u.id = a.created_by
          WHERE a.id = $1`,
        created.id,
      );
      return rows[0]!;
    });

    return view(row);
  }

  /** Байты вложения вместе с описанием: контроллеру нужны оба. */
  async file(uid: string): Promise<{ meta: AttachmentView; bytes: Buffer }> {
    const found = await this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        (Row & { storage_key: string; owner: OwnerKind })[]
      >(
        `SELECT a.uid, a.kind, a.file_name, a.mime_type, a.size_bytes, a.sha256,
                a.comment, a.created_at, a.storage_key, u.full_name AS author,
                ${ownerCase('a.')} AS owner
           FROM attachment a
           LEFT JOIN user_account u ON u.id = a.created_by
          WHERE a.uid = $1::uuid`,
        uid,
      );
      return rows[0];
    });

    if (!found) throw new NotFoundException(say('Вложение не найдено', 'Ilova topilmadi'));
    this.need(found.owner, 'view');

    const bytes = await this.storage.get(found.storage_key);
    return { meta: view(found), bytes };
  }

  async remove(uid: string): Promise<{ uid: string; removed: true }> {
    const key = await this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        { id: bigint; storage_key: string; owner: OwnerKind }[]
      >(
        `SELECT id, storage_key, ${ownerCase()} AS owner
           FROM attachment WHERE uid = $1::uuid`,
        uid,
      );
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Вложение не найдено', 'Ilova topilmadi'));
      this.need(row.owner, 'edit');
      await tx.$queryRawUnsafe(`DELETE FROM attachment WHERE id = $1`, row.id);
      return row.storage_key;
    });

    // Файл удаляем после того, как строка ушла: обратный порядок при откате
    // транзакции оставил бы описание без файла, и карточка показывала бы
    // вложение, которое не открывается.
    await this.storage.remove(key);
    return { uid, removed: true };
  }
}
