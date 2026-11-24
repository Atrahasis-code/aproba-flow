import { Badge } from '@/components/ui/badge';
import type { ExpenseStatus, ItemAuditStatus, RequestType } from '@aproba-flow/shared';
import {
  EXPENSE_STATUS_LABELS,
  ITEM_AUDIT_STATUS_LABELS,
  REQUEST_TYPE_LABELS,
} from '@aproba-flow/shared';

export function ExpenseStatusBadge({ status }: { status: string }) {
  const typed = status as ExpenseStatus;
  const label = EXPENSE_STATUS_LABELS[typed] ?? status;

  let variant: 'default' | 'slate' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'purple' = 'slate';
  switch (typed) {
    case 'CLOSED_SETTLED':
      variant = 'emerald';
      break;
    case 'READY_FOR_PAYMENT':
    case 'READY_FOR_DISBURSEMENT':
      variant = 'default';
      break;
    case 'PENDING_APPROVAL':
    case 'SETTLEMENT_IN_REVIEW':
    case 'DISBURSED_PENDING_SETTLEMENT':
      variant = 'indigo';
      break;
    case 'OBSERVED':
    case 'SETTLEMENT_OBSERVED':
    case 'PENDING_RETURN':
    case 'RETURN_SUBMITTED':
      variant = 'amber';
      break;
    case 'EXCESS_PENDING_APPROVAL':
      variant = 'purple';
      break;
    case 'REJECTED':
      variant = 'rose';
      break;
    default:
      variant = 'slate';
  }

  return <Badge variant={variant}>{label}</Badge>;
}

export function RequestTypeBadge({ type }: { type: string }) {
  const typed = type as RequestType;
  const label = REQUEST_TYPE_LABELS[typed] ?? type;
  const variant = typed === 'ADVANCE' ? 'purple' : typed === 'REIMBURSEMENT' ? 'default' : 'amber';
  return <Badge variant={variant}>{label}</Badge>;
}

export function ItemAuditBadge({ status }: { status: string }) {
  const typed = status as ItemAuditStatus;
  const label = ITEM_AUDIT_STATUS_LABELS[typed] ?? status;
  const variant =
    typed === 'APPROVED'
      ? 'emerald'
      : typed === 'PARTIALLY_APPROVED'
        ? 'amber'
        : typed === 'REJECTED'
          ? 'rose'
          : typed === 'OBSERVED'
            ? 'default'
            : 'slate';
  return <Badge variant={variant}>{label}</Badge>;
}
