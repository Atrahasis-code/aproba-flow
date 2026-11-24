import type {
  ApprovalRoleType,
  ApprovalStepStatus,
  BudgetTargetType,
  ExpenseStatus,
  ItemAuditStatus,
  RequestType,
  UserRole,
} from './types';

export const ALL_USER_ROLES: UserRole[] = [
  'EMPLOYEE',
  'MANAGER',
  'SPECIAL_APPROVER_IT',
  'FINANCE',
  'TREASURY',
  'DIRECTION',
  'ADMIN',
];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  EMPLOYEE: 'Empleado / Consultor',
  MANAGER: 'Jefe Directo / Gerente PM',
  SPECIAL_APPROVER_IT: 'Aprobador Especial IT',
  FINANCE: 'Finanzas',
  TREASURY: 'Tesorería',
  DIRECTION: 'Dirección Administrativa',
  ADMIN: 'Administrador',
};

export const APPROVAL_ROLE_LABELS: Record<ApprovalRoleType, string> = {
  DIRECT_MANAGER: 'Jefe Directo',
  PROJECT_MANAGER: 'Gerente de Proyecto',
  SPECIAL_IT: 'Jefe de Tecnología (IT)',
  FINANCE: 'Finanzas',
  DIRECTION: 'Dirección Administrativa',
};

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  REIMBURSEMENT: 'Reembolso Directo',
  ADVANCE: 'Anticipo / Fondo a Rendir',
  EXCESS: 'Excedente de Rendición',
};

export const BUDGET_TARGET_LABELS: Record<BudgetTargetType, string> = {
  DEPARTMENT: 'Centro de Costo (Departamento)',
  PROJECT: 'Proyecto de Cliente',
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  DRAFT: 'Borrador',
  PENDING_APPROVAL: 'Pendiente de Aprobación',
  OBSERVED: 'Observada',
  REJECTED: 'Rechazada',
  READY_FOR_DISBURSEMENT: 'Lista para Desembolsar',
  DISBURSED_PENDING_SETTLEMENT: 'Desembolsada / Por Rendir',
  SETTLEMENT_IN_REVIEW: 'Rendición en Revisión',
  SETTLEMENT_OBSERVED: 'Rendición Observada',
  PENDING_RETURN: 'Pendiente de Devolución',
  RETURN_SUBMITTED: 'Devolución en Verificación',
  EXCESS_PENDING_APPROVAL: 'Excedente en Aprobación',
  READY_FOR_PAYMENT: 'Lista para Pagar',
  CLOSED_SETTLED: 'Cerrada / Liquidada',
};

export const ITEM_AUDIT_STATUS_LABELS: Record<ItemAuditStatus, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobado',
  PARTIALLY_APPROVED: 'Aprobado Parcial',
  REJECTED: 'Rechazado',
  OBSERVED: 'Observado',
};

export const APPROVAL_STEP_STATUS_LABELS: Record<ApprovalStepStatus, string> = {
  WAITING: 'En Cola',
  PENDING: 'Pendiente de Firma',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  OBSERVED: 'Observado',
  REASSIGNED: 'Reasignado',
  SKIPPED: 'Omitido',
};
