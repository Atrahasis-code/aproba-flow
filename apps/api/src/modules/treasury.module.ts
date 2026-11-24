import { Elysia, t } from 'elysia';
import { toMoney } from '@aproba-flow/shared';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { EXPENSE_DETAIL_INCLUDE } from '../modules/expenses.module';
import { authPlugin, requireRoles } from '../plugins/auth.plugin';
import { recordAudit } from '../services/audit-logger';
import { serializeExpenseRequest } from '../services/expense-serializers';
import {
  buildTreasuryRows,
  generateTreasuryCsv,
  generateTreasuryExcelBuffer,
} from '../services/export.service';
import { createNotification } from '../services/notification.service';

export const treasuryModule = new Elysia({ prefix: '/treasury' })
  .use(authPlugin)
  .get('/queue', async ({ currentUser }) => {
    requireRoles(currentUser, ['TREASURY', 'FINANCE', 'DIRECTION', 'ADMIN']);

    const [disbursements, payments, completed] = await Promise.all([
      prisma.expenseRequest.findMany({
        where: { status: 'READY_FOR_DISBURSEMENT' },
        include: EXPENSE_DETAIL_INCLUDE,
        orderBy: { updatedAt: 'asc' },
      }),
      prisma.expenseRequest.findMany({
        where: { status: 'READY_FOR_PAYMENT' },
        include: EXPENSE_DETAIL_INCLUDE,
        orderBy: { updatedAt: 'asc' },
      }),
      prisma.expenseRequest.findMany({
        where: { status: { in: ['CLOSED_SETTLED', 'PENDING_RETURN', 'RETURN_SUBMITTED'] } },
        include: EXPENSE_DETAIL_INCLUDE,
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      disbursements: disbursements.map((r) => serializeExpenseRequest(r)),
      payments: payments.map((r) => serializeExpenseRequest(r)),
      completed: completed.map((r) => serializeExpenseRequest(r)),
    };
  })
  .post(
    '/:expenseId/disburse',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const treasuryUser = requireRoles(currentUser, ['TREASURY', 'FINANCE', 'ADMIN']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Anticipo no encontrado.', 404);
        if (req.type !== 'ADVANCE' || req.status !== 'READY_FOR_DISBURSEMENT') {
          throw new DomainError('Este registro no está en bandeja Listo para Desembolsar.', 409);
        }

        const sysConfig = await tx.systemConfig.findUnique({ where: { id: 'singleton' } });
        const dueDays = sysConfig?.advanceSettlementDueDays ?? 15;
        const settlementDueDate = new Date(now.getTime() + dueDays * 24 * 60 * 60 * 1000);
        const disbursedAmount = toMoney(req.requestedAmount);

        const reqUpdated = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            disbursedAmount,
            disbursedAt: now,
            disbursementRef: body.disbursementRef.trim(),
            settlementDueDate,
            status: 'DISBURSED_PENDING_SETTLEMENT',
            currentStepEnteredAt: now,
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: treasuryUser.id,
          actorName: treasuryUser.fullName,
          actorRole: 'TREASURY',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'DISBURSE_ADVANCE',
          summary: `Tesorería (${treasuryUser.fullName}) desembolsó $${disbursedAmount.toFixed(2)} de ${req.code} — Ref: ${body.disbursementRef.trim()}`,
          previousState: { status: 'READY_FOR_DISBURSEMENT' },
          newState: {
            status: 'DISBURSED_PENDING_SETTLEMENT',
            disbursedAmount,
            disbursementRef: body.disbursementRef.trim(),
            settlementDueDate: settlementDueDate.toISOString(),
          },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      await createNotification({
        userId: updated.requesterId,
        userEmail: updated.requester.email,
        userName: updated.requester.fullName,
        type: 'DISBURSED',
        title: `Anticipo ${updated.code} desembolsado ($${toMoney(updated.disbursedAmount).toFixed(2)})`,
        message: `Ref. bancaria: ${body.disbursementRef.trim()}. Recuerda rendir comprobantes antes del ${updated.settlementDueDate?.toLocaleDateString('es-ES')}.`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        disbursementRef: t.String({ minLength: 2 }),
      }),
    }
  )
  .post(
    '/:expenseId/pay',
    async ({ currentUser, params, body, clientIp, userAgent }) => {
      const treasuryUser = requireRoles(currentUser, ['TREASURY', 'FINANCE', 'ADMIN']);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const req = await tx.expenseRequest.findUnique({ where: { id: params.expenseId } });
        if (!req) throw new DomainError('Solicitud no encontrada.', 404);
        if (req.status !== 'READY_FOR_PAYMENT') {
          throw new DomainError('La solicitud no está en estado Lista para Pagar.', 409);
        }

        const amountPaid =
          req.type === 'REIMBURSEMENT'
            ? toMoney(req.approvedAmount) > 0
              ? toMoney(req.approvedAmount)
              : toMoney(req.requestedAmount)
            : toMoney(req.netSettlementAmount);

        const reqUpdated = await tx.expenseRequest.update({
          where: { id: req.id },
          data: {
            status: 'CLOSED_SETTLED',
            paymentExecutedAt: now,
            paymentRef: body.paymentRef.trim(),
            paymentNotes: body.paymentNotes?.trim() || null,
            currentStepEnteredAt: null,
          },
          include: EXPENSE_DETAIL_INCLUDE,
        });

        await recordAudit(tx, {
          actorUserId: treasuryUser.id,
          actorName: treasuryUser.fullName,
          actorRole: 'TREASURY',
          entityType: 'EXPENSE_REQUEST',
          entityId: req.id,
          action: 'EXECUTE_PAYMENT',
          summary: `Tesorería (${treasuryUser.fullName}) liquidó pago de $${amountPaid.toFixed(2)} en ${req.code} — Ref: ${body.paymentRef.trim()}`,
          previousState: { status: 'READY_FOR_PAYMENT' },
          newState: {
            status: 'CLOSED_SETTLED',
            amountPaid,
            paymentRef: body.paymentRef.trim(),
          },
          ipAddress: clientIp,
          userAgent,
        });

        return reqUpdated;
      });

      await createNotification({
        userId: updated.requesterId,
        userEmail: updated.requester.email,
        userName: updated.requester.fullName,
        type: 'PAYMENT_EXECUTED',
        title: `Pago ejecutado en ${updated.code}`,
        message: `Tesorería ejecutó la transferencia bancaria Ref. ${body.paymentRef.trim()}.`,
        linkUrl: `/solicitudes/${updated.id}`,
      });

      return serializeExpenseRequest(updated);
    },
    {
      body: t.Object({
        paymentRef: t.String({ minLength: 2 }),
        paymentNotes: t.Optional(t.Nullable(t.String())),
      }),
    }
  )
  .get('/export', async ({ currentUser, query }) => {
    requireRoles(currentUser, ['TREASURY', 'FINANCE', 'DIRECTION', 'ADMIN']);

    const rows = await buildTreasuryRows(prisma, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      branchId: query.branchId || undefined,
      status: query.status || undefined,
    });

    const format = query.format === 'csv' ? 'csv' : 'xlsx';
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const csv = generateTreasuryCsv(rows);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="conciliacion-tesoreria-${stamp}.csv"`,
        },
      });
    }

    const buffer = await generateTreasuryExcelBuffer(rows);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="conciliacion-tesoreria-${stamp}.xlsx"`,
      },
    });
  });
