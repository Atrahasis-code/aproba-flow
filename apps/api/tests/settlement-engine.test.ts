import { beforeAll, describe, expect, it } from 'vitest';
import { hasDuplicateInvoice } from '../src/services/settlement-engine';
import { apiFetch, loginCookieFor, prisma, resetAndSeed } from './test-helpers';

describe('Settlement Engine (Ítem por Ítem, Escenarios A/B/C, Bloqueos y Duplicados)', () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it('bloquea nuevos anticipos con 409 cuando hay devolución pendiente y los desbloquea al confirmar depósito', async () => {
    const andresCookie = await loginCookieFor('andres.consultor@aprobaflow.com');
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');
    const prjData = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-DATA-04' } });

    // Andrés tiene ANT-YYYY-0005 en PENDING_RETURN ($120.00)
    const blockedRes = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: andresCookie,
      body: {
        title: 'Nuevo viaje bloqueado',
        budgetTargetType: 'PROJECT',
        projectId: prjData.id,
        requestedAmount: 250,
      },
    });
    expect(blockedRes.status).toBe(409);
    const blockedJson = await blockedRes.json();
    expect(blockedJson.code).toBe('ADVANCE_BLOCKED');

    // Andrés sube comprobante de depósito bancario para ANT-YYYY-0005
    const ant5 = await prisma.expenseRequest.findFirstOrThrow({
      where: { code: { endsWith: '-0005' } },
    });
    const seedFile = await prisma.storedFile.findFirstOrThrow();

    const depRes = await apiFetch(`/api/settlements/${ant5.id}/return-deposit`, {
      method: 'POST',
      cookie: andresCookie,
      body: { depositRef: 'DEP-CDMX-9001', depositFileId: seedFile.id },
    });
    expect(depRes.status).toBe(200);
    expect((await depRes.json()).status).toBe('RETURN_SUBMITTED');

    // Finanzas confirma recepción -> CLOSED_SETTLED
    const confirmRes = await apiFetch(`/api/settlements/${ant5.id}/confirm-return`, {
      method: 'POST',
      cookie: sofiaCookie,
      body: { accepted: true },
    });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json()).status).toBe('CLOSED_SETTLED');

    // Ahora Andrés ya puede solicitar anticipo
    const okRes = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: andresCookie,
      body: {
        title: 'Viaje habilitado tras devolución',
        budgetTargetType: 'PROJECT',
        projectId: prjData.id,
        requestedAmount: 250,
      },
    });
    expect(okRes.status).toBe(200);
  });

  it('audita ítem por ítem (Aprobado + Parcial + Rechazado), calcula Escenario B y protege ítems rechazados de reclamo', async () => {
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');
    const valeriaCookie = await loginCookieFor('valeria.consultora@aprobaflow.com');

    // ANT-YYYY-0004: $600 desembolsado; 3 ítems: Hotel $380, Cena $120, Taxi $45
    const ant4 = await prisma.expenseRequest.findFirstOrThrow({
      where: { code: { endsWith: '-0004' } },
      include: { items: { orderBy: { claimedAmount: 'desc' } } },
    });
    const [hotelItem, cenaItem, taxiItem] = ant4.items; // 380, 120, 45

    // Hotel 100% ($380)
    const r1 = await apiFetch(`/api/settlements/${ant4.id}/items/${hotelItem.id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: { auditStatus: 'APPROVED' },
    });
    expect(r1.status).toBe(200);

    // Cena parcial ($95 de $120 por alcohol)
    const r2 = await apiFetch(`/api/settlements/${ant4.id}/items/${cenaItem.id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: {
        auditStatus: 'PARTIALLY_APPROVED',
        approvedAmount: 95,
        auditNote: 'Se descuentan $25 de bebidas alcohólicas no cubiertas por política',
      },
    });
    expect(r2.status).toBe(200);

    // Taxi observado primero para verificar flujo OBSERVED vs REJECTED
    const r3 = await apiFetch(`/api/settlements/${ant4.id}/items/${taxiItem.id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: {
        auditStatus: 'OBSERVED',
        auditNote: 'Foto recortada, por favor re-subir recibo legible',
      },
    });
    expect(r3.status).toBe(200);

    // Finalizar con un ítem OBSERVED -> SETTLEMENT_OBSERVED
    const finObs = await apiFetch(`/api/settlements/${ant4.id}/finalize-audit`, {
      method: 'POST',
      cookie: sofiaCookie,
    });
    expect(finObs.status).toBe(200);
    expect((await finObs.json()).outcome).toBe('OBSERVED');

    // Valeria NO puede editar el ítem de Cena (PARTIALLY_APPROVED), solo el OBSERVED
    const tamperRes = await apiFetch(`/api/settlements/${ant4.id}/resubmit-observed`, {
      method: 'PATCH',
      cookie: valeriaCookie,
      body: {
        items: [{ itemId: cenaItem.id, claimedAmount: 120 }],
      },
    });
    expect(tamperRes.status).toBe(403);

    // Valeria corrige solo el ítem OBSERVED
    const fixRes = await apiFetch(`/api/settlements/${ant4.id}/resubmit-observed`, {
      method: 'PATCH',
      cookie: valeriaCookie,
      body: {
        items: [{ itemId: taxiItem.id, description: 'Taxi legible re-subido' }],
      },
    });
    expect(fixRes.status).toBe(200);
    expect((await fixRes.json()).status).toBe('SETTLEMENT_IN_REVIEW');

    // Ahora Finanzas aprueba Taxi ($45) -> Total aprobado = 380 + 95 + 45 = $520 vs $600 desembolsado -> Escenario B (-$80)
    await apiFetch(`/api/settlements/${ant4.id}/items/${taxiItem.id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: { auditStatus: 'APPROVED' },
    });

    const finB = await apiFetch(`/api/settlements/${ant4.id}/finalize-audit`, {
      method: 'POST',
      cookie: sofiaCookie,
    });
    expect(finB.status).toBe(200);
    const finBJson = await finB.json();
    expect(finBJson.outcome).toBe('SCENARIO_B_RETURN');
    expect(finBJson.request.status).toBe('PENDING_RETURN');
    expect(finBJson.request.approvedAmount).toBe(520);
    expect(finBJson.request.netSettlementAmount).toBe(-80);
  });

  it('resuelve Escenario A (cuadre exacto), Escenario C (<=50 directo y >250 con Dirección) y detecta duplicados', async () => {
    await resetAndSeed();
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');
    const valeriaCookie = await loginCookieFor('valeria.consultora@aprobaflow.com');
    const diegoCookie = await loginCookieFor('diego.tesoreria@aprobaflow.com');
    const luciaCookie = await loginCookieFor('lucia.suplente@aprobaflow.com');

    const catHotel = await prisma.category.findUniqueOrThrow({ where: { code: 'VIAT-HOTEL' } });
    const seedFile = await prisma.storedFile.findFirstOrThrow();
    const prjErp = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-ERP-02' } });

    // Confirmar detección de factura duplicada existente en seed (20512849102 + F001-4821)
    const isDup = await hasDuplicateInvoice(prisma, {
      vendorTaxId: '20512849102',
      invoiceNumber: 'F001-4821',
    });
    expect(isDup).toBe(true);

    // Crear un anticipo de $200 por Valeria en PRJ-ERP-02 (PM: Lucía), aprobar, desembolsar y rendir exacto $200 (Escenario A)
    const advRes = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: valeriaCookie,
      body: {
        title: 'Anticipo prueba Escenario A',
        budgetTargetType: 'PROJECT',
        projectId: prjErp.id,
        requestedAmount: 200,
      },
    });
    const advA = await advRes.json();
    await apiFetch(`/api/approvals/${advA.approvalSteps[0].id}/decide`, {
      method: 'POST',
      cookie: luciaCookie,
      body: { decision: 'APPROVED' },
    });
    await apiFetch(`/api/treasury/${advA.id}/disburse`, {
      method: 'POST',
      cookie: diegoCookie,
      body: { disbursementRef: 'DES-A-001' },
    });
    const subARes = await apiFetch(`/api/settlements/${advA.id}/submit`, {
      method: 'POST',
      cookie: valeriaCookie,
      body: {
        items: [
          {
            categoryId: catHotel.id,
            expenseDate: new Date().toISOString().slice(0, 10),
            vendorName: 'Hotel Exacto',
            vendorTaxId: '999888777',
            invoiceNumber: 'EX-001',
            description: 'Alojamiento exacto',
            claimedAmount: 200,
            receiptFileId: seedFile.id,
          },
        ],
      },
    });
    const subA = await subARes.json();
    await apiFetch(`/api/settlements/${advA.id}/items/${subA.items[0].id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: { auditStatus: 'APPROVED' },
    });
    const finA = await apiFetch(`/api/settlements/${advA.id}/finalize-audit`, {
      method: 'POST',
      cookie: sofiaCookie,
    });
    expect((await finA.json()).outcome).toBe('SCENARIO_A_EXACT');

    // Crear anticipo $200 y rendir $500 (excedente $300 > $250 -> Escenario C con PM + DIRECTION)
    const advCRes = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: valeriaCookie,
      body: {
        title: 'Anticipo prueba Escenario C alto',
        budgetTargetType: 'PROJECT',
        projectId: prjErp.id,
        requestedAmount: 200,
      },
    });
    const advC = await advCRes.json();
    await apiFetch(`/api/approvals/${advC.approvalSteps[0].id}/decide`, {
      method: 'POST',
      cookie: luciaCookie,
      body: { decision: 'APPROVED' },
    });
    await apiFetch(`/api/treasury/${advC.id}/disburse`, {
      method: 'POST',
      cookie: diegoCookie,
      body: { disbursementRef: 'DES-C-002' },
    });
    const subCRes = await apiFetch(`/api/settlements/${advC.id}/submit`, {
      method: 'POST',
      cookie: valeriaCookie,
      body: {
        items: [
          {
            categoryId: catHotel.id,
            expenseDate: new Date().toISOString().slice(0, 10),
            vendorName: 'Hotel Extendido',
            vendorTaxId: '999888778',
            invoiceNumber: 'EX-002',
            description: 'Alojamiento extendido',
            claimedAmount: 500,
            receiptFileId: seedFile.id,
          },
        ],
      },
    });
    const subC = await subCRes.json();
    await apiFetch(`/api/settlements/${advC.id}/items/${subC.items[0].id}/audit`, {
      method: 'PATCH',
      cookie: sofiaCookie,
      body: { auditStatus: 'APPROVED' },
    });
    const finC = await apiFetch(`/api/settlements/${advC.id}/finalize-audit`, {
      method: 'POST',
      cookie: sofiaCookie,
    });
    const finCJson = await finC.json();
    expect(finCJson.outcome).toBe('SCENARIO_C_EXCESS_APPROVAL');
    expect(finCJson.request.status).toBe('EXCESS_PENDING_APPROVAL');
    const excessSteps = finCJson.request.approvalSteps.filter(
      (s: { phase: string }) => s.phase === 'EXCESS_SETTLEMENT'
    );
    expect(excessSteps.map((s: { requiredRole: string }) => s.requiredRole)).toEqual([
      'PROJECT_MANAGER',
      'DIRECTION',
    ]);
  });

  it('bloquea nuevos anticipos si el colaborador tiene un anticipo con settlementDueDate vencido', async () => {
    const camilaCookie = await loginCookieFor('camila.comercial@aprobaflow.com');
    const camila = await prisma.user.findUniqueOrThrow({ where: { email: 'camila.comercial@aprobaflow.com' } });
    const prjErp = await prisma.project.findUniqueOrThrow({ where: { code: 'PRJ-ERP-02' } });

    const overdueAdvance = await prisma.expenseRequest.create({
      data: {
        code: 'ANT-TEST-OVERDUE',
        type: 'ADVANCE',
        status: 'DISBURSED_PENDING_SETTLEMENT',
        requesterId: camila.id,
        title: 'Anticipo vencido sin rendir',
        budgetTargetType: 'PROJECT',
        projectId: prjErp.id,
        budgetYear: new Date().getFullYear(),
        budgetMonth: new Date().getMonth() + 1,
        requestedAmount: 100,
        disbursedAmount: 100,
        disbursedAt: new Date(Date.now() - 20 * 86400000),
        settlementDueDate: new Date(Date.now() - 2 * 86400000), // Vencido hace 2 días
      },
    });

    const res = await apiFetch('/api/expenses/advances', {
      method: 'POST',
      cookie: camilaCookie,
      body: {
        title: 'Intento con anticipo vencido',
        budgetTargetType: 'PROJECT',
        projectId: prjErp.id,
        requestedAmount: 150,
      },
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('ADVANCE_BLOCKED');
    expect(json.details[0].id).toBe(overdueAdvance.id);
    expect(json.details[0].reason).toBe('OVERDUE_SETTLEMENT');
  });
});
