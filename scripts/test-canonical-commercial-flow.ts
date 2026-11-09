// Canonical AgentHub E1/E2 discipline test.
// Run: node --env-file=.env.local --experimental-strip-types scripts/test-canonical-commercial-flow.ts
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildInitialE1WelcomeMessages, resolveInitialE1WelcomeMessageCount } from '../supabase/functions/ai-processor/initial-opening.ts';
import { resolveTrustedLeadName } from '../supabase/functions/_shared/lead-name.ts';
import { classifyInboundAgainstStageState, getNextE1Criterion, getNextE2Criterion } from '../supabase/functions/ai-processor/stage-state.ts';
import { detectPersonalityOutputViolations } from '../supabase/functions/ai-processor/output-guard.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):/);
const s = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sourceTenant = '00000000-0000-0000-0000-000000000001';
const keys = ['PERSONALITY','E1','E2','E3','E4','E5','E6','E7'];
const tenant = randomUUID();
const phone = '+5500090900001';
const adminPhone = '+5500090900999';
const port = 18083;
const sent: string[] = [];
const sentMeta: Array<{ number?: string; telefone?: string; text: string }> = [];
const cleanupLeadIds = new Set<string>();

function normalize(value: unknown) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function realQuestionCount(text: string) {
  return (String(text || '').match(/\?/g) || []).length;
}
function assertNoProcessNarration(text: string) {
  assert.doesNotMatch(normalize(text), /vou verificar|vou consultar|vou checar|vou buscar informacoes|aguarde|um momento|estou analisando|proxima etapa|vamos seguir|vamos avancar|agora,? vamos|para podermos avancar|para avancar|para que possamos seguir|antes de avancarmos|antes de seguir|antes de seguirmos|para darmos continuidade|darmos continuidade|para concluir|so para concluir|so para garantir/);
}
async function checked(query: any) {
  const r = await query;
  if (r.error) throw Error(JSON.stringify(r.error));
  return r.data;
}
async function runTurn(text: string, lead: string) {
  const before = await checked(s.from('leads').select('*').eq('id', lead).single());
  const inboundId = randomUUID();
  const started = new Date().toISOString();
  await checked(s.from('mensagens').insert({ id: inboundId, tenant_id: tenant, lead_id: lead, role: 'user', conteudo: text }));
  const messages = await checked(s.from('mensagens').select('role,conteudo').eq('lead_id', lead).order('created_at'));
  const sentBefore = sent.length;
  const response = await fetch(`${url}/functions/v1/ai-processor`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  }, body: JSON.stringify({ lead_id: lead, tenant_id: tenant, telefone: phone, etapa_atual: before.etapa_atual,
    text, trigger: 'whatsapp_inbound', history: messages.map((m: any) => ({ role: m.role, content: m.conteudo })), recent_user_messages: [text], inbound_message_ids: [inboundId],
    last_received_at: started, message_count: 1, debug_llm_trace: process.env.DEBUG_LLM_TRACE === 'true' }), signal: AbortSignal.timeout(120000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const after = await checked(s.from('leads').select('*').eq('id', lead).single());
  const events = await checked(s.from('lead_events').select('event_type,payload').eq('lead_id', lead).gte('created_at', started).order('created_at'));
  const stages = events.filter((e: any) => e.event_type === 'test_stage_result').map((e: any) => e.payload);
  return { text, before, after, stages, sent_output_parts: sent.slice(sentBefore), events };
}
async function createLead(index: number, trustedName = true) {
  const id = randomUUID();
  cleanupLeadIds.add(id);
  await checked(s.from('leads').insert({
    id,
    tenant_id: tenant,
    telefone: `${phone}${index}`,
    etapa_atual: 'E1',
    ...(trustedName ? {
      nome: 'João Silva',
      lead_person_name: 'João Silva',
      lead_first_name: 'João',
      lead_name_confidence: 'trusted',
      lead_name_source: 'test',
    } : {}),
    sales_context: { initial_welcome_status: 'completed', initial_greeting_completed_at: new Date().toISOString() },
  }));
  return id;
}
async function createFreshLead(index: number, trustedName = false) {
  const id = randomUUID();
  cleanupLeadIds.add(id);
  await checked(s.from('leads').insert({
    id,
    tenant_id: tenant,
    telefone: `${phone}${index}`,
    etapa_atual: 'E1',
    ...(trustedName ? {
      nome: 'João Silva',
      lead_person_name: 'João Silva',
      lead_first_name: 'João',
      lead_name_confidence: 'trusted',
      lead_name_source: 'test',
    } : {}),
    sales_context: {},
  }));
  return id;
}

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url?.includes('/message/sendText/')) {
    sent.push(body.text);
    sentMeta.push({ number: body.number, telefone: body.telefone, text: body.text });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, key: { id: randomUUID() } }));
});
server.listen(port, '0.0.0.0');
await once(server, 'listening');

try {
  const promptRows = await checked(s.from('agent_definitions').select('*').eq('tenant_id', sourceTenant).in('subagent_key', keys));
  assert.equal(promptRows.length, 8, 'all canonical prompts active');
  for (const key of keys) {
    const row = promptRows.find((r: any) => r.subagent_key === key);
    const prompt = String(row?.config?.prompt_override || row?.config?.default_prompt || '');
    assert.ok(row?.id, `${key} active id`);
    assert.ok(prompt.trim().length > 0, `${key} prompt active`);
  }
  const e1Prompt = String(promptRows.find((r: any) => r.subagent_key === 'E1')?.config?.prompt_override || '');
  const e2Prompt = String(promptRows.find((r: any) => r.subagent_key === 'E2')?.config?.prompt_override || '');
  assert.match(normalize(e1Prompt), /meaningful|momento significativo/);
  assert.match(normalize(e1Prompt), /uma reacao contextual|maximo uma reacao/);
  assert.match(normalize(e2Prompt), /exatamente 3 perguntas/);
  assert.match(normalize(e2Prompt), /lado negativo/);
  assert.match(normalize(e2Prompt), /lado positivo/);
  assert.doesNotMatch(normalize(e2Prompt), /vaccine|vacina/);

  assert.equal(resolveTrustedLeadName({ pushName: 'Helton Barcelos' }).leadNameUsed, false);
  assert.equal(resolveTrustedLeadName({ pushName: 'Psicóloga' }).leadNameUsed, false);
  assert.deepEqual(resolveTrustedLeadName({ pushName: 'João Silva' }).leadFirstName, 'João');
  assert.equal(resolveTrustedLeadName({ existingTrustedName: 'Quero saber mais sobre Biomedicina' }).leadNameUsed, false);
  assert.equal(resolveTrustedLeadName({ explicitName: 'João' }).leadFirstName, 'João');
  for (const rawName of ['Adelino', 'Meu nome é Adelino', 'Me chamo Adelino', 'Sou Adelino']) {
    const resolved = resolveTrustedLeadName({ explicitName: rawName });
    assert.equal(resolved.leadNameUsed, true);
    assert.equal(resolved.leadNameConfidence, 'trusted');
    assert.equal(resolved.leadPersonName, 'Adelino');
    assert.equal(resolved.leadFirstName, 'Adelino');
  }
  assert.equal(resolveTrustedLeadName({ explicitName: 'sou de Candeias' }).leadNameUsed, false);
  assert.equal(buildInitialE1WelcomeMessages({ leadSnapshot: { lead_name_confidence: 'trusted', lead_first_name: 'João' }, timeZone: 'America/Porto_Velho' }).length, 3);
  assert.equal(resolveInitialE1WelcomeMessageCount({ salesContext: {}, firstInboundHasCommercialIntent: false }), 3);
  assert.equal(resolveInitialE1WelcomeMessageCount({ salesContext: {}, firstInboundHasCommercialIntent: true }), 2);

  const beforeMotivation = { curso_interesse: 'FISIOTERAPIA (BACHARELADO)', cidade: 'Porto Velho', sales_context: { course_status: 'confirmed_available', course_display_name: 'Fisioterapia', e1_city_confirmed: true, pending_criterion: 'motivation' } };
  const motivation = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: beforeMotivation, history: [], latestUserMessage: 'Minha família toda é da área, vamos abrir um consultório' });
  assert.equal(motivation.classificationReason, 'resolved_pending_motivation');
  const afterMotivation = { ...beforeMotivation, sales_context: { ...beforeMotivation.sales_context, ...motivation.statePatch } };
  assert.equal(getNextE1Criterion({ leadSnapshot: afterMotivation }), null);
  assert.equal(getNextE2Criterion({ leadSnapshot: afterMotivation }), 'vaccine_availability');
  assert.equal(detectPersonalityOutputViolations({ stage: 'E1', processAction: 'complete_stage', latestUserMessage: 'Minha família toda é da área, vamos abrir um consultório', text: 'Vou verificar algumas informações importantes. Um momento.' }).personality_guard_triggered, true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E2', processAction: 'ask_vaccine_decider', latestUserMessage: 'Até esse momento não tenho', text: 'Legal saber que você não tem viagem ou mudança. Você decide sozinho?' }).personality_violations.includes('operational_answer_overvalidation'), true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E2', processAction: 'ask_vaccine_agreement', latestUserMessage: 'Eu mesmo que decido', text: 'Ótimo que você decide sozinho. Posso te fazer um combinado?' }).personality_violations.includes('agreement_permission_preamble'), true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E2', processAction: 'ask_vaccine_agreement', latestUserMessage: 'Eu mesmo que decido', text: 'Quero te propor um combinado antes de seguir.' }).personality_violations.includes('agreement_permission_preamble'), true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E2', processAction: 'ask_vaccine_agreement', latestUserMessage: 'Eu mesmo que decido', text: 'Agora, quero te fazer um combinado.' }).personality_violations.includes('agreement_permission_preamble'), true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E2', processAction: 'ask_vaccine_agreement', latestUserMessage: 'Eu mesmo que decido', text: 'Se não fizer sentido, você me diz que não ficou legal. Combinado?' }).personality_violations.includes('commercial_agreement_incomplete'), true);
  assert.equal(detectPersonalityOutputViolations({ stage: 'E3', processAction: 'present_e3_structured_blocks', latestUserMessage: 'Ok', text: 'A comunicação comercial pode apresentar claim_key institucional.' }).personality_violations.includes('internal_metadata_leak'), true);
  for (const decisionInput of ['Sou eu mesmo', 'Eu decido', 'Eu que decido', 'Decido sozinho', 'A decisão é minha']) {
    const decision = classifyInboundAgainstStageState({
      stage: 'E2',
      leadSnapshot: { sales_context: { e2_availability_status: 'resolved', e2_vaccine_availability_done: true, pending_criterion: 'vaccine_decider' } },
      history: [{ role: 'assistant', content: 'Você decide por você mesmo ou conversa com alguém?' }],
      latestUserMessage: decisionInput,
    });
    assert.equal(decision.classificationReason, 'resolved_pending_vaccine_2');
    assert.equal(decision.statePatch.e2_decision_participant, 'self');
    assert.equal(decision.statePatch.pending_criterion, 'vaccine_agreement');
  }
  for (const agreementInput of ['Ok', 'Combinado', 'Fechado', 'Pode ser']) {
    const agreement = classifyInboundAgainstStageState({
      stage: 'E2',
      leadSnapshot: { sales_context: { e2_availability_status: 'resolved', e2_vaccine_availability_done: true, e2_decision_maker_status: 'resolved', e2_vaccine_decider_done: true, pending_criterion: 'vaccine_agreement' } },
      history: [{ role: 'assistant', content: 'Se não fizer sentido ou não encaixar no seu bolso, tudo bem. Se fizer sentido e a bolsa ficar boa, seguimos para inscrição. Combinado?' }],
      latestUserMessage: agreementInput,
    });
    assert.equal(agreement.classificationReason, 'resolved_pending_vaccine_3');
    assert.equal(agreement.statePatch.e2_vaccine_agreement_done, true);
    assert.equal(agreement.statePatch.pending_criterion, null);
  }
  const combinedAgreement = classifyInboundAgainstStageState({
    stage: 'E2',
    leadSnapshot: { sales_context: { e2_availability_status: 'resolved', e2_vaccine_availability_done: true, e2_decision_maker_status: 'resolved', e2_vaccine_decider_done: true, pending_criterion: 'vaccine_agreement' } },
    history: [{ role: 'assistant', content: 'Se não fizer sentido ou não encaixar no seu bolso, tudo bem. Se fizer sentido e a bolsa ficar boa, seguimos para inscrição. Combinado?' }],
    latestUserMessage: 'Vai depender do valor, mas combinado',
  });
  assert.equal(combinedAgreement.classificationReason, 'conditional_price_pending_confirmation');
  assert.equal(combinedAgreement.statePatch.e2_price_condition, true);
  assert.equal(combinedAgreement.statePatch.e2_vaccine_agreement_done, false);

  const original = await checked(s.from('tenants').select('config').eq('id', sourceTenant).single());
  await checked(s.from('tenants').insert({ id: tenant, name: 'Canonical commercial flow', slug: `canonical-${tenant}`, config: { ...original.config, evolution_api_url: `http://127.0.0.1:${port}`, evolution_api_key: 'isolated-test', evolution_instance_name: 'isolated-canonical', admin_phone: adminPhone, adminPhone } }));
  await checked(s.from('agent_definitions').insert(promptRows.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant }))));
  const sources = await checked(s.from('course_catalog_sources').select('*').eq('tenant_id', sourceTenant));
  const sourceIds = new Map(sources.map((r: any) => [r.id, randomUUID()]));
  await checked(s.from('course_catalog_sources').insert(sources.map((r: any) => ({ ...r, id: sourceIds.get(r.id), tenant_id: tenant }))));
  const entries = await checked(s.from('course_catalog_entries').select('*').eq('tenant_id', sourceTenant));
  await checked(s.from('course_catalog_entries').insert(entries.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant, source_id: sourceIds.get(r.source_id) || null }))));

  const canonicalLead = await createFreshLead(1000, false);
  const turn1Opening = await runTurn('Olá', canonicalLead);
  assert.ok(turn1Opening.sent_output_parts.length >= 1);

  const turn2NameGate = await runTurn('Quero saber mais sobre Ciências Contábeis', canonicalLead);
  assert.match(normalize(turn2NameGate.sent_output_parts.join('\n')), /confirma.*nome|nome|como posso te chamar/);
  assert.equal(turn2NameGate.after.sales_context.pending_pre_name_input, 'Quero saber mais sobre Ciências Contábeis');
  assert.notEqual(turn2NameGate.after.sales_context.course_status, 'confirmed_available');

  const turn3RecoveredIntent = await runTurn('Karen', canonicalLead);
  assert.equal(turn3RecoveredIntent.after.lead_name_confidence, 'trusted');
  assert.equal(turn3RecoveredIntent.after.lead_first_name, 'Karen');
  assert.equal(turn3RecoveredIntent.after.sales_context.pending_pre_name_input, null);
  assert.equal(turn3RecoveredIntent.after.sales_context.course_status, 'confirmed_available');
  assert.match(normalize(turn3RecoveredIntent.after.curso_interesse || turn3RecoveredIntent.after.sales_context.course_display_name), /ciencias contabeis/);
  assert.equal(turn3RecoveredIntent.after.sales_context.pending_criterion, 'city');
  const recoveredCourseLookups = turn3RecoveredIntent.events.filter((e: any) => e.event_type === 'test_e1_course_preflight_lookup');
  assert.equal(recoveredCourseLookups.length, 1);
  assert.match(normalize(recoveredCourseLookups[0]?.payload?.query), /ciencias contabeis/);
  assert.equal(recoveredCourseLookups[0]?.payload?.match_status, 'found');

  const courseAfterRecovery = turn3RecoveredIntent.after.curso_interesse;
  const statusAfterRecovery = turn3RecoveredIntent.after.sales_context.course_status;
  const turn4City = await runTurn('Sou de Buritis', canonicalLead);
  assert.equal(turn4City.after.curso_interesse, courseAfterRecovery);
  assert.equal(turn4City.after.sales_context.course_status, statusAfterRecovery);
  assert.equal(turn4City.after.sales_context.e1_city_confirmed, true);
  assert.equal(turn4City.after.sales_context.pending_criterion, 'motivation');
  assert.equal(turn4City.events.filter((e: any) => e.event_type === 'test_e1_course_preflight_lookup').length, 0);
  assert.doesNotMatch(normalize(turn4City.sent_output_parts.join('\n')), /nao temos|nao esta disponivel|alternativas|juridico|publico|gestao|negocios/);

  const turn5PartialMotivation = await runTurn('Não trabalho', canonicalLead);
  assert.equal(turn5PartialMotivation.after.curso_interesse, courseAfterRecovery);
  assert.equal(turn5PartialMotivation.after.sales_context.course_status, statusAfterRecovery);
  assert.equal(turn5PartialMotivation.after.sales_context.e1_works_in_area, false);
  assert.equal(turn5PartialMotivation.after.sales_context.pending_criterion, 'motivation');
  assert.equal(turn5PartialMotivation.events.filter((e: any) => e.event_type === 'test_e1_course_preflight_lookup').length, 0);
  assert.doesNotMatch(normalize(turn5PartialMotivation.sent_output_parts.join('\n')), /nao temos|nao esta disponivel|alternativas|juridico|publico|gestao|negocios/);
  assert.match(normalize(turn5PartialMotivation.sent_output_parts.join('\n')), /sonho|objetivo|motiva|vontade|escolh/);

  const turn6Motivation = await runTurn('Sempre quis fazer essa graduação', canonicalLead);
  assert.equal(turn6Motivation.after.etapa_atual, 'E2');
  assert.equal(turn6Motivation.after.sales_context.pending_criterion, 'vaccine_availability');
  assert.equal(turn6Motivation.sent_output_parts.length, 2);
  assert.doesNotMatch(normalize(turn6Motivation.sent_output_parts[0]), /viagem|mudanca/);
  assert.match(normalize(turn6Motivation.sent_output_parts[1]), /viagem|mudanca/);

  const turn7Travel = await runTurn('Até o momento não tenho', canonicalLead);
  assert.equal(turn7Travel.after.sales_context.pending_criterion, 'vaccine_decider');
  assert.doesNotMatch(normalize(turn7Travel.sent_output_parts.join('\n')), /que bom|legal saber|otimo/);

  const turn8Decision = await runTurn('Só eu mesmo', canonicalLead);
  assert.equal(turn8Decision.after.sales_context.pending_criterion, 'vaccine_agreement');
  assert.doesNotMatch(normalize(turn8Decision.sent_output_parts.join('\n')), /decide sozinho|perfeito|otimo|legal saber|que legal|show|maravilha|quero te fazer um combinado|quero te propor um combinado|posso te fazer um combinado|vamos ao combinado/);
  assert.match(normalize(turn8Decision.sent_output_parts.join('\n')), /nao fizer sentido|nao faz sentido|nao encaixar|nao ficou legal/);
  assert.match(normalize(turn8Decision.sent_output_parts.join('\n')), /combinado/);

  const turn9E3 = await runTurn('Ok', canonicalLead);
  assert.equal(turn9E3.after.etapa_atual, 'E3');
  assert.equal(turn9E3.after.sales_context.e2_vaccine_agreement_done, true);
  assert.equal(turn9E3.after.sales_context.pending_criterion, 'interest_signal');
  const turn9E3Stage = turn9E3.stages.find((stage: any) => stage.stage === 'E3');
  assert.equal(turn9E3Stage?.process_action, 'present_e3_structured_blocks');
  assert.equal(turn9E3Stage?.deterministic_reply_used, false);
  assert.equal(turn9E3Stage?.fallback_used, false);
  assert.equal(turn9E3.sent_output_parts.length, 4);
  assert.doesNotMatch(normalize(turn9E3.sent_output_parts.join('\n')), /comunicacao comercial pode|o agente pode|metadata|claim_key|instrucao interna|regra de comunicacao/);

  const explicitChangeLead = await createLead(1001, true);
  await checked(s.from('leads').update({
    curso_interesse: 'Ciências Contábeis',
    cidade: 'Buritis',
    sales_context: {
      course_display_name: 'Ciências Contábeis',
      course_validated: true,
      course_status: 'confirmed_available',
      e1_city_confirmed: true,
      pending_criterion: 'motivation',
    },
  }).eq('id', explicitChangeLead));
  const explicitChange = await runTurn('Na verdade quero saber sobre Administração', explicitChangeLead);
  assert.match(normalize(explicitChange.after.curso_interesse || explicitChange.after.sales_context.course_display_name), /administracao/);
  assert.equal(explicitChange.after.sales_context.course_status, 'confirmed_available');
  assert.ok(['city', 'motivation'].includes(String(explicitChange.after.sales_context.pending_criterion || '')));
  assert.equal(explicitChange.events.filter((e: any) => e.event_type === 'test_e1_course_preflight_lookup').length, 1);

  const adminLead = await createLead(1002, true);
  const adminBefore = sentMeta.filter((item) => normalize(item.text).includes('lead perguntou valor antes')).length;
  const firstPrice = await runTurn('Quanto custa?', adminLead);
  const adminAfterFirst = sentMeta.filter((item) => normalize(item.text).includes('lead perguntou valor antes')).length;
  assert.equal(adminAfterFirst, adminBefore);
  assert.equal(firstPrice.after.sales_context.pre_proposal_price_ask_count, 1);
  assert.equal(firstPrice.events.find((e: any) => e.event_type === 'test_pre_proposal_price_ask')?.payload?.admin_notified, false);
  const secondPrice = await runTurn('Mas qual é o valor?', adminLead);
  assert.equal(secondPrice.events.find((e: any) => e.event_type === 'test_pre_proposal_price_ask')?.payload?.admin_notified, true);
  assert.equal(secondPrice.after.sales_context.pre_proposal_price_admin_notified, true);
  const thirdPrice = await runTurn('Me fala logo o valor', adminLead);
  assert.equal(thirdPrice.events.find((e: any) => e.event_type === 'test_pre_proposal_price_ask')?.payload?.admin_notified, false);

  const nameGateLead = await createLead(900, false);
  const nameGateBlocked = await runTurn('Quero saber sobre Terapia Ocupacional', nameGateLead);
  assert.match(normalize(nameGateBlocked.sent_output_parts.join('\n')), /confirma.*nome|nome|como posso te chamar/);
  assert.equal(nameGateBlocked.after.sales_context.pending_pre_name_input, 'Quero saber sobre Terapia Ocupacional');
  assert.notEqual(nameGateBlocked.after.sales_context.course_status, 'confirmed_available');
  assert.doesNotMatch(normalize(nameGateBlocked.sent_output_parts.join('\n')), /cidade/);
  const nameGateRecovered = await runTurn('Me chamo Adelino', nameGateLead);
  assert.equal(nameGateRecovered.after.lead_name_confidence, 'trusted');
  assert.equal(nameGateRecovered.after.lead_person_name, 'Adelino');
  assert.equal(nameGateRecovered.after.lead_first_name, 'Adelino');
  assert.equal(nameGateRecovered.after.sales_context.pending_pre_name_input, null);
  assert.equal(nameGateRecovered.after.sales_context.course_status, 'confirmed_available');
  assert.match(normalize(nameGateRecovered.sent_output_parts.join('\n')), /cidade/);
  const nameGateReloaded = await checked(s.from('leads').select('nome, lead_person_name, lead_first_name, lead_name_confidence, lead_name_source, sales_context').eq('id', nameGateLead).single());
  assert.equal(nameGateReloaded.lead_name_confidence, 'trusted');
  assert.equal(nameGateReloaded.lead_person_name, 'Adelino');
  assert.equal(nameGateReloaded.lead_first_name, 'Adelino');
  assert.equal(nameGateReloaded.lead_name_source, 'explicit_name_gate');
  assert.equal(nameGateReloaded.sales_context.pending_pre_name_input, null);
  const nameGateCity = await runTurn('Ariquemes', nameGateLead);
  assert.doesNotMatch(normalize(nameGateCity.sent_output_parts.join('\n')), /confirma.*nome|qual.*nome|seu nome|nome completo|me.*nome/);
  assert.match(normalize(nameGateCity.after.cidade), /ariquemes/);
  assert.equal(nameGateCity.after.sales_context.e1_city_confirmed, true);
  assert.equal(nameGateCity.after.sales_context.pending_criterion, 'motivation');
  assert.match(normalize(nameGateCity.sent_output_parts.join('\n')), /trabalha|sonho|objetivo|motivo|escolheu|terapia ocupacional/);

  if (process.env.AGENTHUB_NAME_GATE_ONLY === 'true') {
    console.log(JSON.stringify({ NAME_GATE_ADELINO_TERAPIA_OCUPACIONAL: 'PASS', trusted_name_after_reload: nameGateReloaded.lead_first_name, city: nameGateCity.after.cidade }));
  } else {
    let multigenPass = 0;
    for (let i = 0; i < 3; i += 1) {
    const lead = await createLead(i);
    const turns = [] as any[];
    for (const input of ['Quero saber sobre Fisioterapia', 'Porto Velho', 'Minha família toda é da área, vamos abrir um consultório', 'Até esse momento não tenho', 'Eu mesmo que decido', 'Ok']) {
      const turn = await runTurn(input, lead);
      turns.push(turn);
      console.log(JSON.stringify({ run: i + 1, input, stage: turn.after.etapa_atual, pending: turn.after.sales_context?.pending_criterion, parts: turn.sent_output_parts.length, outputs: turn.sent_output_parts, stages: turn.stages.map((r: any) => ({ stage: r.stage, action: r.process_action, deterministic: r.deterministic_reply_used, fallback: r.fallback_used })) }));
      for (const stage of turn.stages) {
        if (stage.stage !== 'E3' && stage.process_action !== 'complete_stage' && !(stage.stage === 'E1' && stage.process_action === 'ask_motivation')) {
          assert.equal(stage.deterministic_reply_used, false);
          assert.equal(stage.fallback_used, false);
        }
        if (stage.stage !== 'E3' && stage.process_action !== 'complete_stage') {
          assert.ok(stage.personality_prompt_id, 'PERSONALITY_LOADED=false');
          assert.ok(stage.stage_prompt_id, `${stage.stage}_PROMPT_LOADED=false`);
        }
      }
    }
    const [courseTurn, cityTurn, motivationTurn, travelNegativeTurn, decisionAloneTurn, agreementOkTurn] = turns;
    const courseText = courseTurn.sent_output_parts.join('\n');
    assert.equal(courseTurn.after.sales_context.course_status, 'confirmed_available');
    assert.match(normalize(courseText), /escolh|excelente|decisao/);
    assert.match(normalize(courseText), /oportunidade|area/);
    assert.match(normalize(courseText), /cidade/);
    assert.doesNotMatch(normalize(courseText), /disponivel|ofertad|temos esse curso|catalogo|se interessou|entender melhor|me informe/);

    assert.equal(cityTurn.after.sales_context.pending_criterion, 'motivation');
    assert.doesNotMatch(normalize(cityTurn.sent_output_parts.join('\n')), /excelente escolha/);
    assert.match(normalize(cityTurn.sent_output_parts.join('\n')), /trabalha|sonho|objetivo/);

    assert.equal(motivationTurn.after.etapa_atual, 'E2');
    assert.equal(motivationTurn.sent_output_parts.length, 2);
    assert.match(normalize(motivationTurn.sent_output_parts[0]), /excelente|perfeito|legal|incrivel|maravilha/);
    assert.doesNotMatch(normalize(motivationTurn.sent_output_parts[0]), /viagem|mudanca|vacina|vacinas|covid|vou verificar|aguarde|um momento/);
    assert.match(normalize(motivationTurn.sent_output_parts[1]), /viagem|mudanca/);
    assert.doesNotMatch(normalize(motivationTurn.sent_output_parts[1]), /familia|consultorio|objetivo/);
    assertNoProcessNarration(motivationTurn.sent_output_parts.join('\n'));

    const travelNegativeText = travelNegativeTurn.sent_output_parts.join('\n');
    assert.equal(travelNegativeTurn.after.sales_context.pending_criterion, 'vaccine_decider');
    assert.match(normalize(travelNegativeText), /decid|alguem|participa|sozinh/);
    assert.doesNotMatch(normalize(travelNegativeText), /viagem|viajar|mudanca|mudar|programada|planejada|vacina|vacinas|covid/);
    assertNoProcessNarration(travelNegativeText);

    const agreementText = decisionAloneTurn.sent_output_parts.join('\n');
    assert.equal(decisionAloneTurn.after.sales_context.pending_criterion, 'vaccine_agreement');
    assert.doesNotMatch(normalize(agreementText), /decide sozinho|decide por conta propria|otimo que voce decide|posso te fazer um combinado|podemos fazer um combinado|quero te fazer um combinado|quero te propor um combinado|posso seguir|posso te apresentar|vamos ao combinado|combinado comercial|agora que temos essas informacoes|para podermos avancar/);
    assert.match(normalize(agreementText), /nao faz sentido|nao fizer sentido|nao encaixar no.*(?:bolso|orcamento)|nao ficou legal/);
    assert.match(normalize(agreementText), /sem problema|continuamos amigos|tudo bem/);
    assert.match(normalize(agreementText), /se fizer sentido|encaixar no.*bolso|inscricao/);
    assert.match(normalize(agreementText), /combinado/);
    assert.doesNotMatch(normalize(agreementText), /disponivel|ofertad|temos esse curso|catalogo/);
    assert.equal(realQuestionCount(agreementText), 1);
    assertNoProcessNarration(agreementText);
    const e2Questions = [
      /viagem|mudanca/.test(normalize(motivationTurn.sent_output_parts[1])) ? 1 : 0,
      /decid|alguem|participa|sozinh/.test(normalize(travelNegativeText)) ? 1 : 0,
      /combinado/.test(normalize(agreementText)) ? 1 : 0,
    ].reduce((sum, value) => sum + value, 0);
    assert.equal(e2Questions, 3);
    assert.equal(agreementOkTurn.after.etapa_atual, 'E3');
    assert.equal(agreementOkTurn.after.sales_context.e2_vaccine_agreement_done, true);
    assert.doesNotMatch(normalize(agreementOkTurn.sent_output_parts.join('\n')), /posso te fazer um combinado|podemos fazer um combinado/);
    const e3Stage = agreementOkTurn.stages.find((stage: any) => stage.stage === 'E3');
    assert.equal(e3Stage?.process_action, 'present_e3_structured_blocks');
    assert.equal(e3Stage?.deterministic_reply_used, false);
    assert.equal(e3Stage?.fallback_used, false);
    const e3Parts = agreementOkTurn.sent_output_parts.slice(-4);
    assert.equal(e3Parts.length, 4);
    assert.doesNotMatch(normalize(e3Parts.join('\n')), /comunicacao comercial pode|o agente pode|metadata|claim_key|instrucao interna|regra de comunicacao/);
    assert.match(normalize(e3Parts[0]), /instituicao|faculdade|unesc|credenciada|mec|diploma|diferencial/);
    assert.match(normalize(e3Parts[1]), /fisioterapia|bacharelado|modalidade|curso|metodologia|aula/);
    assert.match(normalize(e3Parts[2]), /tutor|suporte|acompanhamento|apoio/);
    assert.match(normalize(e3Parts[3]), /chamou.*atencao|fez sentido|mais gostou|mais sentido/);
      multigenPass += 1;
    }

    console.log(JSON.stringify({ CANONICAL_E1_E2: 'PASS', MULTIGEN: `${multigenPass}/3`, deterministic_normal_flow: false, fallback_normal_flow: false }));
  }
} finally {
  for (const currentLeadId of cleanupLeadIds) {
    for (const table of ['followup_schedule', 'lead_events', 'mensagens']) await s.from(table).delete().eq('lead_id', currentLeadId);
  }
  for (const table of ['leads', 'agent_definitions', 'course_catalog_entries', 'course_catalog_sources']) await s.from(table).delete().eq('tenant_id', tenant);
  await s.from('tenants').delete().eq('id', tenant);
  server.close();
  await once(server, 'close');
}
