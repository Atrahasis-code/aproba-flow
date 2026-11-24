import { Elysia, t } from 'elysia';
import { hasAnyRole } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';
import { createNotification } from '../services/notification.service';

export const delegationsModule = new Elysia({ prefix: '/delegations' })
  .use(authPlugin)
  .get('/', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    const isAdminOrExec = hasAnyRole(user, ['ADMIN', 'DIRECTION', 'FINANCE']);

    const list = await prisma.approvalDelegation.findMany({
      where: isAdminOrExec
        ? {}
        : {
            OR: [{ delegatorId: user.id }, { delegateId: user.id }],
          },
      include: {
        delegator: { select: { id: true, fullName: true, email: true, jobTitle: true } },
        delegate: { select: { id: true, fullName: true, email: true, jobTitle: true } },
        createdBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return list.map((d) => ({
      ...d,
      startDate: d.startDate.toISOString(),
      endDate: d.endDate.toISOString(),
      createdAt: d.createdAt.toISOString(),
    }));
  })
  .post(
    '/',
    async ({ currentUser, body, clientIp, userAgent }) => {
      const actor = requireAuth(currentUser);
      const isAdmin = hasAnyRole(actor, ['ADMIN', 'DIRECTION']);
      const delegatorId = isAdmin && body.delegatorId ? body.delegatorId : actor.id;

      if (delegatorId === body.delegateId) {
        throw new DomainError('El titular y el suplente no pueden ser la misma persona.', 400);
      }

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        throw new DomainError('El rango de fechas de suplencia es inválido.', 400);
      }

      const [delegator, delegate] = await Promise.all([
        prisma.user.findUnique({ where: { id: delegatorId } }),
        prisma.user.findUnique({ where: { id: body.delegateId } }),
      ]);
      if (!delegator || !delegate || !delegate.isActive) {
        throw new DomainError('Usuario titular o suplente inválido.', 404);
      }

      const created = await prisma.$transaction(async (tx) => {
        const del = await tx.approvalDelegation.create({
          data: {
            delegatorId,
            delegateId: body.delegateId,
            startDate: start,
            endDate: end,
            reason: body.reason.trim(),
            isActive: true,
            createdById: actor.id,
          },
          include: {
            delegator: { select: { id: true, fullName: true, email: true, jobTitle: true } },
            delegate: { select: { id: true, fullName: true, email: true, jobTitle: true } },
          },
        });

        // Also update currently PENDING steps assigned to delegator if delegation is currently active
        const now = new Date();
        if (start <= now && end >= now) {
          await tx.approvalStep.updateMany({
            where: { assignedApproverId: delegatorId, status: 'PENDING' },
            data: { delegatedToUserId: body.delegateId, delegationId: del.id },
          });
        }

        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'DELEGATION',
          entityId: del.id,
          action: 'CREATE_DELEGATION',
          summary: `Delegación temporal creada: ${delegator.fullName} -> ${delegate.fullName} (${body.reason.trim()})`,
          newState: {
            delegatorId,
            delegateId: body.delegateId,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            reason: body.reason.trim(),
          },
          ipAddress: clientIp,
          userAgent,
        });

        return del;
      });

      await createNotification({
        userId: delegate.id,
        userEmail: delegate.email,
        userName: delegate.fullName,
        type: 'DELEGATION_ASSIGNED',
        title: `Asignado como suplente de ${delegator.fullName}`,
        message: `Cubrirás sus aprobaciones del ${start.toLocaleDateString('es-ES')} al ${end.toLocaleDateString('es-ES')} — Motivo: ${body.reason.trim()}.`,
        linkUrl: '/aprobaciones',
      });

      return {
        ...created,
        startDate: created.startDate.toISOString(),
        endDate: created.endDate.toISOString(),
        createdAt: created.createdAt.toISOString(),
      };
    },
    {
      body: t.Object({
        delegatorId: t.Optional(t.String()),
        delegateId: t.String({ minLength: 1 }),
        startDate: t.String({ minLength: 4 }),
        endDate: t.String({ minLength: 4 }),
        reason: t.String({ minLength: 3 }),
      }),
    }
  )
  .patch(
    '/:id',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const actor = requireAuth(currentUser);
      const existing = await prisma.approvalDelegation.findUnique({ where: { id: params.id } });
      if (!existing) throw new DomainError('Delegación no encontrada.', 404);

      const isAdmin = hasAnyRole(actor, ['ADMIN', 'DIRECTION']);
      if (!isAdmin && existing.delegatorId !== actor.id) {
        throw new DomainError('No tienes permiso para modificar esta suplencia.', 403);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const del = await tx.approvalDelegation.update({
          where: { id: params.id },
          data: { isActive: body.isActive },
        });
        if (!body.isActive) {
          await tx.approvalStep.updateMany({
            where: { delegationId: del.id, status: 'PENDING' },
            data: { delegatedToUserId: null, delegationId: null },
          });
        }
        await recordAudit(tx, {
          actorUserId: actor.id,
          actorName: actor.fullName,
          actorRole: actor.roles.join(','),
          entityType: 'DELEGATION',
          entityId: del.id,
          action: body.isActive ? 'ACTIVATE_DELEGATION' : 'DEACTIVATE_DELEGATION',
          summary: `Suplencia ${body.isActive ? 'reactivada' : 'desactivada'} por ${actor.fullName}`,
          ipAddress: clientIp,
          userAgent,
        });
        return del;
      });

      return {
        ...updated,
        startDate: updated.startDate.toISOString(),
        endDate: updated.endDate.toISOString(),
      };
    },
    {
      body: t.Object({
        isActive: t.Boolean(),
      }),
    }
  );
