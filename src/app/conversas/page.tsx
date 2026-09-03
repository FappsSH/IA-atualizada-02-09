'use client';

import { useState } from 'react';
import { Lead } from '@/lib/types';
import { LeadList } from '@/components/conversas/LeadList';
import { ChatWindow } from '@/components/conversas/ChatWindow';
import { useLead } from '@/hooks/useLeads';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageSquare } from 'lucide-react';

export default function ConversasPage() {
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const { lead, loading } = useLead(selectedLeadId || undefined);

  const handleSelectLead = (nextLead: Lead) => {
    setSelectedLeadId(nextLead.id);
    setSelectedLead(nextLead);
  };

  const displayLead = lead || selectedLead;

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col overflow-hidden rounded-xl border bg-card lg:min-h-[calc(100dvh-6.5rem)] lg:flex-row">
      <div className="h-[360px] border-b lg:h-auto lg:w-96 lg:shrink-0 lg:border-b-0 lg:border-r">
        <LeadList selectedId={selectedLeadId} onSelect={handleSelectLead} />
      </div>

      <div className="min-h-[420px] min-w-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-3xl space-y-4">
              <Skeleton className="h-12 w-full" />
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                  <Skeleton className="h-16 w-3/4 rounded-2xl" />
                </div>
              ))}
            </div>
          </div>
        ) : displayLead ? (
          <ChatWindow key={displayLead.id} lead={displayLead} onUpdate={() => {}} />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
              <p className="text-lg font-medium text-muted-foreground">Selecione um lead</p>
              <p className="text-sm text-muted-foreground">
                Escolha um lead na lista para ver a conversa
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
