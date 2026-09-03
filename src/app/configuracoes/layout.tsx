import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Configurações | AgenteHub - Fapps',
};

export default function ConfiguracoesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
