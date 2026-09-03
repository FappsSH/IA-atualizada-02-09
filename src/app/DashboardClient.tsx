'use client';

import { lazy, Suspense, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MetricCard } from '../components/dashboard/MetricCard';
import { LeadsByStage } from '../components/dashboard/LeadsByStage';
import { AlertsPanel } from '../components/dashboard/AlertsPanel';
import { SalesIntelligencePanel } from '../components/dashboard/SalesIntelligencePanel';
import { Skeleton } from '../components/ui/skeleton';
import { Users, UserCheck, GraduationCap, HeadphonesIcon, Gift, Flame, FileText, CircleDollarSign } from 'lucide-react';
import { useRealtime } from '../hooks/useRealtime';

const TrendChart = lazy(() => import('../components/dashboard/TrendChart'));

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

interface DashboardData {
  metrics: {
    leadsHoje: number;
    leadsAtivos: number;
    matriculasHoje: number;
    handoffCount: number;
    indicacoesHoje: number;
    leadsQuentes: number;
    propostasProntas: number;
    matriculasProntas: number;
  };
  chartData: { date: string; leads: number; matriculas: number }[];
  stageCounts: Record<string, number>;
  alerts: {
    handoffCount: number;
    stuckLeads: { nome: string | null; telefone: string; etapa_atual: string; updated_at: string }[];
    recentErrors: { error_code: string; count: number }[];
  };
  salesIntelligence: {
    hotLeads: PriorityLead[];
    proposalReadyLeads: PriorityLead[];
    enrollmentReadyLeads: PriorityLead[];
  };
}

export function DashboardClient({ initialData }: { initialData: DashboardData }) {
  const router = useRouter();
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = () => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }

    refreshTimeoutRef.current = setTimeout(() => {
      router.refresh();
    }, 500);
  };

  useRealtime<any>('leads', scheduleRefresh);
  useRealtime<any>('trace_span', scheduleRefresh);
  useRealtime<any>('indicacoes', scheduleRefresh);
  useRealtime<any>('lead_events', scheduleRefresh);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Visão geral do sistema de IA comercial</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-8">
        <MetricCard title="Leads Hoje" value={initialData.metrics.leadsHoje} icon={Users} color="text-blue-500" />
        <MetricCard title="Leads Ativos" value={initialData.metrics.leadsAtivos} icon={UserCheck} color="text-green-500" />
        <MetricCard title="Matrículas Hoje" value={initialData.metrics.matriculasHoje} icon={GraduationCap} color="text-violet-500" />
        <MetricCard title="Em Handoff" value={initialData.metrics.handoffCount} icon={HeadphonesIcon} color="text-red-500" />
        <MetricCard title="Indicações Hoje" value={initialData.metrics.indicacoesHoje} icon={Gift} color="text-orange-500" />
        <MetricCard title="Leads Quentes" value={initialData.metrics.leadsQuentes} icon={Flame} color="text-rose-500" />
        <MetricCard title="Prontos Proposta" value={initialData.metrics.propostasProntas} icon={FileText} color="text-amber-500" />
        <MetricCard title="Prontos Matrícula" value={initialData.metrics.matriculasProntas} icon={CircleDollarSign} color="text-emerald-500" />
      </div>

      <SalesIntelligencePanel
        hotLeads={initialData.salesIntelligence.hotLeads}
        proposalReadyLeads={initialData.salesIntelligence.proposalReadyLeads}
        enrollmentReadyLeads={initialData.salesIntelligence.enrollmentReadyLeads}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6">
            <h3 className="mb-4 text-base font-semibold">Leads e Matrículas - Últimos 14 dias</h3>
            <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
              <TrendChart data={initialData.chartData} />
            </Suspense>
          </div>
        </div>
        <div className="space-y-6">
          <LeadsByStage stageCounts={initialData.stageCounts} />
          <AlertsPanel data={initialData.alerts} />
        </div>
      </div>
    </div>
  );
}
