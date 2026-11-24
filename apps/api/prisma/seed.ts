import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { hashPassword } from '../src/lib/auth';
import { getUploadDir } from '../src/lib/env';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://aprobaflow:aprobaflow_secret@127.0.0.1:5432/aprobaflow?schema=public';

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createSampleReceiptPng(accentRgb: [number, number, number]): Buffer {
  const width = 420;
  const height = 260;
  const raw = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      let r = 248;
      let g = 250;
      let b = 252;

      // White card interior
      if (x >= 16 && x < width - 16 && y >= 16 && y < height - 16) {
        r = 255;
        g = 255;
        b = 255;
      }
      // Header bar
      if (x >= 16 && x < width - 16 && y >= 16 && y < 60) {
        [r, g, b] = accentRgb;
      }
      // Receipt simulated text lines
      const isLine =
        (y >= 82 && y <= 88 && x >= 36 && x <= 260) ||
        (y >= 104 && y <= 108 && x >= 36 && x <= 320) ||
        (y >= 122 && y <= 126 && x >= 36 && x <= 290) ||
        (y >= 140 && y <= 144 && x >= 36 && x <= 340) ||
        (y >= 184 && y <= 192 && x >= 240 && x <= 380);
      if (isLine) {
        r = 51;
        g = 65;
        b = 85;
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function createSampleReceiptPdf(title: string, detail: string, total: string): Buffer {
  const safe = (s: string) => s.replace(/[()\\]/g, '');
  const streamContent = `BT
/F1 16 Tf
50 740 Td
(${safe(title)}) Tj
/F1 11 Tf
0 -28 Td
(${safe(detail)}) Tj
0 -24 Td
(TOTAL COMPROBANTE: ${safe(total)}) Tj
ET`;

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(streamContent, 'utf8')} >> stream\n${streamContent}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${obj}\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export async function seedDatabase() {
  const uploadDir = getUploadDir();

  // Clean existing records in reverse FK order for deterministic seed state
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.approvalStep.deleteMany();
  await prisma.expenseItem.deleteMany();
  await prisma.expenseRequest.deleteMany();
  await prisma.storedFile.deleteMany();
  await prisma.approvalDelegation.deleteMany();
  await prisma.approvalRule.deleteMany();
  await prisma.projectAssignment.deleteMany();
  await prisma.project.deleteMany();
  await prisma.departmentBudget.deleteMany();
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.category.deleteMany();
  await prisma.systemConfig.deleteMany();
  await prisma.codeCounter.deleteMany();

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
  const daysAhead = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

  // 1. System Config
  await prisma.systemConfig.create({
    data: {
      id: 'singleton',
      budgetAlertThresholdPct: 85,
      stalledHoursThreshold: 48,
      advanceSettlementDueDays: 15,
      excessToleranceUsd: 50.0,
      excessMediumMaxUsd: 250.0,
    },
  });

  // 2. Branches (3 cities)
  const [bog, cdmx, lim] = await Promise.all([
    prisma.branch.create({
      data: { code: 'BOG', name: 'Filial Bogotá', city: 'Bogotá', country: 'Colombia' },
    }),
    prisma.branch.create({
      data: { code: 'CDMX', name: 'Filial Ciudad de México', city: 'Ciudad de México', country: 'México' },
    }),
    prisma.branch.create({
      data: { code: 'LIM', name: 'Filial Lima', city: 'Lima', country: 'Perú' },
    }),
  ]);

  // 3. Departments (5 cost centers)
  const [deptCons, deptIt, deptCom, deptRrhh, deptAdm] = await Promise.all([
    prisma.department.create({ data: { code: 'CONS', name: 'Consultoría' } }),
    prisma.department.create({ data: { code: 'IT', name: 'Tecnología (IT)' } }),
    prisma.department.create({ data: { code: 'COM', name: 'Comercial' } }),
    prisma.department.create({ data: { code: 'RRHH', name: 'Recursos Humanos' } }),
    prisma.department.create({ data: { code: 'ADM', name: 'Administración y Finanzas' } }),
  ]);

  // 4. Users (10 representative users)
  const commonPasswordHash = await hashPassword('Demo1234!');

  const admin = await prisma.user.create({
    data: {
      email: 'admin@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Ricardo Navarro',
      employeeCode: 'EMP-001',
      jobTitle: 'Administrador de Plataforma',
      branchId: bog.id,
      departmentId: deptAdm.id,
      roles: ['ADMIN', 'EMPLOYEE'],
      bankName: 'Bancolombia',
      bankAccountNumber: '****-4011',
    },
  });

  const elena = await prisma.user.create({
    data: {
      email: 'elena.direccion@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Elena Morales',
      employeeCode: 'EMP-002',
      jobTitle: 'Directora Administrativa',
      branchId: bog.id,
      departmentId: deptAdm.id,
      roles: ['DIRECTION', 'MANAGER', 'EMPLOYEE'],
      bankName: 'Bancolombia',
      bankAccountNumber: '****-8820',
    },
  });

  const sofia = await prisma.user.create({
    data: {
      email: 'sofia.finanzas@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Sofía Vargas',
      employeeCode: 'EMP-003',
      jobTitle: 'Analista Senior de Finanzas',
      branchId: bog.id,
      departmentId: deptAdm.id,
      managerId: elena.id,
      roles: ['FINANCE', 'EMPLOYEE'],
      bankName: 'Davivienda',
      bankAccountNumber: '****-1904',
    },
  });

  const diego = await prisma.user.create({
    data: {
      email: 'diego.tesoreria@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Diego Ramírez',
      employeeCode: 'EMP-004',
      jobTitle: 'Jefe de Tesorería',
      branchId: cdmx.id,
      departmentId: deptAdm.id,
      managerId: elena.id,
      roles: ['TREASURY', 'EMPLOYEE'],
      bankName: 'BBVA México',
      bankAccountNumber: '****-5532',
    },
  });

  const carlos = await prisma.user.create({
    data: {
      email: 'carlos.gerente@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Carlos Pérez',
      employeeCode: 'EMP-005',
      jobTitle: 'Gerente de Consultoría',
      branchId: bog.id,
      departmentId: deptCons.id,
      managerId: elena.id,
      roles: ['MANAGER', 'EMPLOYEE'],
      bankName: 'Bancolombia',
      bankAccountNumber: '****-7719',
    },
  });

  const lucia = await prisma.user.create({
    data: {
      email: 'lucia.suplente@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Lucía Mendoza',
      employeeCode: 'EMP-006',
      jobTitle: 'Gerente de Proyectos (Suplente)',
      branchId: cdmx.id,
      departmentId: deptCons.id,
      managerId: elena.id,
      roles: ['MANAGER', 'EMPLOYEE'],
      bankName: 'Santander MX',
      bankAccountNumber: '****-3201',
    },
  });

  const mateo = await prisma.user.create({
    data: {
      email: 'mateo.it@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Mateo Silva',
      employeeCode: 'EMP-007',
      jobTitle: 'Jefe de Tecnología (IT)',
      branchId: lim.id,
      departmentId: deptIt.id,
      managerId: elena.id,
      roles: ['MANAGER', 'SPECIAL_APPROVER_IT', 'EMPLOYEE'],
      bankName: 'BCP Perú',
      bankAccountNumber: '****-6140',
    },
  });

  const valeria = await prisma.user.create({
    data: {
      email: 'valeria.consultora@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Valeria Castro',
      employeeCode: 'EMP-008',
      jobTitle: 'Consultora Senior',
      branchId: bog.id,
      departmentId: deptCons.id,
      managerId: carlos.id,
      roles: ['EMPLOYEE'],
      bankName: 'Bancolombia',
      bankAccountNumber: '****-9045',
    },
  });

  const andres = await prisma.user.create({
    data: {
      email: 'andres.consultor@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Andrés Ruiz',
      employeeCode: 'EMP-009',
      jobTitle: 'Consultor Cloud',
      branchId: cdmx.id,
      departmentId: deptCons.id,
      managerId: carlos.id,
      roles: ['EMPLOYEE'],
      bankName: 'BBVA México',
      bankAccountNumber: '****-2388',
    },
  });

  const camila = await prisma.user.create({
    data: {
      email: 'camila.comercial@aprobaflow.com',
      passwordHash: commonPasswordHash,
      fullName: 'Camila Rojas',
      employeeCode: 'EMP-010',
      jobTitle: 'Ejecutiva Comercial',
      branchId: lim.id,
      departmentId: deptCom.id,
      managerId: elena.id,
      roles: ['EMPLOYEE'],
      bankName: 'Interbank Perú',
      bankAccountNumber: '****-1127',
    },
  });

  await Promise.all([
    prisma.department.update({ where: { id: deptCons.id }, data: { headUserId: carlos.id } }),
    prisma.department.update({ where: { id: deptIt.id }, data: { headUserId: mateo.id } }),
    prisma.department.update({ where: { id: deptCom.id }, data: { headUserId: elena.id } }),
    prisma.department.update({ where: { id: deptRrhh.id }, data: { headUserId: elena.id } }),
    prisma.department.update({ where: { id: deptAdm.id }, data: { headUserId: elena.id } }),
  ]);

  // 5. 12 Monthly Budgets per Department for current year
  const deptMonthlyDefault: Record<string, number> = {
    [deptCons.id]: 18000,
    [deptIt.id]: 12000,
    [deptCom.id]: 2000, // Comercial at $2,000 -> $1,740 spent = 87% alert!
    [deptRrhh.id]: 6000,
    [deptAdm.id]: 10000,
  };

  const budgetRows = [];
  for (const [departmentId, amount] of Object.entries(deptMonthlyDefault)) {
    for (let month = 1; month <= 12; month++) {
      budgetRows.push({ departmentId, year: currentYear, month, amount });
    }
  }
  await prisma.departmentBudget.createMany({ data: budgetRows });

  // 6. Projects (4) & Active Assignments
  const prjCloud = await prisma.project.create({
    data: {
      code: 'PRJ-CLOUD-01',
      name: 'Migración Cloud - Banco Andino',
      clientName: 'Banco Andino S.A.',
      managerId: carlos.id,
      totalBudget: 45000.0,
      startDate: daysAgo(90),
      endDate: daysAhead(120),
      status: 'ACTIVE',
    },
  });

  const prjErp = await prisma.project.create({
    data: {
      code: 'PRJ-ERP-02',
      name: 'Implementación ERP - Grupo Pacífico',
      clientName: 'Grupo Pacífico',
      managerId: lucia.id,
      totalBudget: 30000.0,
      startDate: daysAgo(60),
      endDate: daysAhead(150),
      status: 'ACTIVE',
    },
  });

  const prjSec = await prisma.project.create({
    data: {
      code: 'PRJ-SEC-03',
      name: 'Auditoría Seguridad - FinTech Sur',
      clientName: 'FinTech Sur',
      managerId: mateo.id,
      totalBudget: 15000.0,
      startDate: daysAgo(45),
      endDate: daysAhead(60),
      status: 'ACTIVE',
    },
  });

  const prjData = await prisma.project.create({
    data: {
      code: 'PRJ-DATA-04',
      name: 'Analítica Retail - Tiendas Norte',
      clientName: 'Tiendas Norte',
      managerId: carlos.id,
      totalBudget: 22000.0,
      startDate: daysAgo(30),
      endDate: daysAhead(180),
      status: 'ACTIVE',
    },
  });

  await prisma.projectAssignment.createMany({
    data: [
      { projectId: prjCloud.id, userId: valeria.id },
      { projectId: prjCloud.id, userId: andres.id },
      { projectId: prjErp.id, userId: valeria.id },
      { projectId: prjErp.id, userId: camila.id },
      { projectId: prjSec.id, userId: andres.id },
      { projectId: prjSec.id, userId: mateo.id },
      { projectId: prjData.id, userId: andres.id },
    ],
  });

  // 7. Categories
  const [catHotel, catComida, catTransp, catVuelos, catItSw, catItHw, catOficina, catClientes] =
    await Promise.all([
      prisma.category.create({
        data: { code: 'VIAT-HOTEL', name: 'Hoteles y Alojamiento', accountCode: '5101-01' },
      }),
      prisma.category.create({
        data: { code: 'VIAT-COMIDA', name: 'Alimentación y Viáticos', accountCode: '5101-02' },
      }),
      prisma.category.create({
        data: { code: 'TRANSP', name: 'Transporte y Taxis', accountCode: '5101-03' },
      }),
      prisma.category.create({
        data: { code: 'VUELOS', name: 'Pasajes Aéreos', accountCode: '5101-04' },
      }),
      prisma.category.create({
        data: {
          code: 'IT-SW',
          name: 'Licencias y Software',
          accountCode: '5201-01',
          specialTag: 'IT',
        },
      }),
      prisma.category.create({
        data: {
          code: 'IT-HW',
          name: 'Equipamiento Tecnológico',
          accountCode: '5201-02',
          specialTag: 'IT',
        },
      }),
      prisma.category.create({
        data: { code: 'OFICINA', name: 'Insumos de Oficina', accountCode: '5301-01' },
      }),
      prisma.category.create({
        data: { code: 'CLIENTES', name: 'Atención a Clientes', accountCode: '5401-01' },
      }),
    ]);

  // 8. Configurable Approval Rules (BRD Matrix)
  await prisma.approvalRule.createMany({
    data: [
      {
        name: 'Reembolso Directo <= $50 USD',
        requestType: 'REIMBURSEMENT',
        minAmount: 0,
        maxAmount: 50.0,
        approverChain: ['DIRECT_MANAGER'],
        allowAutoApprove: false,
        priority: 10,
      },
      {
        name: 'Reembolso Directo > $50 USD',
        requestType: 'REIMBURSEMENT',
        minAmount: 50.01,
        maxAmount: null,
        approverChain: ['DIRECT_MANAGER', 'FINANCE'],
        allowAutoApprove: false,
        priority: 20,
      },
      {
        name: 'Anticipo de Fondos < $500 USD',
        requestType: 'ADVANCE',
        minAmount: 0,
        maxAmount: 499.99,
        approverChain: ['DIRECT_MANAGER'],
        allowAutoApprove: false,
        priority: 10,
      },
      {
        name: 'Anticipo de Fondos >= $500 USD',
        requestType: 'ADVANCE',
        minAmount: 500.0,
        maxAmount: null,
        approverChain: ['DIRECT_MANAGER', 'FINANCE'],
        allowAutoApprove: false,
        priority: 20,
      },
      {
        name: 'Compras Especiales IT > $1,000 USD (Reembolso)',
        requestType: 'REIMBURSEMENT',
        categorySpecialTag: 'IT',
        minAmount: 1000.01,
        maxAmount: null,
        approverChain: ['DIRECT_MANAGER', 'SPECIAL_IT', 'FINANCE'],
        allowAutoApprove: false,
        priority: 5,
      },
      {
        name: 'Compras Especiales IT > $1,000 USD (Anticipo)',
        requestType: 'ADVANCE',
        categorySpecialTag: 'IT',
        minAmount: 1000.01,
        maxAmount: null,
        approverChain: ['DIRECT_MANAGER', 'SPECIAL_IT', 'FINANCE'],
        allowAutoApprove: false,
        priority: 5,
      },
      {
        name: 'Excedente Tolerancia <= $50 USD',
        requestType: 'EXCESS',
        minAmount: 0,
        maxAmount: 50.0,
        approverChain: [],
        allowAutoApprove: true,
        priority: 10,
      },
      {
        name: 'Excedente Medio $50.01 - $250 USD',
        requestType: 'EXCESS',
        minAmount: 50.01,
        maxAmount: 250.0,
        approverChain: ['DIRECT_MANAGER'],
        allowAutoApprove: false,
        priority: 20,
      },
      {
        name: 'Excedente Alto > $250 USD',
        requestType: 'EXCESS',
        minAmount: 250.01,
        maxAmount: null,
        approverChain: ['DIRECT_MANAGER', 'DIRECTION'],
        allowAutoApprove: false,
        priority: 30,
      },
    ],
  });

  // 9. Active Delegation: Carlos Pérez -> Lucía Mendoza (Vacaciones)
  const delegationCarlos = await prisma.approvalDelegation.create({
    data: {
      delegatorId: carlos.id,
      delegateId: lucia.id,
      startDate: daysAgo(2),
      endDate: daysAhead(12),
      reason: 'Vacaciones',
      isActive: true,
      createdById: carlos.id,
    },
  });

  // 10. Sample Stored Receipt Files (real PNG & PDF files on disk)
  const writeSeedFile = async (
    storedName: string,
    originalName: string,
    mimeType: string,
    bytes: Buffer,
    uploadedById: string
  ) => {
    const filePath = path.join(uploadDir, storedName);
    fs.writeFileSync(filePath, bytes);
    return prisma.storedFile.create({
      data: {
        originalName,
        storedName,
        mimeType,
        sizeBytes: bytes.length,
        storagePath: storedName,
        purpose: 'RECEIPT',
        uploadedById,
      },
    });
  };

  const [fileTaxi, fileHotelPdf, fileCenaPng, fileTaxiPng, fileItPdf] = await Promise.all([
    writeSeedFile(
      'seed-taxi-001.png',
      'recibo_taxi_aeropuerto.png',
      'image/png',
      createSampleReceiptPng([37, 99, 235]),
      valeria.id
    ),
    writeSeedFile(
      'seed-hotel-002.pdf',
      'factura_hotel_pacifico_F001-4821.pdf',
      'application/pdf',
      createSampleReceiptPdf(
        'HOTEL PACIFICO CORPORATIVO S.A.',
        'RUC 20512849102 - Factura F001-4821 - 3 noches alojamiento',
        '$380.00 USD'
      ),
      valeria.id
    ),
    writeSeedFile(
      'seed-cena-003.png',
      'factura_restaurante_cena_cliente.png',
      'image/png',
      createSampleReceiptPng([217, 119, 6]),
      valeria.id
    ),
    writeSeedFile(
      'seed-movilidad-004.png',
      'comprobante_uber_corporativo.png',
      'image/png',
      createSampleReceiptPng([16, 185, 129]),
      valeria.id
    ),
    writeSeedFile(
      'seed-hw-005.pdf',
      'cotizacion_workstation_dell.pdf',
      'application/pdf',
      createSampleReceiptPdf(
        'TECH SUPPLY LATAM S.A.C.',
        'NIT 900812344-1 - Factura FE-9910 - Estación de trabajo portátil',
        '$1,250.00 USD'
      ),
      mateo.id
    ),
  ]);

  // 11. Seeded Expense Requests covering ALL scenarios
  // Scenario 1: Reembolso <= $50 routed to Carlos -> active delegation to Lucía
  const ree1 = await prisma.expenseRequest.create({
    data: {
      code: `REE-${currentYear}-0001`,
      type: 'REIMBURSEMENT',
      status: 'PENDING_APPROVAL',
      requesterId: valeria.id,
      title: 'Taxi traslado a sede Banco Andino',
      description: 'Traslado urgente para reunión de arquitectura cloud con el cliente.',
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 42.0,
      budgetUsagePctAtSubmit: 16.2,
      currentStepEnteredAt: hoursAgo(8),
      items: {
        create: [
          {
            categoryId: catTransp.id,
            expenseDate: daysAgo(1),
            vendorName: 'Cooperativa Taxis Express',
            vendorTaxId: '900112233-1',
            invoiceNumber: 'TX-88412',
            description: 'Carrera desde oficina norte a torre Banco Andino',
            claimedAmount: 42.0,
            receiptFileId: fileTaxi.id,
          },
        ],
      },
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'PROJECT_MANAGER',
            assignedApproverId: carlos.id,
            delegatedToUserId: lucia.id,
            delegationId: delegationCarlos.id,
            status: 'PENDING',
            enteredAt: hoursAgo(8),
          },
        ],
      },
    },
  });

  // Scenario 2: Anticipo $850 STALLED > 48h (62h waiting in Finance)
  const ant2 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0002`,
      type: 'ADVANCE',
      status: 'PENDING_APPROVAL',
      requesterId: valeria.id,
      title: 'Viaje implementación Cloud Fase 2 (Medellín)',
      description: 'Anticipo para vuelos, hospedaje 4 noches y viáticos de consultoría.',
      travelStartDate: daysAhead(4),
      travelEndDate: daysAhead(8),
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 850.0,
      budgetUsagePctAtSubmit: 18.1,
      currentStepEnteredAt: hoursAgo(62),
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'PROJECT_MANAGER',
            assignedApproverId: carlos.id,
            actedByUserId: carlos.id,
            status: 'APPROVED',
            comment: 'Aprobado conforme cronograma del proyecto.',
            enteredAt: hoursAgo(74),
            actedAt: hoursAgo(62),
            ipAddress: '190.24.112.18',
          },
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 2,
            requiredRole: 'FINANCE',
            status: 'PENDING',
            enteredAt: hoursAgo(62),
          },
        ],
      },
    },
  });

  // Scenario 3: Departamento Comercial at 87% ($1,740 of $2,000)
  const ree3 = await prisma.expenseRequest.create({
    data: {
      code: `REE-${currentYear}-0003`,
      type: 'REIMBURSEMENT',
      status: 'CLOSED_SETTLED',
      requesterId: camila.id,
      title: 'Desayuno ejecutivo y material comercial Q4',
      description: 'Cierre de evento de prospección con cuentas corporativas en Lima.',
      budgetTargetType: 'DEPARTMENT',
      departmentId: deptCom.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 1740.0,
      approvedAmount: 1740.0,
      netSettlementAmount: 1740.0,
      budgetAlert85Triggered: true,
      budgetUsagePctAtSubmit: 87.0,
      paymentExecutedAt: daysAgo(3),
      paymentRef: 'TRF-LIM-2026-441',
      items: {
        create: [
          {
            categoryId: catClientes.id,
            expenseDate: daysAgo(6),
            vendorName: 'Centro Empresarial Lima',
            vendorTaxId: '20499812311',
            invoiceNumber: 'F002-1190',
            description: 'Alquiler de sala y catering desayuno corporativo',
            claimedAmount: 1740.0,
            approvedAmount: 1740.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: daysAgo(4),
          },
        ],
      },
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'DIRECT_MANAGER',
            assignedApproverId: elena.id,
            actedByUserId: elena.id,
            status: 'APPROVED',
            comment: 'Autorizado para evento comercial estratégico.',
            enteredAt: daysAgo(6),
            actedAt: daysAgo(5),
            ipAddress: '181.55.12.90',
          },
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 2,
            requiredRole: 'FINANCE',
            actedByUserId: sofia.id,
            status: 'APPROVED',
            comment: 'Validado con alerta >85% en presupuesto Comercial.',
            enteredAt: daysAgo(5),
            actedAt: daysAgo(4),
            ipAddress: '181.55.12.44',
          },
        ],
      },
    },
  });

  // Scenario 4: Anticipo $600 en SETTLEMENT_IN_REVIEW con 3 ítems para auditar por Finanzas
  const ant4 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0004`,
      type: 'ADVANCE',
      status: 'SETTLEMENT_IN_REVIEW',
      requesterId: valeria.id,
      title: 'Visita técnica arranque ERP Grupo Pacífico',
      description: 'Viaje de levantamiento de procesos en planta.',
      travelStartDate: daysAgo(9),
      travelEndDate: daysAgo(5),
      budgetTargetType: 'PROJECT',
      projectId: prjErp.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 600.0,
      disbursedAmount: 600.0,
      renderedAmount: 545.0,
      budgetUsagePctAtSubmit: 3.8,
      disbursedAt: daysAgo(11),
      disbursementRef: 'DES-BOG-2026-089',
      settlementDueDate: daysAhead(4),
      currentStepEnteredAt: hoursAgo(14),
      items: {
        create: [
          {
            categoryId: catHotel.id,
            expenseDate: daysAgo(8),
            vendorName: 'Hotel Pacífico Corporativo',
            vendorTaxId: '20512849102',
            invoiceNumber: 'F001-4821',
            description: '3 noches de alojamiento tarifa corporativa',
            claimedAmount: 380.0,
            auditStatus: 'PENDING',
            receiptFileId: fileHotelPdf.id,
          },
          {
            categoryId: catComida.id,
            expenseDate: daysAgo(7),
            vendorName: 'Restaurante La Brasa',
            vendorTaxId: '20588771234',
            invoiceNumber: 'B004-982',
            description: 'Cena de trabajo ($95 alimentación + $25 bebidas alcohólicas de bar)',
            claimedAmount: 120.0,
            auditStatus: 'PENDING',
            receiptFileId: fileCenaPng.id,
          },
          {
            categoryId: catTransp.id,
            expenseDate: daysAgo(6),
            vendorName: 'Movilidad Urbana S.A.',
            vendorTaxId: '20600112233',
            invoiceNumber: 'E001-5521',
            description: 'Traslados aeropuerto - planta cliente - hotel',
            claimedAmount: 45.0,
            auditStatus: 'PENDING',
            receiptFileId: fileTaxiPng.id,
          },
        ],
      },
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'PROJECT_MANAGER',
            assignedApproverId: lucia.id,
            actedByUserId: lucia.id,
            status: 'APPROVED',
            enteredAt: daysAgo(13),
            actedAt: daysAgo(12),
          },
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 2,
            requiredRole: 'FINANCE',
            actedByUserId: sofia.id,
            status: 'APPROVED',
            enteredAt: daysAgo(12),
            actedAt: daysAgo(11),
          },
        ],
      },
    },
  });

  // Scenario 5: Escenario B (PENDING_RETURN $120.00) -> bloquea nuevos anticipos para Andrés
  const ant5 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0005`,
      type: 'ADVANCE',
      status: 'PENDING_RETURN',
      requesterId: andres.id,
      title: 'Taller arquitectura Data Retail (Monterrey)',
      description: 'Viáticos de taller presencial con equipo de datos.',
      travelStartDate: daysAgo(14),
      travelEndDate: daysAgo(11),
      budgetTargetType: 'PROJECT',
      projectId: prjData.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 500.0,
      disbursedAmount: 500.0,
      renderedAmount: 430.0,
      approvedAmount: 380.0,
      netSettlementAmount: -120.0,
      disbursedAt: daysAgo(16),
      disbursementRef: 'DES-CDMX-2026-104',
      settlementDueDate: daysAgo(1),
      currentStepEnteredAt: daysAgo(2),
      items: {
        create: [
          {
            categoryId: catVuelos.id,
            expenseDate: daysAgo(14),
            vendorName: 'Aeroméxico Corporativo',
            vendorTaxId: 'AME880912I89',
            invoiceNumber: 'AM-772109',
            description: 'Vuelo redondo CDMX - MTY',
            claimedAmount: 380.0,
            approvedAmount: 380.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: daysAgo(2),
          },
          {
            categoryId: catComida.id,
            expenseDate: daysAgo(12),
            vendorName: 'Snack Bar Hotel',
            vendorTaxId: 'SBH990101AA1',
            invoiceNumber: 'SB-102',
            description: 'Minibar personal no cubierto por política',
            claimedAmount: 50.0,
            approvedAmount: 0.0,
            auditStatus: 'REJECTED',
            auditNote: 'Gasto personal (minibar) excluido por política de viáticos.',
            auditedById: sofia.id,
            auditedAt: daysAgo(2),
          },
        ],
      },
    },
  });

  // Scenario 6: Escenario C (EXCESS_PENDING_APPROVAL $180.00)
  const ant6 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0006`,
      type: 'ADVANCE',
      status: 'EXCESS_PENDING_APPROVAL',
      requesterId: valeria.id,
      title: 'Soporte en sitio cierre fase ERP Pacífico',
      description: 'Extensión de 1 día adicional solicitada por el cliente.',
      travelStartDate: daysAgo(12),
      travelEndDate: daysAgo(8),
      budgetTargetType: 'PROJECT',
      projectId: prjErp.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 400.0,
      disbursedAmount: 400.0,
      renderedAmount: 580.0,
      approvedAmount: 580.0,
      netSettlementAmount: 180.0,
      disbursedAt: daysAgo(14),
      disbursementRef: 'DES-BOG-2026-077',
      currentStepEnteredAt: hoursAgo(20),
      items: {
        create: [
          {
            categoryId: catHotel.id,
            expenseDate: daysAgo(10),
            vendorName: 'Hotel Pacífico Corporativo',
            vendorTaxId: '20512849102',
            invoiceNumber: 'F001-4799',
            description: '4 noches (incluye 1 noche extra aprobada por contingencia)',
            claimedAmount: 460.0,
            approvedAmount: 460.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: hoursAgo(20),
          },
          {
            categoryId: catComida.id,
            expenseDate: daysAgo(9),
            vendorName: 'Restaurante Central',
            vendorTaxId: '20511223344',
            invoiceNumber: 'F010-221',
            description: 'Alimentación durante jornada extendida',
            claimedAmount: 120.0,
            approvedAmount: 120.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: hoursAgo(20),
          },
        ],
      },
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'PROJECT_MANAGER',
            assignedApproverId: lucia.id,
            actedByUserId: lucia.id,
            status: 'APPROVED',
            enteredAt: daysAgo(15),
            actedAt: daysAgo(14),
          },
          {
            phase: 'EXCESS_SETTLEMENT',
            stepOrder: 1,
            requiredRole: 'PROJECT_MANAGER',
            assignedApproverId: lucia.id,
            status: 'PENDING',
            enteredAt: hoursAgo(20),
          },
        ],
      },
    },
  });

  // Scenario 7: Ready for Disbursement (Treasury) — IT purchase > $1,000
  const ant7 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0007`,
      type: 'ADVANCE',
      status: 'READY_FOR_DISBURSEMENT',
      requesterId: mateo.id,
      title: 'Compra estación de trabajo laboratorio IT',
      description: 'Adquisición de equipo de pruebas de seguridad.',
      budgetTargetType: 'DEPARTMENT',
      departmentId: deptIt.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 1250.0,
      budgetUsagePctAtSubmit: 10.4,
      currentStepEnteredAt: hoursAgo(10),
      items: {
        create: [
          {
            categoryId: catItHw.id,
            expenseDate: daysAgo(2),
            vendorName: 'Tech Supply Latam',
            vendorTaxId: '900812344-1',
            invoiceNumber: 'COT-9910',
            description: 'Workstation portátil 64GB RAM para pruebas',
            claimedAmount: 1250.0,
            receiptFileId: fileItPdf.id,
          },
        ],
      },
      approvalSteps: {
        create: [
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 1,
            requiredRole: 'DIRECT_MANAGER',
            assignedApproverId: elena.id,
            actedByUserId: elena.id,
            status: 'APPROVED',
            enteredAt: daysAgo(2),
            actedAt: daysAgo(1),
          },
          {
            phase: 'INITIAL_REQUEST',
            stepOrder: 2,
            requiredRole: 'FINANCE',
            actedByUserId: sofia.id,
            status: 'APPROVED',
            enteredAt: daysAgo(1),
            actedAt: hoursAgo(10),
          },
        ],
      },
    },
  });

  // Scenario 8: Ready for Payment (Treasury) — Reembolso directo aprobado
  const ree8 = await prisma.expenseRequest.create({
    data: {
      code: `REE-${currentYear}-0008`,
      type: 'REIMBURSEMENT',
      status: 'READY_FOR_PAYMENT',
      requesterId: valeria.id,
      title: 'Almuerzo revisión arquitectura Banco Andino',
      description: 'Almuerzo de trabajo con equipo técnico del cliente.',
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 135.0,
      approvedAmount: 135.0,
      netSettlementAmount: 135.0,
      currentStepEnteredAt: hoursAgo(6),
      items: {
        create: [
          {
            categoryId: catClientes.id,
            expenseDate: daysAgo(3),
            vendorName: 'Bistró Financiero Bogotá',
            vendorTaxId: '900445566-8',
            invoiceNumber: 'FE-11420',
            description: 'Almuerzo ejecutivo 4 personas',
            claimedAmount: 135.0,
            approvedAmount: 135.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: hoursAgo(6),
          },
        ],
      },
    },
  });

  // Scenario 9 & 10: Closed settled records for Charts, Excel Export & Project > 85% alert (PRJ-SEC-03 = 87.3%)
  const ree9 = await prisma.expenseRequest.create({
    data: {
      code: `REE-${currentYear}-0009`,
      type: 'REIMBURSEMENT',
      status: 'CLOSED_SETTLED',
      requesterId: andres.id,
      title: 'Suscripciones nube y pruebas de carga Banco Andino',
      description: 'Consumo mensual ambiente sandbox y herramientas de monitoreo.',
      budgetTargetType: 'PROJECT',
      projectId: prjCloud.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 6400.0,
      approvedAmount: 6400.0,
      netSettlementAmount: 6400.0,
      paymentExecutedAt: daysAgo(5),
      paymentRef: 'TRF-CDMX-2026-229',
      items: {
        create: [
          {
            categoryId: catItSw.id,
            expenseDate: daysAgo(10),
            vendorName: 'CloudScale Corp',
            vendorTaxId: 'US-94-3312091',
            invoiceNumber: 'INV-2026-881',
            description: 'Licencias de observabilidad y cluster de pruebas',
            claimedAmount: 6400.0,
            approvedAmount: 6400.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: daysAgo(6),
          },
        ],
      },
    },
  });

  const ant10 = await prisma.expenseRequest.create({
    data: {
      code: `ANT-${currentYear}-0010`,
      type: 'ADVANCE',
      status: 'CLOSED_SETTLED',
      requesterId: andres.id,
      title: 'Auditoría integral pentesting FinTech Sur',
      description: 'Certificaciones, licencias de escaneo y desplazamiento equipo.',
      budgetTargetType: 'PROJECT',
      projectId: prjSec.id,
      budgetYear: currentYear,
      budgetMonth: currentMonth,
      requestedAmount: 13100.0,
      disbursedAmount: 13100.0,
      renderedAmount: 13100.0,
      approvedAmount: 13100.0,
      netSettlementAmount: 0.0,
      budgetAlert85Triggered: true,
      budgetUsagePctAtSubmit: 87.33,
      disbursedAt: daysAgo(18),
      disbursementRef: 'DES-CDMX-2026-041',
      paymentExecutedAt: daysAgo(4),
      items: {
        create: [
          {
            categoryId: catItSw.id,
            expenseDate: daysAgo(15),
            vendorName: 'SecOps Licensing LLC',
            vendorTaxId: 'US-88-4412001',
            invoiceNumber: 'SEC-4410',
            description: 'Suites de análisis de vulnerabilidades',
            claimedAmount: 13100.0,
            approvedAmount: 13100.0,
            auditStatus: 'APPROVED',
            auditedById: sofia.id,
            auditedAt: daysAgo(5),
          },
        ],
      },
    },
  });

  // Set counters above seeded codes
  await prisma.codeCounter.createMany({
    data: [
      { key: `REE-${currentYear}`, lastValue: 10 },
      { key: `ANT-${currentYear}`, lastValue: 10 },
    ],
  });

  // 12. Initial Audit Logs (including delegation wording required by BRD)
  await prisma.auditLog.createMany({
    data: [
      {
        timestamp: daysAgo(2),
        actorUserId: carlos.id,
        actorName: carlos.fullName,
        actorRole: 'MANAGER',
        entityType: 'DELEGATION',
        entityId: delegationCarlos.id,
        action: 'CREATE_DELEGATION',
        summary: `Delegación temporal creada de ${carlos.fullName} hacia ${lucia.fullName} - Motivo: Vacaciones`,
        ipAddress: '190.24.112.18',
      },
      {
        timestamp: hoursAgo(62),
        actorUserId: carlos.id,
        actorName: carlos.fullName,
        actorRole: 'PROJECT_MANAGER',
        entityType: 'EXPENSE_REQUEST',
        entityId: ant2.id,
        action: 'APPROVE_STEP',
        summary: `Paso 1 (Gerente de Proyecto) aprobado por ${carlos.fullName} para ${ant2.code}`,
        ipAddress: '190.24.112.18',
      },
      {
        timestamp: daysAgo(4),
        actorUserId: sofia.id,
        actorName: sofia.fullName,
        actorRole: 'FINANCE',
        entityType: 'EXPENSE_REQUEST',
        entityId: ree3.id,
        action: 'APPROVE_STEP',
        summary: `Finanzas aprobó ${ree3.code} con alerta presupuestaria >85% en Comercial (87.0%)`,
        ipAddress: '181.55.12.44',
      },
      {
        timestamp: daysAgo(1),
        actorUserId: lucia.id,
        actorName: lucia.fullName,
        actorRole: 'PROJECT_MANAGER',
        onBehalfOfUserId: carlos.id,
        onBehalfOfName: carlos.fullName,
        delegationReason: 'Vacaciones',
        entityType: 'EXPENSE_REQUEST',
        entityId: ree9.id,
        action: 'APPROVE_STEP',
        summary: `Aprobado por ${lucia.fullName} en reemplazo temporal de ${carlos.fullName} - Motivo: Vacaciones`,
        ipAddress: '187.190.44.12',
      },
      {
        timestamp: hoursAgo(8),
        actorUserId: valeria.id,
        actorName: valeria.fullName,
        actorRole: 'EMPLOYEE',
        entityType: 'EXPENSE_REQUEST',
        entityId: ree1.id,
        action: 'CREATE_EXPENSE',
        summary: `Solicitud de Reembolso ${ree1.code} ($42.00) enviada por ${valeria.fullName}`,
        ipAddress: '190.24.112.99',
      },
    ],
  });

  // 13. Initial Notifications
  await prisma.notification.createMany({
    data: [
      {
        userId: lucia.id,
        type: 'APPROVAL_REQUIRED',
        title: 'Firma pendiente por suplencia',
        message: `Tienes pendiente aprobar ${ree1.code} ($42.00) de ${valeria.fullName} en reemplazo de ${carlos.fullName}.`,
        linkUrl: `/solicitudes/${ree1.id}`,
      },
      {
        userId: sofia.id,
        type: 'STALLED_48H',
        title: 'Solicitud trabada >48 horas',
        message: `${ant2.code} ($850.00) lleva más de 60 horas esperando aprobación de Finanzas.`,
        linkUrl: `/solicitudes/${ant2.id}`,
      },
      {
        userId: elena.id,
        type: 'BUDGET_ALERT_85',
        title: 'Alerta presupuestaria (>85%) en Comercial y FinTech Sur',
        message: 'El departamento Comercial alcanzó 87.0% mensual y el proyecto PRJ-SEC-03 alcanzó 87.3%.',
        linkUrl: '/presupuestos',
      },
      {
        userId: andres.id,
        type: 'RETURN_REQUIRED',
        title: 'Devolución pendiente en ANT-2026-0005',
        message: `Debes devolver $120.00 correspondientes a ${ant5.code} para habilitar nuevos anticipos.`,
        linkUrl: `/solicitudes/${ant5.id}`,
      },
    ],
  });

  return {
    usersCount: 10,
    requestsCreated: [ree1.code, ant2.code, ree3.code, ant4.code, ant5.code, ant6.code, ant7.code, ree8.code, ree9.code, ant10.code],
  };
}

const isMainEntry =
  (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) ||
  Boolean((import.meta as { main?: boolean }).main);

if (isMainEntry) {
  seedDatabase()
    .then(async (res) => {
      console.log('Seed completado:', res);
      await prisma.$disconnect();
      await pool.end();
    })
    .catch(async (err) => {
      console.error('Error en seed:', err);
      await prisma.$disconnect();
      await pool.end();
      process.exit(1);
    });
}
