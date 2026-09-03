import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppShell } from '@/components/layout/AppShell';

export const metadata: Metadata = {
  title: 'AgenteHub - Fapps',
  description: 'Painel de Gestao do Sistema de IA Comercial',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen font-sans antialiased">
        <AppShell>
          <ErrorBoundary>{children}</ErrorBoundary>
        </AppShell>
        <Toaster />
      </body>
    </html>
  );
}
