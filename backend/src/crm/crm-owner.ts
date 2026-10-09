import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * К кому относится задача или активность.
 *
 * Компания не приходит из запроса: она берётся у клиента или сделки, к которым
 * запись привязана. Иначе можно было бы завести задачу в одной компании по
 * клиенту другой — RLS такую строку пропустит (обе компании видны менеджеру с
 * доступом к обеим), а в карточке клиента она не покажется никогда.
 *
 * Связь обязательна хотя бы одна (ТЗ 8.4: «связь с клиентом/сделкой»). Сделка
 * без указанного клиента подставляет своего: задача по сделке — это задача по
 * её клиенту, и в карточке клиента она должна быть видна.
 */
export type CrmOwner = {
  companyId: bigint;
  partnerId: bigint | null;
  dealId: bigint | null;
};

export async function resolveOwner(
  tx: Tx,
  input: { partnerUid?: string | null; dealUid?: string | null },
): Promise<CrmOwner> {
  const partnerUid = input.partnerUid ?? null;
  const dealUid = input.dealUid ?? null;
  if (!partnerUid && !dealUid) {
    throw new UnprocessableEntityException(say(
      'Укажите клиента или сделку: задача без обеих связей не покажется ни в одной карточке', 'Mijoz yoki bitimni ko‘rsating: ikkisiga ham bog‘lanmagan vazifa birorta kartada ko‘rinmaydi'));
  }

  let partner: { id: bigint; company_id: bigint } | null = null;
  if (partnerUid) {
    const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint }[]>`
      SELECT id, company_id FROM partner WHERE uid = ${partnerUid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.partnerNotFound());
    partner = rows[0];
  }

  let deal: { id: bigint; company_id: bigint; partner_id: bigint | null } | null = null;
  if (dealUid) {
    const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; partner_id: bigint | null }[]>`
      SELECT id, company_id, partner_id FROM deal WHERE uid = ${dealUid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.dealNotFound());
    deal = rows[0];
  }

  if (partner && deal) {
    if (partner.company_id !== deal.company_id) {
      throw new UnprocessableEntityException(say('Клиент и сделка заведены в разных компаниях', 'Mijoz va bitim turli kompaniyalarda kiritilgan'));
    }
    if (deal.partner_id !== null && deal.partner_id !== partner.id) {
      throw new UnprocessableEntityException(say('Сделка ведётся по другому клиенту', 'Bitim boshqa mijoz bo‘yicha yuritiladi'));
    }
  }

  return {
    companyId: (partner ?? deal!).company_id,
    partnerId: partner?.id ?? deal?.partner_id ?? null,
    dealId: deal?.id ?? null,
  };
}
