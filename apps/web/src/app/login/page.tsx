'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Lock, Mail, ShieldCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { AprobaFlowIcon } from '@/components/brand/AprobaFlowIcon';
import { api, extractApiError } from '@/lib/eden';

interface DemoUserItem {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  roles: string[];
  branchCode: string;
  departmentName: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState('elena.direccion@aprobaflow.com');
  const [password, setPassword] = React.useState('Demo1234!');
  const [submitting, setSubmitting] = React.useState(false);
  const [demoUsers, setDemoUsers] = React.useState<DemoUserItem[]>([]);
  const [demoEnabled, setDemoEnabled] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const { data } = await api.api.auth['demo-users'].get();
      if (data?.enabled) {
        setDemoEnabled(true);
        setDemoUsers(data.users as DemoUserItem[]);
      }
    })();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { data, error } = await api.api.auth.login.post({ email, password });
      if (error || !data?.user) {
        toast.error(extractApiError(error, 'Credenciales inválidas'));
        return;
      }
      toast.success(`Bienvenido, ${data.user.fullName}`);
      router.push('/');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const quickLogin = async (userId: string) => {
    setSubmitting(true);
    try {
      const { data, error } = await api.api.auth['demo-switch'].post({ userId });
      if (error || !data?.user) {
        toast.error(extractApiError(error, 'No se pudo iniciar sesión demo'));
        return;
      }
      toast.success(`Sesión iniciada como ${data.user.fullName}`);
      router.push('/');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Login Form */}
        <div className="lg:col-span-5 space-y-6">
          <div className="flex items-center gap-3">
            <AprobaFlowIcon className="h-11 w-11 shrink-0 drop-shadow-sm" />
            <div>
              <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">AprobaFlow</h1>
              <p className="text-xs text-slate-500">Control de Gastos y Aprobaciones</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Iniciar Sesión</CardTitle>
              <CardDescription>
                Ingresa con tus credenciales corporativas o selecciona un perfil demo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <Label htmlFor="email">Correo corporativo</Label>
                  <div className="relative">
                    <Mail className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                    <Input
                      id="email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-9"
                      placeholder="nombre@aprobaflow.com"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="password">Contraseña</Label>
                  <div className="relative">
                    <Lock className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                    <Input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? 'Verificando...' : 'Ingresar al Portal'}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </form>

              <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-500">
                <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>Trazabilidad auditada inmutable · Moneda USD · Control presupuestario 85%</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Quick Demo Access */}
        {demoEnabled && (
          <div className="lg:col-span-7">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-brand-600" />
                  Acceso Rápido Demo — Consultora (80 empleados · 3 filiales)
                </CardTitle>
                <CardDescription>
                  Haz clic en cualquier perfil para recorrer aprobaciones, suplencias, auditoría ítem
                  por ítem, tesorería y tablero gerencial. Contraseña común:{' '}
                  <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">Demo1234!</code>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {demoUsers.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      disabled={submitting}
                      onClick={() => void quickLogin(u.id)}
                      className="text-left rounded-xl border border-slate-200 bg-white p-3 hover:border-brand-500 hover:bg-brand-50/40 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-slate-900 group-hover:text-brand-700 truncate">
                          {u.fullName}
                        </span>
                        <span className="text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                          {u.branchCode}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">{u.jobTitle}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {u.roles.map((r) => (
                          <Badge key={r} variant="slate" className="text-[10px] px-1.5 py-0">
                            {r}
                          </Badge>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
