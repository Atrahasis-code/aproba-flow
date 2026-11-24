import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateBudgetImpact, validateTargetAccess } from '../src/services/budget-engine';
import { resolveApprovalSteps } from '../src/services/approval-rule-engine';
import { apiFetch, loginCookieFor, prisma, resetAndSeed } from './test-helpers';

describe('Budget Engine & Regla 85% / 100% Override', () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it('rechaza imputación exclusiva violada y acceso a proyecto no asignado', async () => {
    const valeria = await prisma.user.findUniqueOrThrow({ where: { email: 'valeria.consultora@aprobaflow.com' } });
    const deptCom = await prisma.department.findUniqueOrThrow({ where: { code: 'COM' } });
    const prjSec = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-SEC-03' } });

    await expect(
      validateTargetAccess(prisma, valeria, {
        budgetTargetType: 'DEPARTMENT',
        departmentId: valeria.departmentId,
        projectId: prjSec.id,
      })
    ).rejects.toMatchObject({ status: 400, code: 'EXCLUSIVE_TARGET_VIOLATION' });

    await expect(
      validateTargetAccess(prisma, valeria, {
        budgetTargetType: 'DEPARTMENT',
        departmentId: deptCom.id,
      })
    ).rejects.toMatchObject({ status: 403, code: 'DEPARTMENT_ACCESS_DENIED' });

    await expect(
      validateTargetAccess(prisma, valeria, {
        budgetTargetType: 'PROJECT',
        projectId: prjSec.id,
      })
    ).rejects.toMatchObject({ status: 403, code: 'PROJECT_ASSIGNMENT_REQUIRED' });
  });

  it('calcula Ejecutado + Comprometido, dispara alerta >85% y fuerza Finanzas incluso en montos chicos', async () => {
    const now = new Date();
    const deptCom = await prisma.department.findUniqueOrThrow({ where: { code: 'COM' } });
    const camila = await prisma.user.findUniqueOrThrow({ where: { email: 'camila.comercial@aprobaflow.com' } });

    // Comercial tiene $1,740 ejecutado de $2,000 (87%)
    const impact = await evaluateBudgetImpact(prisma, {
      budgetTargetType: 'DEPARTMENT',
      departmentId: deptCom.id,
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      candidateAmount: 30.0,
    });

    expect(impact.executed).toBe(1740);
    expect(impact.projectedPct).toBeCloseTo(88.5, 1);
    expect(impact.alert85Triggered).toBe(true);
    expect(impact.exceeded100).toBe(false);

    // Monto chico $30 normalmente solo requiere DIRECT_MANAGER, pero >85% fuerza FINANCE y bloquea autoApprove
    const plan = await resolveApprovalSteps(prisma, {
      requestType: 'REIMBURSEMENT',
      phase: 'INITIAL_REQUEST',
      amount: 30.0,
      specialTags: [],
      budgetTargetType: 'DEPARTMENT',
      departmentId: deptCom.id,
      requesterId: camila.id,
      budgetAlert85Triggered: true,
      budgetExceeded100: false,
    });

    expect(plan.autoApprove).toBe(false);
    expect(plan.steps.map((s) => s.requiredRole)).toEqual(['DIRECT_MANAGER', 'FINANCE']);

    // Incluso en EXCESS <= $50 (normalmente allowAutoApprove: true), >85% desactiva autoaprobación y fuerza FINANCE
    const excessPlan = await resolveApprovalSteps(prisma, {
      requestType: 'EXCESS',
      phase: 'EXCESS_SETTLEMENT',
      amount: 25.0,
      specialTags: [],
      budgetTargetType: 'DEPARTMENT',
      departmentId: deptCom.id,
      requesterId: camila.id,
      budgetAlert85Triggered: true,
      budgetExceeded100: false,
    });

    expect(excessPlan.autoApprove).toBe(false);
    expect(excessPlan.steps.map((s) => s.requiredRole)).toEqual(['FINANCE']);
  });

  it('bloquea aprobación estándar al >100% y exige Override Presupuestario auditado de Finanzas/Dirección', async () => {
    const camilaCookie = await loginCookieFor('camila.comercial@aprobaflow.com');
    const elenaCookie = await loginCookieFor('elena.direccion@aprobaflow.com');
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');

    const deptCom = await prisma.department.findUniqueOrThrow({ where: { code: 'COM' } });

    // Comercial tiene $1,740/$2,000. Un anticipo de $400 lo lleva a $2,140 (107% -> >100%)
    const createRes = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: camilaCookie,
      body: {
        title: 'Gira comercial regional',
        budgetTargetType: 'DEPARTMENT',
        departmentId: deptCom.id,
        requestedAmount: 400,
      },
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.budgetAlert85Triggered).toBe(true);
    expect(created.budgetOverrideRequired).toBe(true);

    const step1 = created.approvalSteps.find((s: { status: string }) => s.status === 'PENDING');
    expect(step1).toBeTruthy();

    // Elena (Jefe Directo de Camila) intenta aprobar normalmente -> bloqueado con 409 BUDGET_OVERRIDE_REQUIRED
    const blockedRes = await apiFetch(`/api/approvals/${step1.id}/decide`, {
      method: 'POST',
      cookie: elenaCookie,
      body: { decision: 'APPROVED', comment: 'Intento sin override' },
    });
    expect(blockedRes.status).toBe(409);
    const blockedJson = await blockedRes.json();
    expect(blockedJson.code).toBe('BUDGET_OVERRIDE_REQUIRED');

    // Sofía (Finanzas) autoriza Override >100% con motivo obligatorio
    const overrideRes = await apiFetch(`/api/approvals/${step1.id}/override-budget`, {
      method: 'POST',
      cookie: sofiaCookie,
      body: { reason: 'Ampliación presupuestaria aprobada para cierre de cuentas Q4' },
    });
    expect(overrideRes.status).toBe(200);
    const overridden = await overrideRes.json();
    expect(overridden.budgetOverrideApprovedById).toBeTruthy();

    // Ahora Elena sí puede aprobar Paso 1
    const approveRes = await apiFetch(`/api/approvals/${step1.id}/decide`, {
      method: 'POST',
      cookie: elenaCookie,
      body: { decision: 'APPROVED', comment: 'Aprobado tras override' },
    });
    expect(approveRes.status).toBe(200);

    const overrideAudit = await prisma.auditLog.findFirst({
      where: { entityId: created.id, action: 'BUDGET_OVERRIDE' },
    });
    expect(overrideAudit).toBeTruthy();
    expect(overrideAudit?.summary).toContain('Override presupuestario (>100%)');
  });
});
