import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const functionsUrl = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const tenantId = '00000000-0000-0000-0000-000000000001';
const supabase = createClient(supabaseUrl, serviceKey);

type ChatItem = { role: 'user' | 'assistant'; content: string };
type Scenario = {
  id: string;
  label: string;
  steps: string[];
};

const scenarios: Scenario[] = [
  {
    id: 'confirmed_available',
    label: 'Curso disponivel',
    steps: [
      'Oi',
      'Quero Administracao Publica',
      'Sou de Vilhena',
      'Ja trabalho na area',
    ],
  },
  {
    id: 'ambiguous_available',
    label: 'Curso com Bacharelado/Licenciatura',
    steps: [
      'Oi',
      'Quero Ciencias Biologicas',
      'Licenciatura',
    ],
  },
  {
    id: 'confirmed_unavailable_same_segment',
    label: 'Curso indisponivel com alternativas no mesmo segmento',
    steps: [
      'Oi',
      'Quero Medicina',
      'Sim, pode me mostrar outras opcoes dessa area',
    ],
  },
  {
    id: 'confirmed_unavailable_no_segment_options',
    label: 'Curso indisponivel sem alternativas',
    steps: [
      'Oi',
      'Quero Astrofisica Quantica',
    ],
  },
];

async function createLead(phone: string, scenarioId: string) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      tenant_id: tenantId,
      nome: `Teste ${scenarioId} ${Date.now()}`,
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

async function insertUserMessage(leadId: string, etapaAtual: string, text: string) {
  const { error } = await supabase.from('mensagens').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    role: 'user',
    conteudo: text,
    etapa_no_momento: etapaAtual,
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
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

async function getLatestEvents(leadId: string) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('event_type, payload, created_at')
    .eq('lead_id', leadId)
    .in('event_type', ['test_stage_result', 'test_response_ready', 'test_stage_contract_violation'])
    .order('created_at', { ascending: false })
    .limit(6);

  if (error) throw error;
  return data || [];
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
  return { ok: res.ok, status: res.status, json };
}

async function runScenario(scenario: Scenario) {
  const phone = `550000${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;
  const lead = await createLead(phone, scenario.id);
  const history: ChatItem[] = [];
  const turns: any[] = [];
  let previousCourseStatus: string | null = null;

  for (const userText of scenario.steps) {
    const leadBefore = await getLead(lead.id);
    const etapaAtual = leadBefore.etapa_atual;
    const salesContextBefore = { ...(leadBefore.sales_context || {}) } as Record<string, unknown>;
    const courseStatusBefore = String(salesContextBefore.course_status || '').trim() || null;

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

    const leadAfter = await getLead(lead.id);
    const events = await getLatestEvents(lead.id);
    const responseReady = events.find((event: any) => event.event_type === 'test_response_ready');
    const stageResult = events.find((event: any) => event.event_type === 'test_stage_result');
    const salesContextAfter = { ...(leadAfter.sales_context || {}) } as Record<string, unknown>;
    const courseStatusAfter = String(salesContextAfter.course_status || '').trim() || null;

    const assistantText = String(responseReady?.payload?.texto_final || '').trim();
    if (assistantText) {
      history.push({ role: 'assistant', content: assistantText });
    }

    turns.push({
      user: userText,
      http_ok: result.ok,
      status: result.status,
      stage_before: etapaAtual,
      stage_after: leadAfter.etapa_atual,
      course_status_before: courseStatusBefore,
      course_status_after: courseStatusAfter,
      course_status_changed_without_new_course_intent:
        previousCourseStatus !== null &&
        courseStatusBefore === previousCourseStatus &&
        courseStatusAfter !== previousCourseStatus &&
        !/quero|curso|graduacao|graduacao|opcao|opção|area|área|bacharelado|licenciatura/i.test(userText),
      response_origin: responseReady?.payload?.response_origin || null,
      allowed_intent: responseReady?.payload?.allowed_intent || null,
      process_action: responseReady?.payload?.process_action || null,
      conversational_behavior: responseReady?.payload?.conversational_behavior || null,
      speakable_facts: responseReady?.payload?.speakable_facts || null,
      final_text: assistantText,
      raw_model_output: responseReady?.payload?.raw_model_output || null,
      output_before_governance: responseReady?.payload?.output_before_governance || null,
      regenerated_output: responseReady?.payload?.regenerated_output || null,
      personality_guard_triggered: responseReady?.payload?.personality_guard_triggered || false,
      personality_violations: responseReady?.payload?.personality_violations || [],
      flow_narration_detected: responseReady?.payload?.flow_narration_detected || false,
      repeated_fact_detected: responseReady?.payload?.repeated_fact_detected || false,
      ungrounded_output_detected: responseReady?.payload?.ungrounded_output_detected || false,
      unauthorized_stage_fact_detected: responseReady?.payload?.unauthorized_stage_fact_detected || false,
      regeneration_attempt: responseReady?.payload?.regeneration_attempt || 0,
      regeneration_success: responseReady?.payload?.regeneration_success || false,
      guard_runs: responseReady?.payload?.guard_runs || [],
      final_output_source: responseReady?.payload?.final_output_source || 'raw_model',
      final_personality_valid: responseReady?.payload?.final_personality_valid !== false,
      stage_result_text: stageResult?.payload?.texto_gerado || null,
    });

    previousCourseStatus = courseStatusAfter;
  }

  const finalLead = await getLead(lead.id);
  return {
    scenario: scenario.label,
    scenario_id: scenario.id,
    lead_id: lead.id,
    final_stage: finalLead.etapa_atual,
    final_course_status: String(finalLead.sales_context?.course_status || '').trim() || null,
    final_sales_context: finalLead.sales_context || {},
    turns,
  };
}

async function main() {
  const results = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  console.log(JSON.stringify({
    ran_at: new Date().toISOString(),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
