'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Clock,
  Landmark,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  APPROVAL_ROLE_LABELS,
  EXPENSE_STATUS_LABELS,
  formatUsd,
} from '@aproba-flow/shared';
import { useAuth } from '@/components/providers/auth-provider';
import { ExpenseStatusBadge, RequestTypeBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { api, extractApiError } from '@/lib/eden';
import { withFrom } from '@/lib/navigation';
import { formatDateEs } from '@/lib/utils';

interface PendingApprovalItem {
  stepId: string;
  phase: string;
  stepOrder: number;
  requiredRole: string;
  hoursWaiting: number;
  isStalled48h: boolean;
  actingAsDelegate: boolean;
  delegatorName: string | null;
  delegationReason: string | null;
  request: {
    id: string;
    code: string;
    type: string;
    title: string;
    requestedAmount: number;
    netSettlementAmount: number;
    budgetAlert85Triggered: boolean;
    budgetOverrideRequired: boolean;
    budgetOverrideApprovedById: string | null;
    requester: { fullName: string; branch?: { code: string } | null };
    department?: { name: string } | null;
    project?: { code: string; name: string } | null;
  };
}

interface ReviewRequestRow {
  id: string;
  code: string;
  type: string;
  status: string;
  title: string;
  requester: { fullName: string; branch?: { code: string } | null };
  department?: { name: string } | null;
  project?: { code: string; name: string } | null;
  requestedAmount: number;
  disbursedAmount: number;
  renderedAmount: number;
  netSettlementAmount: number;
  returnDepositRef: string | null;
  budgetAlert85Triggered: boolean;
  isStalled48h: boolean;
  hoursInCurrentStep: number;
  createdAt: string;
}

export default function CentroRevisionPage() {
  const { user, refreshBadges } = useAuth();
  const [signatures, setSignatures] = React.useState<PendingApprovalItem[]>([]);
  const [financeSettlements, setFinanceSettlements] = React.useState<ReviewRequestRow[]>([]);
  const [financeReturns, setFinanceReturns] = React.useState<ReviewRequestRow[]>([]);
  const [teamRequests, setTeamRequests] = React.useState<ReviewRequestRow[]>([]);
  const [teamSearch, setTeamSearch] = React.useState('');
  const [teamStatus, setTeamStatus] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  const [modalItem, setModalItem] = React.useState<{
    item: PendingApprovalItem;
    decision: 'APPROVED' | 'REJECTED' | 'OBSERVED';
  } | null>(null);
  const [comment, setComment] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const isFinance = Boolean(user?.roles.includes('FINANCE'));

  const loadHub = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: hubData, error: hubErr }, { data: teamData, error: teamErr }] =
        await Promise.all([
          api.api.approvals['review-hub'].get(),
          api.api.expenses.get({
            query: {
              scope: 'team',
              ...(teamSearch ? { search: teamSearch } : {}),
              ...(teamStatus ? { status: teamStatus } : {}),
            },
          }),
        ]);

      if (hubErr) {
        toast.error(extractApiError(hubErr, 'Error cargando centro de revisión'));
      } else if (hubData && 'pendingSignatures' in hubData) {
        setSignatures(hubData.pendingSignatures as PendingApprovalItem[]);
        setFinanceSettlements(hubData.pendingFinanceSettlements as ReviewRequestRow[]);
        setFinanceReturns(hubData.pendingFinanceReturns as ReviewRequestRow[]);
      }

      if (!teamErr && Array.isArray(teamData)) {
        setTeamRequests(teamData as ReviewRequestRow[]);
      }
    } finally {
      setLoading(false);
    }
  }, [user?.id, teamSearch, teamStatus]);

  React.useEffect(() => {
    void loadHub();
  }, [loadHub]);

  const submitDecision = async () => {
    if (!modalItem) return;
    setBusy(true);
    try {
      const { error } = await api.api.approvals({ stepId: modalItem.item.stepId }).decide.post({
        decision: modalItem.decision,
        comment: comment || null,
      });
      if (error) {
        toast.error(extractApiError(error, 'No se pudo procesar la firma'));
        return;
      }
      toast.success('Decisión registrada en el historial de auditoría');
      setModalItem(null);
      setComment('');
      await Promise.all([loadHub(), refreshBadges()]);
    } finally {
      setBusy(false);
    }
  };

  const financeActionCount = financeSettlements.length + financeReturns.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
          Centro de Revisión (Por Revisar)
        </h1>
        <p className="text-sm text-slate-500">
          Solicitudes de terceros pendientes de tu firma, auditoría financiera o seguimiento gerencial. Nunca mezcla tus propias solicitudes.
        </p>
      </div>

      <Tabs defaultValue="signatures">
        <TabsList>
          <TabsTrigger value="signatures">
            Pendientes de Firma ({signatures.length})
          </TabsTrigger>
          {(isFinance || financeActionCount > 0) && (
            <TabsTrigger value="finance">
              Auditoría Finanzas ({financeActionCount})
            </TabsTrigger>
          )}
          <TabsTrigger value="team">
            Seguimiento de Terceros ({teamRequests.length})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Pending Signatures */}
        <TabsContent value="signatures">
          {loading ? (
            <p className="p-8 text-center text-sm text-slate-500">Cargando firmas pendientes...</p>
          ) : signatures.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center space-y-2">
                <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
                <p className="font-semibold text-slate-900">Sin firmas pendientes</p>
                <p className="text-sm text-slate-500">
                  No tienes solicitudes pendientes de autorización directa ni por suplencia.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {signatures.map((item) => {
                const amountToShow =
                  item.phase === 'EXCESS_SETTLEMENT'
                    ? item.request.netSettlementAmount
                    : item.request.requestedAmount;
                const roleLabel =
                  APPROVAL_ROLE_LABELS[item.requiredRole as keyof typeof APPROVAL_ROLE_LABELS] ??
                  item.requiredRole;
                const blockedBy100 =
                  item.request.budgetOverrideRequired && !item.request.budgetOverrideApprovedById;

                return (
                  <Card key={item.stepId} className="hover:border-brand-300 transition-colors">
                    <CardContent className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={withFrom(`/solicitudes/${item.request.id}`, '/aprobaciones')}
                            className="text-base font-extrabold text-brand-600 hover:underline"
                          >
                            {item.request.code}
                          </Link>
                          <RequestTypeBadge type={item.request.type} />
                          <Badge variant="indigo">Etapa: {roleLabel}</Badge>
                          {item.phase === 'EXCESS_SETTLEMENT' && (
                            <Badge variant="purple">Excedente de Rendición</Badge>
                          )}
                          {item.actingAsDelegate && (
                            <Badge variant="indigo">
                              <ShieldCheck className="h-3 w-3" />
                              En reemplazo de {item.delegatorName} ({item.delegationReason})
                            </Badge>
                          )}
                          {item.request.budgetAlert85Triggered && (
                            <Badge variant="amber">
                              <AlertTriangle className="h-3 w-3" /> Presupuesto &gt;85%
                            </Badge>
                          )}
                          {item.isStalled48h && (
                            <Badge variant="rose">
                              <Clock className="h-3 w-3" /> Trabada ({item.hoursWaiting}h)
                            </Badge>
                          )}
                        </div>

                        <p className="font-semibold text-slate-900">{item.request.title}</p>
                        <p className="text-xs text-slate-500">
                          Solicitante: <strong>{item.request.requester.fullName}</strong> (
                          {item.request.requester.branch?.code}) ·{' '}
                          {item.request.project
                            ? `${item.request.project.code} - ${item.request.project.name}`
                            : `Depto. ${item.request.department?.name}`}
                        </p>
                        {blockedBy100 && (
                          <p className="text-xs font-semibold text-rose-700 flex items-center gap-1 pt-1">
                            <ShieldAlert className="h-3.5 w-3.5" />
                            Requiere Override Presupuestario (&gt;100%) desde el detalle antes de aprobar.
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col sm:flex-row lg:flex-col items-start sm:items-center lg:items-end gap-3 shrink-0">
                        <div className="text-left lg:text-right">
                          <span className="text-xs text-slate-500 block">
                            {item.phase === 'EXCESS_SETTLEMENT' ? 'Excedente a aprobar' : 'Monto solicitado'}
                          </span>
                          <span className="text-xl font-extrabold text-slate-900 tabular-nums">
                            {formatUsd(amountToShow)}
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="success"
                            disabled={blockedBy100}
                            onClick={() => {
                              setComment('');
                              setModalItem({ item, decision: 'APPROVED' });
                            }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Aprobar
                          </Button>
                          {item.phase === 'INITIAL_REQUEST' && (
                            <Button
                              size="sm"
                              variant="warning"
                              onClick={() => {
                                setComment('');
                                setModalItem({ item, decision: 'OBSERVED' });
                              }}
                            >
                              Observar
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              setComment('');
                              setModalItem({ item, decision: 'REJECTED' });
                            }}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            Rechazar
                          </Button>
                          <Link href={withFrom(`/solicitudes/${item.request.id}`, '/aprobaciones')}>
                            <Button size="sm" variant="outline">
                              Ver Detalle
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* TAB 2: Finance Item-by-Item Settlements & Bank Returns */}
        {(isFinance || financeActionCount > 0) && (
          <TabsContent value="finance" className="space-y-4">
            {financeActionCount === 0 ? (
              <Card>
                <CardContent className="p-10 text-center space-y-2">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
                  <p className="font-semibold text-slate-900">Sin rendiciones ni devoluciones pendientes</p>
                  <p className="text-sm text-slate-500">
                    Todas las rendiciones de anticipos y depósitos bancarios fueron auditados.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                {financeSettlements.map((r) => (
                  <Card key={r.id} className="border-indigo-200">
                    <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={withFrom(`/solicitudes/${r.id}`, '/aprobaciones')}
                            className="text-base font-extrabold text-brand-600 hover:underline"
                          >
                            {r.code}
                          </Link>
                          <ExpenseStatusBadge status={r.status} />
                          <Badge variant="indigo">Rendición Ítem por Ítem</Badge>
                        </div>
                        <p className="font-semibold text-slate-900">{r.title}</p>
                        <p className="text-xs text-slate-500">
                          Colaborador: <strong>{r.requester.fullName}</strong> · Anticipo:{' '}
                          <strong>{formatUsd(r.disbursedAmount)}</strong> · Rendido:{' '}
                          <strong>{formatUsd(r.renderedAmount)}</strong>
                        </p>
                      </div>
                      <Link href={withFrom(`/solicitudes/${r.id}`, '/aprobaciones')}>
                        <Button>
                          <Calculator className="h-4 w-4" />
                          Auditar Ítems
                        </Button>
                      </Link>
                    </CardContent>
                  </Card>
                ))}

                {financeReturns.map((r) => (
                  <Card key={r.id} className="border-amber-200">
                    <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={withFrom(`/solicitudes/${r.id}`, '/aprobaciones')}
                            className="text-base font-extrabold text-brand-600 hover:underline"
                          >
                            {r.code}
                          </Link>
                          <ExpenseStatusBadge status={r.status} />
                          <Badge variant="amber">Confirmar Devolución Bancaria</Badge>
                        </div>
                        <p className="font-semibold text-slate-900">{r.title}</p>
                        <p className="text-xs text-slate-500">
                          Colaborador: <strong>{r.requester.fullName}</strong> · Ref. Depósito:{' '}
                          <strong>{r.returnDepositRef ?? '—'}</strong> · Monto:{' '}
                          <strong>{formatUsd(Math.abs(r.netSettlementAmount))}</strong>
                        </p>
                      </div>
                      <Link href={withFrom(`/solicitudes/${r.id}`, '/aprobaciones')}>
                        <Button variant="warning">
                          <Landmark className="h-4 w-4" />
                          Confirmar Depósito
                        </Button>
                      </Link>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </TabsContent>
        )}

        {/* TAB 3: Team / Third-Party Follow-up */}
        <TabsContent value="team" className="space-y-4">
          <Card>
            <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="relative sm:col-span-2">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                <Input
                  placeholder="Buscar por código, título o solicitante..."
                  value={teamSearch}
                  onChange={(e) => setTeamSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={teamStatus} onChange={(e) => setTeamStatus(e.target.value)}>
                <option value="">Todos los estados</option>
                {Object.entries(EXPENSE_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {teamRequests.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  No hay solicitudes de terceros para revisar con estos filtros.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Solicitud</TableHead>
                      <TableHead>Solicitante</TableHead>
                      <TableHead>Modalidad</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-right">Fecha</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teamRequests.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link
                            href={withFrom(`/solicitudes/${r.id}`, '/aprobaciones')}
                            className="font-bold text-brand-600 hover:underline block"
                          >
                            {r.code}
                          </Link>
                          <span className="text-xs text-slate-600 line-clamp-1">{r.title}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="font-semibold text-slate-900">{r.requester.fullName}</span>
                          {r.requester.branch?.code && (
                            <span className="text-slate-400 ml-1">({r.requester.branch.code})</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <RequestTypeBadge type={r.type} />
                        </TableCell>
                        <TableCell>
                          <ExpenseStatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-right font-bold tabular-nums">
                          {formatUsd(r.requestedAmount)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-slate-500">
                          {formatDateEs(r.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(modalItem)} onOpenChange={(o) => !o && setModalItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modalItem?.decision === 'APPROVED'
                ? 'Confirmar Aprobación'
                : modalItem?.decision === 'REJECTED'
                  ? 'Confirmar Rechazo'
                  : 'Observar Solicitud'}{' '}
              — {modalItem?.item.request.code}
            </DialogTitle>
            <DialogDescription>
              {modalItem?.item.actingAsDelegate
                ? `Se registrará en auditoría que actúas en reemplazo temporal de ${modalItem.item.delegatorName} (${modalItem.item.delegationReason}).`
                : 'La firma quedará registrada de forma inmutable con marca de tiempo e IP.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>
                Comentario{' '}
                {modalItem?.decision === 'APPROVED' ? '(Opcional)' : '(Motivo obligatorio)'}
              </Label>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Escribe el detalle o sustento de tu decisión..."
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setModalItem(null)}>
                Cancelar
              </Button>
              <Button
                variant={
                  modalItem?.decision === 'APPROVED'
                    ? 'success'
                    : modalItem?.decision === 'REJECTED'
                      ? 'destructive'
                      : 'warning'
                }
                disabled={busy}
                onClick={() => void submitDecision()}
              >
                {busy ? 'Procesando...' : 'Confirmar Firma'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
