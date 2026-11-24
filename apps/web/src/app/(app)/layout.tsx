import { AppShell } from '@/components/layout/AppShell';
import { AuthProvider } from '@/components/providers/auth-provider';

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
