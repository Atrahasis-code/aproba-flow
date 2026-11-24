'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  History,
  Pencil,
  PieChart,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  ALL_USER_ROLES,
  APPROVAL_ROLE_LABELS,
  REQUEST_TYPE_LABELS,
  USER_ROLE_LABELS,
  type UserRole,
} from '@aproba-flow/shared';
import { useAuth } from '@/components/providers/auth-provider';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, extractApiError } from '@/lib/eden';
import { formatUsd } from '@aproba-flow/shared';
import { withFrom } from '@/lib/navigation';
import { formatDateEs } from '@/lib/utils';

interface ApprovalRuleDto {
  id: string;
  name: string;
  requestType: 'REIMBURSEMENT' | 'ADVANCE' | 'EXCESS';
  categorySpecialTag: string | null;
  minAmount: number;
  maxAmount: number | null;
  approverChain: string[];
  allowAutoApprove: boolean;
  priority: number;
  isActive: boolean;
}

interface CategoryDto {
  id: string;
  code: string;
  name: string;
  accountCode: string;
  specialTag: string | null;
  requiresReceipt: boolean;
  isActive: boolean;
}

interface UserAdminDto {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  branchId: string;
  branch?: { id: string; code: string; name: string } | null;
  departmentId: string;
  department?: { id: string; code: string; name: string } | null;
  managerId: string | null;
  manager?: { id: string; fullName: string } | null;
  roles: UserRole[];
  bankName: string | null;
  bankAccountNumber: string | null;
  isActive: boolean;
}

interface DelegationDto {
  id: string;
  delegator: { id: string; fullName: string; jobTitle: string };
  delegate: { id: string; fullName: string; jobTitle: string };
  startDate: string;
  endDate: string;
  reason: string;
  isActive: boolean;
}

export default function ConfiguracionPage() {
  const { user } = useAuth();
  const isStrictAdmin = Boolean(user?.roles.includes('ADMIN'));
  const canEditRules = Boolean(
    user?.roles.some((r) => ['ADMIN', 'FINANCE', 'DIRECTION'].includes(r))
  );
  const canEditCategories = Boolean(
    user?.roles.some((r) => ['ADMIN', 'FINANCE'].includes(r))
  );
  const canViewUsers = Boolean(
    user?.roles.some((r) => ['ADMIN', 'FINANCE', 'DIRECTION'].includes(r))
  );

  const [rules, setRules] = React.useState<ApprovalRuleDto[]>([]);
  const [config, setConfig] = React.useState({
    budgetAlertThresholdPct: 85,
    stalledHoursThreshold: 48,
    advanceSettlementDueDays: 15,
    excessToleranceUsd: 50,
    excessMediumMaxUsd: 250,
  });
  const [delegations, setDelegations] = React.useState<DelegationDto[]>([]);
  const [bootstrapUsers, setBootstrapUsers] = React.useState<
    Array<{ id: string; fullName: string; email: string; roles: string[] }>
  >([]);
  const [adminUsers, setAdminUsers] = React.useState<UserAdminDto[]>([]);
  const [branches, setBranches] = React.useState<Array<{ id: string; code: string; name: string }>>([]);
  const [departments, setDepartments] = React.useState<Array<{ id: string; code: string; name: string }>>([]);
  const [categories, setCategories] = React.useState<CategoryDto[]>([]);
  const [stalledOrPending, setStalledOrPending] = React.useState<
    Array<{ id: string; code: string; title: string; pendingStepId: string; currentApprover: string }>
  >([]);

  // Rule Create/Edit Modal
  const [ruleModalOpen, setRuleModalOpen] = React.useState(false);
  const [editingRuleId, setEditingRuleId] = React.useState<string | null>(null);
  const [ruleForm, setRuleForm] = React.useState({
    name: '',
    requestType: 'REIMBURSEMENT' as 'REIMBURSEMENT' | 'ADVANCE' | 'EXCESS',
    categorySpecialTag: '',
    minAmount: '0',
    maxAmount: '',
    approverChain: ['DIRECT_MANAGER'] as string[],
    allowAutoApprove: false,
    priority: '15',
    isActive: true,
  });

  // Category Create/Edit Modal
  const [catModalOpen, setCatModalOpen] = React.useState(false);
  const [editingCatId, setEditingCatId] = React.useState<string | null>(null);
  const [catForm, setCatForm] = React.useState({
    code: '',
    name: '',
    accountCode: '',
    specialTag: '',
    requiresReceipt: true,
    isActive: true,
  });

  // User Create/Edit Modal
  const [userModalOpen, setUserModalOpen] = React.useState(false);
  const [editingUserId, setEditingUserId] = React.useState<string | null>(null);
  const [userForm, setUserForm] = React.useState({
    email: '',
    password: '',
    fullName: '',
    employeeCode: '',
    jobTitle: '',
    branchId: '',
    departmentId: '',
    managerId: '',
    roles: ['EMPLOYEE'] as UserRole[],
    bankName: '',
    bankAccountNumber: '',
    isActive: true,
  });

  // Delete Confirmation Modal
  const [confirmDelete, setConfirmDelete] = React.useState<{
    kind: 'RULE' | 'CATEGORY' | 'USER';
    id: string;
    label: string;
  } | null>(null);

  // Delegation Form
  const [newDel, setNewDel] = React.useState({
    delegatorId: '',
    delegateId: '',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    reason: 'Vacaciones',
  });

  // Reassign modal
  const [reassignTarget, setReassignTarget] = React.useState<{
    stepId: string;
    code: string;
  } | null>(null);
  const [reassignUserId, setReassignUserId] = React.useState('');
  const [reassignReason, setReassignReason] = React.useState('');

  const loadAll = React.useCallback(async () => {
    const [{ data: rData }, { data: cData }, { data: dData }, { data: boot }, { data: cats }] =
      await Promise.all([
        api.api.rules.get(),
        api.api.rules.config.get(),
        api.api.delegations.get(),
        api.api.catalogs.bootstrap.get(),
        api.api.catalogs.categories.get(),
      ]);

    if (Array.isArray(rData)) setRules(rData as ApprovalRuleDto[]);
    if (cData && 'budgetAlertThresholdPct' in cData) setConfig(cData);
    if (Array.isArray(dData)) setDelegations(dData as DelegationDto[]);
    if (boot && 'users' in boot) {
      setBootstrapUsers(boot.users);
      setBranches(boot.branches);
      setDepartments(boot.departments);
      if (boot.users.length > 0) {
        setNewDel((p) => ({
          ...p,
          delegatorId: p.delegatorId || user?.id || boot.users[0].id,
          delegateId:
            p.delegateId || boot.users.find((u) => u.id !== user?.id)?.id || boot.users[0].id,
        }));
        setReassignUserId((prev) => prev || boot.users[0].id);
      }
    }
    if (Array.isArray(cats)) setCategories(cats as CategoryDto[]);

    if (canViewUsers) {
      const { data: uData } = await api.api.catalogs.users.get();
      if (Array.isArray(uData)) {
        setAdminUsers(uData as UserAdminDto[]);
      }
    }

    if (user?.roles.includes('ADMIN')) {
      const { data: exps } = await api.api.expenses.get({
        query: { scope: 'team', status: 'PENDING_APPROVAL' },
      });
      if (Array.isArray(exps)) {
        const list = exps
          .map((e) => {
            const pending = e.approvalSteps?.find((s) => s.status === 'PENDING');
            if (!pending) return null;
            return {
              id: e.id,
              code: e.code,
              title: e.title,
              pendingStepId: pending.id,
              currentApprover:
                pending.delegatedToUser?.fullName ??
                pending.assignedApprover?.fullName ??
                pending.requiredRole,
            };
          })
          .filter((x): x is NonNullable<typeof x> => Boolean(x));
        setStalledOrPending(list);
      }
    }
  }, [user?.id, user?.roles, canViewUsers]);

  React.useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const saveConfig = async () => {
    const { error } = await api.api.rules.config.put(config);
    if (error) {
      toast.error(extractApiError(error, 'Error guardando parámetros'));
      return;
    }
    toast.success('Parámetros globales actualizados');
  };

  // --- Rule CRUD handlers ---
  const openCreateRule = () => {
    setEditingRuleId(null);
    setRuleForm({
      name: '',
      requestType: 'REIMBURSEMENT',
      categorySpecialTag: '',
      minAmount: '0',
      maxAmount: '',
      approverChain: ['DIRECT_MANAGER'],
      allowAutoApprove: false,
      priority: '15',
      isActive: true,
    });
    setRuleModalOpen(true);
  };

  const openEditRule = (rule: ApprovalRuleDto) => {
    setEditingRuleId(rule.id);
    setRuleForm({
      name: rule.name,
      requestType: rule.requestType,
      categorySpecialTag: rule.categorySpecialTag ?? '',
      minAmount: String(rule.minAmount),
      maxAmount: rule.maxAmount !== null ? String(rule.maxAmount) : '',
      approverChain: [...rule.approverChain],
      allowAutoApprove: rule.allowAutoApprove,
      priority: String(rule.priority),
      isActive: rule.isActive,
    });
    setRuleModalOpen(true);
  };

  const submitRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: ruleForm.name,
      requestType: ruleForm.requestType,
      categorySpecialTag: ruleForm.categorySpecialTag.trim() || null,
      minAmount: Number(ruleForm.minAmount),
      maxAmount: ruleForm.maxAmount.trim() !== '' ? Number(ruleForm.maxAmount) : null,
      approverChain: ruleForm.approverChain,
      allowAutoApprove: ruleForm.allowAutoApprove,
      priority: Number(ruleForm.priority) || 10,
      isActive: ruleForm.isActive,
    };

    if (editingRuleId) {
      const { error } = await api.api.rules({ id: editingRuleId }).patch(payload);
      if (error) {
        toast.error(extractApiError(error, 'No se pudo actualizar la regla'));
        return;
      }
      toast.success('Regla de aprobación actualizada');
    } else {
      const { error } = await api.api.rules.post(payload);
      if (error) {
        toast.error(extractApiError(error, 'Error creando regla'));
        return;
      }
      toast.success('Regla agregada a la Matriz de Aprobaciones');
    }
    setRuleModalOpen(false);
    await loadAll();
  };

  const toggleRule = async (rule: ApprovalRuleDto) => {
    const { error } = await api.api.rules({ id: rule.id }).patch({ isActive: !rule.isActive });
    if (error) {
      toast.error(extractApiError(error, 'Error actualizando regla'));
      return;
    }
    await loadAll();
  };

  const toggleChainRole = (role: string) => {
    setRuleForm((prev) => ({
      ...prev,
      approverChain: prev.approverChain.includes(role)
        ? prev.approverChain.filter((r) => r !== role)
        : [...prev.approverChain, role],
    }));
  };

  // --- Category CRUD handlers ---
  const openCreateCat = () => {
    setEditingCatId(null);
    setCatForm({
      code: '',
      name: '',
      accountCode: '',
      specialTag: '',
      requiresReceipt: true,
      isActive: true,
    });
    setCatModalOpen(true);
  };

  const openEditCat = (c: CategoryDto) => {
    setEditingCatId(c.id);
    setCatForm({
      code: c.code,
      name: c.name,
      accountCode: c.accountCode,
      specialTag: c.specialTag ?? '',
      requiresReceipt: c.requiresReceipt,
      isActive: c.isActive,
    });
    setCatModalOpen(true);
  };

  const submitCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCatId) {
      const { error } = await api.api.catalogs.categories({ id: editingCatId }).patch({
        code: catForm.code,
        name: catForm.name,
        accountCode: catForm.accountCode,
        specialTag: catForm.specialTag.trim() || null,
        requiresReceipt: catForm.requiresReceipt,
        isActive: catForm.isActive,
      });
      if (error) {
        toast.error(extractApiError(error, 'No se pudo actualizar la categoría'));
        return;
      }
      toast.success('Categoría contable actualizada');
    } else {
      const { error } = await api.api.catalogs.categories.post({
        code: catForm.code,
        name: catForm.name,
        accountCode: catForm.accountCode,
        specialTag: catForm.specialTag.trim() || null,
        requiresReceipt: catForm.requiresReceipt,
      });
      if (error) {
        toast.error(extractApiError(error, 'Error creando categoría'));
        return;
      }
      toast.success('Categoría contable creada');
    }
    setCatModalOpen(false);
    await loadAll();
  };

  const toggleCategoryActive = async (c: CategoryDto) => {
    const { error } = await api.api.catalogs.categories({ id: c.id }).patch({
      isActive: !c.isActive,
    });
    if (error) {
      toast.error(extractApiError(error, 'Error actualizando categoría'));
      return;
    }
    await loadAll();
  };

  // --- User CRUD handlers ---
  const openCreateUser = () => {
    setEditingUserId(null);
    setUserForm({
      email: '',
      password: '',
      fullName: '',
      employeeCode: '',
      jobTitle: '',
      branchId: branches[0]?.id ?? '',
      departmentId: departments[0]?.id ?? '',
      managerId: '',
      roles: ['EMPLOYEE'],
      bankName: '',
      bankAccountNumber: '',
      isActive: true,
    });
    setUserModalOpen(true);
  };

  const openEditUser = (u: UserAdminDto) => {
    setEditingUserId(u.id);
    setUserForm({
      email: u.email,
      password: '',
      fullName: u.fullName,
      employeeCode: u.employeeCode,
      jobTitle: u.jobTitle,
      branchId: u.branchId,
      departmentId: u.departmentId,
      managerId: u.managerId ?? '',
      roles: [...u.roles],
      bankName: u.bankName ?? '',
      bankAccountNumber: u.bankAccountNumber ?? '',
      isActive: u.isActive,
    });
    setUserModalOpen(true);
  };

  const toggleUserRole = (role: UserRole) => {
    setUserForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(role)
        ? prev.roles.filter((r) => r !== role)
        : [...prev.roles, role],
    }));
  };

  const submitUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (userForm.roles.length === 0) {
      toast.error('Selecciona al menos un rol RBAC para el usuario');
      return;
    }

    if (editingUserId) {
      const { error } = await api.api.catalogs.users({ id: editingUserId }).patch({
        email: userForm.email,
        employeeCode: userForm.employeeCode,
        fullName: userForm.fullName,
        jobTitle: userForm.jobTitle,
        branchId: userForm.branchId,
        departmentId: userForm.departmentId,
        managerId: userForm.managerId || null,
        roles: userForm.roles,
        bankName: userForm.bankName || null,
        bankAccountNumber: userForm.bankAccountNumber || null,
        isActive: userForm.isActive,
        ...(userForm.password.trim() ? { password: userForm.password.trim() } : {}),
      });
      if (error) {
        toast.error(extractApiError(error, 'Error actualizando usuario'));
        return;
      }
      toast.success('Usuario actualizado');
    } else {
      const { error } = await api.api.catalogs.users.post({
        email: userForm.email,
        password: userForm.password.trim() || 'Demo1234!',
        fullName: userForm.fullName,
        employeeCode: userForm.employeeCode,
        jobTitle: userForm.jobTitle,
        branchId: userForm.branchId,
        departmentId: userForm.departmentId,
        managerId: userForm.managerId || null,
        roles: userForm.roles,
        bankName: userForm.bankName || null,
        bankAccountNumber: userForm.bankAccountNumber || null,
      });
      if (error) {
        toast.error(extractApiError(error, 'Error creando usuario'));
        return;
      }
      toast.success('Usuario creado correctamente');
    }
    setUserModalOpen(false);
    await loadAll();
  };

  const toggleUserActive = async (u: UserAdminDto) => {
    const { error } = await api.api.catalogs.users({ id: u.id }).patch({ isActive: !u.isActive });
    if (error) {
      toast.error(extractApiError(error, 'Error cambiando estado del usuario'));
      return;
    }
    await loadAll();
  };

  // --- Delete Confirmation Handler ---
  const executeDelete = async () => {
    if (!confirmDelete) return;
    if (confirmDelete.kind === 'RULE') {
      const { error } = await api.api.rules({ id: confirmDelete.id }).delete();
      if (error) {
        toast.error(extractApiError(error, 'No se pudo eliminar la regla'));
        return;
      }
      toast.success('Regla eliminada');
    } else if (confirmDelete.kind === 'CATEGORY') {
      const { error } = await api.api.catalogs.categories({ id: confirmDelete.id }).delete();
      if (error) {
        toast.error(extractApiError(error, 'No se pudo eliminar la categoría'));
        return;
      }
      toast.success('Categoría eliminada');
    } else {
      const { error } = await api.api.catalogs.users({ id: confirmDelete.id }).delete();
      if (error) {
        toast.error(extractApiError(error, 'No se pudo eliminar el usuario'));
        return;
      }
      toast.success('Usuario eliminado');
    }
    setConfirmDelete(null);
    await loadAll();
  };

  // --- Delegations & Reassign ---
  const createDelegation = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await api.api.delegations.post({
      delegatorId:
        user?.roles.includes('ADMIN') || user?.roles.includes('DIRECTION')
          ? newDel.delegatorId
          : undefined,
      delegateId: newDel.delegateId,
      startDate: newDel.startDate,
      endDate: newDel.endDate,
      reason: newDel.reason,
    });
    if (error) {
      toast.error(extractApiError(error, 'No se pudo crear la suplencia'));
      return;
    }
    toast.success('Delegación temporal activada');
    await loadAll();
  };

  const toggleDelegation = async (d: DelegationDto) => {
    const { error } = await api.api.delegations({ id: d.id }).patch({ isActive: !d.isActive });
    if (error) {
      toast.error(extractApiError(error, 'Error cambiando estado'));
      return;
    }
    await loadAll();
  };

  const handleReassign = async () => {
    if (!reassignTarget) return;
    const { error } = await api.api.approvals({ stepId: reassignTarget.stepId }).reassign.post({
      newApproverId: reassignUserId,
      reason: reassignReason,
    });
    if (error) {
      toast.error(extractApiError(error, 'Error al reasignar'));
      return;
    }
    toast.success(`Caso ${reassignTarget.code} reasignado con trazabilidad en auditoría`);
    setReassignTarget(null);
    setReassignReason('');
    await loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Configuración del Sistema y Gobierno
          </h1>
          <p className="text-sm text-slate-500">
            Administración de Matriz de Aprobaciones, Categorías Contables, Usuarios RBAC y Suplencias.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href={withFrom('/presupuestos', '/configuracion')}>
            <Button variant="outline" size="sm">
              <PieChart className="h-4 w-4" />
              Presupuestos
            </Button>
          </Link>
          {user?.roles.some((r) => ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY'].includes(r)) && (
            <Link href={withFrom('/auditoria', '/configuracion')}>
              <Button variant="outline" size="sm">
                <History className="h-4 w-4" />
                Auditoría Inmutable
              </Button>
            </Link>
          )}
        </div>
      </div>

      <Tabs defaultValue={canEditRules ? 'matrix' : 'delegations'}>
        <TabsList>
          <TabsTrigger value="matrix">Matriz de Aprobaciones ({rules.length})</TabsTrigger>
          <TabsTrigger value="categories">Categorías Contables ({categories.length})</TabsTrigger>
          {canViewUsers && (
            <TabsTrigger value="users">Usuarios y Roles ({adminUsers.length})</TabsTrigger>
          )}
          <TabsTrigger value="delegations">Delegaciones y Suplencias</TabsTrigger>
        </TabsList>

        {/* TAB 1: Approval Rules Matrix & Global Params */}
        <TabsContent value="matrix" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Parámetros Globales de Control</CardTitle>
              <CardDescription>
                Controla el umbral de alerta del 85%, el monitor de cuellos de botella (48h) y vencimiento de anticipos.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4 items-end">
              <div>
                <Label>Alerta Presupuesto (%)</Label>
                <Input
                  type="number"
                  disabled={!canEditRules}
                  value={config.budgetAlertThresholdPct}
                  onChange={(e) =>
                    setConfig((p) => ({ ...p, budgetAlertThresholdPct: Number(e.target.value) }))
                  }
                />
              </div>
              <div>
                <Label>Cuello de Botella (Horas)</Label>
                <Input
                  type="number"
                  disabled={!canEditRules}
                  value={config.stalledHoursThreshold}
                  onChange={(e) =>
                    setConfig((p) => ({ ...p, stalledHoursThreshold: Number(e.target.value) }))
                  }
                />
              </div>
              <div>
                <Label>Plazo Rendición (Días)</Label>
                <Input
                  type="number"
                  disabled={!canEditRules}
                  value={config.advanceSettlementDueDays}
                  onChange={(e) =>
                    setConfig((p) => ({ ...p, advanceSettlementDueDays: Number(e.target.value) }))
                  }
                />
              </div>
              <div>
                <Label>Tolerancia Excedente ($)</Label>
                <Input
                  type="number"
                  disabled={!canEditRules}
                  value={config.excessToleranceUsd}
                  onChange={(e) =>
                    setConfig((p) => ({ ...p, excessToleranceUsd: Number(e.target.value) }))
                  }
                />
              </div>
              <div>
                {canEditRules && (
                  <Button onClick={() => void saveConfig()} className="w-full">
                    <Save className="h-4 w-4" />
                    Guardar Parámetros
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Matriz Parametrizable de Aprobaciones</CardTitle>
                <CardDescription>
                  Reglas ordenadas por prioridad. Menor número evalúa primero (ej. Compras Especiales IT).
                </CardDescription>
              </div>
              {canEditRules && (
                <Button size="sm" onClick={openCreateRule}>
                  <Plus className="h-4 w-4" />
                  Nueva Regla
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prioridad</TableHead>
                    <TableHead>Regla</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Rango USD</TableHead>
                    <TableHead>Cadena de Firmas</TableHead>
                    <TableHead>Estado</TableHead>
                    {canEditRules && <TableHead className="text-right">Acciones</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.priority}</TableCell>
                      <TableCell className="text-xs font-semibold">
                        {r.name}
                        {r.categorySpecialTag && (
                          <Badge variant="purple" className="ml-2 text-[10px]">
                            Tag: {r.categorySpecialTag}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{REQUEST_TYPE_LABELS[r.requestType]}</TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatUsd(r.minAmount)} –{' '}
                        {r.maxAmount !== null ? formatUsd(r.maxAmount) : 'Sin límite'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.approverChain.length === 0 ? (
                            <Badge variant="emerald">Auto / Finanzas directo</Badge>
                          ) : (
                            r.approverChain.map((role) => (
                              <Badge key={role} variant="indigo" className="text-[10px]">
                                {APPROVAL_ROLE_LABELS[role as keyof typeof APPROVAL_ROLE_LABELS] ?? role}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.isActive ? 'emerald' : 'slate'}>
                          {r.isActive ? 'Activa' : 'Inactiva'}
                        </Badge>
                      </TableCell>
                      {canEditRules && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEditRule(r)}
                              title="Editar regla"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Editar
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void toggleRule(r)}>
                              {r.isActive ? 'Pausar' : 'Activar'}
                            </Button>
                            {isStrictAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setConfirmDelete({ kind: 'RULE', id: r.id, label: r.name })
                                }
                                title="Eliminar regla"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: Accounting Categories */}
        <TabsContent value="categories" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Categorías Contables</CardTitle>
                <CardDescription>
                  Cuentas contables y etiquetas especiales (ej. IT) aplicadas en solicitudes y exportaciones.
                </CardDescription>
              </div>
              {canEditCategories && (
                <Button size="sm" onClick={openCreateCat}>
                  <Plus className="h-4 w-4" />
                  Nueva Categoría
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Cuenta Contable</TableHead>
                    <TableHead>Etiqueta</TableHead>
                    <TableHead>Estado</TableHead>
                    {canEditCategories && <TableHead className="text-right">Acciones</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.code}</TableCell>
                      <TableCell className="font-semibold text-xs">{c.name}</TableCell>
                      <TableCell className="font-mono text-xs">{c.accountCode}</TableCell>
                      <TableCell>
                        {c.specialTag ? <Badge variant="purple">{c.specialTag}</Badge> : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={c.isActive ? 'emerald' : 'slate'}>
                          {c.isActive ? 'Activa' : 'Inactiva'}
                        </Badge>
                      </TableCell>
                      {canEditCategories && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => openEditCat(c)}>
                              <Pencil className="h-3.5 w-3.5" />
                              Editar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void toggleCategoryActive(c)}
                            >
                              {c.isActive ? 'Desactivar' : 'Activar'}
                            </Button>
                            {isStrictAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setConfirmDelete({
                                    kind: 'CATEGORY',
                                    id: c.id,
                                    label: `${c.code} (${c.name})`,
                                  })
                                }
                                title="Eliminar categoría"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: Users & Roles (Admin) */}
        {canViewUsers && (
          <TabsContent value="users" className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-brand-600" />
                    Administración de Usuarios y Roles RBAC ({adminUsers.length})
                  </CardTitle>
                  <CardDescription>
                    Gestiona altas, cambios de rol, jefatura directa, filiales y estado operativo de colaboradores.
                  </CardDescription>
                </div>
                {isStrictAdmin && (
                  <Button size="sm" onClick={openCreateUser}>
                    <UserPlus className="h-4 w-4" />
                    Nuevo Usuario
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Colaborador</TableHead>
                      <TableHead>Filial / Depto.</TableHead>
                      <TableHead>Jefe Directo</TableHead>
                      <TableHead>Roles RBAC</TableHead>
                      <TableHead>Estado</TableHead>
                      {isStrictAdmin && <TableHead className="text-right">Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adminUsers.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="text-xs">
                          <span className="font-bold text-slate-900 block">
                            {u.fullName}{' '}
                            <span className="font-mono text-[11px] text-slate-400">
                              ({u.employeeCode})
                            </span>
                          </span>
                          <span className="text-slate-500 block">{u.email}</span>
                          <span className="text-[11px] text-slate-400">{u.jobTitle}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium text-slate-800 block">
                            {u.branch?.code ?? '—'} · {u.department?.name ?? '—'}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">
                          {u.manager?.fullName ?? '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {u.roles.map((r) => (
                              <Badge key={r} variant="slate" className="text-[10px]">
                                {r}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.isActive ? 'emerald' : 'rose'}>
                            {u.isActive ? 'Activo' : 'Inactivo'}
                          </Badge>
                        </TableCell>
                        {isStrictAdmin && (
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="outline" onClick={() => openEditUser(u)}>
                                <Pencil className="h-3.5 w-3.5" />
                                Editar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void toggleUserActive(u)}
                              >
                                {u.isActive ? 'Desactivar' : 'Activar'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={u.id === user?.id}
                                onClick={() =>
                                  setConfirmDelete({
                                    kind: 'USER',
                                    id: u.id,
                                    label: `${u.fullName} (${u.email})`,
                                  })
                                }
                                title="Eliminar usuario"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* TAB 4: Delegations & Manual Reassignment */}
        <TabsContent value="delegations" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Registrar Ausencia o Suplencia Temporal</CardTitle>
              <CardDescription>
                Mientras esté vigente, todas las solicitudes entrantes y pendientes se enrutarán automáticamente al suplente dejando traza explícita en Auditoría.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={createDelegation}
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
              >
                {(user?.roles.includes('ADMIN') || user?.roles.includes('DIRECTION')) && (
                  <div>
                    <Label>Titular Ausente</Label>
                    <Select
                      value={newDel.delegatorId}
                      onChange={(e) => setNewDel((p) => ({ ...p, delegatorId: e.target.value }))}
                    >
                      {bootstrapUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fullName}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                <div>
                  <Label>Suplente Designado</Label>
                  <Select
                    value={newDel.delegateId}
                    onChange={(e) => setNewDel((p) => ({ ...p, delegateId: e.target.value }))}
                  >
                    {bootstrapUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <Label>Desde</Label>
                  <Input
                    type="date"
                    required
                    value={newDel.startDate}
                    onChange={(e) => setNewDel((p) => ({ ...p, startDate: e.target.value }))}
                  />
                </div>

                <div>
                  <Label>Hasta</Label>
                  <Input
                    type="date"
                    required
                    value={newDel.endDate}
                    onChange={(e) => setNewDel((p) => ({ ...p, endDate: e.target.value }))}
                  />
                </div>

                <div>
                  <Label>Motivo (ej. Vacaciones)</Label>
                  <Input
                    required
                    value={newDel.reason}
                    onChange={(e) => setNewDel((p) => ({ ...p, reason: e.target.value }))}
                  />
                </div>

                <div className="sm:col-span-2 lg:col-span-5 flex justify-end">
                  <Button type="submit">Activar Suplencia</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Suplencias Configuradas</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Titular</TableHead>
                    <TableHead>Suplente</TableHead>
                    <TableHead>Vigencia</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Acción</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {delegations.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs font-semibold">{d.delegator.fullName}</TableCell>
                      <TableCell className="text-xs font-semibold text-brand-700">
                        {d.delegate.fullName}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {formatDateEs(d.startDate)} → {formatDateEs(d.endDate)}
                      </TableCell>
                      <TableCell className="text-xs">{d.reason}</TableCell>
                      <TableCell>
                        <Badge variant={d.isActive ? 'emerald' : 'slate'}>
                          {d.isActive ? 'Activa' : 'Inactiva'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => void toggleDelegation(d)}>
                          {d.isActive ? 'Desactivar' : 'Reactivar'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {isStrictAdmin && stalledOrPending.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-brand-600" />
                  Reasignación Manual de Casos Pendientes (Admin)
                </CardTitle>
                <CardDescription>
                  Para bajas de personal o reestructuraciones organizacionales.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Solicitud</TableHead>
                      <TableHead>Aprobador Actual</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stalledOrPending.map((item) => (
                      <TableRow key={item.pendingStepId}>
                        <TableCell className="text-xs">
                          <Link
                            href={withFrom(`/solicitudes/${item.id}`, '/configuracion')}
                            className="font-bold text-brand-600 hover:underline mr-1"
                          >
                            {item.code}
                          </Link>
                          — {item.title}
                        </TableCell>
                        <TableCell className="text-xs">{item.currentApprover}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setReassignTarget({ stepId: item.pendingStepId, code: item.code })
                            }
                          >
                            Reasignar Firma
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Rule Create / Edit Modal */}
      <Dialog open={ruleModalOpen} onOpenChange={setRuleModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingRuleId ? 'Editar Regla de Aprobación' : 'Nueva Regla de Aprobación'}
            </DialogTitle>
            <DialogDescription>
              Define tipo de solicitud, rangos USD, etiqueta especial y cadena de aprobadores.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitRule} className="space-y-3">
            <div>
              <Label>Nombre de la Regla *</Label>
              <Input
                required
                value={ruleForm.name}
                onChange={(e) => setRuleForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Tipo</Label>
                <Select
                  value={ruleForm.requestType}
                  onChange={(e) =>
                    setRuleForm((p) => ({
                      ...p,
                      requestType: e.target.value as typeof ruleForm.requestType,
                    }))
                  }
                >
                  <option value="REIMBURSEMENT">Reembolso</option>
                  <option value="ADVANCE">Anticipo</option>
                  <option value="EXCESS">Excedente</option>
                </Select>
              </div>
              <div>
                <Label>Tag Especial</Label>
                <Input
                  placeholder="Ej. IT"
                  value={ruleForm.categorySpecialTag}
                  onChange={(e) =>
                    setRuleForm((p) => ({ ...p, categorySpecialTag: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Prioridad</Label>
                <Input
                  type="number"
                  value={ruleForm.priority}
                  onChange={(e) => setRuleForm((p) => ({ ...p, priority: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Monto Mínimo (USD)</Label>
                <Input
                  type="number"
                  step="0.01"
                  required
                  value={ruleForm.minAmount}
                  onChange={(e) => setRuleForm((p) => ({ ...p, minAmount: e.target.value }))}
                />
              </div>
              <div>
                <Label>Monto Máximo (vacío = sin límite)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={ruleForm.maxAmount}
                  onChange={(e) => setRuleForm((p) => ({ ...p, maxAmount: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Cadena de Aprobadores</Label>
              <div className="flex flex-wrap gap-2">
                {['DIRECT_MANAGER', 'SPECIAL_IT', 'FINANCE', 'DIRECTION'].map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleChainRole(role)}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer ${
                      ruleForm.approverChain.includes(role)
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-600'
                    }`}
                  >
                    {APPROVAL_ROLE_LABELS[role as keyof typeof APPROVAL_ROLE_LABELS]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs pt-1">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleForm.allowAutoApprove}
                  onChange={(e) =>
                    setRuleForm((p) => ({ ...p, allowAutoApprove: e.target.checked }))
                  }
                />
                Permitir auto-aprobación (si presupuesto &le; 85%)
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleForm.isActive}
                  onChange={(e) => setRuleForm((p) => ({ ...p, isActive: e.target.checked }))}
                />
                Regla activa
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setRuleModalOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit">{editingRuleId ? 'Guardar Cambios' : 'Crear Regla'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Category Create / Edit Modal */}
      <Dialog open={catModalOpen} onOpenChange={setCatModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingCatId ? 'Editar Categoría Contable' : 'Nueva Categoría Contable'}
            </DialogTitle>
            <DialogDescription>
              Configura código interno, cuenta contable y obligatoriedad de comprobante.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCategory} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Código *</Label>
                <Input
                  required
                  placeholder="CAPACIT"
                  value={catForm.code}
                  onChange={(e) => setCatForm((p) => ({ ...p, code: e.target.value }))}
                />
              </div>
              <div>
                <Label>Cuenta Contable *</Label>
                <Input
                  required
                  placeholder="5501-01"
                  value={catForm.accountCode}
                  onChange={(e) => setCatForm((p) => ({ ...p, accountCode: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Nombre de Categoría *</Label>
              <Input
                required
                placeholder="Capacitación Técnica"
                value={catForm.name}
                onChange={(e) => setCatForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <Label>Etiqueta Especial (opcional)</Label>
              <Input
                placeholder="Ej. IT"
                value={catForm.specialTag}
                onChange={(e) => setCatForm((p) => ({ ...p, specialTag: e.target.value }))}
              />
            </div>
            <div className="flex flex-wrap gap-4 text-xs pt-1">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={catForm.requiresReceipt}
                  onChange={(e) =>
                    setCatForm((p) => ({ ...p, requiresReceipt: e.target.checked }))
                  }
                />
                Requiere comprobante adjunto
              </label>
              {editingCatId && (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catForm.isActive}
                    onChange={(e) => setCatForm((p) => ({ ...p, isActive: e.target.checked }))}
                  />
                  Categoría activa
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCatModalOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit">{editingCatId ? 'Guardar Cambios' : 'Crear Categoría'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* User Create / Edit Modal */}
      <Dialog open={userModalOpen} onOpenChange={setUserModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingUserId ? 'Editar Usuario' : 'Nuevo Usuario'}</DialogTitle>
            <DialogDescription>
              Asigna filial, departamento, jefe directo y roles RBAC del colaborador.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitUser} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Nombre Completo *</Label>
                <Input
                  required
                  value={userForm.fullName}
                  onChange={(e) => setUserForm((p) => ({ ...p, fullName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Código Empleado *</Label>
                <Input
                  required
                  placeholder="EMP-020"
                  value={userForm.employeeCode}
                  onChange={(e) => setUserForm((p) => ({ ...p, employeeCode: e.target.value }))}
                />
              </div>
              <div>
                <Label>Correo Corporativo *</Label>
                <Input
                  type="email"
                  required
                  value={userForm.email}
                  onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))}
                />
              </div>
              <div>
                <Label>Cargo *</Label>
                <Input
                  required
                  value={userForm.jobTitle}
                  onChange={(e) => setUserForm((p) => ({ ...p, jobTitle: e.target.value }))}
                />
              </div>
              <div>
                <Label>Filial *</Label>
                <Select
                  value={userForm.branchId}
                  onChange={(e) => setUserForm((p) => ({ ...p, branchId: e.target.value }))}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Departamento *</Label>
                <Select
                  value={userForm.departmentId}
                  onChange={(e) => setUserForm((p) => ({ ...p, departmentId: e.target.value }))}
                >
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Jefe Directo</Label>
                <Select
                  value={userForm.managerId}
                  onChange={(e) => setUserForm((p) => ({ ...p, managerId: e.target.value }))}
                >
                  <option value="">Sin jefe asignado</option>
                  {adminUsers
                    .filter((u) => u.id !== editingUserId)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName}
                      </option>
                    ))}
                </Select>
              </div>
              <div>
                <Label>
                  {editingUserId ? 'Nueva Contraseña (opcional)' : 'Contraseña Inicial *'}
                </Label>
                <Input
                  type="password"
                  required={!editingUserId}
                  placeholder={editingUserId ? 'Dejar vacío para mantener' : 'Mín. 6 caracteres'}
                  value={userForm.password}
                  onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))}
                />
              </div>
              <div>
                <Label>Banco (para Tesorería)</Label>
                <Input
                  value={userForm.bankName}
                  onChange={(e) => setUserForm((p) => ({ ...p, bankName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Cuenta Bancaria</Label>
                <Input
                  value={userForm.bankAccountNumber}
                  onChange={(e) =>
                    setUserForm((p) => ({ ...p, bankAccountNumber: e.target.value }))
                  }
                />
              </div>
            </div>

            <div>
              <Label>Roles RBAC *</Label>
              <div className="flex flex-wrap gap-2">
                {ALL_USER_ROLES.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleUserRole(role)}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer ${
                      userForm.roles.includes(role)
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-600'
                    }`}
                  >
                    {USER_ROLE_LABELS[role]}
                  </button>
                ))}
              </div>
            </div>

            {editingUserId && (
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={userForm.isActive}
                  onChange={(e) => setUserForm((p) => ({ ...p, isActive: e.target.checked }))}
                />
                Usuario activo
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setUserModalOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit">{editingUserId ? 'Guardar Cambios' : 'Crear Usuario'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={Boolean(confirmDelete)} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar Eliminación</DialogTitle>
            <DialogDescription>
              ¿Estás seguro de eliminar <strong>{confirmDelete?.label}</strong>? Esta acción quedará registrada en el historial de auditoría.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void executeDelete()}>
              Eliminar Definitivamente
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reassign Modal */}
      <Dialog open={Boolean(reassignTarget)} onOpenChange={(o) => !o && setReassignTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reasignar Aprobador — {reassignTarget?.code}</DialogTitle>
            <DialogDescription>
              La reasignación quedará registrada en el historial de auditoría.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nuevo Aprobador</Label>
              <Select value={reassignUserId} onChange={(e) => setReassignUserId(e.target.value)}>
                {bootstrapUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Motivo de Reasignación *</Label>
              <Input
                value={reassignReason}
                onChange={(e) => setReassignReason(e.target.value)}
                placeholder="Ej. Reestructuración de área"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setReassignTarget(null)}>
                Cancelar
              </Button>
              <Button disabled={!reassignReason.trim()} onClick={() => void handleReassign()}>
                Confirmar Reasignación
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
