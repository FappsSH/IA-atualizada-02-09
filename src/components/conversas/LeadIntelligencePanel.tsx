'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lead } from '@/lib/types';
import {
  formatDate,
  getBuyingStageLabel,
  getIntentLabel,
  getNextBestActionLabel,
  getObjectionLabel,
  getTemperatureBadgeColor,
  getTemperatureLabel,
  getUrgencyLabel,
} from '@/lib/utils';

interface LeadIntelligencePanelProps {
  lead: Lead;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function LeadIntelligencePanel({ lead }: LeadIntelligencePanelProps) {
  const ctx = lead.sales_context;

  return (
    <div className="hidden w-80 border-l bg-muted/20 xl:block">
      <div className="space-y-4 p-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Leitura Comercial</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge className={`${getTemperatureBadgeColor(ctx?.temperature)} text-white`}>
                {getTemperatureLabel(ctx?.temperature)}
              </Badge>
              <Badge variant="outline">{getBuyingStageLabel(ctx?.buying_stage)}</Badge>
              <Badge variant="outline">{getUrgencyLabel(ctx?.urgency)}</Badge>
            </div>
            <InfoRow label="Intencao" value={getIntentLabel(ctx?.intent)} />
            <InfoRow label="Objecao" value={getObjectionLabel(ctx?.primary_objection)} />
            <InfoRow label="Proximo passo" value={getNextBestActionLabel(ctx?.next_best_action)} />
            <InfoRow
              label="Confianca da IA"
              value={ctx?.confidence ? `${Math.round(ctx.confidence * 100)}%` : 'Nao calculada'}
            />
            <InfoRow label="Ultima leitura" value={formatDate(lead.ultima_classificacao_em || ctx?.updated_at)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Sinais de Conversao</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <InfoRow label="Preco cedo" value={ctx?.asked_price_early ? 'Sim' : 'Nao'} />
            <InfoRow label="Pediu desconto" value={ctx?.asked_discount ? 'Sim' : 'Nao'} />
            <InfoRow label="Proposta pronta" value={ctx?.proposal_ready ? 'Sim' : 'Nao'} />
            <InfoRow label="Matricula pronta" value={ctx?.enrollment_ready ? 'Sim' : 'Nao'} />
            <InfoRow label="Precisa handoff" value={ctx?.needs_handoff ? 'Sim' : 'Nao'} />
            <InfoRow label="Pagamento confirmado" value={ctx?.payment_confirmed ? 'Sim' : 'Nao'} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Resumo da IA</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {ctx?.summary || lead.ultimo_resumo_ia || 'A IA ainda nao gerou um resumo comercial consolidado para este lead.'}
            </p>
            <div className="space-y-2 text-xs text-muted-foreground">
              <div>Proposta sinalizada em: {formatDate(lead.proposta_enviada_em)}</div>
              <div>Pronto para matricula em: {formatDate(lead.pronto_matricula_em)}</div>
              <div>Matricula concluida em: {formatDate(lead.matricula_em)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
