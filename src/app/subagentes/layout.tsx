import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Subagentes | AgenteHub - Fapps',
};

export default function SubagentesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
