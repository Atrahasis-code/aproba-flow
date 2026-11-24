'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Plus, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { BudgetMeter } from '@/components/shared/BudgetMeter';
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
import { Input, Label, Select } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, extractApiError } from '@/lib/eden';
import { resolveReturnTarget } from '@/lib/navigation';
import { formatUsd } from '@aproba-flow/shared';
import { MONTH_NAMES_ES } from '@/lib/utils';

interface DeptSummary {
  targetId: string;
  targetCode: string;
  targetName: string;
  budgetLimit: number;
  executed: number;
  committed: number;
  totalUsed: number;
  available: number;
  usagePct: number;
  isAlert85: boolean;
  isOver100: boolean;
  months: Array<{ month: number; amount: number }>;
}

interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  clientName: string;
  managerName: string;
  status: string;
  budgetLimit: number;
  executed: number;
  committed: number;
  totalUsed: number;
  available: number;
  usagePct: number;
  targetName: string;
  assignedUsers: Array<{ id: string; fullName: string; employeeCode: string }>;
}

function PresupuestosInner() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const fromParam = searchParams.get('from');
  const returnTarget = fromParam ? resolveReturnTarget(fromParam, '/') : null;
  const now = new Date();
  const [year, setYear] = React.useState(now.getFullYear());
  const [month, setMonth] = React.useState(now.getMonth() + 1);
  const [departments, setDepartments] = React.useState<DeptSummary[]>([]);
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [allUsers, setAllUsers] = React.useState<Array<{ id: string; fullName: string; roles: string[] }>>([]);
  const [loading, setLoading] = React.useState(true);

  const [editDeptModal, setEditDeptModal] = React.useState<{
    deptId: string;
    deptName: string;
    month: number;
    amount: string;
  } | null>(null);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [newProj, setNewProj] = React.useState({
    code: '',
    name: '',
    clientName: '',
    managerId: '',
    totalBudget: '15000',
    startDate: new Date().toISOString().slice(0, 10),
  });
  const [assignProjectModal, setAssignProjectModal] = React.useState<ProjectSummary | null>(null);
  const [assignUserId, setAssignUserId] = React.useState('');

  const canManageBudgets = Boolean(
    user?.roles.some((r) => ['ADMIN', 'FINANCE', 'DIRECTION'].includes(r))
  );

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, { data: boot }] = await Promise.all([
        api.api.budgets.overview.get({
          query: { year: String(year), month: String(month) },
        }),
        api.api.catalogs.bootstrap.get(),
      ]);
      if (error) {
        toast.error(extractApiError(error, 'Error cargando presupuestos'));
      } else if (data && 'departments' in data) {
        setDepartments(data.departments as DeptSummary[]);
        setProjects(data.projects as ProjectSummary[]);
      }
      if (boot && 'users' in boot) {
        setAllUsers(boot.users);
        if (boot.users.length > 0 && !newProj.managerId) {
          const mgr = boot.users.find((u) => u.roles.includes('MANAGER')) ?? boot.users[0];
          setNewProj((p) => ({ ...p, managerId: mgr.id }));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [year, month, user?.id]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const saveDeptBudget = async () => {
    if (!editDeptModal) return;
    const { error } = await api.api.budgets
      .departments({ id: editDeptModal.deptId })({ year: String(year) })({
        month: String(editDeptModal.month),
      })
      .put({ amount: Number(editDeptModal.amount) });
    if (error) {
      toast.error(extractApiError(error, 'No se pudo actualizar el presupuesto'));
      return;
    }
    toast.success('Techo mensual actualizado');
    setEditDeptModal(null);
    await loadData();
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await api.api.budgets.projects.post({
      code: newProj.code,
      name: newProj.name,
      clientName: newProj.clientName,
      managerId: newProj.managerId,
      totalBudget: Number(newProj.totalBudget),
      startDate: newProj.startDate,
    });
    if (error) {
      toast.error(extractApiError(error, 'Error al crear proyecto'));
      return;
    }
    toast.success('Proyecto creado');
    setNewProjectOpen(false);
    setNewProj((p) => ({ ...p, code: '', name: '', clientName: '' }));
    await loadData();
  };

  const assignUser = async () => {
    if (!assignProjectModal || !assignUserId) return;
    const { error } = await api.api.budgets
      .projects({ id: assignProjectModal.id })
      .assignments.post({ userId: assignUserId });
    if (error) {
      toast.error(extractApiError(error, 'No se pudo asignar'));
      return;
    }
    toast.success('Consultor asignado al proyecto');
    setAssignProjectModal(null);
    await loadData();
  };

  const unassignUser = async (projectId: string, userId: string) => {
    const { error } = await api.api.budgets
      .projects({ id: projectId })
      .assignments({ userId })
      .delete();
    if (error) {
      toast.error(extractApiError(error, 'Error al desasignar'));
      return;
    }
    toast.success('Asignación retirada');
    await loadData();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {returnTarget && (
            <Link href={returnTarget.href}>
              <Button variant="outline" size="sm" className="mt-0.5 shrink-0">
                <ArrowLeft className="h-4 w-4" />
                Volver a {returnTarget.label}
              </Button>
            </Link>
          )}
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
              Estructura Presupuestaria
            </h1>
            <p className="text-sm text-slate-500">
              Centros de costo mensuales (12 techos por departamento) y presupuestos globales por proyecto.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={String(month)} onChange={(e) => setMonth(Number(e.target.value))} className="w-36">
            {MONTH_NAMES_ES.map((m, idx) => (
              <option key={m} value={idx + 1}>
                {m}
              </option>
            ))}
          </Select>
          <Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))} className="w-24">
            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Tabs defaultValue="departments">
        <TabsList>
          <TabsTrigger value="departments">Centros de Costo ({departments.length})</TabsTrigger>
          <TabsTrigger value="projects">Proyectos de Cliente ({projects.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="departments" className="space-y-4">
          {loading ? (
            <p className="p-8 text-center text-sm text-slate-500">Cargando presupuestos...</p>
          ) : (
            departments.map((d) => (
              <Card key={d.targetId}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle>{d.targetName}</CardTitle>
                    <CardDescription>
                      Código: {d.targetCode} · Mes consultado: {MONTH_NAMES_ES[month - 1]} {year}
                    </CardDescription>
                  </div>
                  {canManageBudgets && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditDeptModal({
                          deptId: d.targetId,
                          deptName: d.targetName,
                          month,
                          amount: String(d.budgetLimit),
                        })
                      }
                    >
                      Editar techo {MONTH_NAMES_ES[month - 1]}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <BudgetMeter data={d} />
                  <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-12 gap-2">
                    {d.months.map((m) => (
                      <button
                        key={m.month}
                        type="button"
                        disabled={!canManageBudgets}
                        onClick={() =>
                          canManageBudgets &&
                          setEditDeptModal({
                            deptId: d.targetId,
                            deptName: d.targetName,
                            month: m.month,
                            amount: String(m.amount),
                          })
                        }
                        className={`rounded-lg border p-2 text-left text-[11px] transition-colors ${
                          m.month === month
                            ? 'border-brand-600 bg-brand-50'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <span className="font-semibold text-slate-500 block">
                          {MONTH_NAMES_ES[m.month - 1].slice(0, 3)}
                        </span>
                        <span className="font-bold text-slate-900 tabular-nums">
                          {formatUsd(m.amount)}
                        </span>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="projects" className="space-y-4">
          {canManageBudgets && (
            <div className="flex justify-end">
              <Button onClick={() => setNewProjectOpen(true)}>
                <Plus className="h-4 w-4" />
                Nuevo Proyecto
              </Button>
            </div>
          )}

          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle>
                      {p.code} — {p.name}
                    </CardTitle>
                    <Badge variant={p.status === 'ACTIVE' ? 'emerald' : 'slate'}>{p.status}</Badge>
                  </div>
                  <CardDescription>
                    Cliente: {p.clientName} · Gerente PM: <strong>{p.managerName}</strong>
                  </CardDescription>
                </div>
                {canManageBudgets && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAssignUserId(allUsers[0]?.id ?? '');
                      setAssignProjectModal(p);
                    }}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Asignar Consultor
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <BudgetMeter data={p} />
                <div>
                  <span className="text-xs font-semibold text-slate-500 block mb-2">
                    Consultores con permiso de imputación ({p.assignedUsers.length}):
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {p.assignedUsers.map((u) => (
                      <span
                        key={u.id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
                      >
                        {u.fullName}
                        {canManageBudgets && (
                          <button
                            type="button"
                            onClick={() => void unassignUser(p.id, u.id)}
                            className="text-slate-400 hover:text-rose-600 cursor-pointer"
                            title="Retirar del proyecto"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      {/* Edit Dept Monthly Budget Modal */}
      <Dialog open={Boolean(editDeptModal)} onOpenChange={(o) => !o && setEditDeptModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Techo Mensual — {editDeptModal?.deptName}</DialogTitle>
            <DialogDescription>
              Mes: {editDeptModal ? MONTH_NAMES_ES[editDeptModal.month - 1] : ''} {year}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Monto Presupuestado (USD)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={editDeptModal?.amount ?? ''}
                onChange={(e) =>
                  setEditDeptModal((prev) => (prev ? { ...prev, amount: e.target.value } : null))
                }
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditDeptModal(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void saveDeptBudget()}>Guardar Techo</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* New Project Modal */}
      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Crear Nuevo Proyecto de Cliente</DialogTitle>
            <DialogDescription>Presupuesto global único para toda la duración del contrato.</DialogDescription>
          </DialogHeader>
          <form onSubmit={createProject} className="space-y-3">
            <div>
              <Label>Código *</Label>
              <Input
                required
                placeholder="PRJ-CRM-05"
                value={newProj.code}
                onChange={(e) => setNewProj((p) => ({ ...p, code: e.target.value }))}
              />
            </div>
            <div>
              <Label>Nombre del Proyecto *</Label>
              <Input
                required
                placeholder="Implementación CRM"
                value={newProj.name}
                onChange={(e) => setNewProj((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <Label>Cliente *</Label>
              <Input
                required
                value={newProj.clientName}
                onChange={(e) => setNewProj((p) => ({ ...p, clientName: e.target.value }))}
              />
            </div>
            <div>
              <Label>Gerente del Proyecto *</Label>
              <Select
                value={newProj.managerId}
                onChange={(e) => setNewProj((p) => ({ ...p, managerId: e.target.value }))}
              >
                {allUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Presupuesto Total (USD) *</Label>
                <Input
                  type="number"
                  required
                  value={newProj.totalBudget}
                  onChange={(e) => setNewProj((p) => ({ ...p, totalBudget: e.target.value }))}
                />
              </div>
              <div>
                <Label>Fecha Inicio *</Label>
                <Input
                  type="date"
                  required
                  value={newProj.startDate}
                  onChange={(e) => setNewProj((p) => ({ ...p, startDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setNewProjectOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit">Crear Proyecto</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Assign User to Project Modal */}
      <Dialog open={Boolean(assignProjectModal)} onOpenChange={(o) => !o && setAssignProjectModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Asignar Consultor a {assignProjectModal?.code}</DialogTitle>
            <DialogDescription>
              Solo los consultores asignados pueden imputar gastos a este proyecto.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Colaborador</Label>
              <Select value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)}>
                {allUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAssignProjectModal(null)}>
                Cancelar
              </Button>
              <Button onClick={() => void assignUser()}>Asignar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PresupuestosPage() {
  return (
    <React.Suspense
      fallback={<p className="p-8 text-center text-sm text-slate-500">Cargando presupuestos...</p>}
    >
      <PresupuestosInner />
    </React.Suspense>
  );
}
