import type { Prisma } from '../generated/prisma';

export interface AuditInput {
  actorUserId?: string | null;
  actorName: string;
  actorRole: string;
  onBehalfOfUserId?: string | null;
  onBehalfOfName?: string | null;
  delegationReason?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  previousState?: Prisma.InputJsonValue | null;
  newState?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only immutable audit logger.
 * Never provides update or delete operations.
 */
export async function recordAudit(tx: Prisma.TransactionClient, input: AuditInput) {
  return tx.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName,
      actorRole: input.actorRole,
      onBehalfOfUserId: input.onBehalfOfUserId ?? null,
      onBehalfOfName: input.onBehalfOfName ?? null,
      delegationReason: input.delegationReason ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      previousState: input.previousState ?? undefined,
      newState: input.newState ?? undefined,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
