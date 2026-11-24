import { Elysia, t } from 'elysia';
import type { ApprovalRoleType, RequestType } from '../generated/prisma';
import { toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';

export const rulesModule = new Elysia({ prefix: '/rules' })
  .use(authPlugin)
  .get('/', async ({ currentUser }) => {
    requireAuth(currentUser);
    const rules = await prisma.approvalRule.findMany({
      orderBy: [{ requestType: 'asc' }, { priority: 'asc' }, { minAmount: 'asc' }],
    });
    return rules.map((r) => ({
      ...r,
      minAmount: toMoney(r.minAmount),
      maxAmount: r.maxAmount !== null ? toMoney(r.maxAmount) : null,
      approverChain: Array.isArray(r.approverChain) ? (r.approverChain as ApprovalRoleType[]) : [],
    }));
  })
  .post(
    '/',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const admin = requireRoles(currentUser, ['ADMIN', 'DIRECTION', 'FINANCE']);
      if (body.maxAmount !== null && body.maxAmount !== undefined && body.maxAmount < body.minAmount) {
        throw new DomainError('El monto máximo no puede ser menor al monto mínimo.', 400);
      }

      const created = await prisma.$transaction(async (tx) => {
        const rule = await tx.approvalRule.create({
          data: {
            name: body.name.trim(),
            requestType: body.requestType as RequestType,
            categorySpecialTag: body.categorySpecialTag?.trim() || null,
            minAmount: body.minAmount,
            maxAmount: body.maxAmount ?? null,
            approverChain: body.approverChain,
            allowAutoApprove: body.allowAutoApprove ?? false,
            priority: body.priority ?? 10,
            isActive: body.isActive ?? true,
          },
        });
        await recordAudit(tx, {
          actorUserId: admin.id,
          actorName: admin.fullName,
          actorRole: admin.roles.join(','),
          entityType: 'APPROVAL_RULE',
          entityId: rule.id,
          action: 'CREATE_APPROVAL_RULE',
          summary: `Regla de aprobación "${rule.name}" creada por ${admin.fullName}`,
          newState: {
            name: rule.name,
            requestType: rule.requestType,
            minAmount: body.minAmount,
            maxAmount: body.maxAmount ?? null,
            approverChain: body.approverChain,
          },
          ipAddress: clientIp,
          userAgent,
        });
        return rule;
      });

      return {
        ...created,
        minAmount: toMoney(created.minAmount),
        maxAmount: created.maxAmount !== null ? toMoney(created.maxAmount) : null,
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 3 }),
        requestType: t.Union([t.Literal('REIMBURSEMENT'), t.Literal('ADVANCE'), t.Literal('EXCESS')]),
        categorySpecialTag: t.Optional(t.Nullable(t.String())),
        minAmount: t.Number({ minimum: 0 }),
        maxAmount: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
        approverChain: t.Array(t.String()),
        allowAutoApprove: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .patch(
    '/:id',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const admin = requireRoles(currentUser, ['ADMIN', 'DIRECTION', 'FINANCE']);
      const prev = await prisma.approvalRule.findUnique({ where: { id: params.id } });
      if (!prev) throw new DomainError('Regla no encontrada.', 404);

      const effectiveMin = body.minAmount !== undefined ? body.minAmount : toMoney(prev.minAmount);
      const effectiveMax =
        body.maxAmount !== undefined
          ? body.maxAmount
          : prev.maxAmount !== null
            ? toMoney(prev.maxAmount)
            : null;
      if (effectiveMax !== null && effectiveMax < effectiveMin) {
        throw new DomainError('El monto máximo no puede ser menor al monto mínimo.', 400);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const rule = await tx.approvalRule.update({
          where: { id: params.id },
          data: {
            ...(body.name !== undefined ? { name: body.name.trim() } : {}),
            ...(body.requestType !== undefined
              ? { requestType: body.requestType as RequestType }
              : {}),
            ...(body.categorySpecialTag !== undefined
              ? { categorySpecialTag: body.categorySpecialTag?.trim() || null }
              : {}),
            ...(body.minAmount !== undefined ? { minAmount: body.minAmount } : {}),
            ...(body.maxAmount !== undefined ? { maxAmount: body.maxAmount } : {}),
            ...(body.approverChain !== undefined ? { approverChain: body.approverChain } : {}),
            ...(body.allowAutoApprove !== undefined ? { allowAutoApprove: body.allowAutoApprove } : {}),
            ...(body.priority !== undefined ? { priority: body.priority } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          },
        });
        await recordAudit(tx, {
          actorUserId: admin.id,
          actorName: admin.fullName,
          actorRole: admin.roles.join(','),
          entityType: 'APPROVAL_RULE',
          entityId: rule.id,
          action: 'UPDATE_APPROVAL_RULE',
          summary: `Regla de aprobación "${rule.name}" actualizada por ${admin.fullName}`,
          previousState: {
            name: prev.name,
            requestType: prev.requestType,
            minAmount: toMoney(prev.minAmount),
            maxAmount: prev.maxAmount !== null ? toMoney(prev.maxAmount) : null,
            approverChain: prev.approverChain,
            isActive: prev.isActive,
          },
          newState: {
            name: rule.name,
            requestType: rule.requestType,
            minAmount: toMoney(rule.minAmount),
            maxAmount: rule.maxAmount !== null ? toMoney(rule.maxAmount) : null,
            approverChain: rule.approverChain,
            isActive: rule.isActive,
          },
          ipAddress: clientIp,
          userAgent,
        });
        return rule;
      });

      return {
        ...updated,
        minAmount: toMoney(updated.minAmount),
        maxAmount: updated.maxAmount !== null ? toMoney(updated.maxAmount) : null,
      };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 2 })),
        requestType: t.Optional(
          t.Union([t.Literal('REIMBURSEMENT'), t.Literal('ADVANCE'), t.Literal('EXCESS')])
        ),
        categorySpecialTag: t.Optional(t.Nullable(t.String())),
        minAmount: t.Optional(t.Number({ minimum: 0 })),
        maxAmount: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
        approverChain: t.Optional(t.Array(t.String())),
        allowAutoApprove: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete('/:id', async ({ currentUser, params, clientIp, userAgent }) => {
    const admin = requireRoles(currentUser, ['ADMIN']);
    const prev = await prisma.approvalRule.findUnique({ where: { id: params.id } });
    if (!prev) throw new DomainError('Regla no encontrada.', 404);

    await prisma.$transaction(async (tx) => {
      await tx.approvalRule.delete({ where: { id: params.id } });
      await recordAudit(tx, {
        actorUserId: admin.id,
        actorName: admin.fullName,
        actorRole: 'ADMIN',
        entityType: 'APPROVAL_RULE',
        entityId: params.id,
        action: 'DELETE_APPROVAL_RULE',
        summary: `Regla "${prev.name}" eliminada por ${admin.fullName}`,
        previousState: { name: prev.name, requestType: prev.requestType },
        ipAddress: clientIp,
        userAgent,
      });
    });

    return { ok: true };
  })
  .get('/config', async ({ currentUser }) => {
    requireAuth(currentUser);
    const cfg = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });
    if (!cfg) {
      return {
        budgetAlertThresholdPct: 85,
        stalledHoursThreshold: 48,
        advanceSettlementDueDays: 15,
        excessToleranceUsd: 50,
        excessMediumMaxUsd: 250,
      };
    }
    return {
      budgetAlertThresholdPct: cfg.budgetAlertThresholdPct,
      stalledHoursThreshold: cfg.stalledHoursThreshold,
      advanceSettlementDueDays: cfg.advanceSettlementDueDays,
      excessToleranceUsd: toMoney(cfg.excessToleranceUsd),
      excessMediumMaxUsd: toMoney(cfg.excessMediumMaxUsd),
    };
  })
  .put(
    '/config',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const admin = requireRoles(currentUser, ['ADMIN', 'DIRECTION', 'FINANCE']);
      const prev = await prisma.systemConfig.findUnique({ where: { id: 'singleton' } });

      const updated = await prisma.$transaction(async (tx) => {
        const cfg = await tx.systemConfig.upsert({
          where: { id: 'singleton' },
          update: {
            budgetAlertThresholdPct: body.budgetAlertThresholdPct,
            stalledHoursThreshold: body.stalledHoursThreshold,
            advanceSettlementDueDays: body.advanceSettlementDueDays,
            excessToleranceUsd: body.excessToleranceUsd,
            excessMediumMaxUsd: body.excessMediumMaxUsd,
          },
          create: {
            id: 'singleton',
            budgetAlertThresholdPct: body.budgetAlertThresholdPct,
            stalledHoursThreshold: body.stalledHoursThreshold,
            advanceSettlementDueDays: body.advanceSettlementDueDays,
            excessToleranceUsd: body.excessToleranceUsd,
            excessMediumMaxUsd: body.excessMediumMaxUsd,
          },
        });
        await recordAudit(tx, {
          actorUserId: admin.id,
          actorName: admin.fullName,
          actorRole: admin.roles.join(','),
          entityType: 'SYSTEM_CONFIG',
          entityId: 'singleton',
          action: 'UPDATE_SYSTEM_CONFIG',
          summary: `Parámetros globales actualizados por ${admin.fullName} (Alerta ${body.budgetAlertThresholdPct}%, Cuello ${body.stalledHoursThreshold}h, Plazo ${body.advanceSettlementDueDays}d)`,
          previousState: prev
            ? {
                budgetAlertThresholdPct: prev.budgetAlertThresholdPct,
                stalledHoursThreshold: prev.stalledHoursThreshold,
                advanceSettlementDueDays: prev.advanceSettlementDueDays,
              }
            : null,
          newState: body,
          ipAddress: clientIp,
          userAgent,
        });
        return cfg;
      });

      return {
        budgetAlertThresholdPct: updated.budgetAlertThresholdPct,
        stalledHoursThreshold: updated.stalledHoursThreshold,
        advanceSettlementDueDays: updated.advanceSettlementDueDays,
        excessToleranceUsd: toMoney(updated.excessToleranceUsd),
        excessMediumMaxUsd: toMoney(updated.excessMediumMaxUsd),
      };
    },
    {
      body: t.Object({
        budgetAlertThresholdPct: t.Number({ minimum: 50, maximum: 100 }),
        stalledHoursThreshold: t.Number({ minimum: 1, maximum: 240 }),
        advanceSettlementDueDays: t.Number({ minimum: 1, maximum: 90 }),
        excessToleranceUsd: t.Number({ minimum: 0 }),
        excessMediumMaxUsd: t.Number({ minimum: 0 }),
      }),
    }
  );
