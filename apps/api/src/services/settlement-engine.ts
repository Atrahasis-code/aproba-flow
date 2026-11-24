import type { ItemAuditStatus, Prisma, PrismaClient } from '../generated/prisma';
import { roundMoney, subtractMoney, sumMoney, toCents, toMoney } from '@aproba-flow/shared';
import { DomainError } from '../errors';
import { evaluateBudgetImpact } from '../services/budget-engine';
import { resolveApprovalSteps } from '../services/approval-rule-engine';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AdvanceBlockingInfo {
  id: string;
  code: string;
  title: string;
  status: string;
  reason: 'PENDING_RETURN' | 'OVERDUE_SETTLEMENT';
  amountOwed?: number;
  settlementDueDate?: string | null;
}

export async function checkAdvanceEligibility(
  db: DbClient,
  userId: string
): Promise<{ eligible: boolean; blockingRequests: AdvanceBlockingInfo[] }> {
  const now = new Date();

  const candidates = await db.expenseRequest.findMany({
    where: {
      requesterId: userId,
      type: 'ADVANCE',
      OR: [
        { status: { in: ['PENDING_RETURN', 'RETURN_SUBMITTED'] } },
        {
          status: 'DISBURSED_PENDING_SETTLEMENT',
          settlementDueDate: { lt: now },
        },
      ],
    },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      netSettlementAmount: true,
      settlementDueDate: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const blockingRequests: AdvanceBlockingInfo[] = candidates.map((req) => {
    const isReturn = req.status === 'PENDING_RETURN' || req.status === 'RETURN_SUBMITTED';
    return {
      id: req.id,
      code: req.code,
      title: req.title,
      status: req.status,
      reason: isReturn ? 'PENDING_RETURN' : 'OVERDUE_SETTLEMENT',
      amountOwed: isReturn ? Math.abs(toMoney(req.netSettlementAmount)) : undefined,
      settlementDueDate: req.settlementDueDate ? req.settlementDueDate.toISOString() : null,
    };
  });

  return {
    eligible: blockingRequests.length === 0,
    blockingRequests,
  };
}

export async function hasDuplicateInvoice(
  db: DbClient,
  params: { vendorTaxId: string; invoiceNumber: string; excludeItemId?: string }
): Promise<boolean> {
  const taxId = params.vendorTaxId.trim();
  const inv = params.invoiceNumber.trim();
  if (!taxId || !inv) return false;

  const existing = await db.expenseItem.findFirst({
    where: {
      vendorTaxId: { equals: taxId, mode: 'insensitive' },
      invoiceNumber: { equals: inv, mode: 'insensitive' },
      auditStatus: { not: 'REJECTED' },
      expenseRequest: { status: { not: 'REJECTED' } },
      ...(params.excludeItemId ? { id: { not: params.excludeItemId } } : {}),
    },
    select: { id: true },
  });

  return Boolean(existing);
}

export interface ItemAuditInput {
  auditStatus: Exclude<ItemAuditStatus, 'PENDING'>;
  approvedAmount?: number;
  auditNote?: string;
}

export function validateItemAuditDecision(
  claimedAmount: number,
  input: ItemAuditInput
): { approvedAmount: number | null; auditNote: string | null } {
  const claimed = toMoney(claimedAmount);
  const note = input.auditNote?.trim() || null;

  if (input.auditStatus === 'APPROVED') {
    return { approvedAmount: claimed, auditNote: note };
  }

  if (input.auditStatus === 'REJECTED') {
    if (!note || note.length < 3) {
      throw new DomainError(
        'Para rechazar un ítem por política debes indicar el motivo obligatorio.',
        400,
        'AUDIT_NOTE_REQUIRED'
      );
    }
    return { approvedAmount: 0, auditNote: note };
  }

  if (input.auditStatus === 'PARTIALLY_APPROVED') {
    if (!note || note.length < 3) {
      throw new DomainError(
        'Para aprobar parcialmente un ítem debes indicar el motivo del ajuste.',
        400,
        'AUDIT_NOTE_REQUIRED'
      );
    }
    const adjusted = toMoney(input.approvedAmount ?? -1);
    if (adjusted <= 0 || adjusted >= claimed) {
      throw new DomainError(
        `El monto aprobado parcial debe ser mayor a $0.00 y menor al monto rendido ($${claimed.toFixed(2)}).`,
        400,
        'INVALID_PARTIAL_AMOUNT'
      );
    }
    return { approvedAmount: adjusted, auditNote: note };
  }

  if (input.auditStatus === 'OBSERVED') {
    if (!note || note.length < 3) {
      throw new DomainError(
        'Para observar un ítem debes explicar qué debe corregir el empleado.',
        400,
        'AUDIT_NOTE_REQUIRED'
      );
    }
    return { approvedAmount: null, auditNote: note };
  }

  throw new DomainError('Estado de auditoría de ítem inválido.', 400);
}

export async function finalizeAdvanceSettlement(
  tx: Prisma.TransactionClient,
  expenseRequestId: string
) {
  const request = await tx.expenseRequest.findUnique({
    where: { id: expenseRequestId },
    include: {
      items: {
        include: { category: true },
      },
    },
  });

  if (!request) {
    throw new DomainError('Solicitud no encontrada.', 404);
  }
  if (request.type !== 'ADVANCE') {
    throw new DomainError('Solo los anticipos pasan por liquidación de rendición.', 400);
  }
  if (request.status !== 'SETTLEMENT_IN_REVIEW') {
    throw new DomainError(
      'La rendición debe estar en estado "Rendición en Revisión" para finalizar.',
      409,
      'INVALID_STATUS_FOR_FINALIZE'
    );
  }
  if (request.items.length === 0) {
    throw new DomainError('La rendición no tiene ítems cargados.', 400);
  }

  const pendingItems = request.items.filter((it) => it.auditStatus === 'PENDING');
  if (pendingItems.length > 0) {
    throw new DomainError(
      `Faltan ${pendingItems.length} ítem(s) por auditar antes de finalizar la revisión.`,
      409,
      'ITEMS_PENDING_AUDIT'
    );
  }

  const observedItems = request.items.filter((it) => it.auditStatus === 'OBSERVED');
  if (observedItems.length > 0) {
    const updated = await tx.expenseRequest.update({
      where: { id: request.id },
      data: {
        status: 'SETTLEMENT_OBSERVED',
      },
    });
    return {
      outcome: 'OBSERVED' as const,
      request: updated,
      approvedTotal: 0,
      diff: 0,
      excessStepsCreated: 0,
      budgetAlertTriggered: request.budgetAlert85Triggered,
    };
  }

  const approvedTotal = sumMoney(request.items.map((it) => it.approvedAmount ?? 0));
  const disbursed = toMoney(request.disbursedAmount);
  const diff = subtractMoney(approvedTotal, disbursed);
  const diffCents = toCents(approvedTotal) - toCents(disbursed);

  // Escenario A: Cuadre perfecto (Aprobado == Anticipo)
  if (diffCents === 0) {
    const updated = await tx.expenseRequest.update({
      where: { id: request.id },
      data: {
        approvedAmount: approvedTotal,
        netSettlementAmount: 0,
        status: 'CLOSED_SETTLED',
        currentStepEnteredAt: null,
      },
    });
    return {
      outcome: 'SCENARIO_A_EXACT' as const,
      request: updated,
      approvedTotal,
      diff: 0,
      excessStepsCreated: 0,
      budgetAlertTriggered: request.budgetAlert85Triggered,
    };
  }

  // Escenario B: Sobró dinero (Aprobado < Anticipo)
  if (diffCents < 0) {
    const updated = await tx.expenseRequest.update({
      where: { id: request.id },
      data: {
        approvedAmount: approvedTotal,
        netSettlementAmount: diff, // negativo: empleado debe devolver |diff|
        status: 'PENDING_RETURN',
        currentStepEnteredAt: new Date(),
      },
    });
    return {
      outcome: 'SCENARIO_B_RETURN' as const,
      request: updated,
      approvedTotal,
      diff,
      excessStepsCreated: 0,
      budgetAlertTriggered: request.budgetAlert85Triggered,
    };
  }

  // Escenario C: Excedente (Aprobado > Anticipo)
  const excessAmount = roundMoney(diff);
  const specialTags = Array.from(
    new Set(
      request.items
        .filter((it) => it.auditStatus !== 'REJECTED' && it.category.specialTag)
        .map((it) => it.category.specialTag!)
    )
  );

  // Evaluar impacto del excedente adicional sobre el presupuesto
  const impact = await evaluateBudgetImpact(tx, {
    budgetTargetType: request.budgetTargetType,
    departmentId: request.departmentId,
    projectId: request.projectId,
    year: request.budgetYear,
    month: request.budgetMonth,
    excludeRequestId: request.id,
    candidateAmount: approvedTotal,
  });

  const { autoApprove, steps } = await resolveApprovalSteps(tx, {
    requestType: 'EXCESS',
    phase: 'EXCESS_SETTLEMENT',
    amount: excessAmount,
    specialTags,
    budgetTargetType: request.budgetTargetType,
    departmentId: request.departmentId,
    projectId: request.projectId,
    requesterId: request.requesterId,
    budgetAlert85Triggered: impact.alert85Triggered,
    budgetExceeded100: impact.exceeded100,
  });

  if (autoApprove) {
    const updated = await tx.expenseRequest.update({
      where: { id: request.id },
      data: {
        approvedAmount: approvedTotal,
        netSettlementAmount: excessAmount,
        status: 'READY_FOR_PAYMENT',
        budgetAlert85Triggered: request.budgetAlert85Triggered || impact.alert85Triggered,
        budgetOverrideRequired: request.budgetOverrideRequired || impact.exceeded100,
        currentStepEnteredAt: new Date(),
      },
    });
    return {
      outcome: 'SCENARIO_C_DIRECT_PAY' as const,
      request: updated,
      approvedTotal,
      diff: excessAmount,
      excessStepsCreated: 0,
      budgetAlertTriggered: impact.alert85Triggered,
    };
  }

  // Crear cadena de aprobación del excedente
  for (const step of steps) {
    await tx.approvalStep.create({
      data: {
        expenseRequestId: request.id,
        phase: 'EXCESS_SETTLEMENT',
        stepOrder: step.stepOrder,
        requiredRole: step.requiredRole,
        assignedApproverId: step.assignedApproverId,
        delegatedToUserId: step.delegatedToUserId,
        delegationId: step.delegationId,
        status: step.status,
        enteredAt: step.enteredAt,
      },
    });
  }

  const updated = await tx.expenseRequest.update({
    where: { id: request.id },
    data: {
      approvedAmount: approvedTotal,
      netSettlementAmount: excessAmount,
      status: 'EXCESS_PENDING_APPROVAL',
      budgetAlert85Triggered: request.budgetAlert85Triggered || impact.alert85Triggered,
      budgetOverrideRequired:
        impact.exceeded100 && !request.budgetOverrideApprovedById ? true : request.budgetOverrideRequired,
      currentStepEnteredAt: new Date(),
    },
  });

  return {
    outcome: 'SCENARIO_C_EXCESS_APPROVAL' as const,
    request: updated,
    approvedTotal,
    diff: excessAmount,
    excessStepsCreated: steps.length,
    budgetAlertTriggered: impact.alert85Triggered,
  };
}
