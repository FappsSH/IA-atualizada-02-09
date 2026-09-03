import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Conversas | AgenteHub - Fapps',
};

export default function ConversasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
