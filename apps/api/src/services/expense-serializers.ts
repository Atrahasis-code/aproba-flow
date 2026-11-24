import { toMoney } from '@aproba-flow/shared';

export function serializeUserSummary(user: {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  roles: string[];
  branch?: { id: string; code: string; name: string } | null;
  department?: { id: string; code: string; name: string } | null;
}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    employeeCode: user.employeeCode,
    jobTitle: user.jobTitle,
    roles: user.roles,
    branch: user.branch ?? null,
    department: user.department ?? null,
  };
}

export function serializeExpenseItem(item: {
  id: string;
  expenseRequestId: string;
  categoryId: string;
  category?: { id: string; code: string; name: string; accountCode: string; specialTag: string | null };
  expenseDate: Date;
  vendorName: string;
  vendorTaxId: string;
  invoiceNumber: string;
  description: string;
  claimedAmount: unknown;
  approvedAmount: unknown;
  auditStatus: string;
  auditNote: string | null;
  auditedById: string | null;
  auditedBy?: { id: string; fullName: string } | null;
  auditedAt: Date | null;
  receiptFileId: string | null;
  receiptFile?: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null;
  duplicateWarning: boolean;
}) {
  return {
    id: item.id,
    expenseRequestId: item.expenseRequestId,
    categoryId: item.categoryId,
    category: item.category ?? null,
    expenseDate: item.expenseDate.toISOString(),
    vendorName: item.vendorName,
    vendorTaxId: item.vendorTaxId,
    invoiceNumber: item.invoiceNumber,
    description: item.description,
    claimedAmount: toMoney(item.claimedAmount),
    approvedAmount: item.approvedAmount !== null ? toMoney(item.approvedAmount) : null,
    auditStatus: item.auditStatus,
    auditNote: item.auditNote,
    auditedById: item.auditedById,
    auditedByName: item.auditedBy?.fullName ?? null,
    auditedAt: item.auditedAt ? item.auditedAt.toISOString() : null,
    receiptFileId: item.receiptFileId,
    receiptFile: item.receiptFile ?? null,
    duplicateWarning: item.duplicateWarning,
  };
}

export function serializeApprovalStep(step: {
  id: string;
  expenseRequestId: string;
  phase: string;
  stepOrder: number;
  requiredRole: string;
  assignedApproverId: string | null;
  assignedApprover?: { id: string; fullName: string; email: string } | null;
  delegatedToUserId: string | null;
  delegatedToUser?: { id: string; fullName: string; email: string } | null;
  delegationId: string | null;
  delegation?: { id: string; reason: string; startDate: Date; endDate: Date } | null;
  actedByUserId: string | null;
  actedByUser?: { id: string; fullName: string } | null;
  status: string;
  comment: string | null;
  enteredAt: Date | null;
  actedAt: Date | null;
  ipAddress: string | null;
}) {
  const hoursWaiting =
    step.status === 'PENDING' && step.enteredAt
      ? Math.floor((Date.now() - step.enteredAt.getTime()) / (1000 * 60 * 60))
      : 0;

  return {
    id: step.id,
    expenseRequestId: step.expenseRequestId,
    phase: step.phase,
    stepOrder: step.stepOrder,
    requiredRole: step.requiredRole,
    assignedApproverId: step.assignedApproverId,
    assignedApprover: step.assignedApprover ?? null,
    delegatedToUserId: step.delegatedToUserId,
    delegatedToUser: step.delegatedToUser ?? null,
    delegationId: step.delegationId,
    delegationReason: step.delegation?.reason ?? null,
    actedByUserId: step.actedByUserId,
    actedByUser: step.actedByUser ?? null,
    status: step.status,
    comment: step.comment,
    enteredAt: step.enteredAt ? step.enteredAt.toISOString() : null,
    actedAt: step.actedAt ? step.actedAt.toISOString() : null,
    ipAddress: step.ipAddress,
    hoursWaiting,
  };
}

export function serializeExpenseRequest(
  req: {
    id: string;
    code: string;
    type: string;
    status: string;
    requesterId: string;
    requester: {
      id: string;
      email: string;
      fullName: string;
      employeeCode: string;
      jobTitle: string;
      roles: string[];
      branch?: { id: string; code: string; name: string } | null;
      department?: { id: string; code: string; name: string } | null;
    };
    title: string;
    description: string | null;
    travelStartDate: Date | null;
    travelEndDate: Date | null;
    budgetTargetType: string;
    departmentId: string | null;
    department?: { id: string; code: string; name: string } | null;
    projectId: string | null;
    project?: { id: string; code: string; name: string; clientName: string } | null;
    budgetYear: number;
    budgetMonth: number;
    requestedAmount: unknown;
    disbursedAmount: unknown;
    renderedAmount: unknown;
    approvedAmount: unknown;
    netSettlementAmount: unknown;
    budgetAlert85Triggered: boolean;
    budgetUsagePctAtSubmit: unknown;
    budgetOverrideRequired: boolean;
    budgetOverrideApprovedById: string | null;
    budgetOverrideApprovedBy?: { id: string; fullName: string } | null;
    budgetOverrideReason: string | null;
    budgetOverrideAt: Date | null;
    currentStepEnteredAt: Date | null;
    disbursedAt: Date | null;
    disbursementRef: string | null;
    settlementDueDate: Date | null;
    returnDepositRef: string | null;
    returnDepositFileId: string | null;
    returnDepositFile?: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null;
    returnConfirmedById: string | null;
    returnConfirmedAt: Date | null;
    paymentExecutedAt: Date | null;
    paymentRef: string | null;
    paymentNotes: string | null;
    createdAt: Date;
    updatedAt: Date;
    items?: Parameters<typeof serializeExpenseItem>[0][];
    approvalSteps?: Parameters<typeof serializeApprovalStep>[0][];
  },
  stalledHoursThreshold = 48
) {
  const hoursInCurrentStep = req.currentStepEnteredAt
    ? Math.floor((Date.now() - req.currentStepEnteredAt.getTime()) / (1000 * 60 * 60))
    : 0;

  const isStalled48h =
    (req.status === 'PENDING_APPROVAL' || req.status === 'EXCESS_PENDING_APPROVAL') &&
    hoursInCurrentStep >= stalledHoursThreshold;

  const isOverdueSettlement =
    req.status === 'DISBURSED_PENDING_SETTLEMENT' &&
    req.settlementDueDate !== null &&
    req.settlementDueDate.getTime() < Date.now();

  return {
    id: req.id,
    code: req.code,
    type: req.type,
    status: req.status,
    requesterId: req.requesterId,
    requester: serializeUserSummary(req.requester),
    title: req.title,
    description: req.description,
    travelStartDate: req.travelStartDate ? req.travelStartDate.toISOString() : null,
    travelEndDate: req.travelEndDate ? req.travelEndDate.toISOString() : null,
    budgetTargetType: req.budgetTargetType,
    departmentId: req.departmentId,
    department: req.department ?? null,
    projectId: req.projectId,
    project: req.project ?? null,
    budgetYear: req.budgetYear,
    budgetMonth: req.budgetMonth,
    requestedAmount: toMoney(req.requestedAmount),
    disbursedAmount: toMoney(req.disbursedAmount),
    renderedAmount: toMoney(req.renderedAmount),
    approvedAmount: toMoney(req.approvedAmount),
    netSettlementAmount: toMoney(req.netSettlementAmount),
    budgetAlert85Triggered: req.budgetAlert85Triggered,
    budgetUsagePctAtSubmit: toMoney(req.budgetUsagePctAtSubmit),
    budgetOverrideRequired: req.budgetOverrideRequired,
    budgetOverrideApprovedById: req.budgetOverrideApprovedById,
    budgetOverrideApprovedByName: req.budgetOverrideApprovedBy?.fullName ?? null,
    budgetOverrideReason: req.budgetOverrideReason,
    budgetOverrideAt: req.budgetOverrideAt ? req.budgetOverrideAt.toISOString() : null,
    currentStepEnteredAt: req.currentStepEnteredAt ? req.currentStepEnteredAt.toISOString() : null,
    hoursInCurrentStep,
    isStalled48h,
    isOverdueSettlement,
    disbursedAt: req.disbursedAt ? req.disbursedAt.toISOString() : null,
    disbursementRef: req.disbursementRef,
    settlementDueDate: req.settlementDueDate ? req.settlementDueDate.toISOString() : null,
    returnDepositRef: req.returnDepositRef,
    returnDepositFileId: req.returnDepositFileId,
    returnDepositFile: req.returnDepositFile ?? null,
    returnConfirmedById: req.returnConfirmedById,
    returnConfirmedAt: req.returnConfirmedAt ? req.returnConfirmedAt.toISOString() : null,
    paymentExecutedAt: req.paymentExecutedAt ? req.paymentExecutedAt.toISOString() : null,
    paymentRef: req.paymentRef,
    paymentNotes: req.paymentNotes,
    createdAt: req.createdAt.toISOString(),
    updatedAt: req.updatedAt.toISOString(),
    items: req.items ? req.items.map(serializeExpenseItem) : undefined,
    approvalSteps: req.approvalSteps ? req.approvalSteps.map(serializeApprovalStep) : undefined,
  };
}
