import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Regras | AgenteHub - Fapps',
};

export default function RegrasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
