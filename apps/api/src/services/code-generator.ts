import type { Prisma, RequestType } from '../generated/prisma';

export async function nextExpenseCode(
  tx: Prisma.TransactionClient,
  type: Exclude<RequestType, 'EXCESS'>
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = type === 'REIMBURSEMENT' ? 'REE' : 'ANT';
  const key = `${prefix}-${year}`;

  const counter = await tx.codeCounter.upsert({
    where: { key },
    update: { lastValue: { increment: 1 } },
    create: { key, lastValue: 1 },
  });

  return `${key}-${String(counter.lastValue).padStart(4, '0')}`;
}
