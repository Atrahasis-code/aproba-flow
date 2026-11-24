'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  Clock,
  DollarSign,
  FilePlus2,
  History,
  Landmark,
  PieChart,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { ExpenseStatusBadge, RequestTypeBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, extractApiError } from '@/lib/eden';
import { withFrom } from '@/lib/navigation';
import { formatUsd } from '@aproba-flow/shared';
import { MONTH_NAMES_ES } from '@/lib/utils';

interface DashboardData {
  isExecutive: boolean;
  year: number;
  month: number;
  thresholdPct: number;
  stalledHoursThreshold: number;
  kpis: {
    totalExecutedMonth: number;
    totalCommittedMonth: number;
    totalMonthExposure: number;
    stalledCount: number;
    alerts85Count: number;
    pendingTreasuryCount: number;
  };
  projectConsumption: Array<{
    id: string;
    code: string;
    name: string;
    clientName: string;
    managerName: string;
    budgetLimit: number;
    executed: number;
    committed: number;
    totalUsed: number;
    available: number;
    usagePct: number;
    isAlert85: boolean;
    isOver100: boolean;
  }>;
  departmentConsumption: Array<{
    id: string;
    code: string;
    name: string;
    budgetLimit: number;
    executed: number;
    committed: number;
    totalUsed: number;
    available: number;
    usagePct: number;
    isAlert85: boolean;
    isOver100: boolean;
  }>;
  alerts85: Array<{
    kind: 'DEPARTMENT' | 'PROJECT';
    id: string;
    name: string;
    usagePct: number;
    totalUsed: number;
    budgetLimit: number;
    isOver100: boolean;
  }>;
  stalledRequests: Array<{
    id: string;
    code: string;
    title: string;
    type: string;
    requestedAmount: number;
    requesterName: string;
    branchCode: string;
    targetName: string;
    responsibleName: string;
    hoursWaiting: number;
  }>;
  mySummary: {
    eligibility: {
      eligible: boolean;
      blockingRequests: Array<{
        id: string;
        code: string;
        title: string;
        reason: 'PENDING_RETURN' | 'OVERDUE_SETTLEMENT';
        amountOwed?: number;
      }>;
    };
    recentRequests: Array<{
      id: string;
      code: string;
      title: string;
      type: string;
      status: string;
      requestedAmount: number;
      netSettlementAmount: number;
      createdAt: string;
    }>;
  };
}

export default function DashboardPage() {
  const { user, pendingApprovalsCount } = useAuth();
  const now = new Date();
  const [year, setYear] = React.useState(now.getFullYear());
  const [month, setMonth] = React.useState(now.getMonth() + 1);
  const [branchId, setBranchId] = React.useState('');
  const [branches, setBranches] = React.useState<Array<{ id: string; code: string; name: string }>>([]);
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [remindingId, setRemindingId] = React.useState<string | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: dash, error }, { data: boot }] = await Promise.all([
        api.api.dashboard.executive.get({
          query: {
            year: String(year),
            month: String(month),
            ...(branchId ? { branchId } : {}),
          },
        }),
        api.api.catalogs.bootstrap.get(),
      ]);
      if (error) {
        toast.error(extractApiError(error, 'Error al cargar el tablero'));
      } else if (dash) {
        setData(dash as DashboardData);
      }
      if (boot && 'branches' in boot) {
        setBranches(boot.branches);
      }
    } finally {
      setLoading(false);
    }
  }, [year, month, branchId, user?.id]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const sendReminder = async (expenseId: string) => {
    setRemindingId(expenseId);
    try {
      const { data: res, error } = await api.api.dashboard.stalled({ expenseId }).remind.post();
      if (error) {
        toast.error(extractApiError(error, 'No se pudo enviar el recordatorio'));
        return;
      }
      toast.success(`Recordatorio enviado a ${res?.notified ?? 'aprobador'} (Notificación + Correo)`);
    } finally {
      setRemindingId(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header & Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            {data.isExecutive ? 'Tablero de Visibilidad Gerencial' : `Hola, ${user?.fullName}`}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {data.isExecutive
              ? 'Control en vivo de presupuestos por proyecto y departamento, cuellos de botella (>48h) y liquidez.'
              : 'Gestiona tus reembolsos, anticipos y rendiciones desde un solo lugar.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={withFrom('/solicitudes/nueva', '/')}>
            <Button>
              <FilePlus2 className="h-4 w-4" />
              Nueva Solicitud
            </Button>
          </Link>
          {pendingApprovalsCount > 0 && (
            <Link href="/aprobaciones">
              <Button variant="outline">
                Por Revisar ({pendingApprovalsCount})
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          )}
          {data.isExecutive && (
            <Link href={withFrom('/presupuestos', '/')}>
              <Button variant="outline">
                <PieChart className="h-4 w-4" />
                Presupuestos
              </Button>
            </Link>
          )}
          {user?.roles.some((r) => ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY'].includes(r)) && (
            <Link href={withFrom('/auditoria', '/')}>
              <Button variant="outline">
                <History className="h-4 w-4" />
                Auditoría
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Advance Block Warning for Current User */}
      {!data.mySummary.eligibility.eligible && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-900 space-y-1">
            <p className="font-bold">
              Bloqueo activo de nuevos anticipos en tu cuenta
            </p>
            <p className="text-xs text-rose-800">
              Tienes devoluciones pendientes o rendiciones vencidas. Regulariza estos casos para volver a solicitar anticipos:
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {data.mySummary.eligibility.blockingRequests.map((b) => (
                <Link
                  key={b.id}
                  href={withFrom(`/solicitudes/${b.id}`, '/')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                >
                  {b.code} — {b.reason === 'PENDING_RETURN' ? `Devolver ${formatUsd(b.amountOwed)}` : 'Rendición vencida'}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Executive Section */}
      {data.isExecutive && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl p-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide px-1">
              Periodo:
            </span>
            <Select
              value={String(month)}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="w-40"
              aria-label="Mes"
            >
              {MONTH_NAMES_ES.map((m, idx) => (
                <option key={m} value={idx + 1}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              value={String(year)}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-28"
              aria-label="Año"
            >
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
            <Select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="w-52"
              aria-label="Filial"
            >
              <option value="">Todas las filiales</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </Select>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-5 flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500">Gastado del Mes (Ejecutado)</p>
                  <p className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">
                    {formatUsd(data.kpis.totalExecutedMonth)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    + {formatUsd(data.kpis.totalCommittedMonth)} comprometido
                  </p>
                </div>
                <div className="p-2.5 rounded-xl bg-brand-50 text-brand-600">
                  <DollarSign className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500">
                    Trabadas &gt;{data.stalledHoursThreshold}h
                  </p>
                  <p className="text-2xl font-extrabold text-rose-600 mt-1 tabular-nums">
                    {data.kpis.stalledCount}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Esperando firma gerencial/Finanzas</p>
                </div>
                <div className="p-2.5 rounded-xl bg-rose-50 text-rose-600">
                  <Clock className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500">
                    Alertas Presupuesto (&gt;{data.thresholdPct}%)
                  </p>
                  <p className="text-2xl font-extrabold text-amber-600 mt-1 tabular-nums">
                    {data.kpis.alerts85Count}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Bloqueo auto-aprobación activo</p>
                </div>
                <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500">Pendientes en Tesorería</p>
                  <p className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">
                    {data.kpis.pendingTreasuryCount}
                  </p>
                  <Link href="/tesoreria" className="text-xs font-semibold text-brand-600 hover:underline mt-1 inline-block">
                    Ir a liquidar y exportar →
                  </Link>
                </div>
                <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600">
                  <Landmark className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Alerts >85% Banner */}
          {data.alerts85.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/40">
              <CardHeader className="border-amber-100">
                <CardTitle className="flex items-center gap-2 text-amber-900">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Alertas de Consumo Presupuestario (&gt;{data.thresholdPct}%)
                </CardTitle>
                <CardDescription className="text-amber-800">
                  Estos centros de costo o proyectos superaron el umbral del {data.thresholdPct}%. Toda nueva solicitud fuerza intervención de Finanzas.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.alerts85.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-xl border border-amber-200 bg-white p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <span className="text-[11px] font-semibold uppercase text-slate-400">
                        {a.kind === 'DEPARTMENT' ? 'Departamento' : 'Proyecto'}
                      </span>
                      <p className="text-sm font-bold text-slate-900 truncate">{a.name}</p>
                      <p className="text-xs text-slate-600 tabular-nums">
                        {formatUsd(a.totalUsed)} / {formatUsd(a.budgetLimit)}
                      </p>
                    </div>
                    <Badge variant={a.isOver100 ? 'rose' : 'amber'} className="text-sm font-bold">
                      {a.usagePct.toFixed(1)}%
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Charts: Projects & Departments */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-brand-600" />
                  Consumo Presupuestario por Proyecto
                </CardTitle>
                <CardDescription>Ejecutado + Comprometido frente al presupuesto total (USD)</CardDescription>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.projectConsumption.map((p) => ({
                      name: p.code,
                      Ejecutado: p.executed,
                      Comprometido: p.committed,
                      Disponible: p.available,
                    }))}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(val: number) => formatUsd(val)} />
                    <Bar dataKey="Ejecutado" stackId="a" fill="#2563eb" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Comprometido" stackId="a" fill="#818cf8" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-600" />
                  Consumo Mensual por Departamento ({MONTH_NAMES_ES[month - 1]})
                </CardTitle>
                <CardDescription>Porcentaje consumido respecto al techo mensual asignado</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.departmentConsumption.map((d) => (
                  <div key={d.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-800">{d.name}</span>
                      <span className="tabular-nums text-slate-600">
                        {formatUsd(d.totalUsed)} / {formatUsd(d.budgetLimit)}{' '}
                        <strong
                          className={
                            d.isOver100
                              ? 'text-rose-600'
                              : d.isAlert85
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }
                        >
                          ({d.usagePct.toFixed(1)}%)
                        </strong>
                      </span>
                    </div>
                    <div className="relative h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={
                          d.isOver100
                            ? 'h-full bg-rose-600'
                            : d.isAlert85
                              ? 'h-full bg-amber-500'
                              : 'h-full bg-brand-600'
                        }
                        style={{ width: `${Math.min(100, d.usagePct)}%` }}
                      />
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-slate-900/60"
                        style={{ left: `${data.thresholdPct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* Bottleneck Monitor (>48h) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-rose-600" />
                Monitor de Cuellos de Botella (&gt;{data.stalledHoursThreshold} horas sin firma)
              </CardTitle>
              <CardDescription>
                Solicitudes estancadas esperando autorización. Envía un recordatorio inmediato por notificación y correo.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {data.stalledRequests.length === 0 ? (
                <p className="p-6 text-sm text-slate-500 text-center">
                  ¡Excelente! No hay solicitudes trabadas por más de {data.stalledHoursThreshold} horas.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Solicitud</TableHead>
                      <TableHead>Solicitante</TableHead>
                      <TableHead>Destino</TableHead>
                      <TableHead>Responsable Actual</TableHead>
                      <TableHead>Espera</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.stalledRequests.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <Link
                            href={withFrom(`/solicitudes/${s.id}`, '/')}
                            className="font-semibold text-brand-600 hover:underline block"
                          >
                            {s.code}
                          </Link>
                          <span className="text-xs text-slate-500">{s.title}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium text-slate-800">{s.requesterName}</span>
                          <span className="text-slate-400 ml-1">({s.branchCode})</span>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{s.targetName}</TableCell>
                        <TableCell className="text-xs font-medium text-slate-800">
                          {s.responsibleName}
                        </TableCell>
                        <TableCell>
                          <Badge variant="rose">{s.hoursWaiting} horas</Badge>
                        </TableCell>
                        <TableCell className="text-right font-bold tabular-nums">
                          {formatUsd(s.requestedAmount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={remindingId === s.id}
                              onClick={() => void sendReminder(s.id)}
                            >
                              <BellRing className="h-3.5 w-3.5 text-amber-600" />
                              {remindingId === s.id ? 'Enviando...' : 'Recordatorio'}
                            </Button>
                            <Link href={withFrom(`/solicitudes/${s.id}`, '/')}>
                              <Button size="sm" variant="ghost">
                                Ver
                              </Button>
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* My Recent Requests */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Mis Solicitudes Recientes</CardTitle>
            <CardDescription>Últimos reembolsos y anticipos registrados con tu usuario</CardDescription>
          </div>
          <Link href="/solicitudes" className="text-xs font-semibold text-brand-600 hover:underline">
            Ver todas →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {data.mySummary.recentRequests.length === 0 ? (
            <p className="p-6 text-sm text-slate-500 text-center">
              Aún no registraste solicitudes con este perfil.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Concepto</TableHead>
                  <TableHead>Modalidad</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Monto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.mySummary.recentRequests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={withFrom(`/solicitudes/${r.id}`, '/')}
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        {r.code}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-800">{r.title}</TableCell>
                    <TableCell>
                      <RequestTypeBadge type={r.type} />
                    </TableCell>
                    <TableCell>
                      <ExpenseStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatUsd(r.requestedAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
