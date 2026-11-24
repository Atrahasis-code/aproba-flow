import type { Prisma, PrismaClient } from '../generated/prisma';

export async function findActiveDelegation(
  db: PrismaClient | Prisma.TransactionClient,
  delegatorId: string,
  atDate: Date = new Date()
) {
  return db.approvalDelegation.findFirst({
    where: {
      delegatorId,
      isActive: true,
      startDate: { lte: atDate },
      endDate: { gte: atDate },
      delegate: { isActive: true },
    },
    include: {
      delegator: { select: { id: true, fullName: true, email: true } },
      delegate: { select: { id: true, fullName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export function buildDelegationAuditSummary(
  actionVerb: string,
  actorName: string,
  delegatorName: string,
  reason: string
): string {
  return `${actionVerb} por ${actorName} en reemplazo temporal de ${delegatorName} - Motivo: ${reason}`;
}
