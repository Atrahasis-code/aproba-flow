'use client';

import * as React from 'react';
import Link from 'next/link';
import { Banknote, CheckCircle2, Download, FileSpreadsheet, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { ExpenseStatusBadge, RequestTypeBadge } from '@/components/shared/StatusBadge';
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
import { formatUsd } from '@aproba-flow/shared';
import { formatDateEs } from '@/lib/utils';

interface TreasuryRequest {
  id: string;
  code: string;
  type: string;
  status: string;
  title: string;
  requester: {
    fullName: string;
    employeeCode: string;
    branch?: { code: string; name: string } | null;
  };
  requestedAmount: number;
  disbursedAmount: number;
  approvedAmount: number;
  netSettlementAmount: number;
  disbursementRef: string | null;
  paymentRef: string | null;
  updatedAt: string;
}

export default function TesoreriaPage() {
  const { user } = useAuth();
  const [queue, setQueue] = React.useState<{
    disbursements: TreasuryRequest[];
    payments: TreasuryRequest[];
    completed: TreasuryRequest[];
  }>({ disbursements: [], payments: [], completed: [] });
  const [branches, setBranches] = React.useState<Array<{ id: string; code: string; name: string }>>([]);
  const [filterBranch, setFilterBranch] = React.useState('');
  const [filterFrom, setFilterFrom] = React.useState('');
  const [filterTo, setFilterTo] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  const [actionModal, setActionModal] = React.useState<{
    mode: 'disburse' | 'pay';
    item: TreasuryRequest;
  } | null>(null);
  const [bankRef, setBankRef] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const loadQueue = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, { data: boot }] = await Promise.all([
        api.api.treasury.queue.get(),
        api.api.catalogs.bootstrap.get(),
      ]);
      if (error) {
        toast.error(extractApiError(error, 'No tienes acceso o error cargando Tesorería'));
      } else if (data && 'disbursements' in data) {
        setQueue(data as typeof queue);
      }
      if (boot && 'branches' in boot) {
        setBranches(boot.branches);
      }
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  React.useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const executeTreasuryAction = async () => {
    if (!actionModal) return;
    setBusy(true);
    try {
      if (actionModal.mode === 'disburse') {
        const { error } = await api.api
          .treasury({ expenseId: actionModal.item.id })
          .disburse.post({ disbursementRef: bankRef });
        if (error) {
          toast.error(extractApiError(error, 'Error registrando desembolso'));
          return;
        }
        toast.success(`Anticipo ${actionModal.item.code} desembolsado`);
      } else {
        const { error } = await api.api
          .treasury({ expenseId: actionModal.item.id })
          .pay.post({ paymentRef: bankRef, paymentNotes: notes || null });
        if (error) {
          toast.error(extractApiError(error, 'Error registrando pago'));
          return;
        }
        toast.success(`Pago liquidado en ${actionModal.item.code}`);
      }
      setActionModal(null);
      setBankRef('');
      setNotes('');
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  const buildExportUrl = (format: 'xlsx' | 'csv') => {
    const params = new URLSearchParams({ format });
    if (filterBranch) params.set('branchId', filterBranch);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    return `/api/treasury/export?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Tesorería, Desembolsos y Conciliación
          </h1>
          <p className="text-sm text-slate-500">
            Bandejas automáticas con montos validados sin cálculo manual y reporte limpio para carga bancaria.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a href={buildExportUrl('xlsx')}>
            <Button variant="success">
              <FileSpreadsheet className="h-4 w-4" />
              Exportar Excel (.xlsx)
            </Button>
          </a>
          <a href={buildExportUrl('csv')}>
            <Button variant="outline">
              <Download className="h-4 w-4" />
              Exportar CSV
            </Button>
          </a>
        </div>
      </div>

      {/* Export Filter Bar */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="w-52">
            <Label>Filtrar Exportable por Filial</Label>
            <Select value={filterBranch} onChange={(e) => setFilterBranch(e.target.value)}>
              <option value="">Todas las filiales</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Label>Desde</Label>
            <Input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </div>
          <div className="w-40">
            <Label>Hasta</Label>
            <Input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="payments">
        <TabsList>
          <TabsTrigger value="payments">
            Listos para Pagar ({queue.payments.length})
          </TabsTrigger>
          <TabsTrigger value="disbursements">
            Listos para Desembolsar ({queue.disbursements.length})
          </TabsTrigger>
          <TabsTrigger value="completed">
            Histórico / Devoluciones ({queue.completed.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="payments">
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <p className="p-8 text-center text-sm text-slate-500">Cargando bandeja...</p>
              ) : queue.payments.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  No hay reembolsos o excedentes pendientes de pago.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Solicitud</TableHead>
                      <TableHead>Colaborador</TableHead>
                      <TableHead>Modalidad</TableHead>
                      <TableHead className="text-right">Anticipado</TableHead>
                      <TableHead className="text-right">Validado</TableHead>
                      <TableHead className="text-right">Neto a Pagar</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.payments.map((r) => {
                      const netPay =
                        r.type === 'REIMBURSEMENT'
                          ? r.approvedAmount > 0
                            ? r.approvedAmount
                            : r.requestedAmount
                          : r.netSettlementAmount;
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            <Link
                              href={withFrom(`/solicitudes/${r.id}`, '/tesoreria')}
                              className="font-bold text-brand-600 hover:underline block"
                            >
                              {r.code}
                            </Link>
                            <span className="text-xs text-slate-500">{r.title}</span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="font-semibold text-slate-900">{r.requester.fullName}</span>
                            <span className="block text-slate-400">
                              {r.requester.employeeCode} · {r.requester.branch?.code}
                            </span>
                          </TableCell>
                          <TableCell>
                            <RequestTypeBadge type={r.type} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            {formatUsd(r.disbursedAmount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            {formatUsd(r.approvedAmount > 0 ? r.approvedAmount : r.requestedAmount)}
                          </TableCell>
                          <TableCell className="text-right font-extrabold text-emerald-700 tabular-nums">
                            {formatUsd(netPay)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="success"
                              onClick={() => {
                                setBankRef('');
                                setNotes('');
                                setActionModal({ mode: 'pay', item: r });
                              }}
                            >
                              <Banknote className="h-3.5 w-3.5" />
                              Registrar Pago
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="disbursements">
          <Card>
            <CardContent className="p-0">
              {queue.disbursements.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  No hay anticipos pendientes de desembolso.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Anticipo</TableHead>
                      <TableHead>Colaborador</TableHead>
                      <TableHead className="text-right">Monto a Desembolsar</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.disbursements.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link
                            href={withFrom(`/solicitudes/${r.id}`, '/tesoreria')}
                            className="font-bold text-brand-600 hover:underline block"
                          >
                            {r.code}
                          </Link>
                          <span className="text-xs text-slate-500">{r.title}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="font-semibold text-slate-900">{r.requester.fullName}</span>
                          <span className="block text-slate-400">
                            {r.requester.employeeCode} · {r.requester.branch?.code}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-extrabold text-indigo-700 tabular-nums">
                          {formatUsd(r.requestedAmount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => {
                              setBankRef('');
                              setActionModal({ mode: 'disburse', item: r });
                            }}
                          >
                            <Send className="h-3.5 w-3.5" />
                            Desembolsar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completed">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Colaborador</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Anticipado</TableHead>
                    <TableHead className="text-right">Validado</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                    <TableHead>Ref. / Fecha</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.completed.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link
                          href={withFrom(`/solicitudes/${r.id}`, '/tesoreria')}
                          className="font-semibold text-brand-600 hover:underline"
                        >
                          {r.code}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{r.requester.fullName}</TableCell>
                      <TableCell>
                        <ExpenseStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {formatUsd(r.disbursedAmount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {formatUsd(r.approvedAmount)}
                      </TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-xs">
                        {formatUsd(r.netSettlementAmount)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {r.paymentRef || r.disbursementRef || '—'} · {formatDateEs(r.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Disburse / Pay Dialog */}
      <Dialog open={Boolean(actionModal)} onOpenChange={(o) => !o && setActionModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionModal?.mode === 'disburse' ? 'Registrar Desembolso de Anticipo' : 'Registrar Transferencia de Pago'}
            </DialogTitle>
            <DialogDescription>
              {actionModal?.item.code} — {actionModal?.item.requester.fullName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Referencia / Comprobante Bancario *</Label>
              <Input
                value={bankRef}
                onChange={(e) => setBankRef(e.target.value)}
                placeholder="Ej. TRF-2026-99410"
              />
            </div>
            {actionModal?.mode === 'pay' && (
              <div>
                <Label>Notas de Tesorería (Opcional)</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Ej. Lote de pagos quincenal..."
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActionModal(null)}>
                Cancelar
              </Button>
              <Button disabled={busy || !bankRef.trim()} onClick={() => void executeTreasuryAction()}>
                <CheckCircle2 className="h-4 w-4" />
                {busy ? 'Guardando...' : 'Confirmar Operación'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
