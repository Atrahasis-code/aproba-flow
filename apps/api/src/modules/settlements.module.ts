import { Elysia, t } from 'elysia';
import { sumMoney, toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { EXPENSE_DETAIL_INCLUDE } from '../modules/expenses.module';
import { authPlugin, requireAuth, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';
import { serializeExpenseRequest } from '../services/expense-serializers';
import { createNotification, notifyRoleUsers } from '../services/notification.service';
import {
  finalizeAdvanceSettlement,
  hasDuplicateInvoice,
  validateItemAuditDecision,
} from '../services/settlement-engine';

export const settlementsModule = new Elysia({ prefix: '/settlements' })
  .use(authPlugin)
  .post(
    '/:expenseId/submit',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Anticipo no encontrado.', 404);
        if (req.type !== 'ADVANCE') {
          throw new DomainError('Solo los anticipos requieren rendición de gastos.', 400);
        }
        if (req.requesterId !== user.id) {
          throw new DomainError('Solo el titular del anticipo puede presentar la rendición.', 403);
        }
        if (req.status !== 'DISBURSED_PENDING_SETTLEMENT') {
          throw new DomainError('Este anticipo no está en estado Desembolsado / Por Rendir.', 409);
        }
        if (!body.items || body.items.length === 0) {
          throw new DomainError('Debes cargar al menos un comprobante en tu rendición.', 400);
        }

        const categoryIds = Array.from(new Set(body.items.map((i) => i.categoryId)));
        const categories = await tx.category.findMany({
          where: { id: { in: categoryIds }, isActive: true },
        });
        if (categories.length !== categoryIds.length) {
          throw new DomainError('Categoría contable inválida.', 400);
        }
        const catMap = new Map(categories.map((c) => [c.id, c]));
        for (const it of body.items) {
          const cat = catMap.get(it.categoryId);
          if (cat?.requiresReceipt && !it.receiptFileId) {
            throw new DomainError(
              `La categoría "${cat.name}" requiere adjuntar el comprobante.`,
              400,
              'RECEIPT_REQUIRED'
            );
          }
        }

        const dupFlags = await Promise.all(
          body.items.map((it) =>
            hasDuplicateInvoice(tx, { vendorTaxId: it.vendorTaxId, invoiceNumber: it.invoiceNumber })
          )
        );
        const renderedAmount = sumMoney(body.items.map((i) => i.claimedAmount));

        await tx.expenseItem.deleteMany({ where: { expenseRequestId: req.id } });
        await tx.expenseItem.createMany({
          data: body.items.map((it, idx) => ({
            expenseRequestId: req.id,
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

        const updatedReq = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            renderedAmount,
            status: 'SETTLEMENT_IN_REVIEW',
            currentStepEnteredAt: now,
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: 'EMPLOYEE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'SUBMIT_SETTLEMENT',
          summary: `Rendición de ${req.code} enviada por ${user.fullName} (${body.items.length} ítems, total $${renderedAmount.toFixed(2)})`,
          previousState: { status: req.status },
          newState: { status: 'SETTLEMENT_IN_REVIEW', renderedAmount, itemsCount: body.items.length },
          ipAddress: clientIp,
          userAgent,
        });

        return updatedReq;
      });

      await notifyRoleUsers(['FINANCE'], {
        type: 'APPROVAL_REQUIRED',
        title: `Rendición lista para auditar: ${updated.code}`,
        message: `${user.fullName} rindió $${toMoney(updated.renderedAmount).toFixed(2)} contra anticipo de $${toMoney(updated.disbursedAmount).toFixed(2)}.`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            categoryId: t.String({ minLength: 1 }),
            expenseDate: t.String({ minLength: 4 }),
            vendorName: t.String({ minLength: 2 }),
            vendorTaxId: t.String({ minLength: 2 }),
            invoiceNumber: t.String({ minLength: 1 }),
            description: t.String({ minLength: 2 }),
            claimedAmount: t.Number({ exclusiveMinimum: 0 }),
            receiptFileId: t.Optional(t.Nullable(t.String())),
          }),
          { minItems: 1 }
        ),
      }),
    }
  )
  .patch(
    '/:expenseId/resubmit-observed',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({
          where: { id: params.expenseId },
          include: { items: true },
        });
        if (!req) throw new DomainError('Solicitud no encontrada.', 404);
        if (req.requesterId !== user.id) {
          throw new DomainError('Solo el titular puede subsanar ítems observados.', 403);
        }
        if (req.status !== 'SETTLEMENT_OBSERVED') {
          throw new DomainError('La rendición no se encuentra en estado Observada.', 409);
        }

        const itemMap = new Map(req.items.map((it) => [it.id, it]));
        for (const patch of body.items) {
          const target = itemMap.get(patch.itemId);
          if (!target) {
            throw new DomainError(`Ítem ${patch.itemId} no pertenece a esta rendición.`, 404);
          }
          if (target.auditStatus !== 'OBSERVED') {
            throw new DomainError(
              'Regla de política: solo puedes corregir ítems en estado Observado. Los ítems rechazados quedan firmes.',
              403,
              'ITEM_NOT_OBSERVED'
            );
          }

          const dup = await hasDuplicateInvoice(tx, {
            vendorTaxId: patch.vendorTaxId ?? target.vendorTaxId,
            invoiceNumber: patch.invoiceNumber ?? target.invoiceNumber,
            excludeItemId: target.id,
          });

          await tx.expenseItem.update({
            where: { id: target.id },
            data: {
              ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
              ...(patch.expenseDate !== undefined ? { expenseDate: new Date(patch.expenseDate) } : {}),
              ...(patch.vendorName !== undefined ? { vendorName: patch.vendorName.trim() } : {}),
              ...(patch.vendorTaxId !== undefined ? { vendorTaxId: patch.vendorTaxId.trim() } : {}),
              ...(patch.invoiceNumber !== undefined ? { invoiceNumber: patch.invoiceNumber.trim() } : {}),
              ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
              ...(patch.claimedAmount !== undefined ? { claimedAmount: patch.claimedAmount } : {}),
              ...(patch.receiptFileId !== undefined ? { receiptFileId: patch.receiptFileId } : {}),
              duplicateWarning: dup,
              auditStatus: 'PENDING',
              approvedAmount: null,
              auditNote: null,
              auditedById: null,
              auditedAt: null,
            },
          });
        }

        const allItems = await tx.expenseItem.findMany({ where: { expenseRequestId: req.id } });
        const remainingObserved = allItems.filter((i) => i.auditStatus === 'OBSERVED');
        if (remainingObserved.length > 0) {
          throw new DomainError(
            `Debes corregir los ${remainingObserved.length} ítem(s) observados antes de reenviar.`,
            400
          );
        }

        const renderedAmount = sumMoney(allItems.map((i) => i.claimedAmount));
        const reqUpdated = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            renderedAmount,
            status: 'SETTLEMENT_IN_REVIEW',
            currentStepEnteredAt: now,
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: 'EMPLOYEE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'RESUBMIT_OBSERVED_SETTLEMENT',
          summary: `${user.fullName} subsanó los ítems observados en ${req.code} y reenvió a Finanzas`,
          previousState: { status: 'SETTLEMENT_OBSERVED' },
          newState: { status: 'SETTLEMENT_IN_REVIEW', renderedAmount },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      await notifyRoleUsers(['FINANCE'], {
        type: 'APPROVAL_REQUIRED',
        title: `Rendición subsanada: ${updated.code}`,
        message: `${user.fullName} re-subió las correcciones solicitadas.`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            itemId: t.String({ minLength: 1 }),
            categoryId: t.Optional(t.String()),
            expenseDate: t.Optional(t.String()),
            vendorName: t.Optional(t.String()),
            vendorTaxId: t.Optional(t.String()),
            invoiceNumber: t.Optional(t.String()),
            description: t.Optional(t.String()),
            claimedAmount: t.Optional(t.Number({ exclusiveMinimum: 0 })),
            receiptFileId: t.Optional(t.Nullable(t.String())),
          }),
          { minItems: 1 }
        ),
      }),
    }
  )
  .patch(
    '/:expenseId/items/:itemId/audit',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const financeUser = requireRoles(currentUser, ['FINANCE']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Solicitud no encontrada.', 404);
        if (req.requesterId === financeUser.id) {
          throw new DomainError('No puedes auditar tus propios comprobantes.', 403);
        }
        const canAudit =
          req.status === 'SETTLEMENT_IN_REVIEW' ||
          (req.type === 'REIMBURSEMENT' && req.status === 'PENDING_APPROVAL');
        if (!canAudit) {
          throw new DomainError('La solicitud no está en fase de auditoría de ítems.', 409);
        }

        const item = await tx.expenseItem.findUnique({ where: { id: params.itemId } });
        if (!item || item.expenseRequestId !== req.id) {
          throw new DomainError('Ítem no encontrado en esta solicitud.', 404);
        }

        const decision = validateItemAuditDecision(toMoney(item.claimedAmount), {
          auditStatus: body.auditStatus,
          approvedAmount: body.approvedAmount,
          auditNote: body.auditNote,
        });

        await tx.expenseItem.update({
          where: { id: item.id },
          data: {
            auditStatus: body.auditStatus,
            approvedAmount: decision.approvedAmount,
            auditNote: decision.auditNote,
            auditedById: financeUser.id,
            auditedAt: now,
          },
        });

        await recordAudit(tx, {
          actorUserId: financeUser.id,
          actorName: financeUser.fullName,
          actorRole: 'FINANCE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'AUDIT_ITEM',
          summary: `Ítem "${item.vendorName} (${item.invoiceNumber})" auditado como ${body.auditStatus} por ${financeUser.fullName}${decision.approvedAmount !== null ? ` ($${decision.approvedAmount.toFixed(2)})` : ''}${decision.auditNote ? ` — ${decision.auditNote}` : ''}`,
          previousState: { auditStatus: item.auditStatus, approvedAmount: item.approvedAmount ? toMoney(item.approvedAmount) : null },
          newState: { auditStatus: body.auditStatus, approvedAmount: decision.approvedAmount, auditNote: decision.auditNote },
          ipAddress: clientIp,
          userAgent,
        });

        return tx.expenseRequest.findUniqueOrThrow({
          where: { id: req.id },
          include: EXPENSE_DETAIL_INCLUDE,
        });
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        auditStatus: t.Union([
          t.Literal('APPROVED'),
          t.Literal('PARTIALLY_APPROVED'),
          t.Literal('REJECTED'),
          t.Literal('OBSERVED'),
        ]),
        approvedAmount: t.Optional(t.Number({ minimum: 0 })),
        auditNote: t.Optional(t.String()),
      }),
    }
  )
  .post('/:expenseId/finalize-audit', async ({ currentUser, params, clientIp, userAgent }) => {
    const financeUser = requireRoles(currentUser, ['FINANCE']);

    const txResult = await prisma.$transaction(async (tx) => {
      const reqCheck = await tx.expenseRequest.findUnique({
        where: { id: params.expenseId },
        select: { requesterId: true, code: true },
      });
      if (!reqCheck) throw new DomainError('Solicitud no encontrada.', 404);
      if (reqCheck.requesterId === financeUser.id) {
        throw new DomainError('No puedes liquidar tu propia rendición.', 403);
      }

      const outcomeRes = await finalizeAdvanceSettlement(tx, params.expenseId);

      await recordAudit(tx, {
        actorUserId: financeUser.id,
        actorName: financeUser.fullName,
        actorRole: 'FINANCE',
        entityType: 'EXPENSE_REQUEST',
        entityId: params.expenseId,
        action: 'FINALIZE_SETTLEMENT_AUDIT',
        summary: `Finanzas (${financeUser.fullName}) finalizó revisión de ${outcomeRes.request.code} -> Resultado: ${outcomeRes.outcome} (Validado: $${outcomeRes.approvedTotal.toFixed(2)}, Neto: $${outcomeRes.diff.toFixed(2)})`,
        newState: {
          outcome: outcomeRes.outcome,
          status: outcomeRes.request.status,
          approvedTotal: outcomeRes.approvedTotal,
          netSettlementAmount: outcomeRes.diff,
        },
        ipAddress: clientIp,
        userAgent,
      });

      const full = await tx.expenseRequest.findUniqueOrThrow({
        where: { id: params.expenseId },
        include: EXPENSE_DETAIL_INCLUDE,
      });

      return { outcomeRes, full };
    });

    const { outcomeRes, full } = txResult;
    if (outcomeRes.outcome === 'OBSERVED') {
      await createNotification({
        userId: full.requesterId,
        userEmail: full.requester.email,
        userName: full.requester.fullName,
        type: 'OBSERVED',
        title: `Rendición ${full.code} observada`,
        message: 'Finanzas observó uno o más comprobantes. Por favor corrige y re-sube el soporte.',
        linkUrl: `/solicitudes/${full.id}`,
      });
    } else if (outcomeRes.outcome === 'SCENARIO_A_EXACT') {
      await createNotification({
        userId: full.requesterId,
        userEmail: full.requester.email,
        userName: full.requester.fullName,
        type: 'APPROVED',
        title: `Rendición ${full.code} liquidada (Cuadre perfecto)`,
        message: `Tus gastos validados ($${outcomeRes.approvedTotal.toFixed(2)}) coinciden exactamente con el anticipo.`,
        linkUrl: `/solicitudes/${full.id}`,
      });
    } else if (outcomeRes.outcome === 'SCENARIO_B_RETURN') {
      const owe = Math.abs(outcomeRes.diff).toFixed(2);
      await createNotification({
        userId: full.requesterId,
        userEmail: full.requester.email,
        userName: full.requester.fullName,
        type: 'RETURN_REQUIRED',
        title: `Devolución requerida en ${full.code}: $${owe} USD`,
        message: `El monto validado fue menor al anticipo entregado. Transfiere $${owe} USD a la cuenta corporativa y sube el comprobante.`,
        linkUrl: `/solicitudes/${full.id}`,
      });
    } else if (outcomeRes.outcome === 'SCENARIO_C_DIRECT_PAY') {
      await createNotification({
        userId: full.requesterId,
        userEmail: full.requester.email,
        userName: full.requester.fullName,
        type: 'APPROVED',
        title: `Excedente aprobado en ${full.code}: +$${outcomeRes.diff.toFixed(2)} USD`,
        message: `Tu excedente dentro de tolerancia pasó a Tesorería para reembolso.`,
        linkUrl: `/solicitudes/${full.id}`,
      });
      await notifyRoleUsers(['TREASURY'], {
        type: 'APPROVED',
        title: `Reembolso de excedente listo para pagar: ${full.code}`,
        message: `Monto neto a reembolsar: $${outcomeRes.diff.toFixed(2)} USD a ${full.requester.fullName}.`,
        linkUrl: '/tesoreria',
      });
    } else if (outcomeRes.outcome === 'SCENARIO_C_EXCESS_APPROVAL') {
      const nextStep = full.approvalSteps.find(
        (s) => s.phase === 'EXCESS_SETTLEMENT' && s.status === 'PENDING'
      );
      if (nextStep) {
        const approverId = nextStep.delegatedToUserId || nextStep.assignedApproverId;
        if (approverId) {
          await createNotification({
            userId: approverId,
            type: 'APPROVAL_REQUIRED',
            title: `Aprobación de excedente en ${full.code}: +$${outcomeRes.diff.toFixed(2)} USD`,
            message: `${full.requester.fullName} gastó $${outcomeRes.diff.toFixed(2)} por encima del anticipo.`,
            linkUrl: `/solicitudes/${full.id}`,
          });
        }
      }
    }

    return {
      outcome: outcomeRes.outcome,
      request: serializeExpenseRequest(full),
    };
  })
  .post(
    '/:expenseId/return-deposit',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const user = requireAuth(currentUser);

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Solicitud no encontrada.', 404);
        if (req.requesterId !== user.id) {
          throw new DomainError('Solo el titular puede reportar el depósito de devolución.', 403);
        }
        if (req.status !== 'PENDING_RETURN') {
          throw new DomainError('La solicitud no está esperando devolución.', 409);
        }

        const reqUpdated = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            returnDepositRef: body.depositRef.trim(),
            returnDepositFileId: body.depositFileId,
            status: 'RETURN_SUBMITTED',
            currentStepEnteredAt: new Date(),
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: user.id,
          actorName: user.fullName,
          actorRole: 'EMPLOYEE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'SUBMIT_RETURN_DEPOSIT',
          summary: `${user.fullName} cargó comprobante de devolución bancaria Ref: ${body.depositRef.trim()} en ${req.code}`,
          previousState: { status: 'PENDING_RETURN' },
          newState: { status: 'RETURN_SUBMITTED', depositRef: body.depositRef.trim() },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      await notifyRoleUsers(['FINANCE'], {
        type: 'APPROVAL_REQUIRED',
        title: `Comprobante de devolución cargado: ${updated.code}`,
        message: `${user.fullName} reportó transferencia Ref. ${body.depositRef.trim()}. Confirmar recepción bancaria.`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        depositRef: t.String({ minLength: 2 }),
        depositFileId: t.String({ minLength: 1 }),
      }),
    }
  )
  .post(
    '/:expenseId/confirm-return',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const financeUser = requireRoles(currentUser, ['FINANCE']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Solicitud no encontrada.', 404);
        if (req.requesterId === financeUser.id) {
          throw new DomainError('No puedes confirmar tu propia devolución.', 403);
        }
        if (req.status !== 'RETURN_SUBMITTED') {
          throw new DomainError('No hay una devolución en verificación.', 409);
        }

        if (!body.accepted && (!body.note || body.note.trim().length < 3)) {
          throw new DomainError('Indica el motivo si rechazas/observas el comprobante de devolución.', 400);
        }

        const newStatus = body.accepted ? 'CLOSED_SETTLED' : 'PENDING_RETURN';
        const reqUpdated = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            status: newStatus,
            currentStepEnteredAt: null,
            ...(body.accepted
              ? { returnConfirmedById: financeUser.id, returnConfirmedAt: now }
              : {}),
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: financeUser.id,
          actorName: financeUser.fullName,
          actorRole: 'FINANCE',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: body.accepted ? 'CONFIRM_RETURN' : 'OBSERVE_RETURN',
          summary: body.accepted
            ? `Finanzas (${financeUser.fullName}) confirmó recepción bancaria y liquidó ${req.code}`
            : `Finanzas (${financeUser.fullName}) observó depósito de ${req.code}: ${body.note?.trim()}`,
          previousState: { status: 'RETURN_SUBMITTED' },
          newState: { status: newStatus, note: body.note ?? null },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      await createNotification({
        userId: updated.requesterId,
        userEmail: updated.requester.email,
        userName: updated.requester.fullName,
        type: body.accepted ? 'RETURN_CONFIRMED' : 'OBSERVED',
        title: body.accepted
          ? `Devolución confirmada: ${updated.code} liquidada`
          : `Comprobante de devolución observado en ${updated.code}`,
        message: body.accepted
          ? 'Tu saldo fue conciliado y tu cupo de nuevos anticipos quedó habilitado.'
          : body.note || 'Por favor verifica el comprobante de depósito.',
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        accepted: t.Boolean(),
        note: t.Optional(t.String()),
      }),
    }
  );
