'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Clock, FilePlus2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { EXPENSE_STATUS_LABELS, formatUsd } from '@aproba-flow/shared';
import { useAuth } from '@/components/providers/auth-provider';
import { ExpenseStatusBadge, RequestTypeBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, extractApiError } from '@/lib/eden';
import { withFrom } from '@/lib/navigation';
import { formatDateEs } from '@/lib/utils';

interface ExpenseRow {
  id: string;
  code: string;
  type: string;
  status: string;
  title: string;
  budgetTargetType: string;
  department?: { name: string } | null;
  project?: { code: string; name: string } | null;
  requestedAmount: number;
  approvedAmount: number;
  budgetAlert85Triggered: boolean;
  isStalled48h: boolean;
  hoursInCurrentStep: number;
  createdAt: string;
}

export default function MisSolicitudesPage() {
  const { user } = useAuth();
  const [rows, setRows] = React.useState<ExpenseRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('');
  const [status, setStatus] = React.useState('');

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await api.api.expenses.get({
        query: {
          scope: 'mine',
          ...(search ? { search } : {}),
          ...(type ? { type } : {}),
          ...(status ? { status } : {}),
        },
      });
      if (error) {
        toast.error(extractApiError(error, 'Error cargando tus solicitudes'));
      } else if (Array.isArray(data)) {
        setRows(data as ExpenseRow[]);
      }
    } finally {
      setLoading(false);
    }
  }, [search, type, status, user?.id]);

  React.useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const inProcessCount = rows.filter((r) =>
    ['PENDING_APPROVAL', 'OBSERVED', 'SETTLEMENT_IN_REVIEW', 'EXCESS_PENDING_APPROVAL', 'READY_FOR_DISBURSEMENT', 'READY_FOR_PAYMENT'].includes(r.status)
  ).length;
  const actionNeededCount = rows.filter((r) =>
    ['DISBURSED_PENDING_SETTLEMENT', 'SETTLEMENT_OBSERVED', 'PENDING_RETURN', 'OBSERVED'].includes(r.status)
  ).length;
  const settledCount = rows.filter((r) => r.status === 'CLOSED_SETTLED').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Mis Solicitudes y Rendiciones
          </h1>
          <p className="text-sm text-slate-500">
            Reembolsos y anticipos propios registrados con tu perfil ({user?.fullName}).
          </p>
        </div>
        <Link href={withFrom('/solicitudes/nueva', '/solicitudes')}>
          <Button>
            <FilePlus2 className="h-4 w-4" />
            Nueva Solicitud
          </Button>
        </Link>
      </div>

      {/* Personal Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Total Mis Solicitudes</span>
            <p className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">{rows.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">En Revisión / Aprobación</span>
            <p className="text-2xl font-extrabold text-indigo-700 mt-1 tabular-nums">{inProcessCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Requieren Tu Acción</span>
            <p className="text-2xl font-extrabold text-amber-600 mt-1 tabular-nums">{actionNeededCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-xs text-slate-500">Cerradas / Liquidadas</span>
            <p className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">{settledCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-center">
          <div className="relative lg:col-span-2">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
            <Input
              placeholder="Buscar por código o título..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todas las modalidades</option>
            <option value="REIMBURSEMENT">Reembolso Directo</option>
            <option value="ADVANCE">Anticipo / Fondo a Rendir</option>
          </Select>

          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos los estados</option>
            {Object.entries(EXPENSE_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-8 text-center text-sm text-slate-500">Cargando tus solicitudes...</p>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">
              No tienes solicitudes registradas con los filtros seleccionados.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Modalidad</TableHead>
                  <TableHead>Destino Presupuestario</TableHead>
                  <TableHead>Estado / Alertas</TableHead>
                  <TableHead className="text-right">Solicitado</TableHead>
                  <TableHead className="text-right">Fecha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={withFrom(`/solicitudes/${r.id}`, '/solicitudes')}
                        className="font-bold text-brand-600 hover:underline block"
                      >
                        {r.code}
                      </Link>
                      <span className="text-xs text-slate-600 line-clamp-1">{r.title}</span>
                    </TableCell>
                    <TableCell>
                      <RequestTypeBadge type={r.type} />
                    </TableCell>
                    <TableCell className="text-xs text-slate-700">
                      {r.budgetTargetType === 'PROJECT'
                        ? `${r.project?.code ?? ''} · ${r.project?.name ?? ''}`
                        : `Depto. ${r.department?.name ?? ''}`}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ExpenseStatusBadge status={r.status} />
                        {r.budgetAlert85Triggered && (
                          <Badge variant="amber">
                            <AlertTriangle className="h-3 w-3" /> &gt;85%
                          </Badge>
                        )}
                        {r.isStalled48h && (
                          <Badge variant="rose">
                            <Clock className="h-3 w-3" /> {r.hoursInCurrentStep}h
                          </Badge>
                        )}
                      </div>
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
    </div>
  );
}
