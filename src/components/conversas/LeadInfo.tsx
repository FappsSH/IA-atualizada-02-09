'use client';

import { Lead } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { getStageBadgeColor, getStageLabel, getTemperatureBadgeColor, getTemperatureLabel } from '@/lib/utils';
import { Phone, BookOpen, Target, CheckCircle, XCircle } from 'lucide-react';

interface LeadInfoProps {
  lead: Lead;
}

export function LeadInfo({ lead }: LeadInfoProps) {
  return (
    <div className="flex items-center gap-4 p-4 border-b">
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-lg truncate">{lead.nome || lead.telefone}</h3>
        <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Phone className="h-3.5 w-3.5" />
            {lead.telefone}
          </span>
          {lead.curso_interesse && (
            <span className="flex items-center gap-1">
              <BookOpen className="h-3.5 w-3.5" />
              {lead.curso_interesse}
            </span>
          )}
          {lead.dor_principal && (
            <span className="flex items-center gap-1">
              <Target className="h-3.5 w-3.5" />
              {lead.dor_principal}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge className={`${getStageBadgeColor(lead.etapa_atual)} text-white`}>
          {getStageLabel(lead.etapa_atual)}
        </Badge>
        {lead.sales_context?.temperature && (
          <Badge className={`${getTemperatureBadgeColor(lead.sales_context.temperature)} text-white`}>
            {getTemperatureLabel(lead.sales_context.temperature)}
          </Badge>
        )}
        {lead.sales_context?.next_best_action && (
          <Badge variant="outline">
            {lead.sales_context.next_best_action}
          </Badge>
        )}
        {lead.matriculado ? (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> Matriculado
          </Badge>
        ) : (
          <Badge variant="outline" className="flex items-center gap-1">
            <XCircle className="h-3 w-3" /> Não matriculado
          </Badge>
        )}
      </div>
    </div>
  );
}
