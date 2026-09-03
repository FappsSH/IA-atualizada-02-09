import { createServerClient } from '@/lib/supabase';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';

async function fetchDashboardData() {
  const supabase = createServerClient();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const [
    { count: leadsHoje },
    { count: leadsAtivos },
    { count: matriculasHoje },
    { count: handoffCount },
    { count: indicacoesHoje },
    { data: allLeads },
    { data: allMatriculados },
    stageResults,
    { data: stuckLeadsData },
    { data: errorSpans },
    { data: salesLeadsData },
  ] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', todayISO),
    supabase.from('leads').select('*', { count: 'exact', head: true }).neq('etapa_atual', 'encerrado').neq('etapa_atual', 'inativo'),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('matriculado', true).gte('updated_at', todayISO),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('etapa_atual', 'handoff'),
    supabase.from('indicacoes').select('*', { count: 'exact', head: true }).gte('created_at', todayISO),
    supabase.from('leads').select('created_at').gte('created_at', fourteenDaysAgo.toISOString()),
    supabase.from('leads').select('updated_at').eq('matriculado', true).gte('updated_at', fourteenDaysAgo.toISOString()),
    Promise.all(
      ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'handoff', 'encerrado'].map((stage) =>
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('etapa_atual', stage)
      )
    ),
    supabase.from('leads').select('nome,telefone,etapa_atual,updated_at').order('updated_at', { ascending: true }).limit(10),
    supabase.from('trace_span').select('output').eq('status', 'error').limit(100),
    supabase
      .from('leads')
      .select('id,nome,telefone,etapa_atual,updated_at,sales_context,proposta_enviada_em,pronto_matricula_em,bloqueado,matriculado')
      .neq('etapa_atual', 'encerrado')
      .neq('etapa_atual', 'inativo')
      .order('updated_at', { ascending: false })
      .limit(200),
  ]);

  const stageCounts: Record<string, number> = {};
  ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'handoff', 'encerrado'].forEach((stage, i) => {
    stageCounts[stage] = stageResults[i]?.count || 0;
  });

  const stuckLeads = (stuckLeadsData || []).filter((l: any) => {
    const updated = new Date(l.updated_at).getTime();
    return Date.now() - updated > 24 * 60 * 60 * 1000;
  });

  const errorMap = new Map<string, number>();
  (errorSpans || []).forEach((span: any) => {
    const code = (span.output as any)?.error_code || 'ERR_000';
    errorMap.set(code, (errorMap.get(code) || 0) + 1);
  });

  const leadsByDay: Record<string, number> = {};
  const matriculasByDay: Record<string, number> = {};

  (allLeads || []).forEach((l: any) => {
    const key = new Date(l.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    leadsByDay[key] = (leadsByDay[key] || 0) + 1;
  });
  (allMatriculados || []).forEach((l: any) => {
    const key = new Date(l.updated_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    matriculasByDay[key] = (matriculasByDay[key] || 0) + 1;
  });

  const chartData: { date: string; leads: number; matriculas: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    chartData.push({ date: key, leads: leadsByDay[key] || 0, matriculas: matriculasByDay[key] || 0 });
  }

  const salesLeads = (salesLeadsData || []) as any[];
  const hotLeads = salesLeads.filter((lead) => lead.sales_context?.temperature === 'hot');
  const proposalReadyLeads = salesLeads.filter((lead) => lead.sales_context?.proposal_ready === true);
  const enrollmentReadyLeads = salesLeads.filter((lead) => lead.sales_context?.enrollment_ready === true);

  return {
    metrics: {
      leadsHoje: leadsHoje ?? 0,
      leadsAtivos: leadsAtivos ?? 0,
      matriculasHoje: matriculasHoje ?? 0,
      handoffCount: handoffCount ?? 0,
      indicacoesHoje: indicacoesHoje ?? 0,
      leadsQuentes: hotLeads.length,
      propostasProntas: proposalReadyLeads.length,
      matriculasProntas: enrollmentReadyLeads.length,
    },
    chartData,
    stageCounts,
    alerts: {
      handoffCount: handoffCount ?? 0,
      stuckLeads: stuckLeads as any[],
      recentErrors: Array.from(errorMap.entries()).map(([code, count]) => ({ error_code: code, count })),
    },
    salesIntelligence: {
      hotLeads: hotLeads.slice(0, 5),
      proposalReadyLeads: proposalReadyLeads.slice(0, 5),
      enrollmentReadyLeads: enrollmentReadyLeads.slice(0, 5),
    },
  };
}

export default async function DashboardPage() {
  const data = await fetchDashboardData();
  return <DashboardClient initialData={data} />;
}
