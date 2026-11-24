'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
  CheckCircle2,
  Clock,
  Eye,
  FileCheck2,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { ApprovalTimeline, type TimelineStep } from '@/components/shared/ApprovalTimeline';
import { BudgetMeter, type BudgetImpactData } from '@/components/shared/BudgetMeter';
import { ReceiptPreviewModal } from '@/components/shared/ReceiptPreviewModal';
import { ReceiptUploader, type UploadedFileMeta } from '@/components/shared/ReceiptUploader';
import {
  ExpenseStatusBadge,
  ItemAuditBadge,
  RequestTypeBadge,
} from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { APPROVAL_ROLE_LABELS } from '@aproba-flow/shared';
import { api, extractApiError } from '@/lib/eden';
import { resolveReturnTarget } from '@/lib/navigation';
import { formatUsd, subtractMoney, sumMoney } from '@aproba-flow/shared';
import { formatDateEs, formatDateTimeEs } from '@/lib/utils';

interface ExpenseItemDto {
  id: string;
  categoryId: string;
  category: { id: string; code: string; name: string; accountCode: string } | null;
  expenseDate: string;
  vendorName: string;
  vendorTaxId: string;
  invoiceNumber: string;
  description: string;
  claimedAmount: number;
  approvedAmount: number | null;
  auditStatus: string;
  auditNote: string | null;
  auditedByName: string | null;
  receiptFile: UploadedFileMeta | null;
  duplicateWarning: boolean;
}

interface ExpenseDetailDto {
  id: string;
  code: string;
  type: 'REIMBURSEMENT' | 'ADVANCE';
  status: string;
  requesterId: string;
  requester: {
    id: string;
    fullName: string;
    email: string;
    employeeCode: string;
    jobTitle: string;
    branch?: { name: string; code: string } | null;
  };
  title: string;
  description: string | null;
  budgetTargetType: string;
  department?: { id: string; code: string; name: string } | null;
  project?: { id: string; code: string; name: string; clientName: string } | null;
  budgetYear: number;
  budgetMonth: number;
  requestedAmount: number;
  disbursedAmount: number;
  renderedAmount: number;
  approvedAmount: number;
  netSettlementAmount: number;
  budgetAlert85Triggered: boolean;
  budgetUsagePctAtSubmit: number;
  budgetOverrideRequired: boolean;
  budgetOverrideApprovedById: string | null;
  budgetOverrideApprovedByName: string | null;
  budgetOverrideReason: string | null;
  hoursInCurrentStep: number;
  isStalled48h: boolean;
  disbursementRef: string | null;
  disbursedAt: string | null;
  settlementDueDate: string | null;
  returnDepositRef: string | null;
  returnDepositFile: UploadedFileMeta | null;
  paymentRef: string | null;
  paymentExecutedAt: string | null;
  createdAt: string;
  items: ExpenseItemDto[];
  approvalSteps: TimelineStep[];
}

interface AuditLogDto {
  id: string;
  timestamp: string;
  actorName: string;
  actorRole: string;
  onBehalfOfName: string | null;
  delegationReason: string | null;
  action: string;
  summary: string;
  ipAddress: string | null;
}

function SolicitudDetalleInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const fromParam = searchParams.get('from');
  const { user, refreshBadges } = useAuth();
  const [req, setReq] = React.useState<ExpenseDetailDto | null>(null);
  const [budgetSnapshot, setBudgetSnapshot] = React.useState<BudgetImpactData | null>(null);
  const [auditLogs, setAuditLogs] = React.useState<AuditLogDto[]>([]);
  const [categories, setCategories] = React.useState<
    Array<{ id: string; code: string; name: string; accountCode: string; requiresReceipt: boolean }>
  >([]);
  const [pendingStepId, setPendingStepId] = React.useState<string | null>(null);
  const [previewFile, setPreviewFile] = React.useState<UploadedFileMeta | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Approver action modal state
  const [decisionComment, setDecisionComment] = React.useState('');
  const [overrideReason, setOverrideReason] = React.useState('');
  const [overrideOpen, setOverrideOpen] = React.useState(false);

  // Employee rendition builder (when DISBURSED_PENDING_SETTLEMENT)
  const [renditionItems, setRenditionItems] = React.useState<
    Array<{
      key: string;
      categoryId: string;
      expenseDate: string;
      vendorName: string;
      vendorTaxId: string;
      invoiceNumber: string;
      description: string;
      claimedAmount: string;
      receipt: UploadedFileMeta | null;
    }>
  >([]);

  // Observed item fixes (when SETTLEMENT_OBSERVED)
  const [observedFixes, setObservedFixes] = React.useState<
    Record<
      string,
      {
        description: string;
        claimedAmount: string;
        invoiceNumber: string;
        receipt: UploadedFileMeta | null;
      }
    >
  >({});

  // Finance item audit dialog
  const [auditingItem, setAuditingItem] = React.useState<ExpenseItemDto | null>(null);
  const [auditStatus, setAuditStatus] = React.useState<
    'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'OBSERVED'
  >('APPROVED');
  const [auditAmount, setAuditAmount] = React.useState('');
  const [auditNote, setAuditNote] = React.useState('');

  // Scenario B deposit return
  const [depositRef, setDepositRef] = React.useState('');
  const [depositFile, setDepositFile] = React.useState<UploadedFileMeta | null>(null);
  const [returnRejectNote, setReturnRejectNote] = React.useState('');

  // Initial OBSERVED resubmission
  const [resubmitTitle, setResubmitTitle] = React.useState('');
  const [resubmitDesc, setResubmitDesc] = React.useState('');
  const [resubmitAmount, setResubmitAmount] = React.useState('');

  const [busy, setBusy] = React.useState(false);

  const loadDetail = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, { data: boot }, { data: myPending }] = await Promise.all([
        api.api.expenses({ id }).get(),
        api.api.catalogs.bootstrap.get(),
        api.api.approvals.pending.get(),
      ]);

      if (error || !data || !('request' in data)) {
        toast.error(extractApiError(error, 'No se pudo cargar la solicitud'));
        return;
      }

      const detail = data.request as ExpenseDetailDto;
      setReq(detail);
      setResubmitTitle(detail.title);
      setResubmitDesc(detail.description ?? '');
      setResubmitAmount(String(detail.requestedAmount));
      setBudgetSnapshot(data.budgetSnapshot as BudgetImpactData);
      setAuditLogs((data.auditLogs ?? []) as AuditLogDto[]);

      if (boot && 'categories' in boot) {
        setCategories(boot.categories);
        if (detail.status === 'DISBURSED_PENDING_SETTLEMENT' && renditionItems.length === 0 && boot.categories.length > 0) {
          setRenditionItems([
            {
              key: crypto.randomUUID(),
              categoryId: boot.categories[0].id,
              expenseDate: new Date().toISOString().slice(0, 10),
              vendorName: '',
              vendorTaxId: '',
              invoiceNumber: '',
              description: '',
              claimedAmount: '',
              receipt: null,
            },
          ]);
        }
      }

      if (detail.status === 'SETTLEMENT_OBSERVED') {
        const map: typeof observedFixes = {};
        for (const it of detail.items) {
          if (it.auditStatus === 'OBSERVED') {
            map[it.id] = {
              description: it.description,
              claimedAmount: String(it.claimedAmount),
              invoiceNumber: it.invoiceNumber,
              receipt: it.receiptFile,
            };
          }
        }
        setObservedFixes(map);
      }

      if (Array.isArray(myPending)) {
        const match = myPending.find((p) => p.request.id === detail.id);
        setPendingStepId(match ? match.stepId : null);
      }
    } finally {
      setLoading(false);
    }
  }, [id, user?.id]);

  React.useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  if (loading && !req) {
    return <p className="p-8 text-center text-sm text-slate-500">Cargando expediente...</p>;
  }
  if (!req) return null;

  const isRequester = user?.id === req.requesterId;
  const isFinance = Boolean(user?.roles.includes('FINANCE')) && !isRequester;
  const canOverride =
    Boolean(user?.roles.includes('FINANCE') || user?.roles.includes('DIRECTION')) &&
    !isRequester &&
    req.budgetOverrideRequired &&
    !req.budgetOverrideApprovedById;

  const currentPendingStep = req.approvalSteps.find((s) => s.status === 'PENDING');

  const handleDecision = async (decision: 'APPROVED' | 'REJECTED' | 'OBSERVED') => {
    if (!pendingStepId) return;
    setBusy(true);
    try {
      const { error } = await api.api.approvals({ stepId: pendingStepId }).decide.post({
        decision,
        comment: decisionComment || null,
      });
      if (error) {
        toast.error(extractApiError(error, 'No se pudo procesar la firma'));
        return;
      }
      toast.success(
        decision === 'APPROVED'
          ? 'Etapa aprobada correctamente'
          : decision === 'REJECTED'
            ? 'Solicitud rechazada'
            : 'Solicitud devuelta con observaciones'
      );
      setDecisionComment('');
      await Promise.all([loadDetail(), refreshBadges()]);
    } finally {
      setBusy(false);
    }
  };

  const handleOverrideBudget = async () => {
    const stepIdToUse = pendingStepId || currentPendingStep?.id;
    if (!stepIdToUse) return;
    setBusy(true);
    try {
      const { error } = await api.api.approvals({ stepId: stepIdToUse })['override-budget'].post({
        reason: overrideReason,
      });
      if (error) {
        toast.error(extractApiError(error, 'No se pudo autorizar el override'));
        return;
      }
      toast.success('Override presupuestario (>100%) autorizado y auditado');
      setOverrideOpen(false);
      setOverrideReason('');
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitRendition = async (e: React.FormEvent) => {
    e.preventDefault();
    for (const it of renditionItems) {
      const cat = categories.find((c) => c.id === it.categoryId);
      if (cat?.requiresReceipt && !it.receipt?.id) {
        toast.error(`Adjunta el comprobante en "${cat.name}"`);
        return;
      }
    }
    setBusy(true);
    try {
      const { error } = await api.api.settlements({ expenseId: req.id }).submit.post({
        items: renditionItems.map((it) => ({
          categoryId: it.categoryId,
          expenseDate: it.expenseDate,
          vendorName: it.vendorName,
          vendorTaxId: it.vendorTaxId,
          invoiceNumber: it.invoiceNumber,
          description: it.description,
          claimedAmount: Number(it.claimedAmount),
          receiptFileId: it.receipt?.id ?? null,
        })),
      });
      if (error) {
        toast.error(extractApiError(error, 'Error al enviar rendición'));
        return;
      }
      toast.success('Rendición enviada a revisión de Finanzas');
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const handleResubmitObservedItems = async () => {
    const payloadItems = Object.entries(observedFixes).map(([itemId, fix]) => ({
      itemId,
      description: fix.description,
      claimedAmount: Number(fix.claimedAmount),
      invoiceNumber: fix.invoiceNumber,
      receiptFileId: fix.receipt?.id ?? null,
    }));
    setBusy(true);
    try {
      const { error } = await api.api.settlements({ expenseId: req.id })['resubmit-observed'].patch({
        items: payloadItems,
      });
      if (error) {
        toast.error(extractApiError(error, 'No se pudo reenviar los ítems'));
        return;
      }
      toast.success('Ítems observados corregidos y reenviados a Finanzas');
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const openAuditModal = (item: ExpenseItemDto) => {
    setAuditingItem(item);
    setAuditStatus(
      item.auditStatus !== 'PENDING'
        ? (item.auditStatus as typeof auditStatus)
        : 'APPROVED'
    );
    setAuditAmount(String(item.approvedAmount ?? item.claimedAmount));
    setAuditNote(item.auditNote ?? '');
  };

  const saveItemAudit = async () => {
    if (!auditingItem) return;
    setBusy(true);
    try {
      const { error } = await api.api
        .settlements({ expenseId: req.id })
        .items({ itemId: auditingItem.id })
        .audit.patch({
          auditStatus,
          ...(auditStatus === 'PARTIALLY_APPROVED' ? { approvedAmount: Number(auditAmount) } : {}),
          ...(auditNote ? { auditNote } : {}),
        });
      if (error) {
        toast.error(extractApiError(error, 'Error al guardar auditoría del ítem'));
        return;
      }
      toast.success('Ítem auditado');
      setAuditingItem(null);
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const handleFinalizeAudit = async () => {
    setBusy(true);
    try {
      const { data, error } = await api.api.settlements({ expenseId: req.id })['finalize-audit'].post();
      if (error || !data) {
        toast.error(extractApiError(error, 'No se pudo finalizar la liquidación'));
        return;
      }
      toast.success(`Liquidación calculada (${data.outcome})`);
      await Promise.all([loadDetail(), refreshBadges()]);
    } finally {
      setBusy(false);
    }
  };

  const handleReturnDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!depositFile?.id) {
      toast.error('Adjunta el comprobante bancario de devolución');
      return;
    }
    setBusy(true);
    try {
      const { error } = await api.api.settlements({ expenseId: req.id })['return-deposit'].post({
        depositRef,
        depositFileId: depositFile.id,
      });
      if (error) {
        toast.error(extractApiError(error, 'Error al reportar devolución'));
        return;
      }
      toast.success('Comprobante de devolución enviado a Finanzas');
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReturn = async (accepted: boolean) => {
    setBusy(true);
    try {
      const { error } = await api.api.settlements({ expenseId: req.id })['confirm-return'].post({
        accepted,
        note: returnRejectNote,
      });
      if (error) {
        toast.error(extractApiError(error, 'Error al confirmar recepción'));
        return;
      }
      toast.success(accepted ? 'Devolución confirmada y caso liquidado' : 'Comprobante observado');
      await loadDetail();
    } finally {
      setBusy(false);
    }
  };

  const handleResubmitInitial = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { error } = await api.api.expenses({ id: req.id }).resubmit.patch({
        title: resubmitTitle,
        description: resubmitDesc || null,
        ...(req.type === 'ADVANCE' ? { requestedAmount: Number(resubmitAmount) } : {}),
      });
      if (error) {
        toast.error(extractApiError(error, 'Error reenviando solicitud'));
        return;
      }
      toast.success('Solicitud corregida y reenviada a aprobación');
      await Promise.all([loadDetail(), refreshBadges()]);
    } finally {
      setBusy(false);
    }
  };

  // Live preview of Finance item-by-item settlement math
  const auditedSum = sumMoney(req.items.map((i) => i.approvedAmount ?? 0));
  const allItemsAudited = req.items.length > 0 && req.items.every((i) => i.auditStatus !== 'PENDING');
  const hasObservedItems = req.items.some((i) => i.auditStatus === 'OBSERVED');
  const projectedDiff = subtractMoney(auditedSum, req.disbursedAmount);

  const returnTarget = resolveReturnTarget(
    fromParam,
    isRequester ? '/solicitudes' : '/aprobaciones'
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href={returnTarget.href}>
            <Button variant="outline" size="sm" className="mt-0.5 shrink-0">
              <ArrowLeft className="h-4 w-4" />
              Volver a {returnTarget.label}
            </Button>
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">{req.code}</h1>
              <RequestTypeBadge type={req.type} />
              <ExpenseStatusBadge status={req.status} />
              {req.budgetAlert85Triggered && (
                <Badge variant="amber">
                  <AlertTriangle className="h-3 w-3" /> Alerta &gt;85%
                </Badge>
              )}
              {req.isStalled48h && (
                <Badge variant="rose">
                  <Clock className="h-3 w-3" /> Trabada {req.hoursInCurrentStep}h
                </Badge>
              )}
            </div>
            <p className="text-base font-semibold text-slate-800 mt-1">{req.title}</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Solicitante: <strong>{req.requester.fullName}</strong> ({req.requester.jobTitle}) ·{' '}
              {req.budgetTargetType === 'PROJECT'
                ? `Proyecto ${req.project?.code} (${req.project?.name})`
                : `Depto. ${req.department?.name} (${String(req.budgetMonth).padStart(2, '0')}/${req.budgetYear})`}
            </p>
          </div>
        </div>
      </div>

      {/* Budget Override Banner */}
      {req.budgetOverrideRequired && (
        <div
          className={
            req.budgetOverrideApprovedById
              ? 'rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900 flex items-center justify-between gap-3'
              : 'rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900 flex flex-wrap items-center justify-between gap-3'
          }
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              {req.budgetOverrideApprovedById ? (
                <>
                  <p className="font-bold">Override Presupuestario (&gt;100%) Autorizado</p>
                  <p>
                    Autorizado por <strong>{req.budgetOverrideApprovedByName}</strong> — Motivo: “
                    {req.budgetOverrideReason}”
                  </p>
                </>
              ) : (
                <>
                  <p className="font-bold">Bloqueado por Superar 100% del Presupuesto</p>
                  <p>
                    Ninguna aprobación estándar puede liberar esta solicitud sin Override auditado de
                    Finanzas o Dirección Administrativa.
                  </p>
                </>
              )}
            </div>
          </div>

          {canOverride && (
            <Button variant="destructive" size="sm" onClick={() => setOverrideOpen(true)}>
              Autorizar Override (&gt;100%)
            </Button>
          )}
        </div>
      )}

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Monto Solicitado</span>
            <p className="text-xl font-extrabold text-slate-900 mt-1 tabular-nums">
              {formatUsd(req.requestedAmount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Anticipo Desembolsado</span>
            <p className="text-xl font-extrabold text-indigo-700 mt-1 tabular-nums">
              {formatUsd(req.disbursedAmount)}
            </p>
            {req.disbursementRef && (
              <span className="text-[11px] text-slate-400">Ref. {req.disbursementRef}</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Gastos Validados</span>
            <p className="text-xl font-extrabold text-emerald-700 mt-1 tabular-nums">
              {formatUsd(req.approvedAmount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Saldo Neto Liquidación</span>
            <p className="text-xl font-extrabold text-slate-900 mt-1 tabular-nums">
              {formatUsd(req.netSettlementAmount)}
            </p>
            <span className="text-[11px] text-slate-500">
              {req.netSettlementAmount < 0
                ? 'A devolver a empresa'
                : req.netSettlementAmount > 0
                  ? 'A reembolsar al empleado'
                  : 'Cuadre exacto'}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* CONTEXTUAL PANELS */}
      {/* 0. Initial Request Observed Fix */}
      {isRequester && req.status === 'OBSERVED' && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="text-amber-900">Corregir y Reenviar Solicitud Observada</CardTitle>
            <CardDescription className="text-amber-800">
              Revisa las observaciones del aprobador en la cadena de firmas, ajusta la información y reenvía.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleResubmitInitial} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Título *</Label>
                  <Input
                    required
                    value={resubmitTitle}
                    onChange={(e) => setResubmitTitle(e.target.value)}
                  />
                </div>
                {req.type === 'ADVANCE' && (
                  <div>
                    <Label>Monto Solicitado (USD) *</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="1"
                      required
                      value={resubmitAmount}
                      onChange={(e) => setResubmitAmount(e.target.value)}
                    />
                  </div>
                )}
              </div>
              <div>
                <Label>Justificación / Descripción</Label>
                <Textarea
                  value={resubmitDesc}
                  onChange={(e) => setResubmitDesc(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy}>
                <Send className="h-4 w-4" />
                Reenviar a Aprobación
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 1. Approver Action Panel */}
      {pendingStepId && currentPendingStep && (
        <Card className="border-brand-200 bg-brand-50/30">
          <CardHeader className="border-brand-100">
            <CardTitle className="flex items-center gap-2 text-brand-900">
              <FileCheck2 className="h-5 w-5 text-brand-600" />
              Acción de Aprobación Pendiente —{' '}
              {APPROVAL_ROLE_LABELS[currentPendingStep.requiredRole as keyof typeof APPROVAL_ROLE_LABELS] ??
                currentPendingStep.requiredRole}
            </CardTitle>
            {currentPendingStep.delegatedToUser && (
              <CardDescription className="text-indigo-800 font-medium">
                Estás actuando en reemplazo temporal de{' '}
                <strong>{currentPendingStep.assignedApprover?.fullName}</strong> (Motivo:{' '}
                {currentPendingStep.delegationReason}). Quedará registrado en Auditoría.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="decisionComment">
                Comentario de firma (obligatorio para Rechazar u Observar)
              </Label>
              <Textarea
                id="decisionComment"
                value={decisionComment}
                onChange={(e) => setDecisionComment(e.target.value)}
                placeholder="Ej. Aprobado según presupuesto del proyecto..."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="success"
                disabled={busy || (req.budgetOverrideRequired && !req.budgetOverrideApprovedById)}
                onClick={() => void handleDecision('APPROVED')}
              >
                <CheckCircle2 className="h-4 w-4" />
                Aprobar Etapa
              </Button>
              {currentPendingStep.phase === 'INITIAL_REQUEST' && (
                <Button
                  variant="warning"
                  disabled={busy}
                  onClick={() => void handleDecision('OBSERVED')}
                >
                  <AlertTriangle className="h-4 w-4" />
                  Observar (Corregible)
                </Button>
              )}
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void handleDecision('REJECTED')}
              >
                <XCircle className="h-4 w-4" />
                Rechazar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2. Employee Advance Rendition Form (when DISBURSED_PENDING_SETTLEMENT) */}
      {isRequester && req.status === 'DISBURSED_PENDING_SETTLEMENT' && (
        <Card className="border-indigo-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-indigo-600" />
              Presentar Rendición de Anticipo ({formatUsd(req.disbursedAmount)} entregados)
            </CardTitle>
            <CardDescription>
              Carga factura por factura con su Categoría Contable y comprobante digital. Fecha límite:{' '}
              <strong>{formatDateEs(req.settlementDueDate)}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmitRendition} className="space-y-4">
              {renditionItems.map((it, idx) => (
                <div
                  key={it.key}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-slate-500">
                      Comprobante #{idx + 1}
                    </span>
                    {renditionItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setRenditionItems((prev) => prev.filter((x) => x.key !== it.key))
                        }
                        className="text-xs text-rose-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Quitar
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="sm:col-span-2">
                      <Label>Categoría Contable *</Label>
                      <Select
                        value={it.categoryId}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, categoryId: e.target.value } : x
                            )
                          )
                        }
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.accountCode})
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>Fecha *</Label>
                      <Input
                        type="date"
                        required
                        value={it.expenseDate}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, expenseDate: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label>Monto (USD) *</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={it.claimedAmount}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, claimedAmount: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label>Proveedor *</Label>
                      <Input
                        required
                        value={it.vendorName}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, vendorName: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label>RUC / NIT *</Label>
                      <Input
                        required
                        value={it.vendorTaxId}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, vendorTaxId: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label>N° Factura *</Label>
                      <Input
                        required
                        value={it.invoiceNumber}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, invoiceNumber: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label>Concepto *</Label>
                      <Input
                        required
                        value={it.description}
                        onChange={(e) =>
                          setRenditionItems((prev) =>
                            prev.map((x) =>
                              x.key === it.key ? { ...x, description: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                  <ReceiptUploader
                    value={it.receipt}
                    onChange={(file) =>
                      setRenditionItems((prev) =>
                        prev.map((x) => (x.key === it.key ? { ...x, receipt: file } : x))
                      )
                    }
                    onPreview={setPreviewFile}
                    compact
                  />
                </div>
              ))}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setRenditionItems((prev) => [
                      ...prev,
                      {
                        key: crypto.randomUUID(),
                        categoryId: categories[0]?.id ?? '',
                        expenseDate: new Date().toISOString().slice(0, 10),
                        vendorName: '',
                        vendorTaxId: '',
                        invoiceNumber: '',
                        description: '',
                        claimedAmount: '',
                        receipt: null,
                      },
                    ])
                  }
                >
                  <Plus className="h-4 w-4" />
                  Agregar comprobante
                </Button>
                <Button type="submit" disabled={busy}>
                  <Send className="h-4 w-4" />
                  Enviar Rendición ({formatUsd(sumMoney(renditionItems.map((i) => Number(i.claimedAmount) || 0)))})
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 3. Employee Fix Observed Items (SETTLEMENT_OBSERVED) */}
      {isRequester && req.status === 'SETTLEMENT_OBSERVED' && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardHeader>
            <CardTitle className="text-amber-900">Subsanar Comprobantes Observados</CardTitle>
            <CardDescription className="text-amber-800">
              Solo puedes corregir los ítems marcados como <strong>Observado</strong>. Los ítems rechazados por política quedan firmes sin opción a reclamo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {req.items
              .filter((i) => i.auditStatus === 'OBSERVED')
              .map((it) => {
                const fix = observedFixes[it.id];
                if (!fix) return null;
                return (
                  <div key={it.id} className="rounded-xl border border-amber-200 bg-white p-4 space-y-3">
                    <div className="text-xs text-amber-900 bg-amber-50 p-2 rounded-lg">
                      <strong>Observación de Finanzas:</strong> {it.auditNote}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <Label>N° Factura</Label>
                        <Input
                          value={fix.invoiceNumber}
                          onChange={(e) =>
                            setObservedFixes((prev) => ({
                              ...prev,
                              [it.id]: { ...fix, invoiceNumber: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Monto (USD)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={fix.claimedAmount}
                          onChange={(e) =>
                            setObservedFixes((prev) => ({
                              ...prev,
                              [it.id]: { ...fix, claimedAmount: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Descripción</Label>
                        <Input
                          value={fix.description}
                          onChange={(e) =>
                            setObservedFixes((prev) => ({
                              ...prev,
                              [it.id]: { ...fix, description: e.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                    <ReceiptUploader
                      value={fix.receipt}
                      onChange={(file) =>
                        setObservedFixes((prev) => ({
                          ...prev,
                          [it.id]: { ...fix, receipt: file },
                        }))
                      }
                      onPreview={setPreviewFile}
                      compact
                    />
                  </div>
                );
              })}

            <Button onClick={() => void handleResubmitObservedItems()} disabled={busy}>
              <Send className="h-4 w-4" />
              Reenviar Correcciones a Finanzas
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 4. Employee Scenario B Return Deposit */}
      {isRequester && req.status === 'PENDING_RETURN' && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="text-amber-900">
              Devolución Bancaria Requerida: {formatUsd(Math.abs(req.netSettlementAmount))}
            </CardTitle>
            <CardDescription className="text-amber-800">
              El monto validado fue inferior al anticipo recibido. Transfiere el saldo sobrante a la cuenta corporativa y sube tu comprobante para desbloquear nuevos anticipos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleReturnDeposit} className="space-y-4">
              <div>
                <Label htmlFor="depositRef">N° Referencia / Operación Bancaria *</Label>
                <Input
                  id="depositRef"
                  required
                  value={depositRef}
                  onChange={(e) => setDepositRef(e.target.value)}
                  placeholder="Ej. DEP-2026-88412"
                />
              </div>
              <div>
                <Label>Comprobante de Transferencia *</Label>
                <ReceiptUploader
                  purpose="RETURN_DEPOSIT"
                  value={depositFile}
                  onChange={setDepositFile}
                  onPreview={setPreviewFile}
                />
              </div>
              <Button type="submit" disabled={busy}>
                Registrar Depósito de Devolución
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 5. Finance Confirm Bank Return */}
      {isFinance && req.status === 'RETURN_SUBMITTED' && (
        <Card className="border-indigo-200 bg-indigo-50/30">
          <CardHeader>
            <CardTitle>Confirmar Recepción Bancaria de Devolución</CardTitle>
            <CardDescription>
              El empleado reportó la transferencia Ref. <strong>{req.returnDepositRef}</strong> por{' '}
              <strong>{formatUsd(Math.abs(req.netSettlementAmount))}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {req.returnDepositFile && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewFile(req.returnDepositFile)}
              >
                <Eye className="h-4 w-4" />
                Ver Comprobante de Depósito ({req.returnDepositFile.originalName})
              </Button>
            )}
            <div>
              <Label>Nota (obligatoria si observas el depósito)</Label>
              <Input
                value={returnRejectNote}
                onChange={(e) => setReturnRejectNote(e.target.value)}
                placeholder="Ej. Monto acreditado en extracto bancario..."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="success" disabled={busy} onClick={() => void handleConfirmReturn(true)}>
                <CheckCircle2 className="h-4 w-4" />
                Confirmar Recepción y Cerrar Caso
              </Button>
              <Button variant="warning" disabled={busy} onClick={() => void handleConfirmReturn(false)}>
                Observar Depósito
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 6. Finance Settlement Console Summary (when SETTLEMENT_IN_REVIEW) */}
      {isFinance && req.status === 'SETTLEMENT_IN_REVIEW' && (
        <Card className="border-brand-200 bg-brand-50/40">
          <CardHeader className="border-brand-100">
            <CardTitle className="flex items-center gap-2 text-brand-900">
              <Calculator className="h-5 w-5 text-brand-600" />
              Consola de Auditoría Ítem por Ítem (Finanzas)
            </CardTitle>
            <CardDescription>
              Audita cada recibo abajo con <strong>Aprobar</strong>, <strong>Parcial</strong>,{' '}
              <strong>Rechazar</strong> u <strong>Observar</strong>. El sistema calcula automáticamente el escenario resultante sin cálculo manual.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1 text-xs">
              <p>
                Anticipo Entregado: <strong>{formatUsd(req.disbursedAmount)}</strong> · Suma Validada Actual:{' '}
                <strong className="text-emerald-700">{formatUsd(auditedSum)}</strong> · Diferencia:{' '}
                <strong className={projectedDiff < 0 ? 'text-amber-700' : 'text-indigo-700'}>
                  {projectedDiff >= 0 ? `+${formatUsd(projectedDiff)}` : formatUsd(projectedDiff)}
                </strong>
              </p>
              <p className="text-slate-600">
                Escenario previsto:{' '}
                <strong>
                  {hasObservedItems
                    ? 'Devolver a Empleado por Comprobantes Observados'
                    : !allItemsAudited
                      ? 'Faltan ítems por auditar'
                      : projectedDiff === 0
                        ? 'Escenario A — Cuadre Perfecto (Cierre Inmediato)'
                        : projectedDiff < 0
                          ? `Escenario B — Saldo a Favor Empresa (${formatUsd(Math.abs(projectedDiff))} por devolver)`
                          : `Escenario C — Excedente (${formatUsd(projectedDiff)} a reembolsar)`}
                </strong>
              </p>
            </div>

            <Button
              disabled={busy || !allItemsAudited}
              onClick={() => void handleFinalizeAudit()}
            >
              <CheckCircle2 className="h-4 w-4" />
              Finalizar Auditoría y Liquidar
            </Button>
          </CardContent>
        </Card>
      )}

      {/* TABS: Items / Timeline / Budget / Audit */}
      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">Ítems y Comprobantes ({req.items.length})</TabsTrigger>
          <TabsTrigger value="timeline">Cadena de Aprobación ({req.approvalSteps.length})</TabsTrigger>
          <TabsTrigger value="budget">Presupuesto</TabsTrigger>
          <TabsTrigger value="audit">Auditoría ({auditLogs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="items">
          <Card>
            <CardContent className="p-0">
              {req.items.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  Este anticipo aún no tiene comprobantes rendidos.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha / Categoría</TableHead>
                      <TableHead>Proveedor y Factura</TableHead>
                      <TableHead>Estado Ítem</TableHead>
                      <TableHead className="text-right">Rendido</TableHead>
                      <TableHead className="text-right">Validado</TableHead>
                      <TableHead className="text-right">Comprobante / Auditar</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {req.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell className="text-xs">
                          <span className="font-semibold text-slate-900 block">
                            {it.category?.name ?? 'Sin categoría'}
                          </span>
                          <span className="text-slate-500">
                            {formatDateEs(it.expenseDate)} · {it.category?.accountCode}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900">{it.vendorName}</span>
                            {it.duplicateWarning && (
                              <Badge variant="rose" className="text-[10px]">
                                Posible Duplicado
                              </Badge>
                            )}
                          </div>
                          <span className="text-slate-500 block">
                            RUC/NIT: {it.vendorTaxId} · Fact: {it.invoiceNumber}
                          </span>
                          <span className="text-slate-600 italic">{it.description}</span>
                          {it.auditNote && (
                            <p className="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-0.5 mt-1">
                              Nota Finanzas: {it.auditNote}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <ItemAuditBadge status={it.auditStatus} />
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatUsd(it.claimedAmount)}
                        </TableCell>
                        <TableCell className="text-right font-bold text-emerald-700 tabular-nums">
                          {it.approvedAmount !== null ? formatUsd(it.approvedAmount) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            {it.receiptFile && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPreviewFile(it.receiptFile)}
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Ver
                              </Button>
                            )}
                            {isFinance &&
                              (req.status === 'SETTLEMENT_IN_REVIEW' ||
                                (req.type === 'REIMBURSEMENT' && req.status === 'PENDING_APPROVAL')) && (
                                <Button
                                  size="sm"
                                  variant="default"
                                  onClick={() => openAuditModal(it)}
                                >
                                  Auditar
                                </Button>
                              )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeline">
          <Card>
            <CardContent className="p-5">
              <ApprovalTimeline steps={req.approvalSteps} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="budget">
          {budgetSnapshot && <BudgetMeter data={budgetSnapshot} />}
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha y Hora</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Acción</TableHead>
                    <TableHead>Resumen Inmutable</TableHead>
                    <TableHead>IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-slate-500 whitespace-nowrap">
                        {formatDateTimeEs(l.timestamp)}
                      </TableCell>
                      <TableCell className="text-xs font-semibold text-slate-900">
                        {l.actorName}
                        <span className="block text-[11px] font-normal text-slate-500">
                          {l.actorRole}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="slate">{l.action}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-700">{l.summary}</TableCell>
                      <TableCell className="text-xs font-mono text-slate-500">
                        {l.ipAddress ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Item Audit Dialog */}
      <Dialog open={Boolean(auditingItem)} onOpenChange={(o) => !o && setAuditingItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Auditar Comprobante</DialogTitle>
            <DialogDescription>
              {auditingItem?.vendorName} · Factura {auditingItem?.invoiceNumber} · Monto rendido:{' '}
              {formatUsd(auditingItem?.claimedAmount ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Dictamen de Finanzas</Label>
              <Select
                value={auditStatus}
                onChange={(e) => setAuditStatus(e.target.value as typeof auditStatus)}
              >
                <option value="APPROVED">Aprobado (100% del monto)</option>
                <option value="PARTIALLY_APPROVED">Aprobado Parcial (Ajuste manual)</option>
                <option value="OBSERVED">Observado (Comprobante borroso / corregir)</option>
                <option value="REJECTED">Rechazado por Política ($0.00 definitivo)</option>
              </Select>
            </div>

            {auditStatus === 'PARTIALLY_APPROVED' && (
              <div>
                <Label>Monto Aprobado Validado (USD)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={auditAmount}
                  onChange={(e) => setAuditAmount(e.target.value)}
                />
              </div>
            )}

            <div>
              <Label>
                Motivo / Observación{' '}
                {auditStatus !== 'APPROVED' ? '(Obligatorio)' : '(Opcional)'}
              </Label>
              <Textarea
                value={auditNote}
                onChange={(e) => setAuditNote(e.target.value)}
                placeholder="Ej. Se excluyen $25 de bebidas alcohólicas no cubiertas por política..."
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAuditingItem(null)}>
                Cancelar
              </Button>
              <Button disabled={busy} onClick={() => void saveItemAudit()}>
                Guardar Dictamen
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Budget Override Modal (>100%) */}
      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Autorizar Override Presupuestario (&gt;100%)</DialogTitle>
            <DialogDescription>
              Esta autorización excepcional desbloquea la solicitud aunque el presupuesto exceda el 100%. Quedará grabada en la auditoría anual.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Justificación de Override *</Label>
              <Textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Ej. Gasto crítico autorizado por comité ejecutivo con ampliación presupuestaria en curso..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOverrideOpen(false)}>
                Cancelar
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void handleOverrideBudget()}>
                Confirmar Override
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ReceiptPreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}

export default function SolicitudDetallePage() {
  return (
    <React.Suspense
      fallback={<p className="p-8 text-center text-sm text-slate-500">Cargando expediente...</p>}
    >
      <SolicitudDetalleInner />
    </React.Suspense>
  );
}
