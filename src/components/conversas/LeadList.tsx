'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Lead, Stage } from '@/lib/types';
import { useLeads } from '@/hooks/useLeads';
import { formatRelativeTime, getStageBadgeColor, getStageLabel, getTemperatureBadgeColor } from '@/lib/utils';
import { Search, MessageSquare } from 'lucide-react';

interface LeadListProps {
  selectedId: string | null;
  onSelect: (lead: Lead) => void;
}

const STAGES: Stage[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'handoff', 'encerrado'];

export function LeadList({ selectedId, onSelect }: LeadListProps) {
  const [search, setSearch] = useState('');
  const [etapa, setEtapa] = useState('todas');
  const [status, setStatus] = useState('');
  const { leads, loading } = useLeads({ search, etapa, status });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou telefone..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Select value={etapa || 'todas'} onValueChange={setEtapa}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Etapa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas etapas</SelectItem>
              {STAGES.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {stage} - {getStageLabel(stage)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status || 'todos'} onValueChange={(value) => setStatus(value === 'todos' ? '' : value)}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="handoff">Handoff</SelectItem>
              <SelectItem value="matriculado">Matriculado</SelectItem>
              <SelectItem value="ativo">Ativo</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : leads.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Nenhum lead encontrado</p>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {leads.map((lead) => {
              const isSelected = lead.id === selectedId;

              return (
                <button
                  key={lead.id}
                  onClick={() => onSelect(lead)}
                  className={`w-full px-4 py-3 text-left transition-colors hover:bg-accent/50 ${
                    isSelected ? 'bg-accent' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{lead.nome || lead.telefone}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.telefone}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {lead.bloqueado && (
                        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                          HANDOFF
                        </Badge>
                      )}
                      {lead.sales_context?.temperature && (
                        <Badge
                          className={`${getTemperatureBadgeColor(lead.sales_context.temperature)} px-1.5 py-0 text-[10px] text-white`}
                        >
                          {lead.sales_context.temperature}
                        </Badge>
                      )}
                      <Badge className={`${getStageBadgeColor(lead.etapa_atual)} px-1.5 py-0 text-[10px] text-white`}>
                        {lead.etapa_atual}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{formatRelativeTime(lead.updated_at)}</p>
                      {lead.sales_context?.summary && (
                        <p className="max-w-[220px] truncate text-[11px] text-muted-foreground">
                          {lead.sales_context.summary}
                        </p>
                      )}
                    </div>
                    {lead.matriculado && (
                      <Badge variant="success" className="px-1.5 py-0 text-[10px]">
                        Matriculado
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t p-2 text-center text-xs text-muted-foreground">{leads.length} lead(s)</div>
    </div>
  );
}
