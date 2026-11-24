'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { UserRole } from '@aproba-flow/shared';
import { api, extractApiError } from '@/lib/eden';

export interface ClientUser {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  departmentId: string;
  departmentName: string;
  managerId: string | null;
  roles: UserRole[];
  bankName: string | null;
  bankAccountNumber: string | null;
}

export interface DemoUserOption {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  roles: string[];
  branchName: string;
  branchCode: string;
  departmentName: string;
}

interface AuthContextValue {
  user: ClientUser | null;
  loading: boolean;
  demoUsers: DemoUserOption[];
  demoEnabled: boolean;
  pendingApprovalsCount: number;
  refreshUser: () => Promise<void>;
  refreshBadges: () => Promise<void>;
  switchDemoUser: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = React.useState<ClientUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [demoUsers, setDemoUsers] = React.useState<DemoUserOption[]>([]);
  const [demoEnabled, setDemoEnabled] = React.useState(false);
  const [pendingApprovalsCount, setPendingApprovalsCount] = React.useState(0);

  const refreshBadges = React.useCallback(async () => {
    try {
      const { data } = await api.api.approvals['review-hub'].get();
      if (data && typeof data.totalActionableCount === 'number') {
        setPendingApprovalsCount(data.totalActionableCount);
      }
    } catch {
      // ignore badge fetch errors
    }
  }, []);

  const refreshUser = React.useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: meData, error }, { data: demoData }] = await Promise.all([
        api.api.auth.me.get(),
        api.api.auth['demo-users'].get(),
      ]);

      if (demoData && demoData.enabled) {
        setDemoEnabled(true);
        setDemoUsers(demoData.users as DemoUserOption[]);
      }

      if (error || !meData?.user) {
        setUser(null);
        router.replace('/login');
        return;
      }

      setUser(meData.user as ClientUser);
      await refreshBadges();
    } catch {
      setUser(null);
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [router, refreshBadges]);

  React.useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const switchDemoUser = React.useCallback(
    async (userId: string) => {
      const { data, error } = await api.api.auth['demo-switch'].post({ userId });
      if (error || !data?.user) {
        toast.error(extractApiError(error, 'No se pudo cambiar de usuario'));
        return;
      }
      setUser(data.user as ClientUser);
      await refreshBadges();
      toast.success(`Sesión cambiada a ${data.user.fullName}`);
      router.refresh();
    },
    [refreshBadges, router]
  );

  const logout = React.useCallback(async () => {
    await api.api.auth.logout.post();
    setUser(null);
    router.replace('/login');
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        demoUsers,
        demoEnabled,
        pendingApprovalsCount,
        refreshUser,
        refreshBadges,
        switchDemoUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return ctx;
}
