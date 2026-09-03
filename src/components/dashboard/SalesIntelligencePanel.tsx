import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeTime, getNextBestActionLabel, getTemperatureBadgeColor, getTemperatureLabel } from '@/lib/utils';

interface PriorityLead {
  id: string;
  nome: string | null;
  telefone: string;
  etapa_atual: string;
  updated_at: string;
  sales_context?: {
    temperature?: string;
    next_best_action?: string;
    summary?: string;
  } | null;
}

interface SalesIntelligencePanelProps {
  hotLeads: PriorityLead[];
  proposalReadyLeads: PriorityLead[];
  enrollmentReadyLeads: PriorityLead[];
}

function LeadPriorityList({
  title,
  description,
  leads,
}: {
  title: string;
  description: string;
  leads: PriorityLead[];
}) {
  return (
    <div className="rounded-lg border bg-background/60 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">{leads.length}</Badge>
      </div>

      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum lead nessa fila agora.</p>
      ) : (
        <div className="space-y-3">
          {leads.slice(0, 5).map((lead) => (
            <div key={lead.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{lead.nome || lead.telefone}</p>
                  <p className="text-xs text-muted-foreground">
                    {lead.etapa_atual} • {formatRelativeTime(lead.updated_at)}
                  </p>
                </div>
                {lead.sales_context?.temperature && (
                  <Badge className={`${getTemperatureBadgeColor(lead.sales_context.temperature)} text-white`}>
                    {getTemperatureLabel(lead.sales_context.temperature)}
                  </Badge>
                )}
              </div>
              {lead.sales_context?.summary && (
                <p className="mt-2 text-xs text-muted-foreground">{lead.sales_context.summary}</p>
              )}
              {lead.sales_context?.next_best_action && (
                <p className="mt-2 text-xs font-medium">
                  Proximo passo: {getNextBestActionLabel(lead.sales_context.next_best_action)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SalesIntelligencePanel({
  hotLeads,
  proposalReadyLeads,
  enrollmentReadyLeads,
}: SalesIntelligencePanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Radar Comercial</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 xl:grid-cols-3">
        <LeadPriorityList
          title="Leads quentes"
          description="Prioridade maxima para manter ritmo de conversa."
          leads={hotLeads}
        />
        <LeadPriorityList
          title="Prontos para proposta"
          description="Momento ideal para enviar proposta de valor."
          leads={proposalReadyLeads}
        />
        <LeadPriorityList
          title="Prontos para matricula"
          description="Fila de fechamento e confirmacao final."
          leads={enrollmentReadyLeads}
        />
      </CardContent>
    </Card>
  );
}
