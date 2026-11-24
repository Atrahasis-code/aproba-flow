import { Elysia } from 'elysia';
import { isExecutiveViewer } from '../lib/auth';
import { roundMoney, sumMoney, toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';
import { getBudgetSnapshot } from '../services/budget-engine';
import { createNotification, notifyRoleUsers } from '../services/notification.service';
import { checkAdvanceEligibility } from '../services/settlement-engine';

export const dashboardModule = new Elysia({ prefix: '/dashboard' })
  .use(authPlugin)
  .get('/executive', async ({ currentUser, query }) => {
    const user = requireAuth(currentUser);
    const now = new Date();
    const year = query.year ? Number(query.year) : now.getFullYear();
    const month = query.month ? Number(query.month) : now.getMonth() + 1;
    const branchId = query.branchId || undefined;

    const sysConfig = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    const thresholdPct = sysConfig?.budgetAlertThresholdPct ?? 85;
    const stalledHoursThreshold = sysConfig?.stalledHoursThreshold ?? 48;

    const [departments, projects, monthRequests, stalledCandidates, treasuryCount, myRequests, myEligibility] =
      await Promise.all([
        prisma.department.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
        prisma.project.findMany({
          where: { status: 'ACTIVE' },
          include: { manager: { select: { fullName: true } } },
          orderBy: { name: 'asc' },
        }),
        prisma.expenseRequest.findMany({
          where: {
            budgetYear: year,
            budgetMonth: month,
            status: { notIn: ['DRAFT', 'REJECTED'] },
            ...(branchId ? { requester: { branchId } } : {}),
          },
          select: {
            id: true,
            status: true,
            requestedAmount: true,
            disbursedAmount: true,
            approvedAmount: true,
          },
        }),
        prisma.expenseRequest.findMany({
          where: {
            status: { in: ['PENDING_APPROVAL', 'EXCESS_PENDING_APPROVAL'] },
            currentStepEnteredAt: { not: null },
            ...(branchId ? { requester: { branchId } } : {}),
          },
          include: {
            requester: { select: { fullName: true, branch: { select: { name: true, code: true } } } },
            department: { select: { name: true } },
            project: { select: { code: true, name: true } },
            approvalSteps: {
              where: { status: 'PENDING' },
              include: {
                assignedApprover: { select: { id: true, fullName: true } },
                delegatedToUser: { select: { id: true, fullName: true } },
              },
              take: 1,
            },
          },
          orderBy: { currentStepEnteredAt: 'asc' },
        }),
        prisma.expenseRequest.count({
          where: { status: { in: ['READY_FOR_DISBURSEMENT', 'READY_FOR_PAYMENT'] } },
        }),
        prisma.expenseRequest.findMany({
          where: { requesterId: user.id },
          select: {
            id: true,
            code: true,
            title: true,
            type: true,
            status: true,
            requestedAmount: true,
            disbursedAmount: true,
            netSettlementAmount: true,
            settlementDueDate: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        checkAdvanceEligibility(prisma, user.id),
      ]);

    const projectConsumption = await Promise.all(
      projects.map(async (p) => {
        const snap = await getBudgetSnapshot(prisma, {
          budgetTargetType: 'PROJECT',
          projectId: p.id,
          year,
          month,
        });
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          clientName: p.clientName,
          managerName: p.manager.fullName,
          budgetLimit: snap.budgetLimit,
          executed: snap.executed,
          committed: snap.committed,
          totalUsed: snap.totalUsed,
          available: snap.available,
          usagePct: snap.usagePct,
          isAlert85: snap.usagePct > thresholdPct,
          isOver100: snap.usagePct > 100,
        };
      })
    );

    const departmentConsumption = await Promise.all(
      departments.map(async (d) => {
        const snap = await getBudgetSnapshot(prisma, {
          budgetTargetType: 'DEPARTMENT',
          departmentId: d.id,
          year,
          month,
        });
        return {
          id: d.id,
          code: d.code,
          name: d.name,
          budgetLimit: snap.budgetLimit,
          executed: snap.executed,
          committed: snap.committed,
          totalUsed: snap.totalUsed,
          available: snap.available,
          usagePct: snap.usagePct,
          isAlert85: snap.usagePct > thresholdPct,
          isOver100: snap.usagePct > 100,
        };
      })
    );

    const totalExecutedMonth = sumMoney(
      monthRequests
        .filter((r) =>
          ['CLOSED_SETTLED', 'READY_FOR_PAYMENT', 'PENDING_RETURN', 'RETURN_SUBMITTED'].includes(r.status)
        )
        .map((r) => (toMoney(r.approvedAmount) > 0 ? r.approvedAmount : r.requestedAmount))
    );

    const totalCommittedMonth = sumMoney(
      monthRequests
        .filter(
          (r) =>
            !['CLOSED_SETTLED', 'READY_FOR_PAYMENT', 'PENDING_RETURN', 'RETURN_SUBMITTED'].includes(r.status)
        )
        .map((r) => (toMoney(r.disbursedAmount) > 0 ? r.disbursedAmount : r.requestedAmount))
    );

    const stalledRequests = stalledCandidates
      .map((req) => {
        const pendingStep = req.approvalSteps[0];
        const enteredAt = pendingStep?.enteredAt ?? req.currentStepEnteredAt;
        const hoursWaiting = enteredAt
          ? Math.floor((Date.now() - enteredAt.getTime()) / (1000 * 60 * 60))
          : 0;
        const responsibleName = pendingStep
          ? pendingStep.delegatedToUser
            ? `${pendingStep.delegatedToUser.fullName} (suplente de ${pendingStep.assignedApprover?.fullName ?? 'titular'})`
            : pendingStep.assignedApprover?.fullName ?? `Pool ${pendingStep.requiredRole}`
          : 'Sin etapa activa';

        return {
          id: req.id,
          code: req.code,
          title: req.title,
          type: req.type,
          status: req.status,
          requestedAmount: toMoney(req.requestedAmount),
          requesterName: req.requester.fullName,
          branchCode: req.requester.branch.code,
          targetName:
            req.budgetTargetType === 'PROJECT'
              ? `${req.project?.code ?? ''} - ${req.project?.name ?? ''}`
              : req.department?.name ?? '',
          currentStepId: pendingStep?.id ?? null,
          currentRole: pendingStep?.requiredRole ?? null,
          responsibleName,
          hoursWaiting,
          enteredAt: enteredAt ? enteredAt.toISOString() : null,
        };
      })
      .filter((r) => r.hoursWaiting >= stalledHoursThreshold);

    const alerts85 = [
      ...departmentConsumption
        .filter((d) => d.isAlert85)
        .map((d) => ({
          kind: 'DEPARTMENT' as const,
          id: d.id,
          name: `Depto. ${d.name}`,
          usagePct: d.usagePct,
          totalUsed: d.totalUsed,
          budgetLimit: d.budgetLimit,
          isOver100: d.isOver100,
        })),
      ...projectConsumption
        .filter((p) => p.isAlert85)
        .map((p) => ({
          kind: 'PROJECT' as const,
          id: p.id,
          name: `${p.code} - ${p.name}`,
          usagePct: p.usagePct,
          totalUsed: p.totalUsed,
          budgetLimit: p.budgetLimit,
          isOver100: p.isOver100,
        })),
    ];

    return {
      isExecutive: isExecutiveViewer(user) || user.roles.includes('MANAGER'),
      year,
      month,
      thresholdPct,
      stalledHoursThreshold,
      kpis: {
        totalExecutedMonth,
        totalCommittedMonth,
        totalMonthExposure: roundMoney(totalExecutedMonth + totalCommittedMonth),
        stalledCount: stalledRequests.length,
        alerts85Count: alerts85.length,
        pendingTreasuryCount: treasuryCount,
      },
      projectConsumption,
      departmentConsumption,
      alerts85,
      stalledRequests,
      mySummary: {
        eligibility: myEligibility,
        recentRequests: myRequests.map((r) => ({
          ...r,
          requestedAmount: toMoney(r.requestedAmount),
          disbursedAmount: toMoney(r.disbursedAmount),
          netSettlementAmount: toMoney(r.netSettlementAmount),
          settlementDueDate: r.settlementDueDate ? r.settlementDueDate.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    };
  })
  .post('/stalled/:expenseId/remind', async ({ currentUser, params, clientIp, userAgent }) => {
    const actor = requireRoles(currentUser, ['FINANCE', 'DIRECTION', 'ADMIN', 'MANAGER']);

    const req = await prisma.expenseRequest.findUnique({
      where: { id: params.expenseId },
      include: {
        approvalSteps: {
          where: { status: 'PENDING' },
          include: {
            assignedApprover: { select: { id: true, fullName: true, email: true } },
            delegatedToUser: { select: { id: true, fullName: true, email: true } },
          },
          take: 1,
        },
      },
    });
    if (!req) throw new DomainError('Solicitud no encontrada.', 404);
    const pendingStep = req.approvalSteps[0];
    if (!pendingStep) {
      throw new DomainError('La solicitud no tiene una firma pendiente actualmente.', 409);
    }

    const targetUser = pendingStep.delegatedToUser ?? pendingStep.assignedApprover;
    if (targetUser) {
      await createNotification({
        userId: targetUser.id,
        userEmail: targetUser.email,
        userName: targetUser.fullName,
        type: 'STALLED_48H',
        title: `Recordatorio urgente (>48h): ${req.code}`,
        message: `${actor.fullName} envió un recordatorio por demora en la firma pendiente de ${req.code} ($${toMoney(req.requestedAmount).toFixed(2)}).`,
        linkUrl: `/solicitudes/${req.id}`,
      });
    } else if (pendingStep.requiredRole === 'FINANCE' || pendingStep.requiredRole === 'DIRECTION') {
      await notifyRoleUsers([pendingStep.requiredRole], {
        type: 'STALLED_48H',
        title: `Recordatorio urgente (>48h): ${req.code}`,
        message: `${actor.fullName} solicita revisión prioritaria para ${req.code} ($${toMoney(req.requestedAmount).toFixed(2)}).`,
        linkUrl: `/solicitudes/${req.id}`,
      });
    }

    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorName: actor.fullName,
        actorRole: actor.roles.join(','),
        entityType: 'EXPENSE_REQUEST',
        entityId: req.id,
        action: 'SEND_STALLED_REMINDER',
        summary: `Recordatorio por solicitud trabada (>48h) enviado por ${actor.fullName} a ${targetUser?.fullName ?? pendingStep.requiredRole}`,
        ipAddress: clientIp,
        userAgent,
      });
    });

    return { ok: true, notified: targetUser?.fullName ?? pendingStep.requiredRole };
  });
