import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const functionsUrl = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const tenantId = '00000000-0000-0000-0000-000000000001';

const supabase = createClient(supabaseUrl, serviceKey);
const phone = `559699${String(Date.now()).slice(-7)}`;
const steps = [
  'Oi',
  'Quero saber os cursos que voces tem',
  'Area da tecnologia me chama a atencao',
  'Analise e Desenvolvimento de Sistemas',
];

type ChatItem = { role: 'user' | 'assistant'; content: string };

async function getLead(leadId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (error) throw error;
  return data;
}

async function getHistory(leadId: string): Promise<ChatItem[]> {
  const { data, error } = await supabase
    .from('mensagens')
    .select('role, conteudo, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []).map((message: any) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.conteudo,
  }));
}

async function main() {
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      tenant_id: tenantId,
      nome: `Teste catalog area ${Date.now()}`,
      telefone: phone,
      etapa_atual: 'E1',
      bloqueado: false,
      matriculado: false,
    })
    .select('*')
    .single();

  if (error) throw error;

  let history: ChatItem[] = [];
  const turns: any[] = [];

  for (const text of steps) {
    const freshLead = await getLead(lead.id);
    await supabase.from('mensagens').insert({
      tenant_id: tenantId,
      lead_id: lead.id,
      role: 'user',
      conteudo: text,
      etapa_no_momento: freshLead.etapa_atual,
      created_at: new Date().toISOString(),
    });

    history.push({ role: 'user', content: text });
    const recentUserMessages = history
      .filter((item) => item.role === 'user')
      .map((item) => item.content)
      .slice(-4);

    const res = await fetch(`${functionsUrl}/ai-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        lead_id: lead.id,
        tenant_id: tenantId,
        telefone: phone,
        etapa_atual: freshLead.etapa_atual,
        trigger: 'whatsapp_inbound',
        text,
        recent_user_messages: recentUserMessages,
        history,
        inbound_message_ids: [],
        last_received_at: new Date().toISOString(),
      }),
    });

    const json = await res.json().catch(() => ({}));
    await new Promise((resolve) => setTimeout(resolve, 500));
    history = await getHistory(lead.id);
    turns.push({ text, status: res.status, ok: res.ok, json });
  }

  const finalLead = await getLead(lead.id);
  const { data: events, error: eventsError } = await supabase
    .from('lead_events')
    .select('event_type, payload, created_at')
    .eq('lead_id', lead.id)
    .in('event_type', [
      'test_catalog_area_selection_trace',
      'test_catalog_area_selection_trace_sent',
      'test_response_ready',
      'test_stage_state_classification',
      'test_ai_processor_error',
      'test_whatsapp_sender_result',
    ])
    .order('created_at', { ascending: false })
    .limit(30);

  if (eventsError) throw eventsError;

  console.log(JSON.stringify({
    lead_id: lead.id,
    phone,
    turns,
    final_lead: {
      etapa_atual: finalLead.etapa_atual,
      curso_interesse: finalLead.curso_interesse,
      cidade: finalLead.cidade,
      sales_context: finalLead.sales_context,
    },
    events,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
