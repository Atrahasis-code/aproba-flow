export const ROUTE_LABELS: Record<string, string> = {
  '/': 'Tablero Principal',
  '/solicitudes': 'Mis Solicitudes',
  '/aprobaciones': 'Por Revisar',
  '/tesoreria': 'Tesorería',
  '/presupuestos': 'Presupuestos',
  '/auditoria': 'Auditoría',
  '/configuracion': 'Configuración',
};

export function withFrom(target: string, from: string): string {
  if (!from || !from.startsWith('/') || from.startsWith('//')) return target;
  const sep = target.includes('?') ? '&' : '?';
  return `${target}${sep}from=${encodeURIComponent(from)}`;
}

export function resolveReturnTarget(
  fromParam: string | null | undefined,
  fallbackHref: string
): { href: string; label: string } {
  const clean =
    fromParam && fromParam.startsWith('/') && !fromParam.startsWith('//')
      ? fromParam
      : fallbackHref;
  const basePath = clean.split('?')[0] || fallbackHref;
  return {
    href: clean,
    label: ROUTE_LABELS[basePath] ?? ROUTE_LABELS[fallbackHref] ?? 'Inicio',
  };
}
