import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { apiFetch, loginCookieFor, resetAndSeed } from './test-helpers';

describe('API RBAC, Secure Files & Treasury/Audit Exports', () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it('protege endpoints con 401 sin sesión y aplica RBAC 403 entre roles', async () => {
    const unauth = await apiFetch('/api/expenses');
    expect(unauth.status).toBe(401);

    const valeriaCookie = await loginCookieFor('valeria.consultora@aprobaflow.com');
    const treasuryRes = await apiFetch('/api/treasury/queue', { cookie: valeriaCookie });
    expect(treasuryRes.status).toBe(403);

    const auditRes = await apiFetch('/api/audit', { cookie: valeriaCookie });
    expect(auditRes.status).toBe(403);
  });

  it('permite subir comprobante validado y lo sirve solo a usuarios autorizados', async () => {
    const valeriaCookie = await loginCookieFor('valeria.consultora@aprobaflow.com');
    const camilaCookie = await loginCookieFor('camila.comercial@aprobaflow.com');
    const sofiaCookie = await loginCookieFor('sofia.finanzas@aprobaflow.com');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'ticket.png');
    form.append('purpose', 'RECEIPT');

    const upRes = await apiFetch('/api/files/upload', {
      method: 'POST',
      cookie: valeriaCookie,
      body: form,
    });
    expect(upRes.status).toBe(200);
    const uploaded = await upRes.json();
    expect(uploaded.id).toBeTruthy();

    // Valeria (dueña) y Sofía (Finanzas) pueden verlo
    expect((await apiFetch(`/api/files/${uploaded.id}`, { cookie: valeriaCookie })).status).toBe(200);
    expect((await apiFetch(`/api/files/${uploaded.id}`, { cookie: sofiaCookie })).status).toBe(200);
    // Camila (otro empleado sin relación) recibe 403
    expect((await apiFetch(`/api/files/${uploaded.id}`, { cookie: camilaCookie })).status).toBe(403);
  });

  it('genera reporte Excel (.xlsx) y CSV válido para Tesorería + CSV de Auditoría', async () => {
    const diegoCookie = await loginCookieFor('diego.tesoreria@aprobaflow.com');

    const xlsxRes = await apiFetch('/api/treasury/export?format=xlsx', { cookie: diegoCookie });
    expect(xlsxRes.status).toBe(200);
    expect(xlsxRes.headers.get('content-type')).toContain('spreadsheetml.sheet');

    const arrayBuf = await xlsxRes.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(arrayBuf);
    const sheet = wb.getWorksheet('Conciliación Tesorería');
    expect(sheet).toBeTruthy();
    const headerRow = sheet!.getRow(4);
    expect(headerRow.getCell(1).value).toBe('Código');
    expect(headerRow.getCell(12).value).toBe('Monto Anticipado (USD)');
    expect(headerRow.getCell(13).value).toBe('Gastos Validados (USD)');
    expect(headerRow.getCell(14).value).toBe('Monto Neto Final (USD)');
    expect(sheet!.rowCount).toBeGreaterThan(5);

    const csvRes = await apiFetch('/api/treasury/export?format=csv', { cookie: diegoCookie });
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toContain('Monto Neto Final (USD)');

    const auditCsvRes = await apiFetch('/api/audit/export', { cookie: diegoCookie });
    expect(auditCsvRes.status).toBe(200);
    const auditCsvText = await auditCsvRes.text();
    expect(auditCsvText).toContain('En Reemplazo De');
  });
});
