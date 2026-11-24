import { beforeAll, describe, expect, it } from 'vitest';
import { apiFetch, loginCookieFor, prisma, resetAndSeed } from './test-helpers';

describe('Admin CRUD (Rules, Categories, Users) & Scoped Separation (Mine vs Review Hub)', () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it('separa estrictamente scope=mine vs scope=team y expone review-hub con auditorías de Finanzas', async () => {
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');
    const valeriaCookie = await loginCookieFor('valeria.consultora@aprobaflow.com');

    // Crear un reembolso propio de Sofía para validar que scope=team nunca incluye sus propias solicitudes
    const catTransp = await prisma.category.findUniqueOrThrow({ where: { code: 'TRANSP' } });
    const seedFile = await prisma.storedFile.findFirstOrThrow();

    const createOwn = await apiFetch('/api/expenses/reimbursements', {
      method: 'POST',
      cookie: sofiaCookie,
      body: {
        title: 'Taxi propio de Sofía',
        budgetTargetType: 'DEPARTMENT',
        departmentId: (await prisma.department.findUniqueOrThrow({ where: { code: 'ADM' } })).id,
        items: [
          {
            categoryId: catTransp.id,
            expenseDate: new Date().toISOString().slice(0, 10),
            vendorName: 'Taxi Urbano',
            vendorTaxId: '900123456',
            invoiceNumber: 'SOF-001',
            description: 'Traslado banco',
            claimedAmount: 18,
            receiptFileId: seedFile.id,
          },
        ],
      },
    });
    expect(createOwn.status).toBe(200);
    const sofiaOwn = await createOwn.json();

    // scope=mine para Sofía solo devuelve sus solicitudes
    const mineRes = await apiFetch('/api/expenses?scope=mine', { cookie: sofiaCookie });
    expect(mineRes.status).toBe(200);
    const mine = await mineRes.json();
    expect(mine.length).toBe(1);
    expect(mine[0].id).toBe(sofiaOwn.id);

    // scope=team para Sofía excluye su propia solicitud
    const teamRes = await apiFetch('/api/expenses?scope=team', { cookie: sofiaCookie });
    expect(teamRes.status).toBe(200);
    const team = await teamRes.json();
    expect(team.length).toBeGreaterThan(5);
    expect(team.some((r: { id: string }) => r.id === sofiaOwn.id)).toBe(false);

    // review-hub para Sofía incluye ANT-2026-0004 en pendingFinanceSettlements + ANT-2026-0002 en pendingSignatures
    const hubRes = await apiFetch('/api/approvals/review-hub', { cookie: sofiaCookie });
    expect(hubRes.status).toBe(200);
    const hub = await hubRes.json();
    expect(
      hub.pendingFinanceSettlements.some((r: { code: string }) => r.code.endsWith('-0004'))
    ).toBe(true);
    expect(hub.totalActionableCount).toBeGreaterThanOrEqual(2);

    // scope=mine para Valeria solo devuelve solicitudes de Valeria
    const valMineRes = await apiFetch('/api/expenses?scope=mine', { cookie: valeriaCookie });
    const valMine = await valMineRes.json();
    expect(valMine.length).toBeGreaterThan(0);
    expect(valMine.every((r: { requester: { email: string } }) => r.requester.email === 'valeria.consultora@aprobaflow.com')).toBe(true);
  });

  it('permite al Admin crear, editar (incluyendo tipo y cadena) y eliminar reglas de aprobación', async () => {
    const adminCookie = await loginCookieFor('admin@aprobaflow.com');

    const createRes = await apiFetch('/api/rules', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        name: 'Regla Temporal Prueba',
        requestType: 'REIMBURSEMENT',
        minAmount: 10,
        maxAmount: 90,
        approverChain: ['DIRECT_MANAGER'],
        priority: 99,
      },
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();

    const patchRes = await apiFetch(`/api/rules/${created.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: {
        name: 'Regla Editada Admin',
        requestType: 'ADVANCE',
        minAmount: 20,
        maxAmount: 200,
        approverChain: ['DIRECT_MANAGER', 'FINANCE'],
        priority: 88,
        isActive: false,
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.name).toBe('Regla Editada Admin');
    expect(patched.requestType).toBe('ADVANCE');
    expect(patched.approverChain).toEqual(['DIRECT_MANAGER', 'FINANCE']);
    expect(patched.isActive).toBe(false);

    const delRes = await apiFetch(`/api/rules/${created.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(delRes.status).toBe(200);
  });

  it('permite al Admin editar y eliminar categorías sin uso y bloquea eliminar categorías con gastos', async () => {
    const adminCookie = await loginCookieFor('admin@aprobaflow.com');

    // Crear categoría nueva
    const createRes = await apiFetch('/api/catalogs/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        code: 'EVENTOS',
        name: 'Eventos Corporativos',
        accountCode: '5601-01',
        requiresReceipt: true,
      },
    });
    expect(createRes.status).toBe(200);
    const cat = await createRes.json();

    // Editar código, nombre, cuenta y desactivar
    const patchRes = await apiFetch(`/api/catalogs/categories/${cat.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: {
        code: 'EVENTOS2',
        name: 'Eventos y Ferias',
        accountCode: '5601-02',
        isActive: false,
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.code).toBe('EVENTOS2');
    expect(patched.name).toBe('Eventos y Ferias');
    expect(patched.isActive).toBe(false);

    // Eliminar categoría sin gastos -> 200
    const delUnused = await apiFetch(`/api/catalogs/categories/${cat.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(delUnused.status).toBe(200);

    // Intentar eliminar categoría en uso (VIAT-HOTEL) -> 409 CATEGORY_IN_USE
    const hotelCat = await prisma.category.findUniqueOrThrow({ where: { code: 'VIAT-HOTEL' } });
    const delUsed = await apiFetch(`/api/catalogs/categories/${hotelCat.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(delUsed.status).toBe(409);
    expect((await delUsed.json()).code).toBe('CATEGORY_IN_USE');
  });

  it('permite al Admin crear, editar y eliminar usuarios sin historial y bloquea auto-eliminación o usuarios con historial', async () => {
    const adminCookie = await loginCookieFor('admin@aprobaflow.com');
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@aprobaflow.com' } });
    const valeria = await prisma.user.findUniqueOrThrow({ where: { email: 'valeria.consultora@aprobaflow.com' } });
    const bog = await prisma.branch.findUniqueOrThrow({ where: { code: 'BOG' } });
    const deptCons = await prisma.department.findUniqueOrThrow({ where: { code: 'CONS' } });

    // Auto-eliminación bloqueada (400)
    const selfDel = await apiFetch(`/api/catalogs/users/${adminUser.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(selfDel.status).toBe(400);

    // Usuario con historial financiero bloqueado (409 USER_HAS_HISTORY)
    const histDel = await apiFetch(`/api/catalogs/users/${valeria.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(histDel.status).toBe(409);
    expect((await histDel.json()).code).toBe('USER_HAS_HISTORY');

    // Crear usuario nuevo -> editar -> eliminar -> 200
    const createUser = await apiFetch('/api/catalogs/users', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        email: 'nuevo.temporal@aprobaflow.com',
        password: 'TempPass123!',
        fullName: 'Usuario Temporal',
        employeeCode: 'EMP-999',
        jobTitle: 'Analista Junior',
        branchId: bog.id,
        departmentId: deptCons.id,
        roles: ['EMPLOYEE'],
      },
    });
    expect(createUser.status).toBe(200);
    const newUser = await createUser.json();

    const patchUser = await apiFetch(`/api/catalogs/users/${newUser.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: {
        fullName: 'Usuario Editado',
        email: 'editado.temporal@aprobaflow.com',
        employeeCode: 'EMP-998',
        roles: ['EMPLOYEE', 'FINANCE'],
        isActive: false,
      },
    });
    expect(patchUser.status).toBe(200);
    const patchedUser = await patchUser.json();
    expect(patchedUser.email).toBe('editado.temporal@aprobaflow.com');
    expect(patchedUser.roles).toEqual(['EMPLOYEE', 'FINANCE']);
    expect(patchedUser.isActive).toBe(false);

    const delUser = await apiFetch(`/api/catalogs/users/${newUser.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(delUser.status).toBe(200);
  });
});
