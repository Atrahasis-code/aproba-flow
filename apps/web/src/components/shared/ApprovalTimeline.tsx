import { AlertCircle, CheckCircle2, Clock, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ApprovalRoleType, ApprovalStepStatus } from '@aproba-flow/shared';
import { APPROVAL_ROLE_LABELS, APPROVAL_STEP_STATUS_LABELS } from '@aproba-flow/shared';
import { cn, formatDateTimeEs } from '@/lib/utils';

export interface TimelineStep {
  id: string;
  phase: string;
  stepOrder: number;
  requiredRole: string;
  assignedApprover?: { id: string; fullName: string } | null;
  delegatedToUser?: { id: string; fullName: string } | null;
  delegationReason?: string | null;
  actedByUser?: { id: string; fullName: string } | null;
  status: string;
  comment: string | null;
  enteredAt: string | null;
  actedAt: string | null;
  ipAddress: string | null;
  hoursWaiting: number;
}

export function ApprovalTimeline({ steps }: { steps: TimelineStep[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-slate-500 italic">
        No hay etapas de firma registradas en esta solicitud.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {steps.map((step, idx) => {
        const st = step.status as ApprovalStepStatus;
        const roleLabel =
          APPROVAL_ROLE_LABELS[step.requiredRole as ApprovalRoleType] ?? step.requiredRole;
        const statusLabel = APPROVAL_STEP_STATUS_LABELS[st] ?? step.status;

        const Icon =
          st === 'APPROVED'
            ? CheckCircle2
            : st === 'REJECTED'
              ? XCircle
              : st === 'OBSERVED'
                ? AlertCircle
                : st === 'REASSIGNED'
                  ? RefreshCw
                  : Clock;

        const iconColor =
          st === 'APPROVED'
            ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
            : st === 'REJECTED'
              ? 'text-rose-600 bg-rose-50 border-rose-200'
              : st === 'OBSERVED'
                ? 'text-amber-600 bg-amber-50 border-amber-200'
                : st === 'PENDING'
                  ? 'text-brand-600 bg-brand-50 border-brand-200'
                  : 'text-slate-400 bg-slate-50 border-slate-200';

        return (
          <div key={step.id} className="relative flex gap-3.5">
            {idx < steps.length - 1 && (
              <div className="absolute left-[15px] top-8 bottom-[-16px] w-px bg-slate-200" />
            )}

            <div
              className={cn(
                'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                iconColor
              )}
            >
              <Icon className="h-4 w-4" />
            </div>

            <div className="flex-1 rounded-xl border border-slate-200 bg-white p-3.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">
                    {step.phase === 'EXCESS_SETTLEMENT' ? 'Excedente · ' : ''}
                    Paso {step.stepOrder}: {roleLabel}
                  </span>
                  <Badge
                    variant={
                      st === 'APPROVED'
                        ? 'emerald'
                        : st === 'REJECTED'
                          ? 'rose'
                          : st === 'OBSERVED'
                            ? 'amber'
                            : st === 'PENDING'
                              ? 'default'
                              : 'slate'
                    }
                  >
                    {statusLabel}
                  </Badge>
                  {st === 'PENDING' && step.hoursWaiting >= 48 && (
                    <Badge variant="rose">Trabada ({step.hoursWaiting}h)</Badge>
                  )}
                </div>
                {step.actedAt && (
                  <span className="text-xs text-slate-500">{formatDateTimeEs(step.actedAt)}</span>
                )}
              </div>

              <div className="mt-1.5 text-xs text-slate-600 space-y-1">
                {step.assignedApprover && (
                  <p>
                    Responsable titular: <strong>{step.assignedApprover.fullName}</strong>
                  </p>
                )}
                {step.delegatedToUser && (
                  <p className="inline-flex items-center gap-1 rounded-md bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-indigo-800">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Suplencia activa: <strong>{step.delegatedToUser.fullName}</strong>
                    {step.delegationReason ? ` (${step.delegationReason})` : ''}
                  </p>
                )}
                {step.actedByUser && (
                  <p>
                    Firmado por: <strong>{step.actedByUser.fullName}</strong>
                    {step.ipAddress ? ` · IP ${step.ipAddress}` : ''}
                  </p>
                )}
                {step.comment && (
                  <p className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-slate-700 italic mt-1">
                    “{step.comment}”
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
