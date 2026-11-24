import { AlertTriangle, ShieldAlert, TrendingUp } from 'lucide-react';
import { formatUsd } from '@aproba-flow/shared';
import { cn } from '@/lib/utils';

export interface BudgetImpactData {
  targetName: string;
  budgetLimit: number;
  executed: number;
  committed: number;
  totalUsed: number;
  available: number;
  usagePct: number;
  thresholdPct?: number;
  candidateAmount?: number;
  projectedUsed?: number;
  projectedAvailable?: number;
  projectedPct?: number;
  alert85Triggered?: boolean;
  exceeded100?: boolean;
}

export function BudgetMeter({ data }: { data: BudgetImpactData }) {
  const threshold = data.thresholdPct ?? 85;
  const displayPct = data.projectedPct ?? data.usagePct;
  const displayUsed = data.projectedUsed ?? data.totalUsed;
  const clampedWidth = Math.min(100, Math.max(0, displayPct));

  const barColor =
    displayPct > 100
      ? 'bg-rose-600'
      : displayPct > threshold
        ? 'bg-amber-500'
        : displayPct >= 70
          ? 'bg-amber-400'
          : 'bg-emerald-500';

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-800">{data.targetName}</span>
        </div>
        <span
          className={cn(
            'text-xs font-bold px-2.5 py-0.5 rounded-full border tabular-nums',
            displayPct > 100
              ? 'bg-rose-50 text-rose-700 border-rose-200'
              : displayPct > threshold
                ? 'bg-amber-50 text-amber-800 border-amber-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
          )}
        >
          Consumo {data.projectedPct !== undefined ? 'Proyectado' : 'Actual'}: {displayPct.toFixed(1)}%
        </span>
      </div>

      {/* Progress track with 85% threshold marker */}
      <div className="relative h-3 w-full rounded-full bg-slate-200 overflow-hidden">
        <div
          className={cn('h-full transition-all duration-300 rounded-full', barColor)}
          style={{ width: `${clampedWidth}%` }}
        />
        <div
          title={`Umbral alerta ${threshold}%`}
          className="absolute top-0 bottom-0 w-0.5 bg-slate-900/70 z-10"
          style={{ left: `${threshold}%` }}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <span className="text-slate-500 block">Presupuesto Total</span>
          <span className="font-bold text-slate-900 tabular-nums">{formatUsd(data.budgetLimit)}</span>
        </div>
        <div>
          <span className="text-slate-500 block">Ejecutado</span>
          <span className="font-semibold text-slate-800 tabular-nums">{formatUsd(data.executed)}</span>
        </div>
        <div>
          <span className="text-slate-500 block">Comprometido</span>
          <span className="font-semibold text-indigo-700 tabular-nums">{formatUsd(data.committed)}</span>
        </div>
        <div>
          <span className="text-slate-500 block">
            {data.projectedAvailable !== undefined ? 'Disponible Final' : 'Disponible'}
          </span>
          <span className="font-bold text-emerald-700 tabular-nums">
            {formatUsd(data.projectedAvailable ?? data.available)}
          </span>
        </div>
      </div>

      {data.candidateAmount !== undefined && data.candidateAmount > 0 && (
        <div className="text-xs text-slate-600 flex items-center justify-between border-t border-slate-200 pt-2">
          <span>Esta solicitud (+{formatUsd(data.candidateAmount)})</span>
          <span className="font-semibold tabular-nums">
            Uso proyectado: {formatUsd(displayUsed)} / {formatUsd(data.budgetLimit)}
          </span>
        </div>
      )}

      {displayPct > 100 ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-rose-600" />
          <div>
            <strong>Presupuesto superado (&gt;100%):</strong> La aprobación estándar quedará bloqueada hasta que
            Finanzas o Dirección Administrativa autoricen un <strong>Override Presupuestario</strong> con motivo
            auditado.
          </div>
        </div>
      ) : displayPct > threshold ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
          <div>
            <strong>Alerta Presupuestaria (&gt;{threshold}%):</strong> El sistema bloqueará aprobaciones automáticas y
            exigirá revisión obligatoria de <strong>Finanzas</strong> aunque el monto sea pequeño.
          </div>
        </div>
      ) : null}
    </div>
  );
}
