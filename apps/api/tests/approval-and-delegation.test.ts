import { beforeAll, describe, expect, it } from 'vitest';
import { resolveApprovalSteps } from '../src/services/approval-rule-engine';
import { apiFetch, loginCookieFor, prisma, resetAndSeed } from './test-helpers';

describe('Approval Matrix, Anti-Self-Approval & Delegations', () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it('evalúa todos los tramos de la matriz incluyendo Compras Especiales IT > $1,000', async () => {
    const valeria = await prisma.user.findUniqueOrThrow({ where: { email: 'valeria.consultora@aprobaflow.com' } });
    const prjCloud = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-CLOUD-01' } });

    const rSmall = await resolveApprovalSteps(prisma, {
      requestType: 'REIMBURSEMENT',
      phase: 'INITIAL_REQUEST',
      amount: 50,
      specialTags: [],
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      requesterId: valeria.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });
    expect(rSmall.steps.map((s) => s.requiredRole)).toEqual(['PROJECT_MANAGER']);

    const rLarge = await resolveApprovalSteps(prisma, {
      requestType: 'REIMBURSEMENT',
      phase: 'INITIAL_REQUEST',
      amount: 50.01,
      specialTags: [],
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      requesterId: valeria.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });
    expect(rLarge.steps.map((s) => s.requiredRole)).toEqual(['PROJECT_MANAGER', 'FINANCE']);

    const aMid = await resolveApprovalSteps(prisma, {
      requestType: 'ADVANCE',
      phase: 'INITIAL_REQUEST',
      amount: 350, // Tramo $100 - $499.99
      specialTags: [],
      budgetTargetType: 'DEPARTMENT',
      departmentId: valeria.departmentId,
      requesterId: valeria.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });
    expect(aMid.steps.map((s) => s.requiredRole)).toEqual(['DIRECT_MANAGER']);

    const aBig = await resolveApprovalSteps(prisma, {
      requestType: 'ADVANCE',
      phase: 'INITIAL_REQUEST',
      amount: 500,
      specialTags: [],
      budgetTargetType: 'DEPARTMENT',
      departmentId: valeria.departmentId,
      requesterId: valeria.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });
    expect(aBig.steps.map((s) => s.requiredRole)).toEqual(['DIRECT_MANAGER', 'FINANCE']);

    const itSpecial = await resolveApprovalSteps(prisma, {
      requestType: 'ADVANCE',
      phase: 'INITIAL_REQUEST',
      amount: 1200,
      specialTags: ['IT'],
      budgetTargetType: 'DEPARTMENT',
      departmentId: valeria.departmentId,
      requesterId: valeria.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });
    expect(itSpecial.steps.map((s) => s.requiredRole)).toEqual([
      'DIRECT_MANAGER',
      'SPECIAL_IT',
      'FINANCE',
    ]);
  });

  it('aplica regla anti-autoaprobación cuando el gerente o PM crea su propia solicitud', async () => {
    const carlos = await prisma.user.findUniqueOrThrow({ where: { email: 'carlos.gerente@aprobaflow.com' } });
    const elena = await prisma.user.findUniqueOrThrow({ where: { email: 'elena.direccion@aprobaflow.com' } });
    const prjCloud = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-CLOUD-01' } });

    // Carlos es PM de PRJ-CLOUD-01; al crear una solicitud sobre PRJ-CLOUD-01, escala a su jefa Elena
    const plan = await resolveApprovalSteps(prisma, {
      requestType: 'ADVANCE',
      phase: 'INITIAL_REQUEST',
      amount: 200,
      specialTags: [],
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      requesterId: carlos.id,
      budgetAlert85Triggered: false,
      budgetExceeded100: false,
    });

    expect(plan.steps[0].assignedApproverId).toBe(elena.id);
    expect(plan.steps[0].assignedApproverId).not.toBe(carlos.id);
  });

  it('enruta por delegación temporal y registra el texto exacto de reemplazo + IP en AuditLog', async () => {
    const luciaCookie = await loginCookieFor('lucia.suplente@aprobaflow.com');

    // Lucía debe ver REE-YYYY-0001 (de Valeria, asignada a Carlos y delegada a Lucía)
    const pendingRes = await apiFetch('/api/approvals/pending', { cookie: luciaCookie });
    expect(pendingRes.status).toBe(200);
    const pending = await pendingRes.json();
    const delegatedItem = pending.find(
      (p: { request: { code: string }; actingAsDelegate: boolean }) =>
        p.request.code.endsWith('-0001') && p.actingAsDelegate
    );
    expect(delegatedItem).toBeTruthy();
    expect(delegatedItem.delegatorName).toBe('Carlos Pérez');
    expect(delegatedItem.delegationReason).toBe('Vacaciones');

    const approveRes = await apiFetch(`/api/approvals/${delegatedItem.stepId}/decide`, {
      method: 'POST',
      cookie: luciaCookie,
      ip: '186.112.44.77',
      body: { decision: 'APPROVED', comment: 'Taxi justificado por visita cliente' },
    });
    expect(approveRes.status).toBe(200);

    const log = await prisma.auditLog.findFirst({
      where: {
        entityId: delegatedItem.request.id,
        action: 'APPROVED_STEP',
      },
      orderBy: { timestamp: 'desc' },
    });

    expect(log).toBeTruthy();
    expect(log?.summary).toBe(
      'Aprobado por Lucía Mendoza en reemplazo temporal de Carlos Pérez - Motivo: Vacaciones'
    );
    expect(log?.ipAddress).toBe('186.112.44.77');
    expect(log?.onBehalfOfName).toBe('Carlos Pérez');
    expect(log?.delegationReason).toBe('Vacaciones');
  });

  it('permite reasignación manual de etapa por Admin registrando trazabilidad', async () => {
    const adminCookie = await loginCookieFor('admin@aprobaflow.com');
    const mateo = await prisma.user.findUniqueOrThrow({ where: { email: 'mateo.it@aprobaflow.com' } });

    const ant6 = await prisma.expenseRequest.findFirstOrThrow({
      where: { code: { endsWith: '-0006' } },
      include: { approvalSteps: { where: { status: 'PENDING' } } },
    });
    const pendingStep = ant6.approvalSteps[0];

    const res = await apiFetch(`/api/approvals/${pendingStep.id}/reassign`, {
      method: 'POST',
      cookie: adminCookie,
      body: { newApproverId: mateo.id, reason: 'Reestructuración operativa de proyecto' },
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    const newPending = updated.approvalSteps.find((s: { status: string }) => s.status === 'PENDING');
    expect(newPending.assignedApproverId).toBe(mateo.id);

    const log = await prisma.auditLog.findFirst({
      where: { entityId: ant6.id, action: 'REASSIGN_APPROVER' },
    });
    expect(log).toBeTruthy();
  });
});
