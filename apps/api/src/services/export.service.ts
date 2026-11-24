import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '../generated/prisma';
import { EXPENSE_STATUS_LABELS, REQUEST_TYPE_LABELS } from '@aproba-flow/shared';
import { toMoney } from '@aproba-flow/shared';
import { formatDateEs, formatDateTimeEs } from '../lib/format';

export interface TreasuryExportFilters {
  from?: Date;
  to?: Date;
  branchId?: string;
  status?: string;
}

export interface TreasuryReportRow {
  codigo: string;
  modalidad: string;
  estado: string;
  empleado: string;
  codigoEmpleado: string;
  filial: string;
  banco: string;
  cuentaBancaria: string;
  destinoPresupuestario: string;
  categoriasContables: string;
  montoSolicitado: number;
  montoAnticipado: number;
  gastosValidados: number;
  montoNetoFinal: number;
  direccionFlujo: string;
  referenciaBancaria: string;
  fechaLiquidacion: string;
}

export async function buildTreasuryRows(
  prisma: PrismaClient,
  filters: TreasuryExportFilters = {}
): Promise<TreasuryReportRow[]> {
  const where: Prisma.ExpenseRequestWhereInput = {
    status: filters.status
      ? (filters.status as never)
      : {
          in: [
            'READY_FOR_DISBURSEMENT',
            'READY_FOR_PAYMENT',
            'PENDING_RETURN',
            'RETURN_SUBMITTED',
            'CLOSED_SETTLED',
          ],
        },
    ...(filters.branchId ? { requester: { branchId: filters.branchId } } : {}),
    ...(filters.from || filters.to
      ? {
          updatedAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const requests = await prisma.expenseRequest.findMany({
    where,
    include: {
      requester: {
        include: { branch: true },
      },
      department: true,
      project: true,
      items: {
        where: { auditStatus: { not: 'REJECTED' } },
        include: { category: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map((req) => {
    const requested = toMoney(req.requestedAmount);
    const disbursed = toMoney(req.disbursedAmount);
    const validated =
      toMoney(req.approvedAmount) > 0
        ? toMoney(req.approvedAmount)
        : req.type === 'REIMBURSEMENT' && req.status === 'READY_FOR_PAYMENT'
          ? requested
          : 0;

    let netFinal = toMoney(req.netSettlementAmount);
    if (req.type === 'REIMBURSEMENT') {
      netFinal = validated;
    } else if (req.status === 'READY_FOR_DISBURSEMENT') {
      netFinal = requested;
    }

    let flowDir = 'Cuadre Exacto ($0.00)';
    if (req.status === 'READY_FOR_DISBURSEMENT') {
      flowDir = 'Desembolsar Anticipo';
    } else if (req.type === 'REIMBURSEMENT') {
      flowDir = 'Reembolsar al Empleado';
    } else if (netFinal > 0) {
      flowDir = 'Reembolsar Excedente al Empleado';
    } else if (netFinal < 0) {
      flowDir =
        req.status === 'CLOSED_SETTLED'
          ? 'Saldo Devuelto a la Empresa'
          : 'Por Cobrar / Devolución Empleado';
    }

    const cats = Array.from(
      new Set(req.items.map((it) => `${it.category.accountCode} (${it.category.name})`))
    ).join('; ');

    const targetName =
      req.budgetTargetType === 'PROJECT'
        ? `Proyecto: ${req.project?.code ?? ''} - ${req.project?.name ?? ''}`
        : `Depto: ${req.department?.name ?? ''} (${String(req.budgetMonth).padStart(2, '0')}/${req.budgetYear})`;

    return {
      codigo: req.code,
      modalidad: REQUEST_TYPE_LABELS[req.type],
      estado: EXPENSE_STATUS_LABELS[req.status],
      empleado: req.requester.fullName,
      codigoEmpleado: req.requester.employeeCode,
      filial: `${req.requester.branch.name} (${req.requester.branch.code})`,
      banco: req.requester.bankName || 'Sin registrar',
      cuentaBancaria: req.requester.bankAccountNumber || 'Sin registrar',
      destinoPresupuestario: targetName,
      categoriasContables: cats || 'Anticipo General',
      montoSolicitado: requested,
      montoAnticipado: disbursed,
      gastosValidados: validated,
      montoNetoFinal: netFinal,
      direccionFlujo: flowDir,
      referenciaBancaria: req.paymentRef || req.returnDepositRef || req.disbursementRef || '—',
      fechaLiquidacion: formatDateEs(req.paymentExecutedAt || req.returnConfirmedAt || req.disbursedAt || req.updatedAt),
    };
  });
}

export async function generateTreasuryExcelBuffer(rows: TreasuryReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AprobaFlow';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Conciliación Tesorería', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  sheet.mergeCells('A1:Q1');
  sheet.getCell('A1').value = 'AprobaFlow — Reporte Limpio de Conciliación y Reembolsos para Tesorería';
  sheet.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF0F172A' } };

  sheet.mergeCells('A2:Q2');
  sheet.getCell('A2').value = `Generado el ${formatDateTimeEs(new Date())} | Moneda: USD`;
  sheet.getCell('A2').font = { size: 10, color: { argb: 'FF475569' } };

  sheet.addRow([]);

  const headers = [
    'Código',
    'Modalidad',
    'Estado',
    'Empleado',
    'Cód. Empleado',
    'Filial',
    'Banco',
    'Cuenta Bancaria',
    'Destino Presupuestario',
    'Cuentas Contables',
    'Solicitado (USD)',
    'Monto Anticipado (USD)',
    'Gastos Validados (USD)',
    'Monto Neto Final (USD)',
    'Dirección de Flujo',
    'Referencia Bancaria',
    'Fecha Mov.',
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 26;

  for (const r of rows) {
    const row = sheet.addRow([
      r.codigo,
      r.modalidad,
      r.estado,
      r.empleado,
      r.codigoEmpleado,
      r.filial,
      r.banco,
      r.cuentaBancaria,
      r.destinoPresupuestario,
      r.categoriasContables,
      r.montoSolicitado,
      r.montoAnticipado,
      r.gastosValidados,
      r.montoNetoFinal,
      r.direccionFlujo,
      r.referenciaBancaria,
      r.fechaLiquidacion,
    ]);
    for (const colIdx of [11, 12, 13, 14]) {
      row.getCell(colIdx).numFmt = '$#,##0.00;[Red]-$#,##0.00';
    }
  }

  const widths = [16, 22, 24, 24, 14, 18, 18, 20, 32, 34, 16, 18, 18, 20, 28, 20, 15];
  widths.forEach((w, idx) => {
    sheet.getColumn(idx + 1).width = w;
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateTreasuryCsv(rows: TreasuryReportRow[]): string {
  const headers = [
    'Código',
    'Modalidad',
    'Estado',
    'Empleado',
    'Cód. Empleado',
    'Filial',
    'Banco',
    'Cuenta Bancaria',
    'Destino Presupuestario',
    'Cuentas Contables',
    'Solicitado (USD)',
    'Monto Anticipado (USD)',
    'Gastos Validados (USD)',
    'Monto Neto Final (USD)',
    'Dirección de Flujo',
    'Referencia Bancaria',
    'Fecha Mov.',
  ];

  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.codigo,
        r.modalidad,
        r.estado,
        r.empleado,
        r.codigoEmpleado,
        r.filial,
        r.banco,
        r.cuentaBancaria,
        r.destinoPresupuestario,
        r.categoriasContables,
        r.montoSolicitado.toFixed(2),
        r.montoAnticipado.toFixed(2),
        r.gastosValidados.toFixed(2),
        r.montoNetoFinal.toFixed(2),
        r.direccionFlujo,
        r.referenciaBancaria,
        r.fechaLiquidacion,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

export function generateAuditCsv(
  logs: Array<{
    timestamp: Date;
    actorName: string;
    actorRole: string;
    onBehalfOfName: string | null;
    delegationReason: string | null;
    entityType: string;
    entityId: string;
    action: string;
    summary: string;
    ipAddress: string | null;
  }>
): string {
  const headers = [
    'Fecha y Hora (ISO)',
    'Usuario Actor',
    'Rol',
    'En Reemplazo De',
    'Motivo Suplencia',
    'Tipo Entidad',
    'ID Entidad',
    'Acción',
    'Detalle',
    'IP',
  ];
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const log of logs) {
    lines.push(
      [
        log.timestamp.toISOString(),
        log.actorName,
        log.actorRole,
        log.onBehalfOfName ?? '',
        log.delegationReason ?? '',
        log.entityType,
        log.entityId,
        log.action,
        log.summary,
        log.ipAddress ?? '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}
