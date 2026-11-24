'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Download, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, extractApiError } from '@/lib/eden';
import { resolveReturnTarget } from '@/lib/navigation';
import { formatDateTimeEs } from '@/lib/utils';

interface AuditRow {
  id: string;
  timestamp: string;
  actorName: string;
  actorRole: string;
  onBehalfOfName: string | null;
  delegationReason: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  ipAddress: string | null;
}

function AuditoriaInner() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const fromParam = searchParams.get('from');
  const returnTarget = fromParam ? resolveReturnTarget(fromParam, '/') : null;

  const [logs, setLogs] = React.useState<AuditRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [entityType, setEntityType] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  const loadAudit = React.useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await api.api.audit.get({
        query: {
          ...(search ? { search } : {}),
          ...(entityType ? { entityType } : {}),
        },
      });
      if (error) {
        toast.error(extractApiError(error, 'Error cargando auditoría'));
      } else if (data && 'items' in data) {
        setLogs(data.items as AuditRow[]);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [search, entityType, user?.id]);

  React.useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

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
              Historial Inmutable (Audit Trail)
            </h1>
            <p className="text-sm text-slate-500">
              Registro inalterable de aprobaciones, rechazos, suplencias, overrides presupuestarios y liquidaciones para fiscalización anual.
            </p>
          </div>
        </div>

        <a href="/api/audit/export">
          <Button variant="outline">
            <Download className="h-4 w-4" />
            Exportar Auditoría CSV
          </Button>
        </a>
      </div>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative sm:col-span-2">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
            <Input
              placeholder="Buscar por usuario, reemplazo, resumen o acción..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">Todas las entidades</option>
            <option value="EXPENSE_REQUEST">Solicitudes de Gasto</option>
            <option value="DELEGATION">Delegaciones / Suplencias</option>
            <option value="APPROVAL_RULE">Matriz de Aprobaciones</option>
            <option value="CATEGORY">Categorías Contables</option>
            <option value="USER">Usuarios y Roles</option>
            <option value="DEPARTMENT_BUDGET">Presupuestos Departamentos</option>
            <option value="PROJECT">Proyectos</option>
            <option value="SYSTEM_CONFIG">Parámetros Globales</option>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-8 text-center text-sm text-slate-500">Cargando registro de auditoría...</p>
          ) : logs.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">No hay registros coincidentes.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marca de Tiempo</TableHead>
                  <TableHead>Actor / Rol</TableHead>
                  <TableHead>Acción</TableHead>
                  <TableHead>Detalle de Auditoría</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-slate-500 whitespace-nowrap">
                      {formatDateTimeEs(l.timestamp)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="font-bold text-slate-900 block">{l.actorName}</span>
                      <span className="text-[11px] text-slate-500">{l.actorRole}</span>
                      {l.onBehalfOfName && (
                        <Badge variant="indigo" className="mt-1 text-[10px]">
                          <ShieldCheck className="h-3 w-3" />
                          Suplente de {l.onBehalfOfName}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="slate" className="font-mono text-[10px]">
                        {l.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-800 max-w-xl">{l.summary}</TableCell>
                    <TableCell className="text-xs font-mono text-slate-500">
                      {l.ipAddress ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-500">
            Mostrando {logs.length} de {total} eventos registrados.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AuditoriaPage() {
  return (
    <React.Suspense
      fallback={<p className="p-8 text-center text-sm text-slate-500">Cargando auditoría...</p>}
    >
      <AuditoriaInner />
    </React.Suspense>
  );
}
