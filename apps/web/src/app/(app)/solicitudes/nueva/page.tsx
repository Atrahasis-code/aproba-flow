'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  FolderKanban,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { BudgetMeter, type BudgetImpactData } from '@/components/shared/BudgetMeter';
import { ReceiptPreviewModal } from '@/components/shared/ReceiptPreviewModal';
import { ReceiptUploader, type UploadedFileMeta } from '@/components/shared/ReceiptUploader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, extractApiError } from '@/lib/eden';
import { resolveReturnTarget, withFrom } from '@/lib/navigation';
import { formatUsd, sumMoney } from '@aproba-flow/shared';
import { cn } from '@/lib/utils';

interface DraftItem {
  key: string;
  categoryId: string;
  expenseDate: string;
  vendorName: string;
  vendorTaxId: string;
  invoiceNumber: string;
  description: string;
  claimedAmount: string;
  receipt: UploadedFileMeta | null;
}

interface BootstrapData {
  departments: Array<{ id: string; code: string; name: string }>;
  projects: Array<{ id: string; code: string; name: string; clientName: string; managerName: string }>;
  categories: Array<{
    id: string;
    code: string;
    name: string;
    accountCode: string;
    specialTag: string | null;
    requiresReceipt: boolean;
  }>;
}

interface EligibilityState {
  eligible: boolean;
  blockingRequests: Array<{
    id: string;
    code: string;
    title: string;
    reason: 'PENDING_RETURN' | 'OVERDUE_SETTLEMENT';
    amountOwed?: number;
  }>;
}

function NuevaSolicitudInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTarget = resolveReturnTarget(searchParams.get('from'), '/solicitudes');
  const { user, refreshBadges } = useAuth();
  const [bootstrap, setBootstrap] = React.useState<BootstrapData | null>(null);
  const [eligibility, setEligibility] = React.useState<EligibilityState>({
    eligible: true,
    blockingRequests: [],
  });
  const [type, setType] = React.useState<'REIMBURSEMENT' | 'ADVANCE'>('REIMBURSEMENT');
  const [budgetTargetType, setBudgetTargetType] = React.useState<'DEPARTMENT' | 'PROJECT'>('DEPARTMENT');
  const [departmentId, setDepartmentId] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [advanceAmount, setAdvanceAmount] = React.useState('350.00');
  const [specialTag, setSpecialTag] = React.useState('');
  const [travelStartDate, setTravelStartDate] = React.useState('');
  const [travelEndDate, setTravelEndDate] = React.useState('');
  const [items, setItems] = React.useState<DraftItem[]>([]);
  const [impact, setImpact] = React.useState<BudgetImpactData | null>(null);
  const [previewFile, setPreviewFile] = React.useState<UploadedFileMeta | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const [{ data: boot }, { data: elig }] = await Promise.all([
        api.api.catalogs.bootstrap.get(),
        api.api.expenses.eligibility.get(),
      ]);

      if (boot && 'departments' in boot) {
        const b = boot as BootstrapData;
        setBootstrap(b);
        if (b.departments.length > 0) {
          const own = b.departments.find((d) => d.id === user?.departmentId) ?? b.departments[0];
          setDepartmentId(own.id);
        }
        if (b.projects.length > 0) {
          setProjectId(b.projects[0].id);
        }
        if (b.categories.length > 0) {
          setItems([
            {
              key: crypto.randomUUID(),
              categoryId: b.categories[0].id,
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

      if (elig && 'eligible' in elig) {
        setEligibility(elig as EligibilityState);
      }
    })();
  }, [user?.id, user?.departmentId]);

  const totalAmount =
    type === 'ADVANCE'
      ? Number(advanceAmount) || 0
      : sumMoney(items.map((i) => Number(i.claimedAmount) || 0));

  React.useEffect(() => {
    if (budgetTargetType === 'DEPARTMENT' && !departmentId) return;
    if (budgetTargetType === 'PROJECT' && !projectId) return;

    const timer = setTimeout(() => {
      void (async () => {
        const { data } = await api.api.budgets['check-impact'].post({
          budgetTargetType,
          departmentId: budgetTargetType === 'DEPARTMENT' ? departmentId : null,
          projectId: budgetTargetType === 'PROJECT' ? projectId : null,
          candidateAmount: totalAmount,
        });
        if (data && 'targetName' in data) {
          setImpact(data as BudgetImpactData);
        }
      })();
    }, 220);

    return () => clearTimeout(timer);
  }, [budgetTargetType, departmentId, projectId, totalAmount]);

  const addItem = () => {
    if (!bootstrap?.categories.length) return;
    setItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        categoryId: bootstrap.categories[0].id,
        expenseDate: new Date().toISOString().slice(0, 10),
        vendorName: '',
        vendorTaxId: '',
        invoiceNumber: '',
        description: '',
        claimedAmount: '',
        receipt: null,
      },
    ]);
  };

  const updateItem = (key: string, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error('Ingresa un título descriptivo para la solicitud');
      return;
    }

    if (budgetTargetType === 'PROJECT' && !projectId) {
      toast.error('No tienes proyectos asignados disponibles para imputar');
      return;
    }

    setSubmitting(true);
    try {
      if (type === 'ADVANCE') {
        if (!eligibility.eligible) {
          toast.error('Tienes un bloqueo activo para solicitar nuevos anticipos');
          return;
        }
        const amount = Number(advanceAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          toast.error('El monto del anticipo debe ser mayor a $0.00');
          return;
        }
        const { data, error } = await api.api.expenses.advances.post({
          title,
          description: description || null,
          travelStartDate: travelStartDate || null,
          travelEndDate: travelEndDate || null,
          budgetTargetType,
          departmentId: budgetTargetType === 'DEPARTMENT' ? departmentId : null,
          projectId: budgetTargetType === 'PROJECT' ? projectId : null,
          requestedAmount: amount,
          specialTag: specialTag || null,
        });
        if (error || !data) {
          toast.error(extractApiError(error, 'No se pudo enviar el anticipo'));
          return;
        }
        toast.success(`Anticipo ${data.code} enviado a aprobación`);
        await refreshBadges();
        router.push(withFrom(`/solicitudes/${data.id}`, returnTarget.href));
        return;
      }

      // REIMBURSEMENT
      for (const it of items) {
        const amt = Number(it.claimedAmount);
        if (!it.vendorName.trim() || !it.vendorTaxId.trim() || !it.invoiceNumber.trim() || !it.description.trim()) {
          toast.error('Completa todos los campos de cada factura/comprobante');
          return;
        }
        if (!Number.isFinite(amt) || amt <= 0) {
          toast.error('Cada ítem debe tener un monto mayor a $0.00');
          return;
        }
        const cat = bootstrap?.categories.find((c) => c.id === it.categoryId);
        if (cat?.requiresReceipt && !it.receipt?.id) {
          toast.error(`Adjunta el comprobante en "${cat.name}"`);
          return;
        }
      }

      const { data, error } = await api.api.expenses.reimbursements.post({
        title,
        description: description || null,
        budgetTargetType,
        departmentId: budgetTargetType === 'DEPARTMENT' ? departmentId : null,
        projectId: budgetTargetType === 'PROJECT' ? projectId : null,
        items: items.map((it) => ({
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

      if (error || !data) {
        toast.error(extractApiError(error, 'No se pudo enviar el reembolso'));
        return;
      }
      toast.success(`Reembolso ${data.code} enviado a aprobación`);
      await refreshBadges();
      router.push(withFrom(`/solicitudes/${data.id}`, returnTarget.href));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href={returnTarget.href}>
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Volver a {returnTarget.label}
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Nueva Solicitud de Gasto
          </h1>
          <p className="text-sm text-slate-500">
            Elige si rindes un gasto ya pagado (Reembolso) o solicitas fondos previos (Anticipo).
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: Modalidad */}
        <Card>
          <CardHeader>
            <CardTitle>1. Modalidad de Gasto</CardTitle>
            <CardDescription>
              Cada modalidad sigue su propio flujo de autorización y liquidación.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setType('REIMBURSEMENT')}
              className={cn(
                'text-left rounded-xl border-2 p-4 transition-all cursor-pointer',
                type === 'REIMBURSEMENT'
                  ? 'border-brand-600 bg-brand-50/50'
                  : 'border-slate-200 hover:border-slate-300'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase text-brand-700">Modalidad A</span>
                <span className="text-xs text-slate-500">Fondos Propios</span>
              </div>
              <p className="text-base font-bold text-slate-900 mt-1">Reembolso Directo</p>
              <p className="text-xs text-slate-600 mt-1">
                Para gastos ya realizados (taxis, comidas, compras menores) cargando sus comprobantes reales.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setType('ADVANCE')}
              className={cn(
                'text-left rounded-xl border-2 p-4 transition-all cursor-pointer',
                type === 'ADVANCE'
                  ? 'border-purple-600 bg-purple-50/50'
                  : 'border-slate-200 hover:border-slate-300'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase text-purple-700">Modalidad B</span>
                <span className="text-xs text-slate-500">Fondos de la Empresa</span>
              </div>
              <p className="text-base font-bold text-slate-900 mt-1">Anticipo / Fondo a Rendir</p>
              <p className="text-xs text-slate-600 mt-1">
                Solicita dinero estimado antes de un viaje o compra grande; se rinde ítem por ítem al finalizar.
              </p>
            </button>
          </CardContent>
        </Card>

        {/* Block warning if Advance and ineligible */}
        {type === 'ADVANCE' && !eligibility.eligible && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="text-sm text-rose-900 space-y-1.5">
              <p className="font-bold">
                Bloqueo activo: No puedes solicitar nuevos anticipos en este momento
              </p>
              <p className="text-xs text-rose-800">
                La política financiera impide emitir anticipos a colaboradores con devoluciones pendientes o rendiciones vencidas:
              </p>
              <div className="flex flex-wrap gap-2">
                {eligibility.blockingRequests.map((b) => (
                  <Link
                    key={b.id}
                    href={`/solicitudes/${b.id}`}
                    className="rounded-lg bg-white border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                  >
                    Ir a {b.code} ({b.reason === 'PENDING_RETURN' ? `Devolver ${formatUsd(b.amountOwed)}` : 'Vencido'})
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Imputación Presupuestaria */}
        <Card>
          <CardHeader>
            <CardTitle>2. Destino Presupuestario (Imputación Exclusiva)</CardTitle>
            <CardDescription>
              Para evitar doble conteo, imputa el gasto a un único Centro de Costo o a un Proyecto asignado.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setBudgetTargetType('DEPARTMENT')}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-3.5 text-left cursor-pointer transition-colors',
                  budgetTargetType === 'DEPARTMENT'
                    ? 'border-brand-600 bg-brand-50/50 text-brand-900'
                    : 'border-slate-200 hover:bg-slate-50'
                )}
              >
                <Building2 className="h-5 w-5 text-brand-600 shrink-0" />
                <div>
                  <div className="text-sm font-bold">Centro de Costo (Departamento)</div>
                  <div className="text-xs text-slate-500">Techo mensual operativo · Aprueba Jefe Directo</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setBudgetTargetType('PROJECT')}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-3.5 text-left cursor-pointer transition-colors',
                  budgetTargetType === 'PROJECT'
                    ? 'border-brand-600 bg-brand-50/50 text-brand-900'
                    : 'border-slate-200 hover:bg-slate-50'
                )}
              >
                <FolderKanban className="h-5 w-5 text-brand-600 shrink-0" />
                <div>
                  <div className="text-sm font-bold">Proyecto de Cliente</div>
                  <div className="text-xs text-slate-500">Presupuesto global del contrato · Aprueba Gerente PM</div>
                </div>
              </button>
            </div>

            {budgetTargetType === 'DEPARTMENT' ? (
              <div>
                <Label htmlFor="departmentId">Departamento</Label>
                <Select
                  id="departmentId"
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                >
                  {bootstrap?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} — {d.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <div>
                <Label htmlFor="projectId">Proyecto Asignado</Label>
                {bootstrap?.projects.length === 0 ? (
                  <p className="text-xs text-rose-600 font-medium">
                    No estás asignado activamente a ningún proyecto. Solicita tu asignación a Gerencia.
                  </p>
                ) : (
                  <Select
                    id="projectId"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    {bootstrap?.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} — {p.name} (PM: {p.managerName})
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}

            {impact && <BudgetMeter data={impact} />}
          </CardContent>
        </Card>

        {/* Step 3: Detalles generales */}
        <Card>
          <CardHeader>
            <CardTitle>3. Información de la Solicitud</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <Label htmlFor="title">Título / Concepto General *</Label>
                <Input
                  id="title"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    type === 'ADVANCE'
                      ? 'Ej. Viaje de implementación Fase 2 — Medellín'
                      : 'Ej. Taxis y almuerzo de trabajo con cliente Banco Andino'
                  }
                />
              </div>

              <div className="md:col-span-2">
                <Label htmlFor="description">Justificación de Negocio</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Contexto del gasto, proyecto o cliente atendido..."
                />
              </div>

              {type === 'ADVANCE' && (
                <>
                  <div>
                    <Label htmlFor="advanceAmount">Monto Estimado Solicitado (USD) *</Label>
                    <Input
                      id="advanceAmount"
                      type="number"
                      step="0.01"
                      min="1"
                      required
                      value={advanceAmount}
                      onChange={(e) => setAdvanceAmount(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="specialTag">Tipo de Compra / Especialidad</Label>
                    <Select
                      id="specialTag"
                      value={specialTag}
                      onChange={(e) => setSpecialTag(e.target.value)}
                    >
                      <option value="">Viaje / Operación Estándar</option>
                      <option value="IT">Compra Especial de Tecnología (IT)</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="travelStartDate">Fecha Inicio</Label>
                    <Input
                      id="travelStartDate"
                      type="date"
                      value={travelStartDate}
                      onChange={(e) => setTravelStartDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="travelEndDate">Fecha Retorno</Label>
                    <Input
                      id="travelEndDate"
                      type="date"
                      value={travelEndDate}
                      onChange={(e) => setTravelEndDate(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Step 4: Items (only for REIMBURSEMENT) */}
        {type === 'REIMBURSEMENT' && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>4. Detalle de Facturas y Comprobantes</CardTitle>
                <CardDescription>
                  Carga cada comprobante individualmente para que Finanzas pueda auditarlo ítem por ítem.
                </CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="h-4 w-4" />
                Agregar ítem
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((item, idx) => (
                <div
                  key={item.key}
                  className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-slate-500">
                      Comprobante #{idx + 1}
                    </span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(item.key)}
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
                        value={item.categoryId}
                        onChange={(e) => updateItem(item.key, { categoryId: e.target.value })}
                      >
                        {bootstrap?.categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.accountCode}){c.specialTag ? ` [${c.specialTag}]` : ''}
                          </option>
                        ))}
                      </Select>
                    </div>

                    <div>
                      <Label>Fecha del Gasto *</Label>
                      <Input
                        type="date"
                        required
                        value={item.expenseDate}
                        onChange={(e) => updateItem(item.key, { expenseDate: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>Monto (USD) *</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        placeholder="0.00"
                        value={item.claimedAmount}
                        onChange={(e) => updateItem(item.key, { claimedAmount: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>Proveedor / Comercio *</Label>
                      <Input
                        required
                        placeholder="Ej. Hotel Pacífico"
                        value={item.vendorName}
                        onChange={(e) => updateItem(item.key, { vendorName: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>RUC / NIT Proveedor *</Label>
                      <Input
                        required
                        placeholder="Ej. 900112233-1"
                        value={item.vendorTaxId}
                        onChange={(e) => updateItem(item.key, { vendorTaxId: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>N° Factura / Recibo *</Label>
                      <Input
                        required
                        placeholder="Ej. F001-4821"
                        value={item.invoiceNumber}
                        onChange={(e) => updateItem(item.key, { invoiceNumber: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>Detalle del Ítem *</Label>
                      <Input
                        required
                        placeholder="Ej. Almuerzo con cliente"
                        value={item.description}
                        onChange={(e) => updateItem(item.key, { description: e.target.value })}
                      />
                    </div>
                  </div>

                  <div>
                    <Label>Archivo Comprobante (PDF / Imagen) *</Label>
                    <ReceiptUploader
                      value={item.receipt}
                      onChange={(file) => updateItem(item.key, { receipt: file })}
                      onPreview={(file) => setPreviewFile(file)}
                      compact
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Submit Footer */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-brand-50 text-brand-600">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Total de la Solicitud</span>
              <span className="text-xl font-extrabold text-slate-900 tabular-nums">
                {formatUsd(totalAmount)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Link href={returnTarget.href} className="w-full sm:w-auto">
              <Button type="button" variant="outline" className="w-full">
                Cancelar
              </Button>
            </Link>
            <Button
              type="submit"
              disabled={submitting || (type === 'ADVANCE' && !eligibility.eligible)}
              className="w-full sm:w-auto"
            >
              <Send className="h-4 w-4" />
              {submitting ? 'Enviando...' : 'Enviar a Aprobación'}
            </Button>
          </div>
        </div>
      </form>

      <ReceiptPreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}

export default function NuevaSolicitudPage() {
  return (
    <React.Suspense
      fallback={<p className="p-8 text-center text-sm text-slate-500">Cargando formulario...</p>}
    >
      <NuevaSolicitudInner />
    </React.Suspense>
  );
}
