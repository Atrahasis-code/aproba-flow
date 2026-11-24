import type {
  ApprovalPhase,
  ApprovalRoleType,
  BudgetTargetType,
  Prisma,
  PrismaClient,
  RequestType,
  UserRole,
} from '../generated/prisma';
import { hasRole } from '../lib/auth';
import { toMoney } from '@aproba-flow/shared';
import { DomainError } from '../errors';
import { findActiveDelegation } from '../services/delegation-resolver';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface ResolveStepsInput {
  requestType: RequestType;
  phase: ApprovalPhase;
  amount: number;
  specialTags: string[];
  budgetTargetType: BudgetTargetType;
  departmentId?: string | null;
  projectId?: string | null;
  requesterId: string;
  budgetAlert85Triggered: boolean;
  budgetExceeded100: boolean;
}

export interface PlannedApprovalStep {
  phase: ApprovalPhase;
  stepOrder: number;
  requiredRole: ApprovalRoleType;
  assignedApproverId: string | null;
  delegatedToUserId: string | null;
  delegationId: string | null;
  status: 'PENDING' | 'WAITING';
  enteredAt: Date | null;
}

const ROLE_ORDER: Record<ApprovalRoleType, number> = {
  DIRECT_MANAGER: 1,
  PROJECT_MANAGER: 1,
  SPECIAL_IT: 2,
  FINANCE: 3,
  DIRECTION: 4,
};

export async function resolveApprovalSteps(
  db: DbClient,
  input: ResolveStepsInput
): Promise<{ autoApprove: boolean; steps: PlannedApprovalStep[] }> {
  const [rules, sysConfig, requester] = await Promise.all([
    db.approvalRule.findMany({
      where: { requestType: input.requestType, isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    }),
    db.systemConfig.findUnique({ where: { id: 'singleton' } }),
    db.user.findUnique({
      where: { id: input.requesterId },
      select: { id: true, managerId: true, departmentId: true, roles: true },
    }),
  ]);

  if (!requester) {
    throw new DomainError('Usuario solicitante no encontrado.', 404);
  }

  const matchingRules = rules.filter((rule) => {
    const min = toMoney(rule.minAmount);
    const max = rule.maxAmount !== null ? toMoney(rule.maxAmount) : null;
    const inAmount = input.amount >= min && (max === null || input.amount <= max);
    if (!inAmount) return false;
    if (rule.categorySpecialTag) {
      return input.specialTags.includes(rule.categorySpecialTag);
    }
    return true;
  });

  const specialRule = matchingRules.find((r) => r.categorySpecialTag !== null);
  const generalRule = matchingRules.find((r) => r.categorySpecialTag === null);
  const selectedRule = specialRule ?? generalRule;

  let roleChain: ApprovalRoleType[] = [];
  let ruleAllowsAutoApprove = false;

  if (selectedRule) {
    const parsedChain = Array.isArray(selectedRule.approverChain)
      ? (selectedRule.approverChain as ApprovalRoleType[])
      : [];
    roleChain = [...parsedChain];
    ruleAllowsAutoApprove = selectedRule.allowAutoApprove || roleChain.length === 0;
  } else if (input.requestType === 'EXCESS') {
    const tolerance = toMoney(sysConfig?.excessToleranceUsd ?? 50);
    const mediumMax = toMoney(sysConfig?.excessMediumMaxUsd ?? 250);
    if (input.amount <= tolerance) {
      roleChain = [];
      ruleAllowsAutoApprove = true;
    } else if (input.amount <= mediumMax) {
      roleChain = ['DIRECT_MANAGER'];
    } else {
      roleChain = ['DIRECT_MANAGER', 'DIRECTION'];
    }
  } else {
    roleChain = ['DIRECT_MANAGER', 'FINANCE'];
  }

  // Regla del 85% y >100%: bloquea aprobaciones automáticas y fuerza Finanzas
  if (input.budgetAlert85Triggered || input.budgetExceeded100) {
    ruleAllowsAutoApprove = false;
    if (!roleChain.includes('FINANCE')) {
      roleChain.push('FINANCE');
    }
  }

  if (ruleAllowsAutoApprove && roleChain.length === 0) {
    return { autoApprove: true, steps: [] };
  }

  // Deduplicate and normalize hierarchy order
  const uniqueRoles = Array.from(new Set(roleChain)).sort(
    (a, b) => ROLE_ORDER[a] - ROLE_ORDER[b]
  );

  let level1ApproverId: string | null = null;
  let level1RoleType: ApprovalRoleType =
    input.budgetTargetType === 'PROJECT' ? 'PROJECT_MANAGER' : 'DIRECT_MANAGER';

  if (input.budgetTargetType === 'PROJECT' && input.projectId) {
    const project = await db.project.findUnique({
      where: { id: input.projectId },
      select: { managerId: true },
    });
    level1ApproverId = project?.managerId ?? null;
    level1RoleType = 'PROJECT_MANAGER';
  } else if (input.departmentId) {
    const dept = await db.department.findUnique({
      where: { id: input.departmentId },
      select: { headUserId: true },
    });
    level1ApproverId = requester.managerId ?? dept?.headUserId ?? null;
    level1RoleType = 'DIRECT_MANAGER';
  } else {
    level1ApproverId = requester.managerId ?? null;
  }

  // Anti-self-approval: escalate or skip Level 1 -> Finance / Direction
  let skipLevel1 = false;
  if (level1ApproverId === input.requesterId) {
    const approverUser = await db.user.findUnique({
      where: { id: level1ApproverId },
      select: { managerId: true },
    });
    if (approverUser?.managerId && approverUser.managerId !== input.requesterId) {
      level1ApproverId = approverUser.managerId;
    } else {
      skipLevel1 = true;
      level1ApproverId = null;
    }
  }

  if (!level1ApproverId) {
    skipLevel1 = true;
  }

  const resolvedRoles: Array<{ role: ApprovalRoleType; assignedApproverId: string | null }> = [];
  for (const r of uniqueRoles) {
    if (r === 'DIRECT_MANAGER' || r === 'PROJECT_MANAGER') {
      if (skipLevel1) {
        if (!uniqueRoles.includes('FINANCE')) {
          resolvedRoles.push({ role: 'FINANCE', assignedApproverId: null });
        }
        continue;
      }
      resolvedRoles.push({ role: level1RoleType, assignedApproverId: level1ApproverId });
    } else if (r === 'SPECIAL_IT') {
      const itApprover = await db.user.findFirst({
        where: {
          isActive: true,
          roles: { has: 'SPECIAL_APPROVER_IT' },
          id: { not: input.requesterId },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (itApprover) {
        resolvedRoles.push({ role: 'SPECIAL_IT', assignedApproverId: itApprover.id });
      } else {
        // Fallback to Finance/Admin pool if no dedicated IT approver outside requester
        resolvedRoles.push({ role: 'SPECIAL_IT', assignedApproverId: null });
      }
    } else if (r === 'FINANCE') {
      // If requester itself is Finance and no other Finance user exists, escalate to Direction
      const otherFinance = await db.user.findFirst({
        where: {
          isActive: true,
          roles: { has: 'FINANCE' },
          id: { not: input.requesterId },
        },
        select: { id: true },
      });
      if (otherFinance) {
        resolvedRoles.push({ role: 'FINANCE', assignedApproverId: null });
      } else {
        resolvedRoles.push({ role: 'DIRECTION', assignedApproverId: null });
      }
    } else {
      resolvedRoles.push({ role: r, assignedApproverId: null });
    }
  }

  // Deduplicate adjacent identical pool roles (e.g. FINANCE added twice)
  const finalRoles: Array<{ role: ApprovalRoleType; assignedApproverId: string | null }> = [];
  for (const entry of resolvedRoles) {
    if (
      finalRoles.some(
        (existing) =>
          existing.role === entry.role && existing.assignedApproverId === entry.assignedApproverId
      )
    ) {
      continue;
    }
    finalRoles.push(entry);
  }

  if (finalRoles.length === 0) {
    finalRoles.push({ role: 'FINANCE', assignedApproverId: null });
  }

  const now = new Date();
  const steps: PlannedApprovalStep[] = [];

  for (let i = 0; i < finalRoles.length; i++) {
    const entry = finalRoles[i];
    let delegatedToUserId: string | null = null;
    let delegationId: string | null = null;

    if (entry.assignedApproverId) {
      const delegation = await findActiveDelegation(db, entry.assignedApproverId, now);
      if (delegation && delegation.delegateId !== input.requesterId) {
        delegatedToUserId = delegation.delegateId;
        delegationId = delegation.id;
      }
    }

    steps.push({
      phase: input.phase,
      stepOrder: i + 1,
      requiredRole: entry.role,
      assignedApproverId: entry.assignedApproverId,
      delegatedToUserId,
      delegationId,
      status: i === 0 ? 'PENDING' : 'WAITING',
      enteredAt: i === 0 ? now : null,
    });
  }

  return { autoApprove: false, steps };
}

export async function canUserActOnStep(
  db: DbClient,
  user: { id: string; fullName: string; roles: UserRole[] },
  step: {
    id: string;
    status: string;
    requiredRole: ApprovalRoleType;
    assignedApproverId: string | null;
    delegatedToUserId: string | null;
    delegationId: string | null;
  },
  requesterId: string
): Promise<{
  allowed: boolean;
  reason?: string;
  actingAsDelegate: boolean;
  delegatorId?: string;
  delegatorName?: string;
  delegationReason?: string;
  delegationId?: string;
}> {
  if (step.status !== 'PENDING') {
    return { allowed: false, reason: 'Esta etapa de aprobación ya no está pendiente.', actingAsDelegate: false };
  }

  if (user.id === requesterId) {
    return {
      allowed: false,
      reason: 'Regla anti-autoaprobación: no puedes aprobar ni auditar tu propia solicitud.',
      actingAsDelegate: false,
    };
  }

  if (step.requiredRole === 'FINANCE') {
    if (hasRole(user, 'FINANCE')) {
      return { allowed: true, actingAsDelegate: false };
    }
    return { allowed: false, reason: 'Esta etapa requiere rol Finanzas.', actingAsDelegate: false };
  }

  if (step.requiredRole === 'DIRECTION') {
    if (hasRole(user, 'DIRECTION')) {
      return { allowed: true, actingAsDelegate: false };
    }
    return {
      allowed: false,
      reason: 'Esta etapa requiere rol Dirección Administrativa.',
      actingAsDelegate: false,
    };
  }

  if (step.assignedApproverId) {
    if (step.assignedApproverId === user.id) {
      return { allowed: true, actingAsDelegate: false };
    }

    // Check active delegation dynamically (covers delegations created before OR after step creation)
    const liveDelegation = await findActiveDelegation(db, step.assignedApproverId, new Date());
    if (liveDelegation && liveDelegation.delegateId === user.id) {
      return {
        allowed: true,
        actingAsDelegate: true,
        delegatorId: liveDelegation.delegator.id,
        delegatorName: liveDelegation.delegator.fullName,
        delegationReason: liveDelegation.reason,
        delegationId: liveDelegation.id,
      };
    }

    if (step.delegatedToUserId === user.id && step.delegationId) {
      const del = await db.approvalDelegation.findUnique({
        where: { id: step.delegationId },
        include: { delegator: { select: { id: true, fullName: true } } },
      });
      if (del && del.isActive) {
        return {
          allowed: true,
          actingAsDelegate: true,
          delegatorId: del.delegator.id,
          delegatorName: del.delegator.fullName,
          delegationReason: del.reason,
          delegationId: del.id,
        };
      }
    }

    return {
      allowed: false,
      reason: 'Esta firma corresponde a otro aprobador asignado o su suplente activo.',
      actingAsDelegate: false,
    };
  }

  if (step.requiredRole === 'SPECIAL_IT' && hasRole(user, 'SPECIAL_APPROVER_IT')) {
    return { allowed: true, actingAsDelegate: false };
  }

  return { allowed: false, reason: 'No tienes permisos para aprobar esta etapa.', actingAsDelegate: false };
}
