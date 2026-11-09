// One real-model E1 -> E2 run. Isolated tenant; only Evolution delivery is captured.
// Run: node --env-file=.env.local --experimental-strip-types scripts/test-e1-four-regressions.ts
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getNextE1Criterion, getNextE2Criterion } from '../supabase/functions/ai-processor/stage-state.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):/);
const s = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sourceTenant = '00000000-0000-0000-0000-000000000001';
const tenant = randomUUID(), leadId = randomUUID();
const cleanupLeadIds = new Set<string>([leadId]);
const phone = '+5500090800001';
const port = 18082;
const sent: string[] = [];
const report: any = { tenant, leadId, model: null, turns: [], passed: false };
async function checked(query: any) { const r = await query; if (r.error) throw Error(JSON.stringify(r.error)); return r.data; }
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url?.includes('/message/sendText/')) sent.push(body.text);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, key: { id: randomUUID() } }));
});
server.listen(port, '0.0.0.0');
await once(server, 'listening');
try {
  const original = await checked(s.from('tenants').select('config').eq('id', sourceTenant).single());
  report.model = original.config.modelo_ia;
  await checked(s.from('tenants').insert({ id: tenant, name: 'E1 focused regression', slug: `e1-regression-${tenant}`, config: {
    ...original.config, evolution_api_url: `http://127.0.0.1:${port}`, evolution_api_key: 'isolated-test', evolution_instance_name: 'isolated-e1',
  } }));
  const prompts = await checked(s.from('agent_definitions').select('*').eq('tenant_id', sourceTenant).in('subagent_key', ['PERSONALITY', 'E1', 'E2']));
  await checked(s.from('agent_definitions').insert(prompts.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant }))));
  const sources = await checked(s.from('course_catalog_sources').select('*').eq('tenant_id', sourceTenant));
  const sourceIds = new Map(sources.map((r: any) => [r.id, randomUUID()]));
  await checked(s.from('course_catalog_sources').insert(sources.map((r: any) => ({ ...r, id: sourceIds.get(r.id), tenant_id: tenant }))));
  const entries = await checked(s.from('course_catalog_entries').select('*').eq('tenant_id', sourceTenant));
  await checked(s.from('course_catalog_entries').insert(entries.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant, source_id: sourceIds.get(r.source_id) || null }))));
  if (!entries.some((r: any) => String(r.normalized_canonical_name || '').includes('administracao'))) {
    const template = entries.find((r: any) => String(r.normalized_canonical_name || '').includes('farmacia')) || entries[0];
    await checked(s.from('course_catalog_entries').insert({
      ...template,
      id: randomUUID(),
      tenant_id: tenant,
      source_id: sourceIds.get(template.source_id) || null,
      source_key: 'cursos_area_negocios',
      catalog_group: 'area_negocios',
      area_slug: 'negocios',
      area_name: 'Negocios',
      canonical_name: 'Administra\u00e7\u00e3o',
      display_name: 'ADMINISTRA\u00c7\u00c3O (BACHARELADO)',
      normalized_canonical_name: 'administracao',
      normalized_display_name: 'administracao bacharelado',
      normalized_search_text: 'administracao bacharelado administracao negocios gestao empresas bacharelado semipresencial',
      degree_level: 'bacharelado',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
  }
  await checked(s.from('leads').insert({ id: leadId, tenant_id: tenant, telefone: phone, etapa_atual: 'E1', sales_context: { initial_welcome_status: 'completed', initial_greeting_completed_at: new Date().toISOString() } }));
  const inputs = ['Quero saber sobre Administra\u00e7\u00e3o', 'Karen', 'Buritis', 'Eu sempre quis fazer mesmo'];
  for (const [index, text] of inputs.entries()) {
    const before = await checked(s.from('leads').select('*').eq('id', leadId).single());
    const inboundId = randomUUID();
    const started = new Date().toISOString();
    await checked(s.from('mensagens').insert({ id: inboundId, tenant_id: tenant, lead_id: leadId, role: 'user', conteudo: text }));
    const messages = await checked(s.from('mensagens').select('role,conteudo').eq('lead_id', leadId).order('created_at'));
    const sentBefore = sent.length;
    const response = await fetch(`${url}/functions/v1/ai-processor`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    }, body: JSON.stringify({ lead_id: leadId, tenant_id: tenant, telefone: phone, etapa_atual: before.etapa_atual,
      text, trigger: 'whatsapp_inbound', history: messages.map((m: any) => ({ role: m.role, content: m.conteudo })), recent_user_messages: [text], inbound_message_ids: [inboundId],
      last_received_at: started, message_count: 1 }), signal: AbortSignal.timeout(120000) });
    const responseBody = await response.text();
    const after = await checked(s.from('leads').select('*').eq('id', leadId).single());
    const events = await checked(s.from('lead_events').select('event_type,payload').eq('lead_id', leadId).gte('created_at', started).order('created_at'));
    const stages = events.filter((e: any) => e.event_type === 'test_stage_result').map((e: any) => e.payload);
    const transition = events.find((e: any) => e.event_type === 'test_e1_transition_snapshot')?.payload;
    const result = { turn: index + 1, input: text, state_before: { stage: before.etapa_atual, city: before.cidade, ...before.sales_context },
      inbound_resolution: transition?.inbound_resolution || events.find((e: any) => e.event_type === 'test_stage_state_classification')?.payload,
      state_after: { stage: after.etapa_atual, city: after.cidade, lead_name_confidence: after.lead_name_confidence, lead_first_name: after.lead_first_name, lead_person_name: after.lead_person_name, ...after.sales_context },
      getNextE1Criterion: getNextE1Criterion({ leadSnapshot: after }), getNextE2Criterion: getNextE2Criterion({ leadSnapshot: after }),
      handoff_called: events.some((e: any) => e.event_type === 'test_stage_transition' && e.payload.to_stage === 'E2'),
      stage_results: stages, events, sent_output_parts: sent.slice(sentBefore), http_status: response.status, response: responseBody };
    report.turns.push(result);
    console.log(JSON.stringify({ turn: index + 1, status: response.status, stage: after.etapa_atual, pending: after.sales_context.pending_criterion,
      outputs: result.sent_output_parts, stages: stages.map((r: any) => ({ stage: r.stage, action: r.process_action, origin: r.response_origin, deterministic: r.deterministic_reply_used, fallback: r.fallback_used })),
      motivation_resolved: result.state_after.motivacao_principal || null, resolved_this_turn: stages.at(-2)?.speakable_facts?.resolved_this_turn || stages.at(-1)?.speakable_facts?.resolved_this_turn || null,
      getNextE1Criterion: result.getNextE1Criterion, handoff_called: result.handoff_called, stage_after_handoff: after.etapa_atual, getNextE2Criterion: result.getNextE2Criterion, sent_output_parts: result.sent_output_parts }));
    assert.equal(response.status, 200, responseBody);
    assert.ok(result.sent_output_parts.length, 'No captured delivery');
    if (index !== 0) assert.ok(stages.length, 'Missing real runtime telemetry');
    for (const stage of stages) {
      if (!(stage.stage === 'E1' && ['ask_motivation', 'complete_stage'].includes(stage.process_action))) assert.equal(stage.deterministic_reply_used, false);
      assert.equal(stage.fallback_used, false);
      assert.ok(stage.personality_prompt_id, 'PERSONALITY_LOADED=false');
      assert.ok(stage.stage_prompt_id, `${stage.stage || 'stage'}_PROMPT_LOADED=false`);
      assert.ok(stage.raw_model_output, 'RAW_MODEL_OUTPUT missing');
    }
  }
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const [nameGate, first, second, third] = report.turns;
  assert.match(normalize(nameGate.sent_output_parts.join('\n')), /antes.*te passar.*como posso te chamar|nome/);
  assert.equal(nameGate.state_after.pending_pre_name_input, 'Quero saber sobre Administração');
  assert.equal(nameGate.stage_results.length, 0);
  assert.notEqual(nameGate.state_after.course_status, 'confirmed_available');
  assert.doesNotMatch(normalize(nameGate.sent_output_parts.join('\n')), /excelente escolha|parabens|parabéns|cidade|disponivel|disponível|temos esse curso|temos essa graduacao/);
  assert.equal(nameGate.events?.filter?.((e: any) => e.event_type === 'test_e1_course_preflight_lookup')?.length || 0, 0);
  assert.equal(first.state_after.lead_name_confidence, 'trusted');
  assert.equal(first.state_after.lead_first_name, 'Karen');
  assert.equal(first.state_after.pending_pre_name_input, null);
  assert.equal(first.events?.filter?.((e: any) => e.event_type === 'test_e1_course_preflight_lookup')?.length || 0, 1);
  assert.equal(first.stage_results[0].speakable_facts.resolved_this_turn, 'course');
  assert.equal(second.stage_results[0].speakable_facts.resolved_this_turn, 'city');
  assert.equal(third.stage_results[0].speakable_facts.resolved_this_turn, 'motivation');
  assert.equal(first.stage_results[0].speakable_facts.moment_type, 'meaningful');
  assert.equal(second.stage_results[0].speakable_facts.moment_type, 'operational');
  assert.equal(third.stage_results[0].speakable_facts.moment_type, 'meaningful');
  const firstText = first.sent_output_parts.join('\n');
  const firstSpeakableFacts = JSON.stringify(first.stage_results[0].speakable_facts || {});
  assert.equal(first.state_after.course_status, 'confirmed_available');
  assert.equal(first.stage_results[0].process_action, 'ask_city');
  assert.equal(/availability|offered|available|found=true|confirmed_available|course_available|course_offered/i.test(firstSpeakableFacts), false);
  assert.match(firstText, /Administra/i);
  assert.match(normalize(firstText), /administracao|escolha|graduacao/);
    assert.match(normalize(firstText), /cidade|de onde/);
  assert.doesNotMatch(normalize(firstText), /disponibilidade|disponivel|disponível|ofertad|temos esse curso|temos esta graduacao|temos essa graduacao|opcao ofertada|opção ofertada|existe no catalogo|existe no catálogo|oferecemos/);
  assert.equal(first.state_after.pending_criterion, 'city');
  assert.equal(second.state_after.e1_city_confirmed, true);
  assert.equal(second.state_after.pending_criterion, 'motivation');
  assert.doesNotMatch(normalize(second.sent_output_parts.join('\\n')), /helton/);
  assert.match(normalize(second.sent_output_parts.join('\n')), /trabalha|sonho|objetivo/);
  assert.equal(third.getNextE1Criterion, null);
  assert.match(normalize(third.state_after.motivacao_principal || ''), /sempre quis|quis fazer/);
  assert.match(normalize(third.stage_results[0].speakable_facts.motivation_principal || ''), /sempre quis|quis fazer/);
  assert.equal(third.state_after.stage, 'E2');
  assert.equal(third.handoff_called, true);
  assert.equal(third.getNextE2Criterion, 'vaccine_availability');
  assert.deepEqual(third.stage_results.map((r: any) => r.stage), ['E1', 'E2']);
  assert.equal(third.sent_output_parts.length, 2, 'E1 reaction and E2 question must both be delivered with no technical third part');
  assert.match(normalize(third.sent_output_parts[0] || ''), /^(excelente|que legal|muito bom|perfeito)!!$/);
  assert.ok((third.sent_output_parts[0] || '').trim().length <= 25);
  assert.doesNotMatch(normalize(third.sent_output_parts[1] || ''), /^(entendi|agora|certo|ok)/);
  assert.doesNotMatch(normalize(third.sent_output_parts.join('\n')), /vou verificar|vou consultar|vou checar|vou buscar informacoes|aguarde|um momento|estou analisando|ja trabalha na area|sonho ou objetivo|representa um sonho|so para concluir|para concluir|agora falta apenas/);
  assert.doesNotMatch(third.sent_output_parts[0] || '', /\?/);
  assert.doesNotMatch(normalize(third.sent_output_parts[0] || ''), /documentacao|matricula|processo|proxima etapa|proximo passo|\be2\b|etapa e2|subagente e2/);
  const thirdE1Text = normalize(third.sent_output_parts[0] || '');
  assert.doesNotMatch(thirdE1Text, /viagem|viajar|mudanca|mudar|proximos meses|interferir no inicio|disponibilidade futura/);
  assert.match(normalize(third.sent_output_parts.at(-1)), /viagem|viajar|mudanca|mudar/);
  assert.doesNotMatch(normalize(sent.join('\n')), /vou verificar|vou consultar|vou checar|vou buscar informacoes|aguarde|um momento|estou analisando|proxima etapa|vamos seguir|vamos avancar|para continuarmos|etapa concluida/);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await mkdir('reports', { recursive: true });
  await writeFile('reports/e1-four-regressions.json', JSON.stringify(report, null, 2) + '\n');
  // Remove only rows owned by this run. Never change the real tenant or queues.
  for (const currentLeadId of cleanupLeadIds) {
    for (const table of ['followup_schedule', 'lead_events', 'mensagens']) {
      const { error } = await s.from(table).delete().eq('lead_id', currentLeadId);
      if (error) console.error('Cleanup', table, error.message);
    }
  }
  for (const table of ['leads', 'agent_definitions', 'course_catalog_entries', 'course_catalog_sources']) {
    const { error } = await s.from(table).delete().eq('tenant_id', tenant);
    if (error) console.error('Cleanup', table, error.message);
  }
  const { error } = await s.from('tenants').delete().eq('id', tenant);
  if (error) console.error('Cleanup tenant', error.message);
  server.close();
  await once(server, 'close');
}
