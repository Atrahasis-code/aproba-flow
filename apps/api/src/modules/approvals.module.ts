import { Elysia, t } from 'elysia';
import { hasAnyRole, hasRole } from '../lib/auth';
import { sumMoney, toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { EXPENSE_DETAIL_INCLUDE } from '../modules/expenses.module';
import { authPlugin, type AuthUser, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { canUserActOnStep } from '../services/approval-rule-engine';
import { recordAudit } from '../services/audit-logger';
import { buildDelegationAuditSummary, findActiveDelegation } from '../services/delegation-resolver';
import { serializeExpenseRequest } from '../services/expense-serializers';
import { createNotification, notifyRoleUsers } from '../services/notification.service';

async function getPendingStepsForUser(user: AuthUser, stalledHours: number) {
  const pendingSteps = await prisma.approvalStep.findMany({
    where: {
      status: 'PENDING',
      expenseRequest: {
        status: { in: ['PENDING_APPROVAL', 'EXCESS_PENDING_APPROVAL'] },
      },
    },
    include: {
      assignedApprover: { select: { id: true, fullName: true, email: true } },
      delegatedToUser: { select: { id: true, fullName: true, email: true } },
      delegation: { select: { id: true, reason: true, startDate: true, endDate: true } },
      expenseRequest: {
        include: EXPENSE_DETAIL_INCLUDE,
      },
    },
    orderBy: { enteredAt: 'asc' },
  });

  const visible: Array<{
    stepId: string;
    phase: string;
    stepOrder: number;
    requiredRole: string;
    enteredAt: string | null;
    hoursWaiting: number;
    isStalled48h: boolean;
    actingAsDelegate: boolean;
    delegatorName: string | null;
    delegationReason: string | null;
    request: ReturnType<typeof serializeExpenseRequest>;
  }> = [];

  for (const step of pendingSteps) {
    const check = await canUserActOnStep(prisma, user, step, step.expenseRequest.requesterId);
    if (!check.allowed) continue;

    const hoursWaiting = step.enteredAt
      ? Math.floor((Date.now() - step.enteredAt.getTime()) / (1000 * 60 * 60))
      : 0;

    visible.push({
      stepId: step.id,
      phase: step.phase,
      stepOrder: step.stepOrder,
      requiredRole: step.requiredRole,
      enteredAt: step.enteredAt ? step.enteredAt.toISOString() : null,
      hoursWaiting,
      isStalled48h: hoursWaiting >= stalledHours,
      actingAsDelegate: check.actingAsDelegate,
      delegatorName: check.delegatorName ?? step.assignedApprover?.fullName ?? null,
      delegationReason: check.delegationReason ?? step.delegation?.reason ?? null,
      request: serializeExpenseRequest(step.expenseRequest, stalledHours),
    });
  }

  return visible;
}

export const approvalsModule = new Elysia({ prefix: '/approvals' })
  .use(authPlugin)
  .get('/pending', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    const sysConfig = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    const stalledHours = sysConfig?.stalledHoursThreshold ?? 48;
    return getPendingStepsForUser(user, stalledHours);
  })
  .get('/review-hub', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    const sysConfig = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    const stalledHours = sysConfig?.stalledHoursThreshold ?? 48;

    const pendingSignatures = await getPendingStepsForUser(user, stalledHours);
    const isFinance = hasRole(user, 'FINANCE');

    const [settlementRows, returnRows] = isFinance
      ? await Promise.all([
          prisma.expenseRequest.findMany({
            where: { status: 'SETTLEMENT_IN_REVIEW', requesterId: { not: user.id } },
            include: EXPENSE_DETAIL_INCLUDE,
            orderBy: { currentStepEnteredAt: 'asc' },
          }),
          prisma.expenseRequest.findMany({
            where: { status: 'RETURN_SUBMITTED', requesterId: { not: user.id } },
            include: EXPENSE_DETAIL_INCLUDE,
            orderBy: { currentStepEnteredAt: 'asc' },
          }),
        ])
      : [[], []];

    const pendingFinanceSettlements = settlementRows.map((r) =>
      serializeExpenseRequest(r, stalledHours)
    );
    const pendingFinanceReturns = returnRows.map((r) =>
      serializeExpenseRequest(r, stalledHours)
    );

    return {
      pendingSignatures,
      pendingFinanceSettlements,
      pendingFinanceReturns,
      totalActionableCount:
        pendingSignatures.length +
        pendingFinanceSettlements.length +
        pendingFinanceReturns.length,
    };
  })
  .post(
    '/:stepId/decide',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();

      const txResult = await prisma.$transaction(async (tx) => {
        const step = await tx.approvalStep.findUnique({
          where: { id: params.stepId },
          include: {
            assignedApprover: { select: { id: true, fullName: true } },
            expenseRequest: {
              include: {
                items: true,
                approvalSteps: { orderBy: [{ phase: 'asc' }, { stepOrder: 'asc' }] },
                requester: { select: { id: true, fullName: true, email: true } },
              },
            },
          },
        });

        if (!step) throw new DomainError('Etapa de aprobación no encontrada.', 404);

        const req = step.expenseRequest;
        const perm = await canUserActOnStep(tx, user, step, req.requesterId);
        if (!perm.allowed) {
          throw new DomainError(perm.reason || 'No autorizado para firmar esta etapa.', 403, 'FORBIDDEN');
        }

        const comment = body.comment?.trim() || null;

        if ((body.decision === 'REJECTED' || body.decision === 'OBSERVED') && (!comment || comment.length < 3)) {
          throw new DomainError(
            'Debes indicar un comentario/motivo obligatorio para rechazar u observar.',
            400,
            'COMMENT_REQUIRED'
          );
        }

        if (body.decision === 'APPROVED' && req.budgetOverrideRequired && !req.budgetOverrideApprovedById) {
          throw new DomainError(
            'Esta solicitud supera el 100% del presupuesto. Requiere un Override Presupuestario auditado de Finanzas o Dirección antes de aprobar.',
            409,
            'BUDGET_OVERRIDE_REQUIRED'
          );
        }

        // For Reimbursement Finance step, validate/auto-approve pending items cleanly
        let calculatedApprovedAmount = toMoney(req.requestedAmount);
        if (
          body.decision === 'APPROVED' &&
          req.type === 'REIMBURSEMENT' &&
          step.requiredRole === 'FINANCE' &&
          req.items.length > 0
        ) {
          const observedItems = req.items.filter((it) => it.auditStatus === 'OBSERVED');
          if (observedItems.length > 0) {
            throw new DomainError(
              'Hay ítems observados en este reembolso. Usa la acción "Observar" para devolverlo al empleado.',
              409
            );
          }
          const pendingItems = req.items.filter((it) => it.auditStatus === 'PENDING');
          for (const it of pendingItems) {
            await tx.expenseItem.update({
              where: { id: it.id },
              data: {
                auditStatus: 'APPROVED',
                approvedAmount: it.claimedAmount,
                auditedById: user.id,
                auditedAt: now,
              },
            });
          }
          const refreshedItems = await tx.expenseItem.findMany({ where: { expenseRequestId: req.id } });
          calculatedApprovedAmount = sumMoney(refreshedItems.map((i) => i.approvedAmount ?? 0));
          if (calculatedApprovedAmount <= 0) {
            throw new DomainError(
              'Todos los ítems fueron rechazados; debes rechazar la solicitud en lugar de aprobarla.',
              409
            );
          }
        }

        await tx.approvalStep.update({
          where: { id: step.id },
          data: {
            status: body.decision,
            actedByUserId: user.id,
            actedAt: now,
            comment,
            ipAddress: clientIp,
            ...(perm.actingAsDelegate && perm.delegationId
              ? { delegatedToUserId: user.id, delegationId: perm.delegationId }
              : {}),
          },
        });

        let newStatus = req.status;
        let nextNotifyUserId: string | null = null;
        let nextNotifyRole: 'FINANCE' | 'DIRECTION' | 'TREASURY' | null = null;

        if (body.decision === 'REJECTED') {
          await tx.approvalStep.updateMany({
            where: { expenseRequestId: req.id, phase: step.phase, status: 'WAITING' },
            data: { status: 'SKIPPED' },
          });
          if (step.phase === 'EXCESS_SETTLEMENT') {
            newStatus = 'CLOSED_SETTLED';
            await tx.expenseRequest.update({
              where: { id: req.id },
              data: {
                status: 'CLOSED_SETTLED',
                approvedAmount: req.disbursedAmount,
                netSettlementAmount: 0,
                currentStepEnteredAt: null,
              },
            });
          } else {
            newStatus = 'REJECTED';
            await tx.expenseRequest.update({
              where: { id: req.id },
              data: { status: 'REJECTED', currentStepEnteredAt: null },
            });
          }
        } else if (body.decision === 'OBSERVED') {
          if (step.phase === 'EXCESS_SETTLEMENT') {
            throw new DomainError(
              'En aprobación de excedentes solo puedes aprobar o rechazar el excedente.',
              400
            );
          }
          newStatus = 'OBSERVED';
          await tx.expenseRequest.update({
            where: { id: req.id },
            data: { status: 'OBSERVED', currentStepEnteredAt: null },
          });
        } else {
          // APPROVED
          const nextStep = await tx.approvalStep.findFirst({
            where: { expenseRequestId: req.id, phase: step.phase, status: 'WAITING' },
            orderBy: { stepOrder: 'asc' },
          });

          if (nextStep) {
            await tx.approvalStep.update({
              where: { id: nextStep.id },
              data: { status: 'PENDING', enteredAt: now },
            });
            await tx.expenseRequest.update({
              where: { id: req.id },
              data: { currentStepEnteredAt: now },
            });
            nextNotifyUserId = nextStep.delegatedToUserId || nextStep.assignedApproverId;
            if (!nextNotifyUserId && (nextStep.requiredRole === 'FINANCE' || nextStep.requiredRole === 'DIRECTION')) {
              nextNotifyRole = nextStep.requiredRole;
            }
          } else {
            // Final step of phase approved!
            if (step.phase === 'EXCESS_SETTLEMENT') {
              newStatus = 'READY_FOR_PAYMENT';
              await tx.expenseRequest.update({
                where: { id: req.id },
                data: { status: 'READY_FOR_PAYMENT', currentStepEnteredAt: now },
              });
              nextNotifyRole = 'TREASURY';
            } else if (req.type === 'REIMBURSEMENT') {
              newStatus = 'READY_FOR_PAYMENT';
              await tx.expenseRequest.update({
                where: { id: req.id },
                data: {
                  status: 'READY_FOR_PAYMENT',
                  approvedAmount: calculatedApprovedAmount,
                  netSettlementAmount: calculatedApprovedAmount,
                  currentStepEnteredAt: now,
                },
              });
              nextNotifyRole = 'TREASURY';
            } else {
              newStatus = 'READY_FOR_DISBURSEMENT';
              await tx.expenseRequest.update({
                where: { id: req.id },
                data: { status: 'READY_FOR_DISBURSEMENT', currentStepEnteredAt: now },
              });
              nextNotifyRole = 'TREASURY';
            }
          }
        }

        const verbEs =
          body.decision === 'APPROVED'
            ? 'Aprobado'
            : body.decision === 'REJECTED'
              ? 'Rechazado'
              : 'Observado';

        const summary = perm.actingAsDelegate && perm.delegatorName && perm.delegationReason
          ? buildDelegationAuditSummary(verbEs, user.fullName, perm.delegatorName, perm.delegationReason)
          : `${verbEs} por ${user.fullName} (Etapa ${step.stepOrder}: ${step.requiredRole}) en ${req.code}${comment ? ` — "${comment}"` : ''}`;

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: step.requiredRole,
          onBehalfOfUserId: perm.actingAsDelegate ? perm.delegatorId : null,
          onBehalfOfName: perm.actingAsDelegate ? perm.delegatorName : null,
          delegationReason: perm.actingAsDelegate ? perm.delegationReason : null,
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: `${body.decision}_STEP`,
          summary,
          previousState: { status: req.status, stepStatus: step.status },
          newState: { status: newStatus, stepStatus: body.decision, comment },
          ipAddress: clientIp,
          userAgent,
        });

        const updatedFull = await tx.expenseRequest.findUniqueOrThrow({
          where: { id: req.id },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        return {
          updatedFull,
          reqCode: req.code,
          requesterId: req.requesterId,
          requesterEmail: req.requester.email,
          requesterName: req.requester.fullName,
          newStatus,
          nextNotifyUserId,
          nextNotifyRole,
        };
      });

      // Dispatch notifications outside DB tx
      if (body.decision === 'REJECTED' || body.decision === 'OBSERVED') {
        await createNotification({
          userId: txResult.requesterId,
          userEmail: txResult.requesterEmail,
          userName: txResult.requesterName,
          type: body.decision === 'REJECTED' ? 'REJECTED' : 'OBSERVED',
          title: `Solicitud ${txResult.reqCode} ${body.decision === 'REJECTED' ? 'rechazada' : 'observada'}`,
          message: body.comment || 'Revisa los comentarios del aprobador.',
          linkUrl: `/solicitudes/${txResult.updatedFull.id}`,
        });
      } else {
        if (txResult.nextNotifyUserId) {
          await createNotification({
            userId: txResult.nextNotifyUserId,
            type: 'APPROVAL_REQUIRED',
            title: `Tu firma es requerida en ${txResult.reqCode}`,
            message: `La solicitud avanzó a tu bandeja de aprobación.`,
            linkUrl: `/solicitudes/${txResult.updatedFull.id}`,
          });
        } else if (txResult.nextNotifyRole) {
          await notifyRoleUsers([txResult.nextNotifyRole], {
            type: txResult.nextNotifyRole === 'TREASURY' ? 'APPROVED' : 'APPROVAL_REQUIRED',
            title:
              txResult.nextNotifyRole === 'TREASURY'
                ? `Solicitud ${txResult.reqCode} lista en Tesorería`
                : `Solicitud ${txResult.reqCode} pendiente de ${txResult.nextNotifyRole}`,
            message: `Requiere gestión en bandeja correspondiente.`,
            linkUrl:
              txResult.nextNotifyRole === 'TREASURY'
                ? '/tesoreria'
                : `/solicitudes/${txResult.updatedFull.id}`,
          });
        }

        if (txResult.newStatus === 'READY_FOR_PAYMENT' || txResult.newStatus === 'READY_FOR_DISBURSEMENT') {
          await createNotification({
            userId: txResult.requesterId,
            userEmail: txResult.requesterEmail,
            userName: txResult.requesterName,
            type: 'APPROVED',
            title: `Solicitud ${txResult.reqCode} aprobada`,
            message: `Tu solicitud fue aprobada y pasó a Tesorería.`,
            linkUrl: `/solicitudes/${txResult.updatedFull.id}`,
          });
        }
      }

      return serializeExpenseRequest(txResult.updatedFull);
    },
    {
      body: t.Object({
        decision: t.Union([t.Literal('APPROVED'), t.Literal('REJECTED'), t.Literal('OBSERVED')]),
        comment: t.Optional(t.Nullable(t.String())),
      }),
    }
  )
  .post(
    '/:stepId/override-budget',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireRoles(currentUser, ['FINANCE', 'DIRECTION']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const step = await tx.approvalStep.findUnique({
          where: { id: params.stepId },
          include: {
            expenseRequest: {
              include: { requester: { select: { id: true, fullName: true, email: true } } },
            },
          },
        });
        if (!step) throw new DomainError('Etapa no encontrada.', 404);
        const req = step.expenseRequest;
        if (req.requesterId === user.id) {
          throw new DomainError('No puedes autorizar un override sobre tu propia solicitud.', 403);
        }
        if (!req.budgetOverrideRequired) {
          throw new DomainError('Esta solicitud no requiere override presupuestario.', 400);
        }

        await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            budgetOverrideApprovedById: user.id,
            budgetOverrideReason: body.reason.trim(),
            budgetOverrideAt: now,
          },
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: hasAnyRole(user, ['DIRECTION']) ? 'DIRECTION' : 'FINANCE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'BUDGET_OVERRIDE',
          summary: `Override presupuestario (>100%) autorizado por ${user.fullName} en ${req.code} — Motivo: ${body.reason.trim()}`,
          previousState: { budgetOverrideApprovedById: req.budgetOverrideApprovedById },
          newState: { budgetOverrideApprovedById: user.id, reason: body.reason.trim() },
          ipAddress: clientIp,
          userAgent,
        });

        return tx.expenseRequest.findUniqueOrThrow({
          where: { id: req.id },
          include: EXPENSE_DETAIL_INCLUDE,
        });
      });

      await createNotification({
        userId: updated.requesterId,
        type: 'BUDGET_EXCEEDED_100',
        title: `Override presupuestario autorizado en ${updated.code}`,
        message: `${user.fullName} autorizó la excepción presupuestaria (>100%).`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        reason: t.String({ minLength: 5 }),
      }),
    }
  )
  .post(
    '/:stepId/reassign',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const admin = requireRoles(currentUser, ['ADMIN']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const step = await tx.approvalStep.findUnique({
          where: { id: params.stepId },
          include: {
            assignedApprover: { select: { id: true, fullName: true } },
            expenseRequest: true,
          },
        });
        if (!step) throw new DomainError('Etapa no encontrada.', 404);
        if (step.status !== 'PENDING') {
          throw new DomainError('Solo puedes reasignar etapas en estado Pendiente.', 409);
        }
        if (body.newApproverId === step.expenseRequest.requesterId) {
          throw new DomainError('No puedes reasignar la aprobación al propio solicitante.', 400);
        }

        const newApprover = await tx.user.findUnique({
          where: { id: body.newApproverId },
          select: { id: true, fullName: true, isActive: true },
        });
        if (!newApprover || !newApprover.isActive) {
          throw new DomainError('El nuevo aprobador no existe o está inactivo.', 404);
        }

        const activeDel = await findActiveDelegation(tx, newApprover.id, now);

        await tx.approvalStep.update({
          where: { id: step.id },
          data: {
            status: 'REASSIGNED',
            actedByUserId: admin.id,
            actedAt: now,
            comment: `Reasignado a ${newApprover.fullName} — Motivo: ${body.reason.trim()}`,
            ipAddress: clientIp,
          },
        });

        await tx.approvalStep.create({
          data: {
            expenseRequestId: step.expenseRequestId,
            phase: step.phase,
            stepOrder: step.stepOrder,
            requiredRole: step.requiredRole,
            assignedApproverId: newApprover.id,
            delegatedToUserId: activeDel ? activeDel.delegateId : null,
            delegationId: activeDel ? activeDel.id : null,
            status: 'PENDING',
            enteredAt: now,
          },
        });

        await tx.expenseRequest.update({
          where: { id: step.expenseRequestId },
          data: { currentStepEnteredAt: now },
        });

        await recordAudit(tx, {
          actorUserId: admin.id,
          actorName: admin.fullName,
          actorRole: 'ADMIN',
          entityType: 'EXPENSE_REQUEST',
          entityId: step.expenseRequestId,
          action: 'REASSIGN_APPROVER',
          summary: `Etapa reasignada manualmente de ${step.assignedApprover?.fullName ?? step.requiredRole} a ${newApprover.fullName} por ${admin.fullName} — Motivo: ${body.reason.trim()}`,
          previousState: { assignedApproverId: step.assignedApproverId },
          newState: { assignedApproverId: newApprover.id, reason: body.reason.trim() },
          ipAddress: clientIp,
          userAgent,
        });

        return {
          request: await tx.expenseRequest.findUniqueOrThrow({
            where: { id: step.expenseRequestId },
            include: EXPENSE_DETAIL_INCLUDE,
          }),
          notifyUserId: activeDel?.delegateId ?? newApprover.id,
        };
      });

      await createNotification({
        userId: updated.notifyUserId,
        type: 'APPROVAL_REQUIRED',
        title: `Solicitud reasignada a tu bandeja: ${updated.request.code}`,
        message: `Un administrador te asignó la firma pendiente (${body.reason.trim()}).`,
        linkUrl: `/solicitudes/${updated.request.id}`,
      });

      return serializeExpenseRequest(updated.request);
    },
    {
      body: t.Object({
        newApproverId: t.String({ minLength: 1 }),
        reason: t.String({ minLength: 3 }),
      }),
    }
  );
