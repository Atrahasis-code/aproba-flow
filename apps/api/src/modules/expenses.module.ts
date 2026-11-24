import { Elysia, t } from 'elysia';
import type { ExpenseStatus, Prisma } from '../generated/prisma';
import { canSeeAllRequests } from '../lib/auth';
import { sumMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth } from '../plugins/auth.plugin';
import { resolveApprovalSteps } from '../services/approval-rule-engine';
import { recordAudit } from '../services/audit-logger';
import { evaluateBudgetImpact, getBudgetSnapshot, validateTargetAccess } from '../services/budget-engine';
import { nextExpenseCode } from '../services/code-generator';
import { serializeExpenseRequest } from '../services/expense-serializers';
import { createNotification, notifyRoleUsers } from '../services/notification.service';
import { checkAdvanceEligibility, hasDuplicateInvoice } from '../services/settlement-engine';

export const EXPENSE_DETAIL_INCLUDE = {
  requester: {
    include: {
      branch: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, code: true, name: true } },
    },
  },
  department: { select: { id: true, code: true, name: true } },
  project: { select: { id: true, code: true, name: true, clientName: true, managerId: true } },
  budgetOverrideApprovedBy: { select: { id: true, fullName: true } },
  returnDepositFile: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
  items: {
    include: {
      category: true,
      auditedBy: { select: { id: true, fullName: true } },
      receiptFile: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  approvalSteps: {
    include: {
      assignedApprover: { select: { id: true, fullName: true, email: true } },
      delegatedToUser: { select: { id: true, fullName: true, email: true } },
      delegation: { select: { id: true, reason: true, startDate: true, endDate: true } },
      actedByUser: { select: { id: true, fullName: true } },
    },
    orderBy: [{ phase: 'asc' as const }, { stepOrder: 'asc' as const }],
  },
} satisfies Prisma.ExpenseRequestInclude;

const ItemInputSchema = t.Object({
  categoryId: t.String({ minLength: 1 }),
  expenseDate: t.String({ minLength: 4 }),
  vendorName: t.String({ minLength: 2 }),
  vendorTaxId: t.String({ minLength: 2 }),
  invoiceNumber: t.String({ minLength: 1 }),
  description: t.String({ minLength: 2 }),
  claimedAmount: t.Number({ exclusiveMinimum: 0 }),
  receiptFileId: t.Optional(t.Nullable(t.String())),
});

export const expensesModule = new Elysia({ prefix: '/expenses' })
  .use(authPlugin)
  .get('/eligibility', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    return checkAdvanceEligibility(prisma, user.id);
  })
  .get('/', async ({ currentUser, query }) => {
    const user = requireAuth(currentUser);
    const sysConfig = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    const stalledHours = sysConfig?.stalledHoursThreshold ?? 48;

    const seeAll = canSeeAllRequests(user);
    const where: Prisma.ExpenseRequestWhereInput = {};

    if (query.scope === 'mine' || query.mineOnly === 'true') {
      where.requesterId = user.id;
    } else if (query.scope === 'team') {
      where.requesterId = { not: user.id };
      if (!seeAll) {
        where.OR = [
          { project: { managerId: user.id } },
          { requester: { managerId: user.id } },
          {
            approvalSteps: {
              some: {
                OR: [
                  { assignedApproverId: user.id },
                  { delegatedToUserId: user.id },
                  { actedByUserId: user.id },
                ],
              },
            },
          },
        ];
      }
    } else if (!seeAll) {
      where.OR = [
        { requesterId: user.id },
        { project: { managerId: user.id } },
        {
          approvalSteps: {
            some: {
              OR: [{ assignedApproverId: user.id }, { delegatedToUserId: user.id }],
            },
          },
        },
      ];
    }

    if (query.type === 'REIMBURSEMENT' || query.type === 'ADVANCE') {
      where.type = query.type;
    }
    if (query.status) {
      where.status = query.status as ExpenseStatus;
    }
    if (query.budgetTargetType === 'DEPARTMENT' || query.budgetTargetType === 'PROJECT') {
      where.budgetTargetType = query.budgetTargetType;
    }
    if (query.alert85Only === 'true') {
      where.budgetAlert85Triggered = true;
    }
    if (query.search) {
      const s = query.search.trim();
      where.AND = [
        {
          OR: [
            { code: { contains: s, mode: 'insensitive' } },
            { title: { contains: s, mode: 'insensitive' } },
            { requester: { fullName: { contains: s, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    const list = await prisma.expenseRequest.findMany({
      where,
      include: EXPENSE_DETAIL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    let serialized = list.map((r) => serializeExpenseRequest(r, stalledHours));
    if (query.stalledOnly === 'true') {
      serialized = serialized.filter((r) => r.isStalled48h);
    }
    return serialized;
  })
  .get('/:id', async ({ currentUser, params }) => {
    const user = requireAuth(currentUser);
    const sysConfig = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    const stalledHours = sysConfig?.stalledHoursThreshold ?? 48;

    const req = await prisma.expenseRequest.findUnique({
      where: { id: params.id },
      include: EXPENSE_DETAIL_INCLUDE,
    });

    if (!req) {
      throw new DomainError('Solicitud no encontrada.', 404, 'EXPENSE_NOT_FOUND');
    }

    const isInvolved =
      canSeeAllRequests(user) ||
      req.requesterId === user.id ||
      req.project?.managerId === user.id ||
      req.approvalSteps.some(
        (s) =>
          s.assignedApproverId === user.id ||
          s.delegatedToUserId === user.id ||
          s.actedByUserId === user.id
      );

    if (!isInvolved) {
      // Allow active delegates of assigned approvers
      const assignedIds = req.approvalSteps
        .map((s) => s.assignedApproverId)
        .filter((x): x is string => Boolean(x));
      const activeDelegate =
        assignedIds.length > 0
          ? await prisma.approvalDelegation.findFirst({
              where: {
                delegatorId: { in: assignedIds },
                delegateId: user.id,
                isActive: true,
                startDate: { lte: new Date() },
                endDate: { gte: new Date() },
              },
            })
          : null;

      if (!activeDelegate) {
        throw new DomainError('No tienes permiso para ver esta solicitud.', 403, 'FORBIDDEN');
      }
    }

    const [budgetSnapshot, auditLogs] = await Promise.all([
      getBudgetSnapshot(prisma, {
        budgetTargetType: req.budgetTargetType,
        departmentId: req.departmentId,
        projectId: req.projectId,
        year: req.budgetYear,
        month: req.budgetMonth,
      }),
      prisma.auditLog.findMany({
        where: { entityType: 'EXPENSE_REQUEST', entityId: req.id },
        orderBy: { timestamp: 'desc' },
      }),
    ]);

    return {
      request: serializeExpenseRequest(req, stalledHours),
      budgetSnapshot,
      auditLogs: auditLogs.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    };
  })
  .post(
    '/reimbursements',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();
      const budgetYear = body.budgetYear ?? now.getFullYear();
      const budgetMonth = body.budgetMonth ?? now.getMonth() + 1;

      if (!body.items || body.items.length === 0) {
        throw new DomainError('Debes agregar al menos un comprobante/ítem de gasto.', 400);
      }

      const result = await prisma.$transaction(async (tx) => {
        await validateTargetAccess(tx, user, {
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
        });

        const categoryIds = Array.from(new Set(body.items.map((i) => i.categoryId)));
        const categories = await tx.category.findMany({
          where: { id: { in: categoryIds }, isActive: true },
        });
        if (categories.length !== categoryIds.length) {
          throw new DomainError('Una o más categorías contables no son válidas.', 400);
        }

        const catMap = new Map(categories.map((c) => [c.id, c]));
        for (const item of body.items) {
          const cat = catMap.get(item.categoryId);
          if (cat?.requiresReceipt && !item.receiptFileId) {
            throw new DomainError(
              `La categoría "${cat.name}" requiere adjuntar el comprobante.`,
              400,
              'RECEIPT_REQUIRED'
            );
          }
        }

        const requestedAmount = sumMoney(body.items.map((i) => i.claimedAmount));
        const impact = await evaluateBudgetImpact(tx, {
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
          year: budgetYear,
          month: budgetMonth,
          candidateAmount: requestedAmount,
        });

        const specialTags = Array.from(
          new Set(categories.map((c) => c.specialTag).filter((t): t is string => Boolean(t)))
        );

        const { steps } = await resolveApprovalSteps(tx, {
          requestType: 'REIMBURSEMENT',
          phase: 'INITIAL_REQUEST',
          amount: requestedAmount,
          specialTags,
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
          requesterId: user.id,
          budgetAlert85Triggered: impact.alert85Triggered,
          budgetExceeded100: impact.exceeded100,
        });

        const duplicateFlags = await Promise.all(
          body.items.map((it) =>
            hasDuplicateInvoice(tx, {
              vendorTaxId: it.vendorTaxId,
              invoiceNumber: it.invoiceNumber,
            })
          )
        );

        const code = await nextExpenseCode(tx, 'REIMBURSEMENT');

        const created = await tx.expenseRequest.create({
          data: {
            code,
            type: 'REIMBURSEMENT',
            status: 'PENDING_APPROVAL',
            requesterId: user.id,
            title: body.title.trim(),
            description: body.description?.trim() || null,
            budgetTargetType: body.budgetTargetType,
            departmentId: body.budgetTargetType === 'DEPARTMENT' ? body.departmentId! : null,
            projectId: body.budgetTargetType === 'PROJECT' ? body.projectId! : null,
            budgetYear,
            budgetMonth,
            requestedAmount,
            budgetAlert85Triggered: impact.alert85Triggered,
            budgetUsagePctAtSubmit: impact.projectedPct,
            budgetOverrideRequired: impact.exceeded100,
            currentStepEnteredAt: now,
            items: {
              create: body.items.map((it, idx) => ({
                categoryId: it.categoryId,
                expenseDate: new Date(it.expenseDate),
                vendorName: it.vendorName.trim(),
                vendorTaxId: it.vendorTaxId.trim(),
                invoiceNumber: it.invoiceNumber.trim(),
                description: it.description.trim(),
                claimedAmount: it.claimedAmount,
                receiptFileId: it.receiptFileId ?? null,
                duplicateWarning: duplicateFlags[idx],
              })),
            },
            approvalSteps: {
              create: steps.map((s) => ({
                phase: s.phase,
                stepOrder: s.stepOrder,
                requiredRole: s.requiredRole,
                assignedApproverId: s.assignedApproverId,
                delegatedToUserId: s.delegatedToUserId,
                delegationId: s.delegationId,
                status: s.status,
                enteredAt: s.enteredAt,
              })),
            },
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: user.roles.join(','),
          entityType: 'EXPENSE_REQUEST',
          entityId: created.id,
          action: 'CREATE_REIMBURSEMENT',
          summary: `Reembolso Directo ${created.code} ($${requestedAmount.toFixed(2)}) enviado por ${user.fullName}${impact.alert85Triggered ? ` [Alerta Presupuestaria: ${impact.projectedPct}%]` : ''}`,
          newState: {
            code: created.code,
            status: created.status,
            requestedAmount,
            projectedPct: impact.projectedPct,
            budgetAlert85Triggered: impact.alert85Triggered,
            budgetOverrideRequired: impact.exceeded100,
          },
          ipAddress: clientIp,
          userAgent,
        });

        return { created, impact };
      });

      const { created, impact } = result;
      const firstStep = created.approvalSteps.find((s) => s.status === 'PENDING');
      if (firstStep) {
        const targetApproverId = firstStep.delegatedToUserId || firstStep.assignedApproverId;
        if (targetApproverId) {
          await createNotification({
            userId: targetApproverId,
            type: 'APPROVAL_REQUIRED',
            title: `Nueva solicitud por aprobar: ${created.code}`,
            message: `${user.fullName} solicitó un reembolso directo de $${impact.candidateAmount.toFixed(2)} (${created.title}).`,
            linkUrl: `/solicitudes/${created.id}`,
          });
        } else if (firstStep.requiredRole === 'FINANCE') {
          await notifyRoleUsers(['FINANCE'], {
            type: 'APPROVAL_REQUIRED',
            title: `Reembolso pendiente de Finanzas: ${created.code}`,
            message: `${user.fullName} solicitó $${impact.candidateAmount.toFixed(2)}.`,
            linkUrl: `/solicitudes/${created.id}`,
          });
        }
      }

      if (impact.alert85Triggered) {
        await notifyRoleUsers(['FINANCE', 'DIRECTION'], {
          type: impact.exceeded100 ? 'BUDGET_EXCEEDED_100' : 'BUDGET_ALERT_85',
          title: impact.exceeded100
            ? `Presupuesto superado (>100%): ${impact.targetName}`
            : `Alerta presupuestaria (>85%): ${impact.targetName}`,
          message: `La solicitud ${created.code} eleva el consumo proyectado a ${impact.projectedPct.toFixed(1)}% ($${impact.projectedUsed.toFixed(2)} / $${impact.budgetLimit.toFixed(2)}).`,
          linkUrl: `/solicitudes/${created.id}`,
        });
      }

      return serializeExpenseRequest(created);
    },
    {
      body: t.Object({
        title: t.String({ minLength: 3 }),
        description: t.Optional(t.Nullable(t.String())),
        budgetTargetType: t.Union([t.Literal('DEPARTMENT'), t.Literal('PROJECT')]),
        departmentId: t.Optional(t.Nullable(t.String())),
        projectId: t.Optional(t.Nullable(t.String())),
        budgetYear: t.Optional(t.Number()),
        budgetMonth: t.Optional(t.Number()),
        items: t.Array(ItemInputSchema, { minItems: 1 }),
      }),
    }
  )
  .post(
    '/advances',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();
      const budgetYear = body.budgetYear ?? now.getFullYear();
      const budgetMonth = body.budgetMonth ?? now.getMonth() + 1;

      const result = await prisma.$transaction(async (tx) => {
        const eligibility = await checkAdvanceEligibility(tx, user.id);
        if (!eligibility.eligible) {
          throw new DomainError(
            'No puedes solicitar un nuevo anticipo porque tienes devoluciones pendientes o rendiciones vencidas.',
            409,
            'ADVANCE_BLOCKED',
            eligibility.blockingRequests
          );
        }

        await validateTargetAccess(tx, user, {
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
        });

        const impact = await evaluateBudgetImpact(tx, {
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
          year: budgetYear,
          month: budgetMonth,
          candidateAmount: body.requestedAmount,
        });

        const specialTags = body.specialTag ? [body.specialTag.trim()] : [];
        const { steps } = await resolveApprovalSteps(tx, {
          requestType: 'ADVANCE',
          phase: 'INITIAL_REQUEST',
          amount: body.requestedAmount,
          specialTags,
          budgetTargetType: body.budgetTargetType,
          departmentId: body.departmentId ?? null,
          projectId: body.projectId ?? null,
          requesterId: user.id,
          budgetAlert85Triggered: impact.alert85Triggered,
          budgetExceeded100: impact.exceeded100,
        });

        const code = await nextExpenseCode(tx, 'ADVANCE');

        const created = await tx.expenseRequest.create({
          data: {
            code,
            type: 'ADVANCE',
            status: 'PENDING_APPROVAL',
            requesterId: user.id,
            title: body.title.trim(),
            description: body.description?.trim() || null,
            travelStartDate: body.travelStartDate ? new Date(body.travelStartDate) : null,
            travelEndDate: body.travelEndDate ? new Date(body.travelEndDate) : null,
            budgetTargetType: body.budgetTargetType,
            departmentId: body.budgetTargetType === 'DEPARTMENT' ? body.departmentId! : null,
            projectId: body.budgetTargetType === 'PROJECT' ? body.projectId! : null,
            budgetYear,
            budgetMonth,
            requestedAmount: body.requestedAmount,
            budgetAlert85Triggered: impact.alert85Triggered,
            budgetUsagePctAtSubmit: impact.projectedPct,
            budgetOverrideRequired: impact.exceeded100,
            currentStepEnteredAt: now,
            approvalSteps: {
              create: steps.map((s) => ({
                phase: s.phase,
                stepOrder: s.stepOrder,
                requiredRole: s.requiredRole,
                assignedApproverId: s.assignedApproverId,
                delegatedToUserId: s.delegatedToUserId,
                delegationId: s.delegationId,
                status: s.status,
                enteredAt: s.enteredAt,
              })),
            },
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: user.roles.join(','),
          entityType: 'EXPENSE_REQUEST',
          entityId: created.id,
          action: 'CREATE_ADVANCE',
          summary: `Anticipo ${created.code} ($${body.requestedAmount.toFixed(2)}) solicitado por ${user.fullName}${impact.alert85Triggered ? ` [Alerta Presupuestaria: ${impact.projectedPct}%]` : ''}`,
          newState: {
            code: created.code,
            status: created.status,
            requestedAmount: body.requestedAmount,
            projectedPct: impact.projectedPct,
            budgetAlert85Triggered: impact.alert85Triggered,
            budgetOverrideRequired: impact.exceeded100,
          },
          ipAddress: clientIp,
          userAgent,
        });

        return { created, impact };
      });

      const { created, impact } = result;
      const firstStep = created.approvalSteps.find((s) => s.status === 'PENDING');
      if (firstStep) {
        const targetApproverId = firstStep.delegatedToUserId || firstStep.assignedApproverId;
        if (targetApproverId) {
          await createNotification({
            userId: targetApproverId,
            type: 'APPROVAL_REQUIRED',
            title: `Nuevo anticipo por aprobar: ${created.code}`,
            message: `${user.fullName} solicitó un anticipo de $${body.requestedAmount.toFixed(2)} (${created.title}).`,
            linkUrl: `/solicitudes/${created.id}`,
          });
        }
      }

      if (impact.alert85Triggered) {
        await notifyRoleUsers(['FINANCE', 'DIRECTION'], {
          type: impact.exceeded100 ? 'BUDGET_EXCEEDED_100' : 'BUDGET_ALERT_85',
          title: impact.exceeded100
            ? `Presupuesto superado (>100%): ${impact.targetName}`
            : `Alerta presupuestaria (>85%): ${impact.targetName}`,
          message: `El anticipo ${created.code} lleva el presupuesto a ${impact.projectedPct.toFixed(1)}%.`,
          linkUrl: `/solicitudes/${created.id}`,
        });
      }

      return serializeExpenseRequest(created);
    },
    {
      body: t.Object({
        title: t.String({ minLength: 3 }),
        description: t.Optional(t.Nullable(t.String())),
        travelStartDate: t.Optional(t.Nullable(t.String())),
        travelEndDate: t.Optional(t.Nullable(t.String())),
        budgetTargetType: t.Union([t.Literal('DEPARTMENT'), t.Literal('PROJECT')]),
        departmentId: t.Optional(t.Nullable(t.String())),
        projectId: t.Optional(t.Nullable(t.String())),
        budgetYear: t.Optional(t.Number()),
        budgetMonth: t.Optional(t.Number()),
        requestedAmount: t.Number({ exclusiveMinimum: 0 }),
        specialTag: t.Optional(t.Nullable(t.String())),
      }),
    }
  )
  .patch(
    '/:id/resubmit',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.expenseRequest.findUnique({
          where: { id: params.id },
          include: { items: { include: { category: true } } },
        });
        if (!existing) throw new DomainError('Solicitud no encontrada.', 404);
        if (existing.requesterId !== user.id) {
          throw new DomainError('Solo el solicitante puede reenviar su solicitud observada.', 403);
        }
        if (existing.status !== 'OBSERVED') {
          throw new DomainError('La solicitud no está en estado Observada.', 409);
        }

        let newRequestedAmount = existing.type === 'ADVANCE'
          ? (body.requestedAmount ?? Number(existing.requestedAmount))
          : Number(existing.requestedAmount);
        let specialTags: string[] = [];

        if (existing.type === 'REIMBURSEMENT' && body.items && body.items.length > 0) {
          await tx.expenseItem.deleteMany({ where: { expenseRequestId: existing.id } });
          const categoryIds = Array.from(new Set(body.items.map((i) => i.categoryId)));
          const categories = await tx.category.findMany({ where: { id: { in: categoryIds } } });
          specialTags = Array.from(
            new Set(categories.map((c) => c.specialTag).filter((s): s is string => Boolean(s)))
          );
          const dupFlags = await Promise.all(
            body.items.map((it) =>
              hasDuplicateInvoice(tx, { vendorTaxId: it.vendorTaxId, invoiceNumber: it.invoiceNumber })
            )
          );
          newRequestedAmount = sumMoney(body.items.map((i) => i.claimedAmount));
          await tx.expenseItem.createMany({
            data: body.items.map((it, idx) => ({
              expenseRequestId: existing.id,
              categoryId: it.categoryId,
              expenseDate: new Date(it.expenseDate),
              vendorName: it.vendorName.trim(),
              vendorTaxId: it.vendorTaxId.trim(),
              invoiceNumber: it.invoiceNumber.trim(),
              description: it.description.trim(),
              claimedAmount: it.claimedAmount,
              receiptFileId: it.receiptFileId ?? null,
              duplicateWarning: dupFlags[idx],
            })),
          });
        } else {
          specialTags = Array.from(
            new Set(
              existing.items.map((i) => i.category.specialTag).filter((s): s is string => Boolean(s))
            )
          );
        }

        const impact = await evaluateBudgetImpact(tx, {
          budgetTargetType: existing.budgetTargetType,
          departmentId: existing.departmentId,
          projectId: existing.projectId,
          year: existing.budgetYear,
          month: existing.budgetMonth,
          excludeRequestId: existing.id,
          candidateAmount: newRequestedAmount,
        });

        await tx.approvalStep.updateMany({
          where: { expenseRequestId: existing.id, phase: 'INITIAL_REQUEST', status: { in: ['PENDING', 'WAITING', 'OBSERVED'] } },
          data: { status: 'SKIPPED' },
        });

        const { steps } = await resolveApprovalSteps(tx, {
          requestType: existing.type,
          phase: 'INITIAL_REQUEST',
          amount: newRequestedAmount,
          specialTags,
          budgetTargetType: existing.budgetTargetType,
          departmentId: existing.departmentId,
          projectId: existing.projectId,
          requesterId: user.id,
          budgetAlert85Triggered: impact.alert85Triggered,
          budgetExceeded100: impact.exceeded100,
        });

        const reqUpdated = await tx.expenseRequest.update({
          where: { id: existing.id },
          data: {
            title: body.title?.trim() ?? existing.title,
            description: body.description !== undefined ? (body.description?.trim() || null) : existing.description,
            requestedAmount: newRequestedAmount,
            status: 'PENDING_APPROVAL',
            budgetAlert85Triggered: impact.alert85Triggered,
            budgetUsagePctAtSubmit: impact.projectedPct,
            budgetOverrideRequired: impact.exceeded100,
            budgetOverrideApprovedById: null,
            budgetOverrideReason: null,
            budgetOverrideAt: null,
            currentStepEnteredAt: now,
            approvalSteps: {
              create: steps.map((s) => ({
                phase: s.phase,
                stepOrder: s.stepOrder,
                requiredRole: s.requiredRole,
                assignedApproverId: s.assignedApproverId,
                delegatedToUserId: s.delegatedToUserId,
                delegationId: s.delegationId,
                status: s.status,
                enteredAt: s.enteredAt,
              })),
            },
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: user.roles.join(','),
          entityType: 'EXPENSE_REQUEST',
          entityId: existing.id,
          action: 'RESUBMIT_EXPENSE',
          summary: `Solicitud ${existing.code} corregida y reenviada por ${user.fullName}`,
          previousState: { status: existing.status },
          newState: { status: 'PENDING_APPROVAL', requestedAmount: newRequestedAmount },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.Nullable(t.String())),
        requestedAmount: t.Optional(t.Number({ exclusiveMinimum: 0 })),
        items: t.Optional(t.Array(ItemInputSchema)),
      }),
    }
  );
