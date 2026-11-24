import { Elysia, t } from 'elysia';
import type { UserRole } from '../generated/prisma';
import { hasAnyRole, hashPassword } from '../lib/auth';
import { toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';

export const catalogsModule = new Elysia({ prefix: '/catalogs' })
  .use(authPlugin)
  .get('/bootstrap', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    const isPrivileged = hasAnyRole(user, ['ADMIN', 'FINANCE']);

    const [branches, departments, projects, categories, sysConfig, users] = await Promise.all([
      prisma.branch.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.department.findMany({
        where: isPrivileged ? { isActive: true } : { id: user.departmentId, isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.project.findMany({
        where: isPrivileged
          ? { status: 'ACTIVE' }
          : {
              status: 'ACTIVE',
              assignments: { some: { userId: user.id, isActive: true } },
            },
        include: { manager: { select: { id: true, fullName: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.category.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } }),
      prisma.systemConfig.findUnique({ where: { id: 'singleton' } }),
      prisma.user.findMany({
        where: { isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          employeeCode: true,
          jobTitle: true,
          roles: true,
          departmentId: true,
          branchId: true,
        },
        orderBy: { fullName: 'asc' },
      }),
    ]);

    return {
      branches,
      departments,
      projects: projects.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        clientName: p.clientName,
        managerId: p.managerId,
        managerName: p.manager.fullName,
        totalBudget: toMoney(p.totalBudget),
        status: p.status,
      })),
      categories,
      systemConfig: sysConfig
        ? {
            budgetAlertThresholdPct: sysConfig.budgetAlertThresholdPct,
            stalledHoursThreshold: sysConfig.stalledHoursThreshold,
            advanceSettlementDueDays: sysConfig.advanceSettlementDueDays,
            excessToleranceUsd: toMoney(sysConfig.excessToleranceUsd),
            excessMediumMaxUsd: toMoney(sysConfig.excessMediumMaxUsd),
          }
        : null,
      users,
    };
  })
  .get('/categories', async ({ currentUser }) => {
    requireAuth(currentUser);
    return prisma.category.findMany({ orderBy: { code: 'asc' } });
  })
  .post(
    '/categories',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN', 'FINANCE']);
      const created = await prisma.$transaction(async (tx) => {
        const cat = await tx.category.create({
          data: {
            code: body.code.trim().toUpperCase(),
            name: body.name.trim(),
            accountCode: body.accountCode.trim(),
            specialTag: body.specialTag?.trim() || null,
            requiresReceipt: body.requiresReceipt ?? true,
            isActive: true,
          },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'CATEGORY',
          entityId: cat.id,
          action: 'CREATE_CATEGORY',
          summary: `Categoría contable ${cat.code} (${cat.name}) creada por ${actor.fullName}`,
          newState: cat,
          ipAddress: clientIp,
          userAgent,
        });
        return cat;
      });
      return created;
    },
    {
      body: t.Object({
        code: t.String({ minLength: 2 }),
        name: t.String({ minLength: 2 }),
        accountCode: t.String({ minLength: 2 }),
        specialTag: t.Optional(t.Nullable(t.String())),
        requiresReceipt: t.Optional(t.Boolean()),
      }),
    }
  )
  .patch(
    '/categories/:id',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN', 'FINANCE']);
      const prev = await prisma.category.findUnique({ where: { id: params.id } });
      if (!prev) throw new DomainError('Categoría no encontrada.', 404);

      const nextCode = body.code !== undefined ? body.code.trim().toUpperCase() : undefined;
      if (nextCode && nextCode !== prev.code) {
        const dup = await prisma.category.findFirst({
          where: { code: nextCode, id: { not: params.id } },
        });
        if (dup) {
          throw new DomainError('Ya existe otra categoría con ese código.', 409);
        }
      }

      return prisma.$transaction(async (tx) => {
        const updated = await tx.category.update({
          where: { id: params.id },
          data: {
            ...(nextCode !== undefined ? { code: nextCode } : {}),
            ...(body.name !== undefined ? { name: body.name.trim() } : {}),
            ...(body.accountCode !== undefined ? { accountCode: body.accountCode.trim() } : {}),
            ...(body.specialTag !== undefined ? { specialTag: body.specialTag?.trim() || null } : {}),
            ...(body.requiresReceipt !== undefined ? { requiresReceipt: body.requiresReceipt } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'CATEGORY',
          entityId: updated.id,
          action: 'UPDATE_CATEGORY',
          summary: `Categoría contable ${updated.code} (${updated.name}) actualizada por ${actor.fullName}`,
          previousState: prev,
          newState: updated,
          ipAddress: clientIp,
          userAgent,
        });
        return updated;
      });
    },
    {
      body: t.Object({
        code: t.Optional(t.String({ minLength: 2 })),
        name: t.Optional(t.String({ minLength: 2 })),
        accountCode: t.Optional(t.String({ minLength: 2 })),
        specialTag: t.Optional(t.Nullable(t.String())),
        requiresReceipt: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete('/categories/:id', async ({ currentUser, params, clientIp, userAgent }) => {
    const actor = requireRoles(currentUser, ['ADMIN']);
    const prev = await prisma.category.findUnique({ where: { id: params.id } });
    if (!prev) throw new DomainError('Categoría no encontrada.', 404);

    const usedCount = await prisma.expenseItem.count({ where: { categoryId: params.id } });
    if (usedCount > 0) {
      throw new DomainError(
        'No se puede eliminar la categoría porque tiene gastos registrados. Puedes desactivarla para mantener la integridad contable.',
        409,
        'CATEGORY_IN_USE'
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.category.delete({ where: { id: params.id } });
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorName: actor.fullName,
        actorRole: actor.roles.join(','),
        entityType: 'CATEGORY',
        entityId: params.id,
        action: 'DELETE_CATEGORY',
        summary: `Categoría contable ${prev.code} (${prev.name}) eliminada por ${actor.fullName}`,
        previousState: prev,
        ipAddress: clientIp,
        userAgent,
      });
    });

    return { ok: true };
  })
  .get('/users', async ({ currentUser }) => {
    requireRoles(currentUser, ['ADMIN', 'FINANCE', 'DIRECTION']);
    const users = await prisma.user.findMany({
      include: {
        branch: { select: { id: true, code: true, name: true } },
        department: { select: { id: true, code: true, name: true } },
        manager: { select: { id: true, fullName: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      employeeCode: u.employeeCode,
      jobTitle: u.jobTitle,
      branchId: u.branchId,
      branch: u.branch,
      departmentId: u.departmentId,
      department: u.department,
      managerId: u.managerId,
      manager: u.manager,
      roles: u.roles,
      bankName: u.bankName,
      bankAccountNumber: u.bankAccountNumber,
      isActive: u.isActive,
    }));
  })
  .post(
    '/users',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN']);
      const email = body.email.trim().toLowerCase();
      const existing = await prisma.user.findFirst({
        where: { OR: [{ email }, { employeeCode: body.employeeCode.trim() }] },
      });
      if (existing) {
        throw new DomainError('Ya existe un usuario con ese correo o código de empleado.', 409);
      }

      const passwordHash = await hashPassword(body.password || 'Demo1234!');
      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email,
            passwordHash,
            fullName: body.fullName.trim(),
            employeeCode: body.employeeCode.trim().toUpperCase(),
            jobTitle: body.jobTitle.trim(),
            branchId: body.branchId,
            departmentId: body.departmentId,
            managerId: body.managerId || null,
            roles: body.roles as UserRole[],
            bankName: body.bankName?.trim() || null,
            bankAccountNumber: body.bankAccountNumber?.trim() || null,
          },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'USER',
          entityId: u.id,
          action: 'CREATE_USER',
          summary: `Usuario ${u.fullName} (${u.email}) creado por ${actor.fullName}`,
          newState: { email: u.email, roles: u.roles, departmentId: u.departmentId },
          ipAddress: clientIp,
          userAgent,
        });
        return u;
      });
      return { id: created.id, email: created.email, fullName: created.fullName };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        password: t.Optional(t.String()),
        fullName: t.String({ minLength: 2 }),
        employeeCode: t.String({ minLength: 2 }),
        jobTitle: t.String({ minLength: 2 }),
        branchId: t.String(),
        departmentId: t.String(),
        managerId: t.Optional(t.Nullable(t.String())),
        roles: t.Array(t.String(), { minItems: 1 }),
        bankName: t.Optional(t.Nullable(t.String())),
        bankAccountNumber: t.Optional(t.Nullable(t.String())),
      }),
    }
  )
  .patch(
    '/users/:id',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const actor = requireRoles(currentUser, ['ADMIN']);
      const prev = await prisma.user.findUnique({ where: { id: params.id } });
      if (!prev) throw new DomainError('Usuario no encontrado.', 404);

      const nextEmail = body.email !== undefined ? body.email.trim().toLowerCase() : undefined;
      const nextEmployeeCode =
        body.employeeCode !== undefined ? body.employeeCode.trim().toUpperCase() : undefined;

      if (nextEmail && nextEmail !== prev.email) {
        const dupEmail = await prisma.user.findFirst({
          where: { email: nextEmail, id: { not: params.id } },
        });
        if (dupEmail) {
          throw new DomainError('Ya existe otro usuario con ese correo.', 409);
        }
      }
      if (nextEmployeeCode && nextEmployeeCode !== prev.employeeCode) {
        const dupCode = await prisma.user.findFirst({
          where: { employeeCode: nextEmployeeCode, id: { not: params.id } },
        });
        if (dupCode) {
          throw new DomainError('Ya existe otro usuario con ese código de empleado.', 409);
        }
      }

      let nextPasswordHash: string | undefined;
      if (body.password && body.password.trim().length > 0) {
        if (body.password.trim().length < 6) {
          throw new DomainError('La contraseña debe tener al menos 6 caracteres.', 400);
        }
        nextPasswordHash = await hashPassword(body.password.trim());
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: params.id },
          data: {
            ...(nextEmail !== undefined ? { email: nextEmail } : {}),
            ...(nextEmployeeCode !== undefined ? { employeeCode: nextEmployeeCode } : {}),
            ...(nextPasswordHash !== undefined ? { passwordHash: nextPasswordHash } : {}),
            ...(body.fullName !== undefined ? { fullName: body.fullName.trim() } : {}),
            ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle.trim() } : {}),
            ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
            ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
            ...(body.managerId !== undefined ? { managerId: body.managerId || null } : {}),
            ...(body.roles !== undefined ? { roles: body.roles as UserRole[] } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            ...(body.bankName !== undefined ? { bankName: body.bankName || null } : {}),
            ...(body.bankAccountNumber !== undefined
              ? { bankAccountNumber: body.bankAccountNumber || null }
              : {}),
          },
        });
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'USER',
          entityId: u.id,
          action: 'UPDATE_USER',
          summary: `Usuario ${u.fullName} actualizado por ${actor.fullName}`,
          previousState: {
            email: prev.email,
            employeeCode: prev.employeeCode,
            roles: prev.roles,
            isActive: prev.isActive,
            managerId: prev.managerId,
          },
          newState: {
            email: u.email,
            employeeCode: u.employeeCode,
            roles: u.roles,
            isActive: u.isActive,
            managerId: u.managerId,
          },
          ipAddress: clientIp,
          userAgent,
        });
        return u;
      });
      return { id: updated.id, email: updated.email, roles: updated.roles, isActive: updated.isActive };
    },
    {
      body: t.Object({
        email: t.Optional(t.String({ minLength: 3 })),
        employeeCode: t.Optional(t.String({ minLength: 2 })),
        password: t.Optional(t.String()),
        fullName: t.Optional(t.String({ minLength: 2 })),
        jobTitle: t.Optional(t.String({ minLength: 2 })),
        branchId: t.Optional(t.String()),
        departmentId: t.Optional(t.String()),
        managerId: t.Optional(t.Nullable(t.String())),
        roles: t.Optional(t.Array(t.String(), { minItems: 1 })),
        isActive: t.Optional(t.Boolean()),
        bankName: t.Optional(t.Nullable(t.String())),
        bankAccountNumber: t.Optional(t.Nullable(t.String())),
      }),
    }
  )
  .delete('/users/:id', async ({ currentUser, params, clientIp, userAgent }) => {
    const actor = requireRoles(currentUser, ['ADMIN']);
    if (params.id === actor.id) {
      throw new DomainError('No puedes eliminar tu propio usuario administrador.', 400, 'CANNOT_DELETE_SELF');
    }

    const prev = await prisma.user.findUnique({ where: { id: params.id } });
    if (!prev) throw new DomainError('Usuario no encontrado.', 404);

    const [
      reqCount,
      overrideCount,
      returnConfirmCount,
      itemAuditCount,
      managedProjectsCount,
      headedDeptCount,
      subordinatesCount,
      stepCount,
      delegationCount,
      fileCount,
      auditCount,
    ] = await Promise.all([
      prisma.expenseRequest.count({ where: { requesterId: params.id } }),
      prisma.expenseRequest.count({ where: { budgetOverrideApprovedById: params.id } }),
      prisma.expenseRequest.count({ where: { returnConfirmedById: params.id } }),
      prisma.expenseItem.count({ where: { auditedById: params.id } }),
      prisma.project.count({ where: { managerId: params.id } }),
      prisma.department.count({ where: { headUserId: params.id } }),
      prisma.user.count({ where: { managerId: params.id } }),
      prisma.approvalStep.count({
        where: {
          OR: [
            { assignedApproverId: params.id },
            { delegatedToUserId: params.id },
            { actedByUserId: params.id },
          ],
        },
      }),
      prisma.approvalDelegation.count({
        where: {
          OR: [
            { delegatorId: params.id },
            { delegateId: params.id },
            { createdById: params.id },
          ],
        },
      }),
      prisma.storedFile.count({ where: { uploadedById: params.id } }),
      prisma.auditLog.count({
        where: { OR: [{ actorUserId: params.id }, { onBehalfOfUserId: params.id }] },
      }),
    ]);

    const blockingTotal =
      reqCount +
      overrideCount +
      returnConfirmCount +
      itemAuditCount +
      managedProjectsCount +
      headedDeptCount +
      subordinatesCount +
      stepCount +
      delegationCount +
      fileCount +
      auditCount;

    if (blockingTotal > 0) {
      throw new DomainError(
        'Este usuario tiene historial financiero, jerárquico o de auditoría registrado y no puede eliminarse físicamente. Desactívalo para revocar su acceso preservando la trazabilidad.',
        409,
        'USER_HAS_HISTORY'
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.projectAssignment.deleteMany({ where: { userId: params.id } });
      await tx.notification.deleteMany({ where: { userId: params.id } });
      await tx.user.delete({ where: { id: params.id } });
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorName: actor.fullName,
        actorRole: actor.roles.join(','),
        entityType: 'USER',
        entityId: params.id,
        action: 'DELETE_USER',
        summary: `Usuario ${prev.fullName} (${prev.email}) eliminado por ${actor.fullName}`,
        previousState: { email: prev.email, employeeCode: prev.employeeCode, roles: prev.roles },
        ipAddress: clientIp,
        userAgent,
      });
    });

    return { ok: true };
  });
