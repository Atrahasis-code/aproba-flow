'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  ChevronDown,
  ClipboardCheck,
  FileText,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  UserCheck,
  X,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { USER_ROLE_LABELS, type UserRole } from '@aproba-flow/shared';
import { AprobaFlowIcon } from '@/components/brand/AprobaFlowIcon';
import { useAuth } from '@/components/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/eden';
import { withFrom } from '@/lib/navigation';
import { cn, formatDateTimeEs } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: boolean;
  badge?: number;
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading, demoUsers, demoEnabled, pendingApprovalsCount, switchDemoUser, logout } =
    useAuth();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<
    Array<{
      id: string;
      title: string;
      message: string;
      linkUrl: string | null;
      isRead: boolean;
      createdAt: string;
    }>
  >([]);
  const [unreadCount, setUnreadCount] = React.useState(0);

  const loadNotifications = React.useCallback(async () => {
    if (!user) return;
    const { data } = await api.api.notifications.get();
    if (data && 'items' in data) {
      setNotifications(data.items);
      setUnreadCount(data.unreadCount);
    }
  }, [user]);

  React.useEffect(() => {
    void loadNotifications();
  }, [loadNotifications, pathname]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-2">
          <AprobaFlowIcon className="h-10 w-10 mx-auto animate-pulse drop-shadow-xs" />
          <p className="text-sm text-slate-500">Cargando AprobaFlow...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const hasAny = (allowed: UserRole[]) => allowed.some((r) => user.roles.includes(r));

  const isReviewer =
    hasAny(['MANAGER', 'SPECIAL_APPROVER_IT', 'FINANCE', 'DIRECTION', 'ADMIN']) ||
    pendingApprovalsCount > 0;
  const isTreasuryViewer = hasAny(['TREASURY', 'FINANCE', 'DIRECTION', 'ADMIN']);
  const isConfigViewer = hasAny([
    'MANAGER',
    'SPECIAL_APPROVER_IT',
    'FINANCE',
    'DIRECTION',
    'ADMIN',
  ]);

  const navItems: NavItem[] = [
    { href: '/', label: 'Tablero', icon: LayoutDashboard, visible: true },
    { href: '/solicitudes', label: 'Mis Solicitudes', icon: FileText, visible: true },
    {
      href: '/aprobaciones',
      label: 'Por Revisar',
      icon: ClipboardCheck,
      visible: isReviewer,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
    },
    {
      href: '/tesoreria',
      label: 'Tesorería',
      icon: Landmark,
      visible: isTreasuryViewer,
    },
    {
      href: '/configuracion',
      label: 'Configuración',
      icon: Settings,
      visible: isConfigViewer,
    },
  ].filter((item) => item.visible);

  const fromParam = searchParams.get('from');
  const fromBase = fromParam?.split('?')[0] ?? null;

  const isNavItemActive = (href: string): boolean => {
    if (
      pathname.startsWith('/solicitudes/') ||
      pathname === '/presupuestos' ||
      pathname === '/auditoria'
    ) {
      if (fromBase && navItems.some((n) => n.href === fromBase)) {
        return href === fromBase;
      }
      if (pathname.startsWith('/solicitudes/')) {
        return href === '/solicitudes';
      }
      return href === '/';
    }
    return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  };

  const markAllRead = async () => {
    await api.api.notifications['read-all'].patch();
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  };

  const openNotification = async (n: (typeof notifications)[0]) => {
    if (!n.isRead) {
      await api.api.notifications({ id: n.id }).read.patch();
    }
    await loadNotifications();
    if (n.linkUrl) {
      const target =
        n.linkUrl.startsWith('/solicitudes/') || n.linkUrl === '/presupuestos'
          ? withFrom(n.linkUrl, pathname)
          : n.linkUrl;
      router.push(target);
    }
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-slate-900 text-slate-200">
      <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-800">
        <AprobaFlowIcon className="h-9 w-9 shrink-0 drop-shadow-sm" />
        <div className="min-w-0">
          <div className="font-bold text-white text-sm tracking-tight truncate">AprobaFlow</div>
          <div className="text-[11px] text-slate-400 truncate">Control de Gastos</div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Navegación principal">
        {navItems.map((item) => {
          const active = isNavItemActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-brand-600 text-white shadow-xs'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              )}
            >
              <span className="flex items-center gap-2.5 truncate">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-bold',
                    active ? 'bg-white text-brand-700' : 'bg-amber-500 text-slate-950'
                  )}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-800 space-y-2 text-xs">
        <div className="rounded-lg bg-slate-800/80 p-3 space-y-1">
          <div className="font-semibold text-white truncate">{user.fullName}</div>
          <div className="text-slate-400 truncate">{user.jobTitle}</div>
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px]">
              {user.branchCode}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-brand-600/20 text-brand-200 text-[10px] truncate">
              {user.departmentName}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200">
        <div className="sticky top-0 h-screen">
          <SidebarContent />
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-72 max-w-[85vw] h-full">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarContent />
          </div>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 shrink-0"
              aria-label="Abrir menú"
            >
              <Menu className="h-5 w-5" />
            </button>
            <Link
              href="/"
              className="flex items-center gap-2 lg:hidden shrink-0"
              aria-label="AprobaFlow — Inicio"
            >
              <AprobaFlowIcon className="h-7 w-7 shrink-0" />
              <span className="hidden sm:inline font-bold text-slate-900 text-sm tracking-tight">
                AprobaFlow
              </span>
            </Link>
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 min-w-0">
              <span>Filial:</span>
              <Badge variant="slate">{user.branchName}</Badge>
              <span className="hidden md:inline">• Roles:</span>
              <div className="hidden md:flex items-center gap-1">
                {user.roles.map((r) => (
                  <Badge key={r} variant="default">
                    {USER_ROLE_LABELS[r] ?? r}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Demo User Switcher */}
            {demoEnabled && demoUsers.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-brand-200 bg-brand-50/70 text-brand-800 hover:bg-brand-100"
                    data-testid="demo-switcher-trigger"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    <span className="max-w-[100px] sm:max-w-[180px] truncate">
                      Demo: {user.fullName}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    className="z-50 w-80 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg max-h-[75vh] overflow-y-auto"
                  >
                    <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Cambiar Perfil Demo (Consultora)
                    </div>
                    {demoUsers.map((du) => (
                      <DropdownMenu.Item
                        key={du.id}
                        onSelect={() => void switchDemoUser(du.id)}
                        className={cn(
                          'flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-xs cursor-pointer outline-none',
                          du.id === user.id
                            ? 'bg-brand-50 text-brand-900 font-semibold'
                            : 'hover:bg-slate-50 text-slate-700'
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold truncate">{du.fullName}</span>
                          <span className="text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                            {du.branchCode}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500 truncate">
                          {du.jobTitle} · {du.roles.join(', ')}
                        </span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}

            {/* Notifications Bell */}
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button variant="outline" size="icon" className="relative" aria-label="Notificaciones">
                  <Bell className="h-4 w-4 text-slate-600" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-rose-600 text-[10px] font-bold text-white flex items-center justify-center">
                      {unreadCount}
                    </span>
                  )}
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 w-80 sm:w-96 rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden"
                >
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-900">Notificaciones</span>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={() => void markAllRead()}
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline cursor-pointer"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        Marcar leídas
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                    {notifications.length === 0 ? (
                      <p className="p-6 text-center text-xs text-slate-400">
                        No tienes notificaciones recientes.
                      </p>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => void openNotification(n)}
                          className={cn(
                            'w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors cursor-pointer block',
                            !n.isRead && 'bg-brand-50/40'
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-900">{n.title}</span>
                            {!n.isRead && (
                              <span className="h-2 w-2 rounded-full bg-brand-600 shrink-0 mt-1" />
                            )}
                          </div>
                          <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{n.message}</p>
                          <span className="text-[10px] text-slate-400 mt-1 block">
                            {formatDateTimeEs(n.createdAt)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* Logout */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void logout()}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-4 w-4 text-slate-600" />
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center space-y-2">
            <AprobaFlowIcon className="h-10 w-10 mx-auto animate-pulse drop-shadow-xs" />
            <p className="text-sm text-slate-500">Cargando AprobaFlow...</p>
          </div>
        </div>
      }
    >
      <AppShellInner>{children}</AppShellInner>
    </React.Suspense>
  );
}
