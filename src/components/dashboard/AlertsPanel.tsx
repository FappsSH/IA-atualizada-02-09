import { AlertTriangle, Clock, Users } from 'lucide-react';
import { formatRelativeTime } from '@/lib/utils';

interface AlertData {
  handoffCount: number;
  stuckLeads: { nome: string | null; telefone: string; etapa_atual: string; updated_at: string }[];
  recentErrors: { error_code: string; count: number }[];
}

interface AlertsPanelProps {
  data: AlertData;
  loading?: boolean;
}

export function AlertsPanel({ data, loading }: AlertsPanelProps) {
  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-base font-semibold">Alertas</h3>
        <div className="space-y-3">
          <div className="h-12 w-full animate-pulse rounded bg-muted" />
          <div className="h-12 w-full animate-pulse rounded bg-muted" />
          <div className="h-12 w-full animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const hasAlerts = data.handoffCount > 0 || data.stuckLeads.length > 0 || data.recentErrors.length > 0;

  if (!hasAlerts) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-base font-semibold">Alertas</h3>
        <p className="text-sm text-muted-foreground">Nenhum alerta no momento.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6">
      <h3 className="mb-4 flex items-center gap-2 text-base font-semibold">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        Alertas Ativos
      </h3>
      <div className="space-y-3">
        {data.handoffCount > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <Users className="h-5 w-5 shrink-0 text-red-500" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-500">{data.handoffCount} lead(s) em handoff</p>
              <p className="text-xs text-muted-foreground">Aguardando atendimento humano</p>
            </div>
            <span className="inline-flex items-center justify-center rounded-full bg-red-500 px-2 py-0.5 text-xs font-bold text-white">
              {data.handoffCount}
            </span>
          </div>
        )}

        {data.stuckLeads.length > 0 && (
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 shrink-0 text-orange-500" />
              <p className="text-sm font-medium text-orange-500">
                {data.stuckLeads.length} lead(s) parados há mais de 24h
              </p>
            </div>
            <div className="space-y-1">
              {data.stuckLeads.slice(0, 5).map((lead, index) => (
                <div key={index} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{lead.nome || lead.telefone}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {lead.etapa_atual} - {formatRelativeTime(lead.updated_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.recentErrors.length > 0 && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
              <p className="text-sm font-medium text-red-500">Erros nas últimas 6h</p>
            </div>
            <div className="space-y-1">
              {data.recentErrors.slice(0, 5).map((err, index) => (
                <div key={index} className="flex items-center justify-between text-xs">
                  <code className="rounded bg-background px-1">{err.error_code}</code>
                  <span className="text-muted-foreground">{err.count}x</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
