export type UserRole =
  | 'EMPLOYEE'
  | 'MANAGER'
  | 'SPECIAL_APPROVER_IT'
  | 'FINANCE'
  | 'TREASURY'
  | 'DIRECTION'
  | 'ADMIN';

export type ProjectStatus = 'ACTIVE' | 'ON_HOLD' | 'CLOSED';

export type RequestType = 'REIMBURSEMENT' | 'ADVANCE' | 'EXCESS';

export type BudgetTargetType = 'DEPARTMENT' | 'PROJECT';

export type ExpenseStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'OBSERVED'
  | 'REJECTED'
  | 'READY_FOR_DISBURSEMENT'
  | 'DISBURSED_PENDING_SETTLEMENT'
  | 'SETTLEMENT_IN_REVIEW'
  | 'SETTLEMENT_OBSERVED'
  | 'PENDING_RETURN'
  | 'RETURN_SUBMITTED'
  | 'EXCESS_PENDING_APPROVAL'
  | 'READY_FOR_PAYMENT'
  | 'CLOSED_SETTLED';

export type ItemAuditStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'PARTIALLY_APPROVED'
  | 'REJECTED'
  | 'OBSERVED';

export type ApprovalPhase = 'INITIAL_REQUEST' | 'EXCESS_SETTLEMENT';

export type ApprovalRoleType =
  | 'DIRECT_MANAGER'
  | 'PROJECT_MANAGER'
  | 'SPECIAL_IT'
  | 'FINANCE'
  | 'DIRECTION';

export type ApprovalStepStatus =
  | 'WAITING'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'OBSERVED'
  | 'REASSIGNED'
  | 'SKIPPED';

export type FilePurpose = 'RECEIPT' | 'RETURN_DEPOSIT' | 'PAYMENT_PROOF';

export type NotificationType =
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'OBSERVED'
  | 'BUDGET_ALERT_85'
  | 'BUDGET_EXCEEDED_100'
  | 'STALLED_48H'
  | 'DISBURSED'
  | 'RETURN_REQUIRED'
  | 'RETURN_CONFIRMED'
  | 'PAYMENT_EXECUTED'
  | 'DELEGATION_ASSIGNED';
