import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  applicationName: 'AprobaFlow',
  title: 'AprobaFlow — Control de Gastos y Aprobaciones',
  description:
    'Plataforma centralizada de rendiciones, anticipos, control presupuestario y auditoría para equipos distribuidos.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased selection:bg-brand-600 selection:text-white">
        {children}
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
