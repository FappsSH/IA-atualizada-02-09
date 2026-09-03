'use client';

import { useParams } from 'next/navigation';
import { useLead } from '@/hooks/useLeads';
import { ChatWindow } from '@/components/conversas/ChatWindow';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function ConversaPage() {
  const params = useParams();
  const id = params?.id as string;
  const { lead, loading } = useLead(id);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <div className="space-y-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
              <Skeleton className="h-16 w-3/4 rounded-2xl" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">Lead não encontrado</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col overflow-hidden rounded-xl border bg-card lg:min-h-[calc(100dvh-6.5rem)]">
      <div className="border-b px-4 py-3">
        <Link href="/conversas" prefetch className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Voltar para conversas
        </Link>
      </div>
      <div className="min-h-0 flex-1">
        <ChatWindow lead={lead} onUpdate={() => {}} />
      </div>
    </div>
  );
}
