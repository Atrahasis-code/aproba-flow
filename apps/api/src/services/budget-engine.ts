import type { BudgetTargetType, Prisma, PrismaClient, UserRole } from '../generated/prisma';
import { hasAnyRole } from '../lib/auth';
import { roundMoney, sumMoney, toMoney } from '@aproba-flow/shared';
import { DomainError } from '../errors';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface BudgetTargetInput {
  budgetTargetType: BudgetTargetType;
  departmentId?: string | null;
  projectId?: string | null;
  year: number;
  month: number;
  excludeRequestId?: string;
}

export interface BudgetSnapshot {
  targetType: BudgetTargetType;
  targetId: string;
  targetCode: string;
  targetName: string;
  year: number;
  month: number;
  budgetLimit: number;
  executed: number;
  committed: number;
  totalUsed: number;
  available: number;
  usagePct: number;
}

export interface BudgetImpactResult extends BudgetSnapshot {
  thresholdPct: number;
  candidateAmount: number;
  projectedUsed: number;
  projectedAvailable: number;
  projectedPct: number;
  alert85Triggered: boolean;
  exceeded100: boolean;
}

export async function validateTargetAccess(
  db: DbClient,
  user: { id: string; departmentId: string; roles: UserRole[] },
  input: { budgetTargetType: BudgetTargetType; departmentId?: string | null; projectId?: string | null }
) {
  const isPrivileged = hasAnyRole(user, ['ADMIN', 'FINANCE']);

  if (input.budgetTargetType === 'DEPARTMENT') {
    if (!input.departmentId || input.projectId) {
      throw new DomainError(
        'Para Centro de Costo debes seleccionar exactamente un departamento y ningún proyecto.',
        400,
        'EXCLUSIVE_TARGET_VIOLATION'
      );
    }

    const dept = await db.department.findUnique({ where: { id: input.departmentId } });
    if (!dept || !dept.isActive) {
      throw new DomainError('El departamento seleccionado no existe o está inactivo.', 404, 'DEPARTMENT_NOT_FOUND');
    }

    if (!isPrivileged && user.departmentId !== input.departmentId) {
      throw new DomainError(
        'Solo puedes imputar gastos al centro de costo de tu departamento asignado.',
        403,
        'DEPARTMENT_ACCESS_DENIED'
      );
    }
    return { department: dept, project: null };
  }

  if (!input.projectId || input.departmentId) {
    throw new DomainError(
      'Para Proyecto debes seleccionar exactamente un proyecto y ningún departamento.',
      400,
      'EXCLUSIVE_TARGET_VIOLATION'
    );
  }

  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project || project.status !== 'ACTIVE') {
    throw new DomainError('El proyecto seleccionado no existe o no está activo.', 404, 'PROJECT_NOT_ACTIVE');
  }

  if (!isPrivileged) {
    const assignment = await db.projectAssignment.findUnique({
      where: {
        projectId_userId: {
          projectId: input.projectId,
          userId: user.id,
        },
      },
    });
    if (!assignment || !assignment.isActive) {
      throw new DomainError(
        'No estás asignado activamente a este proyecto para imputar gastos.',
        403,
        'PROJECT_ASSIGNMENT_REQUIRED'
      );
    }
  }

  return { department: null, project };
}

export async function getBudgetSnapshot(db: DbClient, input: BudgetTargetInput): Promise<BudgetSnapshot> {
  let targetId = '';
  let targetCode = '';
  let targetName = '';
  let budgetLimit = 0;

  if (input.budgetTargetType === 'DEPARTMENT') {
    if (!input.departmentId) {
      throw new DomainError('departmentId es requerido.', 400);
    }
    const dept = await db.department.findUnique({ where: { id: input.departmentId } });
    if (!dept) {
      throw new DomainError('Departamento no encontrado.', 404);
    }
    const monthlyBudget = await db.departmentBudget.findUnique({
      where: {
        departmentId_year_month: {
          departmentId: input.departmentId,
          year: input.year,
          month: input.month,
        },
      },
    });
    targetId = dept.id;
    targetCode = dept.code;
    targetName = dept.name;
    budgetLimit = toMoney(monthlyBudget?.amount ?? 0);
  } else {
    if (!input.projectId) {
      throw new DomainError('projectId es requerido.', 400);
    }
    const project = await db.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      throw new DomainError('Proyecto no encontrado.', 404);
    }
    targetId = project.id;
    targetCode = project.code;
    targetName = `${project.name} (${project.clientName})`;
    budgetLimit = toMoney(project.totalBudget);
  }

  const requests = await db.expenseRequest.findMany({
    where: {
      budgetTargetType: input.budgetTargetType,
      ...(input.budgetTargetType === 'DEPARTMENT'
        ? { departmentId: input.departmentId!, budgetYear: input.year, budgetMonth: input.month }
        : { projectId: input.projectId! }),
      ...(input.excludeRequestId ? { id: { not: input.excludeRequestId } } : {}),
      status: { notIn: ['DRAFT', 'REJECTED'] },
    },
    select: {
      status: true,
      requestedAmount: true,
      disbursedAmount: true,
      approvedAmount: true,
    },
  });

  const executedValues: number[] = [];
  const committedValues: number[] = [];

  for (const req of requests) {
    if (
      req.status === 'CLOSED_SETTLED' ||
      req.status === 'READY_FOR_PAYMENT' ||
      req.status === 'PENDING_RETURN' ||
      req.status === 'RETURN_SUBMITTED'
    ) {
      executedValues.push(toMoney(req.approvedAmount));
    } else if (req.status === 'EXCESS_PENDING_APPROVAL') {
      committedValues.push(toMoney(req.approvedAmount));
    } else {
      const disb = toMoney(req.disbursedAmount);
      committedValues.push(disb > 0 ? disb : toMoney(req.requestedAmount));
    }
  }

  const executed = sumMoney(executedValues);
  const committed = sumMoney(committedValues);
  const totalUsed = roundMoney(executed + committed);
  const available = Math.max(0, roundMoney(budgetLimit - totalUsed));
  const usagePct =
    budgetLimit > 0 ? roundMoney((totalUsed / budgetLimit) * 100) : totalUsed > 0 ? 100 : 0;

  return {
    targetType: input.budgetTargetType,
    targetId,
    targetCode,
    targetName,
    year: input.year,
    month: input.month,
    budgetLimit,
    executed,
    committed,
    totalUsed,
    available,
    usagePct,
  };
}

export async function evaluateBudgetImpact(
  db: DbClient,
  input: BudgetTargetInput & { candidateAmount: number }
): Promise<BudgetImpactResult> {
  const [snapshot, sysConfig] = await Promise.all([
    getBudgetSnapshot(db, input),
    db.systemConfig.findUnique({ where: { id: 'singleton' } }),
  ]);

  const thresholdPct = sysConfig?.budgetAlertThresholdPct ?? 85;
  const candidateAmount = roundMoney(Math.max(0, input.candidateAmount));
  const projectedUsed = roundMoney(snapshot.totalUsed + candidateAmount);
  const projectedAvailable = Math.max(0, roundMoney(snapshot.budgetLimit - projectedUsed));
  const projectedPct =
    snapshot.budgetLimit > 0
      ? roundMoney((projectedUsed / snapshot.budgetLimit) * 100)
      : projectedUsed > 0
        ? 100
        : 0;

  return {
    ...snapshot,
    thresholdPct,
    candidateAmount,
    projectedUsed,
    projectedAvailable,
    projectedPct,
    alert85Triggered: projectedPct > thresholdPct,
    exceeded100: projectedPct > 100,
  };
}
