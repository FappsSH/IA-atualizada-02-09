import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const functionsUrl = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const tenantId = '00000000-0000-0000-0000-000000000001';
const supabase = createClient(supabaseUrl, serviceKey);

const runId = `flow-${Date.now()}`;
const phone = `550000${String(Date.now()).slice(-7)}`;

const steps = [
  'Oi, quero Agronomia.',
  'Sou de Porto Velho e esse curso e meu objetivo profissional.',
  'Combinado, se a bolsa ficar boa seguimos sim.',
  'Qual o valor e as condicoes de matricula?',
  'Quero seguir para a matricula.',
  'Ja paguei a matricula via PIX.',
  'Tenho uma indicacao.',
  'Maria Souza',
  '5511999998888',
];

type ChatItem = { role: 'user' | 'assistant'; content: string };

async function insertUserMessage(leadId: string, etapaAtual: string, text: string) {
  await supabase.from('mensagens').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    role: 'user',
    conteudo: text,
    etapa_no_momento: etapaAtual,
    created_at: new Date().toISOString(),
  });
}

async function getLead(leadId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (error) throw error;
  return data;
}

async function getLatestResponseReady(leadId: string) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('event_type, payload, created_at')
    .eq('lead_id', leadId)
    .eq('event_type', 'test_response_ready')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function getLatestStageEvents(leadId: string) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('event_type, payload, created_at')
    .eq('lead_id', leadId)
    .in('event_type', ['test_stage_result', 'test_stage_transition', 'test_ai_processor_error', 'test_whatsapp_sender_result'])
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) throw error;
  return data || [];
}

async function createLead() {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      tenant_id: tenantId,
      nome: `Teste ${runId}`,
      telefone: phone,
      etapa_atual: 'E1',
      bloqueado: false,
      matriculado: false,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function callAiProcessor(payload: any) {
  const res = await fetch(`${functionsUrl}/ai-processor`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  const lead = await createLead();
  const history: ChatItem[] = [];
  const transcript: any[] = [];

  for (const userText of steps) {
    const freshLead = await getLead(lead.id);
    const etapaAtual = freshLead.etapa_atual;

    history.push({ role: 'user', content: userText });
    await insertUserMessage(lead.id, etapaAtual, userText);

    const recentUserMessages = history
      .filter((item) => item.role === 'user')
      .map((item) => item.content)
      .slice(-4);

    const result = await callAiProcessor({
      lead_id: lead.id,
      tenant_id: tenantId,
      telefone: phone,
      etapa_atual: etapaAtual,
      trigger: 'whatsapp_inbound',
      text: userText,
      recent_user_messages: recentUserMessages,
      history,
      inbound_message_ids: [],
      last_received_at: new Date().toISOString(),
    });

    const updatedLead = await getLead(lead.id);
    const responseEvent = await getLatestResponseReady(lead.id);
    const assistantText = String(responseEvent?.payload?.texto_final || result.json?.out?.text || '').trim();

    if (assistantText) {
      history.push({ role: 'assistant', content: assistantText });
    }

    transcript.push({
      user: userText,
      etapa_antes: etapaAtual,
      http_ok: result.ok,
      status: result.status,
      etapa_depois: updatedLead.etapa_atual,
      matriculado: updatedLead.matriculado,
      bloqueado: updatedLead.bloqueado,
      assistant: assistantText,
    });

    if (!result.ok) break;
    if (['encerrado', 'handoff', 'inativo'].includes(updatedLead.etapa_atual)) break;
  }

  const finalLead = await getLead(lead.id);
  const recentEvents = await getLatestStageEvents(lead.id);

  console.log(JSON.stringify({
    runId,
    lead_id: lead.id,
    telefone: phone,
    final_stage: finalLead.etapa_atual,
    matriculado: finalLead.matriculado,
    bloqueado: finalLead.bloqueado,
    transcript,
    recentEvents,
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
