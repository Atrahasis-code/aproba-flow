import { Elysia, t } from 'elysia';
import type { ProjectStatus } from '../generated/prisma';
import { toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';
import { evaluateBudgetImpact, getBudgetSnapshot } from '../services/budget-engine';

export const budgetsModule = new Elysia({ prefix: '/budgets' })
  .use(authPlugin)
  .get('/overview', async ({ currentUser, query }) => {
    requireAuth(currentUser);
    const now = new Date();
    const year = query.year ? Number(query.year) : now.getFullYear();
    const month = query.month ? Number(query.month) : now.getMonth() + 1;

    const [departments, monthlyBudgets, projects, sysConfig] = await Promise.all([
      prisma.department.findMany({
        where: { isActive: true },
        include: { headUser: { select: { id: true, fullName: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.departmentBudget.findMany({
        where: { year },
      }),
      prisma.project.findMany({
        include: {
          manager: { select: { id: true, fullName: true } },
          assignments: {
            where: { isActive: true },
            include: { user: { select: { id: true, fullName: true, employeeCode: true, jobTitle: true } } },
          },
        },
        orderBy: { code: 'asc' },
      }),
      prisma.systemConfig.findUnique({ where: { id: 'singleton' } }),
    ]);

    const thresholdPct = sysConfig?.budgetAlertThresholdPct ?? 85;

    const departmentSummaries = await Promise.all(
      departments.map(async (dept) => {
        const snap = await getBudgetSnapshot(prisma, {
          budgetTargetType: 'DEPARTMENT',
          departmentId: dept.id,
          year,
          month,
        });
        const months = Array.from({ length: 12 }, (_, idx) => {
          const m = idx + 1;
          const b = monthlyBudgets.find((mb) => mb.departmentId === dept.id && mb.month === m);
          return { month: m, amount: toMoney(b?.amount ?? 0) };
        });

        return {
          ...snap,
          headUserName: dept.headUser?.fullName ?? null,
          isAlert85: snap.usagePct > thresholdPct,
          isOver100: snap.usagePct > 100,
          months,
        };
      })
    );

    const projectSummaries = await Promise.all(
      projects.map(async (proj) => {
        const snap = await getBudgetSnapshot(prisma, {
          budgetTargetType: 'PROJECT',
          projectId: proj.id,
          year,
          month,
        });
        return {
          ...snap,
          id: proj.id,
          code: proj.code,
          name: proj.name,
          clientName: proj.clientName,
          managerId: proj.managerId,
          managerName: proj.manager.fullName,
          status: proj.status,
          startDate: proj.startDate.toISOString(),
          endDate: proj.endDate ? proj.endDate.toISOString() : null,
          isAlert85: snap.usagePct > thresholdPct,
          isOver100: snap.usagePct > 100,
          assignedUsers: proj.assignments.map((a) => a.user),
        };
      })
    );

    return {
      year,
      month,
      thresholdPct,
      departments: departmentSummaries,
      projects: projectSummaries,
    };
  })
  .post(
    '/check-impact',
    async ({ currentUser, body }) => {
      requireAuth(currentUser);
      const now = new Date();
      return evaluateBudgetImpact(prisma, {
        budgetTargetType: body.budgetTargetType,
        departmentId: body.departmentId ?? null,
        projectId: body.projectId ?? null,
        year: body.year ?? now.getFullYear(),
        month: body.month ?? now.getMonth() + 1,
        candidateAmount: body.candidateAmount,
      });
    },
    {
      body: t.Object({
        budgetTargetType: t.Union([t.Literal('DEPARTMENT'), t.Literal('PROJECT')]),
        departmentId: t.Optional(t.Nullable(t.String())),
        projectId: t.Optional(t.Nullable(t.String())),
        year: t.Optional(t.Number()),
        month: t.Optional(t.Number()),
        candidateAmount: t.Number({ minimum: 0 }),
      }),
    }
  )
  .put(
    '/departments/:id/:year/:month',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION']);
      const year = Number(params.year);
      const month = Number(params.month);
      if (month < 1 || month > 12) {
        throw new DomainError('Mes inválido (1-12).', 400);
      }

      const prev = await prisma.departmentBudget.findUnique({
        where: { departmentId_year_month: { departmentId: params.id, year, month } },
      });

      const updated = await prisma.$transaction(async (tx) => {
        const record = await tx.departmentBudget.upsert({
          where: { departmentId_year_month: { departmentId: params.id, year, month } },
          update: { amount: body.amount },
          create: { departmentId: params.id, year, month, amount: body.amount },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'DEPARTMENT_BUDGET',
          entityId: record.id,
          action: 'UPDATE_DEPARTMENT_BUDGET',
          summary: `Presupuesto mensual (${month}/${year}) actualizado a $${body.amount.toFixed(2)} por ${actor.fullName}`,
          previousState: prev ? { amount: toMoney(prev.amount) } : null,
          newState: { amount: body.amount, year, month },
          ipAddress: clientIp,
          userAgent,
        });
        return record;
      });

      return { id: updated.id, amount: toMoney(updated.amount) };
    },
    {
      body: t.Object({
        amount: t.Number({ minimum: 0 }),
      }),
    }
  )
  .post(
    '/projects',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION']);
      const created = await prisma.$transaction(async (tx) => {
        const proj = await tx.project.create({
          data: {
            code: body.code.trim().toUpperCase(),
            name: body.name.trim(),
            clientName: body.clientName.trim(),
            managerId: body.managerId,
            totalBudget: body.totalBudget,
            startDate: new Date(body.startDate),
            endDate: body.endDate ? new Date(body.endDate) : null,
            status: 'ACTIVE',
          },
        });
        if (body.assignedUserIds && body.assignedUserIds.length > 0) {
          for (const userId of body.assignedUserIds) {
            await tx.projectAssignment.upsert({
              where: { projectId_userId: { projectId: proj.id, userId } },
              update: { isActive: true },
              create: { projectId: proj.id, userId, isActive: true },
            });
          }
        }
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'PROJECT',
          entityId: proj.id,
          action: 'CREATE_PROJECT',
          summary: `Proyecto ${proj.code} (${proj.name}) creado con presupuesto $${body.totalBudget.toFixed(2)}`,
          newState: { code: proj.code, totalBudget: body.totalBudget },
          ipAddress: clientIp,
          userAgent,
        });
        return proj;
      });

      return { id: created.id, code: created.code, name: created.name };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 2 }),
        name: t.String({ minLength: 2 }),
        clientName: t.String({ minLength: 2 }),
        managerId: t.String(),
        totalBudget: t.Number({ minimum: 0 }),
        startDate: t.String(),
        endDate: t.Optional(t.Nullable(t.String())),
        assignedUserIds: t.Optional(t.Array(t.String())),
      }),
    }
  )
  .patch(
    '/projects/:id',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION']);
      const prev = await prisma.project.findUnique({ where: { id: params.id } });
      if (!prev) throw new DomainError('Proyecto no encontrado.', 404);

      const updated = await prisma.$transaction(async (tx) => {
        const proj = await tx.project.update({
          where: { id: params.id },
          data: {
            ...(body.name !== undefined ? { name: body.name.trim() } : {}),
            ...(body.clientName !== undefined ? { clientName: body.clientName.trim() } : {}),
            ...(body.managerId !== undefined ? { managerId: body.managerId } : {}),
            ...(body.totalBudget !== undefined ? { totalBudget: body.totalBudget } : {}),
            ...(body.status !== undefined ? { status: body.status as ProjectStatus } : {}),
          },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'PROJECT',
          entityId: proj.id,
          action: 'UPDATE_PROJECT',
          summary: `Proyecto ${proj.code} actualizado por ${actor.fullName}`,
          previousState: { totalBudget: toMoney(prev.totalBudget), status: prev.status },
          newState: { totalBudget: toMoney(proj.totalBudget), status: proj.status },
          ipAddress: clientIp,
          userAgent,
        });
        return proj;
      });

      return { id: updated.id, totalBudget: toMoney(updated.totalBudget), status: updated.status };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        clientName: t.Optional(t.String()),
        managerId: t.Optional(t.String()),
        totalBudget: t.Optional(t.Number({ minimum: 0 })),
        status: t.Optional(t.String()),
      }),
    }
  )
  .post(
    '/projects/:id/assignments',
    async ({ currentUser, params, body }) => {
      requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION', 'MANAGER']);
      const assignment = await prisma.projectAssignment.upsert({
        where: { projectId_userId: { projectId: params.id, userId: body.userId } },
        update: { isActive: true },
        create: { projectId: params.id, userId: body.userId, isActive: true },
      });
      return assignment;
    },
    {
      body: t.Object({
        userId: t.String(),
      }),
    }
  )
  .delete('/projects/:id/assignments/:userId', async ({ currentUser, params }) => {
    requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION', 'MANAGER']);
    await prisma.projectAssignment.updateMany({
      where: { projectId: params.id, userId: params.userId },
      data: { isActive: false },
    });
    return { ok: true };
  });
