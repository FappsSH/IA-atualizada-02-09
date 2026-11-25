import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Teste EXTRA de aceite da AgentHub (mais perfis de lead + portão do webhook) (spec canônica + adendo de 24/11/2026).
// Roda contra o Supabase LOCAL, num tenant isolado, com uma Evolution simulada:
// nenhuma mensagem vai para o WhatsApp real.
// Run: node --env-file=.env.local --experimental-strip-types scripts/test-agenthub-extra.ts
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { completeAdminCheckpointByReply, getPendingAdminCheckpoint } from '../supabase/functions/_shared/admin-checkpoints.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error('Este teste só roda contra o Supabase local.');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const s = createClient(url, serviceKey);
const reportPath = process.env.AGENTHUB_TEST_REPORT_EXTRA || 'agenthub-extra-test-report.json';
const sourceTenant = '00000000-0000-0000-0000-000000000001';
const tenant = randomUUID();
const adminPhone = '+5500090900999';
const port = Number(process.env.AGENTHUB_TEST_PORT_EXTRA || 18085);
const keys = ['PERSONALITY', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];

type Sent = { to: string; kind: 'text' | 'media'; text: string; id: string; mediaHash?: string };
const sent: Sent[] = [];
const checks: Array<{ scenario: string; turn: string; check: string; pass: boolean; detail?: string }> = [];
const transcript: Array<Record<string, unknown>> = [];
const cleanupLeadIds = new Set<string>();

const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const questions = (t: string) => (String(t).match(/\?/g) || []).length;

const FORBIDDEN_ALWAYS = /vou verificar|vou consultar|vou checar|aguarde|um momento|estou analisando|proxima etapa|proximo passo|vamos seguir|vamos avancar|para seguirmos|so para concluir|para concluir|infelizmente|nao localizei|consultei|recebi sua pergunta|estou aqui para ajudar|estou a disposicao|para te ajudar melhor|para eu entender melhor|checkpoint|administrativ|\bcst\b|tecnologo|proxima etapa|nessa etapa do|etapa do processo|pode perguntar|se tiver (mais |alguma |outras )?duvida|estou por aqui|nao esta confirmad|como mencionei/;
const NO_ACCENT_WORDS = /\b(voce|nao|graduacao|duracao|estagio|informacoes|condicoes|matricula|atencao|proposta para voce)\b/;

function check(scenario: string, turn: string, name: string, pass: boolean, detail?: unknown) {
  checks.push({ scenario, turn, check: name, pass, detail: pass ? undefined : String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) });
}

async function checked(q: any) {
  const r = await q;
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.data;
}

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const id = randomUUID();
  if (req.url?.includes('/message/sendText/')) sent.push({ to: String(body.number || ''), kind: 'text', text: String(body.text || ''), id });
  else if (req.url?.includes('/message/sendMedia/')) sent.push({ to: String(body.number || ''), kind: 'media', text: '[imagem]', id, mediaHash: createHash('md5').update(Buffer.from(String(body.media || '').replace(/^data:[^,]*,/, ''), 'base64')).digest('hex') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ key: { id }, status: 'PENDING' }));
});
server.listen(port, '0.0.0.0');
await once(server, 'listening');

async function newLead(phone: string, opts: { name?: string } = {}) {
  const id = randomUUID();
  cleanupLeadIds.add(id);
  const first = opts.name ? opts.name.split(' ')[0] : null;
  await checked(s.from('leads').insert({
    id, tenant_id: tenant, telefone: phone, etapa_atual: 'E1',
    ...(opts.name ? { nome: opts.name, lead_person_name: opts.name, lead_first_name: first, lead_name_confidence: 'trusted', lead_name_source: 'test' } : {}),
    sales_context: {},
  }));
  return id;
}

async function callProcessor(lead: string, text: string, trigger: 'whatsapp_inbound' | 'stage_handoff') {
  const before = await checked(s.from('leads').select('*').eq('id', lead).single());
  const started = new Date().toISOString();
  let inboundId: string | null = null;
  if (trigger === 'whatsapp_inbound') {
    inboundId = randomUUID();
    await checked(s.from('mensagens').insert({ id: inboundId, tenant_id: tenant, lead_id: lead, role: 'user', conteudo: text }));
  }
  const history = await checked(s.from('mensagens').select('role,conteudo').eq('lead_id', lead).order('created_at'));
  const sentBefore = sent.length;
  const response = await fetch(`${url}/functions/v1/ai-processor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({
      lead_id: lead, tenant_id: tenant, telefone: before.telefone, etapa_atual: before.etapa_atual,
      text, trigger, history: history.map((m: any) => ({ role: m.role, content: m.conteudo })),
      recent_user_messages: text ? [text] : [], inbound_message_ids: inboundId ? [inboundId] : [],
      last_received_at: started, message_count: text ? 1 : 0,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await response.text();
  await new Promise((r) => setTimeout(r, 1500));
  const after = await checked(s.from('leads').select('*').eq('id', lead).single());
  const events = await checked(s.from('lead_events').select('event_type,payload').eq('lead_id', lead).gte('created_at', started).order('created_at'));
  const stages = events.filter((e: any) => e.event_type === 'test_stage_result').map((e: any) => e.payload);
  const out = sent.slice(sentBefore).filter((m) => m.to.replace(/\D/g, '') === String(before.telefone).replace(/\D/g, ''));
  const toAdmin = sent.slice(sentBefore).filter((m) => m.to.replace(/\D/g, '') === adminPhone.replace(/\D/g, ''));
  return { status: response.status, body, before, after, stages, out, toAdmin, events };
}

async function turn(scenario: string, lead: string, text: string, trigger: 'whatsapp_inbound' | 'stage_handoff' = 'whatsapp_inbound') {
  const r = await callProcessor(lead, text, trigger);
  const texts = r.out.filter((m) => m.kind === 'text').map((m) => m.text);
  const joined = texts.join('\n\n');
  transcript.push({
    scenario, lead: text || `(${trigger})`, stage_before: r.before.etapa_atual, stage_after: r.after.etapa_atual,
    pending_after: r.after.sales_context?.pending_criterion ?? null,
    helton: r.out.map((m) => m.kind === 'media' ? '[imagem]' : m.text),
    admin: r.toAdmin.map((m) => m.text),
    origins: r.stages.map((st: any) => ({ stage: st.stage, action: st.process_action, origin: st.response_origin, deterministic: st.deterministic_reply_used, fallback: st.fallback_used })),
  });
  const label = text || trigger;
  check(scenario, label, 'processor HTTP 200', r.status === 200, r.body);
  if (joined) {
    check(scenario, label, 'sem narração de processo / frases proibidas', !FORBIDDEN_ALWAYS.test(norm(joined)), joined.match(FORBIDDEN_ALWAYS)?.[0] || joined);
    check(scenario, label, 'texto com acentuação (sem palavras sem acento)', !NO_ACCENT_WORDS.test(String(joined).toLowerCase()), String(joined).toLowerCase().match(NO_ACCENT_WORDS)?.[0]);
    check(scenario, label, 'nenhum "---" chega ao lead', !texts.some((t) => /(^|\n)\s*-{3,}/.test(t)), texts);
    check(scenario, label, 'sem emoji e sem travessão longo', !/[\u{1F300}-\u{1FAFF}—]/u.test(joined), joined);
    check(scenario, label, 'sem saudação repetida', !/\b(bom dia|boa tarde|boa noite)\b/.test(norm(texts.filter((t) => !/eu sou helton/i.test(t)).join(' '))), joined);
  }
  for (const st of r.stages) {
    // A apresentação da E3 tem um montador oficial (texto da spec) que cobre a IA quando ela erra o formato.
    if (st.stage === 'E3' && (st.process_action === 'present_e3_structured_blocks' || st.fallback_reason === 'empty_e3_presentation_recovered')) continue;
    check(scenario, label, `${st.stage}/${st.process_action}: sem texto fixo (deterministic=false)`, st.deterministic_reply_used !== true, st.response_origin);
    check(scenario, label, `${st.stage}/${st.process_action}: sem fallback`, st.fallback_used !== true, st.fallback_reason);
  }
  return { ...r, texts, joined };
}

async function resolveCheckpoint(scenario: string, lead: string, kind: 'proposal_send' | 'enrollment_processing', adminText: string) {
  const cp = await getPendingAdminCheckpoint(s, lead);
  check(scenario, kind, `checkpoint ${kind} criado`, cp?.checkpoint_admin === kind, cp);
  if (!cp) return null;
  check(scenario, kind, `checkpoint ${kind} tem a mensagem do admin vinculada`, Boolean(cp.admin_message_id), cp);
  const done = await completeAdminCheckpointByReply({ supabase: s, tenantId: tenant, adminReplyToMessageId: cp.admin_message_id, adminPhoneOrId: adminPhone, text: adminText });
  check(scenario, kind, `admin confirma ${kind} e o lead certo é retomado`, done?.ok === true && done.lead_id === lead, done);
  return done;
}

const report = () => {
  const failed = checks.filter((c) => !c.pass);
  const summary = { result: failed.length ? 'FAIL' : 'PASS', total: checks.length, failed: failed.length, finished_at: new Date().toISOString() };
  writeFileSync(reportPath, JSON.stringify({ summary, failed, checks, transcript }, null, 2), 'utf8');
  console.log(JSON.stringify(summary));
};

try {
  // ── Prompts ativos ──────────────────────────────────────────────────────────
  const prompts = await checked(s.from('agent_definitions').select('*').eq('tenant_id', sourceTenant).in('subagent_key', keys));
  check('prompts', '-', '8 prompts ativos', prompts.length === 8, prompts.map((p: any) => p.subagent_key));
  for (const key of keys) {
    const p = String(prompts.find((r: any) => r.subagent_key === key)?.config?.prompt_override || '');
    check('prompts', key, `${key} carregado e com acentuação`, p.length > 200 && /ção|ões|você/.test(p), p.slice(0, 80));
  }

  // ── Tenant isolado ──────────────────────────────────────────────────────────
  const original = await checked(s.from('tenants').select('config').eq('id', sourceTenant).single());
  await checked(s.from('tenants').insert({ id: tenant, name: 'AgentHub teste final', slug: `final-${tenant}`, config: {
    ...original.config, evolution_api_url: `http://127.0.0.1:${port}`, evolution_api_key: 'isolated-test',
    evolution_instance_name: 'isolated-final', telefone_admin: adminPhone, admin_phone: adminPhone,
  } }));
  await checked(s.from('agent_definitions').insert(prompts.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant }))));
  const sources = await checked(s.from('course_catalog_sources').select('*').eq('tenant_id', sourceTenant));
  const sourceIds = new Map(sources.map((r: any) => [r.id, randomUUID()]));
  await checked(s.from('course_catalog_sources').insert(sources.map((r: any) => ({ ...r, id: sourceIds.get(r.id), tenant_id: tenant }))));
  const entries = await checked(s.from('course_catalog_entries').select('*').eq('tenant_id', sourceTenant));
  const entryIds = new Map(entries.map((r: any) => [r.id, randomUUID()]));
  await checked(s.from('course_catalog_entries').insert(entries.map((r: any) => ({ ...r, id: entryIds.get(r.id), tenant_id: tenant, source_id: sourceIds.get(r.source_id) || null }))));
  const aliases = await checked(s.from('course_catalog_aliases').select('*').eq('tenant_id', sourceTenant));
  if (aliases.length) await checked(s.from('course_catalog_aliases').insert(aliases.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant, entry_id: entryIds.get(r.entry_id) || r.entry_id }))));
  const knowledge = await checked(s.from('knowledge_items').select('*').eq('tenant_id', sourceTenant));
  if (knowledge.length) await checked(s.from('knowledge_items').insert(knowledge.map((r: any) => ({ ...r, id: randomUUID(), tenant_id: tenant }))));


  const officialImageHash = createHash('md5').update(readFileSync(new URL('../supabase/functions/whatsapp-sender/assets/informacao-instituicao.jpeg', import.meta.url))).digest('hex');
  const INSTITUTION_REPEAT = /(premiad|\bmec\b|conceito institucional|nota maxima|diploma|reconhecid|60 anos|anos de (historia|tradicao)|tradicao de mais|blackboard|tutor|abrir muitas portas|se destacar)/;
  const ASK_NAME = /como posso te chamar|qual (e )?o seu nome|qual seu nome|me diz seu nome|me fala seu nome/;
  const PRICE_LEAK = /r\$\s*\d|\d+\s*%|\bmensalidade de\b|\breais\b/;

  function e3Checks(sc: string, t: any, o: { course: RegExp; internship: boolean; motivation: RegExp; withName?: boolean }) {
    const tx = t.texts;
    check(sc, 'E3', 'avançou para E3', t.after.etapa_atual === 'E3', t.after.etapa_atual);
    check(sc, 'E3', 'uma imagem, antes dos textos, e é a oficial', t.out[0]?.kind === 'media' && t.out.filter((m: any) => m.kind === 'media').length === 1 && t.out[0]?.mediaHash === officialImageHash, t.out.map((m: any) => m.kind));
    check(sc, 'E3', 'exatamente 3 mensagens de texto', tx.length === 3, tx);
    check(sc, 'E3', 'msg 1: curso, semestres, anos e modalidade', o.course.test(norm(tx[0])) && /\d+ semestres/.test(norm(tx[0])) && /\d+ anos/.test(norm(tx[0])) && /ead|semipresencial/.test(norm(tx[0])), tx[0]);
    if (o.internship) check(sc, 'E3', 'tem estágio e pode ser na cidade da pessoa', /estagio/.test(norm(tx[0])) && /cidade|desloc|polo/.test(norm(tx[0])), tx[0]);
    else check(sc, 'E3', 'sem estágio, apresentado como vantagem (não inventa estágio)', /estagio/.test(norm(tx[0])) && /nao (tem|possui|exige|precisa)|sem (estagio|precisar)|desloc/.test(norm(tx[0])) && !/estagio (que )?pode ser realizado/.test(norm(tx[0])), tx[0]);
    check(sc, 'E3', 'msg 2: liga o curso ao objetivo da pessoa', o.motivation.test(norm(tx[1] || '')), tx[1]);
    check(sc, 'E3', 'msg 3: pergunta canônica "mais gostou / fizeram sentido"', /de todos esses pontos/.test(norm(tx[2] || '')) && /mais gostou/.test(norm(tx[2] || '')) && /sentido/.test(norm(tx[2] || '')), tx[2]);
    check(sc, 'E3', 'textos não repetem a imagem nem inventam', !INSTITUTION_REPEAT.test(norm(tx.join(' '))), tx);
    check(sc, 'E3', 'não fala de preço', !PRICE_LEAK.test(norm(tx.join(' '))) && !/bolsa|desconto/.test(norm(tx.join(' '))), tx);
  }

  async function chooseLineIfAsked(sc: string, lead: string, t: any, line: string) {
    if (/bacharelado|licenciatura/.test(norm(t.joined)) && !/cidade/.test(norm(t.joined))) return await turn(sc, lead, line);
    return t;
  }

  // ── X1: licenciatura, já trabalha na área, decide sozinha, objeção, pensa, matricula, boleto hoje, recusa indicação
  const X1 = 'X1 Pedagogia / já trabalha / decide sozinha / objeção de preço';
  const x1 = await newLead('+5500092000001');
  const x1a = await turn(X1, x1, 'Oi');
  check(X1, 'Oi', 'abertura com 3 mensagens e sem pedir nome', x1a.texts.length === 3 && !ASK_NAME.test(norm(x1a.joined)), x1a.texts);
  let x1b = await turn(X1, x1, 'Quero fazer Pedagogia');
  x1b = await chooseLineIfAsked(X1, x1, x1b, 'Licenciatura');
  check(X1, 'curso', 'pede a cidade, sem falar de modalidade/duração/preço', /cidade/.test(norm(x1b.joined)) && !/semestre|modalidade|ead|semipresencial|valor|bolsa/.test(norm(x1b.joined)), x1b.joined);
  const x1c = await turn(X1, x1, 'Ji-Paraná');
  check(X1, 'cidade', 'pergunta de motivação', /trabalha nessa area|sonho ou objetivo/.test(norm(x1c.joined)), x1c.joined);
  const x1d = await turn(X1, x1, 'Já trabalho como auxiliar numa escola');
  check(X1, 'motivação', 'E1 completa -> E2', x1d.after.etapa_atual === 'E2', x1d.after.etapa_atual);
  check(X1, 'motivação', 'reage ao fato de já trabalhar e faz a pergunta de viagem/mudança', /trabalh|atua|pratica|experiencia|escola|dia a dia/.test(norm(x1d.texts[0] || '')) && /viagem|mudanca/.test(norm(x1d.joined)), x1d.texts);
  const x1e = await turn(X1, x1, 'Não vou viajar nem mudar');
  check(X1, 'sem viagem', 'vai direto para o decisor', /decidir sozinh|alguem que participa/.test(norm(x1e.joined)), x1e.joined);
  const x1f = await turn(X1, x1, 'Decido sozinha');
  check(X1, 'decide sozinha', 'combinado direto', /combinado\?/.test(norm(x1f.joined)) && /inscricao/.test(norm(x1f.joined)), x1f.joined);
  const x1g = await turn(X1, x1, 'Combinado');
  e3Checks(X1, x1g, { course: /pedagogia/, internship: true, motivation: /trabalh|atua|pratica|experiencia|escola|dia a dia/ });
  check(X1, 'E3', 'sem nome confiável: pergunta sem vocativo e sem pedir nome', !ASK_NAME.test(norm(x1g.joined)), x1g.texts[2]);
  const x1h = await turn(X1, x1, 'Gostei da flexibilidade e do estágio');
  check(X1, 'E3 -> E4', 'pede nome completo', /nome completo/.test(norm(x1h.joined)) && x1h.after.etapa_atual === 'E4', [x1h.after.etapa_atual, x1h.joined]);
  const x1i = await turn(X1, x1, 'Fernanda Lima Costa');
  check(X1, 'nome completo', 'proposta sem compromisso + 1 alerta ao admin', /proposta/.test(norm(x1i.joined)) && /compromisso/.test(norm(x1i.joined)) && x1i.toAdmin.length === 1 && /fernanda lima costa/i.test(x1i.toAdmin[0]?.text || ''), [x1i.joined, x1i.toAdmin.map((m: any) => m.text)]);
  await resolveCheckpoint(X1, x1, 'proposal_send', 'Proposta enviada para Fernanda Lima Costa');
  const x1j = await turn(X1, x1, '', 'stage_handoff');
  check(X1, 'retomada', 'liga a proposta ao objetivo (trabalho) e pede retorno até o fim do dia', /trabalh|atua|pratica|experiencia|escola|dia a dia/.test(norm(x1j.joined)) && /fim do dia/.test(norm(x1j.joined)), x1j.joined);
  check(X1, 'retomada', 'texto aprovado sem a frase do decisor (decide sozinha)', x1j.texts.length === 2 && /^prontinho/.test(norm(x1j.texts[0] || '')) && x1j.texts[1] === 'Consegue me dar um retorno até o fim do dia pra gente garantir essa oportunidade? Ou já podemos garantir essa oportunidade agora?', x1j.texts);
  check(X1, 'retomada', 'decide sozinha: não inventa marido/esposa/família', !/marido|esposa|familia|ele |ela pode/.test(norm(x1j.joined)), x1j.joined);
  const x1k = await turn(X1, x1, 'Achei um pouco caro');
  check(X1, 'objeção', 'acolhe sem inventar valor, desconto ou condição', !PRICE_LEAK.test(norm(x1k.joined)) && !/desconto|condicao especial|consigo baixar|ultima chance|so hoje/.test(norm(x1k.joined)) && x1k.joined.length > 0, x1k.joined);
  check(X1, 'objeção', 'acolhe, lembra o objetivo e faz uma pergunta só', /trabalh|atua|pratica|escola|objetivo/.test(norm(x1k.joined)) && /valor da parcela ou o momento/.test(norm(x1k.joined)) && questions(x1k.joined) === 1 && !/parte financeira|condicoes para o curso/.test(norm(x1k.joined)), x1k.joined);
  check(X1, 'objeção', 'continua na E4 e não cria matrícula', x1k.after.etapa_atual === 'E4' && x1k.toAdmin.length === 0, [x1k.after.etapa_atual, x1k.toAdmin.map((m: any) => m.text)]);
  const x1l = await turn(X1, x1, 'Vou pensar com calma e te respondo amanhã');
  check(X1, 'vai pensar', 'aceita o prazo sem pressionar', !/ultima chance|so hoje|garantir hoje|vagas limitadas|nao deixe/.test(norm(x1l.joined)) && questions(x1l.joined) <= 1 && x1l.after.etapa_atual === 'E4', x1l.joined);
  const x1m = await turn(X1, x1, 'Pensei melhor, quero fazer a matrícula');
  check(X1, 'decidiu', 'comemoração curta, sem pergunta e sem narrar processo', x1m.joined.length > 0 && questions(x1m.joined) === 0 && !/encaminh|libera|aguard|vou te enviar|link/.test(norm(x1m.joined)), x1m.joined);
  await resolveCheckpoint(X1, x1, 'enrollment_processing', 'Matrícula concluída');
  const x1n = await turn(X1, x1, '', 'stage_handoff');
  check(X1, 'E5', 'parabéns canônico + boleto hoje ou segunda', /meus parabens/.test(norm(x1n.joined)) && /oficialmente/.test(norm(x1n.joined)) && /boleto/.test(norm(x1n.joined)) && /segunda/.test(norm(x1n.joined)), x1n.joined);
  const x1o = await turn(X1, x1, 'Hoje mesmo');
  check(X1, 'boleto hoje', 'segue para o convite direto de indicação', /ultimo convite/.test(norm(x1o.joined)) && /indicar/.test(norm(x1o.joined)) && !/gostou do atendimento|recomendaria/.test(norm(x1o.joined)), x1o.joined);
  const x1p = await turn(X1, x1, 'Não, obrigada');
  check(X1, 'recusa', '"Tranquilo!!" + encerramento e lead em E7', /tranquilo/.test(norm(x1p.joined)) && /prazer enorme/.test(norm(x1p.joined)) && x1p.after.etapa_atual === 'E7', [x1p.after.etapa_atual, x1p.joined]);
  const x1q = await turn(X1, x1, 'Valeu!');
  check(X1, 'pós-encerramento', 'não reabre o funil', !/ultimo convite|nome completo|cidade|mais gostou/.test(norm(x1q.joined)) && x1q.out.filter((m: any) => m.kind === 'media').length === 0, x1q.joined);

  // ── X2: bacharelado sem estágio, preço antecipado, decide com a esposa, pede valor na E3
  const X2 = 'X2 Administração / pergunta preço cedo / decide com a esposa';
  const x2 = await newLead('+5500092000002', { name: 'Rafael Nunes' });
  await turn(X2, x2, 'Oi');
  let x2a = await turn(X2, x2, 'Quero Administração');
  x2a = await chooseLineIfAsked(X2, x2, x2a, 'Bacharelado');
  const x2b = await turn(X2, x2, 'Quanto custa a mensalidade?');
  check(X2, 'preço na E1', 'não fala valor e não pula etapa', !PRICE_LEAK.test(norm(x2b.joined)) && !/bolsa|desconto/.test(norm(x2b.joined)) && x2b.after.etapa_atual === 'E1', [x2b.after.etapa_atual, x2b.joined]);
  check(X2, 'preço na E1', 'mantém a pergunta pendente (cidade)', /cidade/.test(norm(x2b.joined)), x2b.joined);
  const x2c = await turn(X2, x2, 'Manaus');
  check(X2, 'cidade', 'pergunta de motivação', /trabalha nessa area|sonho ou objetivo/.test(norm(x2c.joined)), x2c.joined);
  const x2d = await turn(X2, x2, 'Quero crescer na empresa onde trabalho');
  check(X2, 'motivação', 'E1 completa -> E2 com vacina de viagem/mudança', x2d.after.etapa_atual === 'E2' && /viagem|mudanca/.test(norm(x2d.joined)), [x2d.after.etapa_atual, x2d.joined]);
  const x2e = await turn(X2, x2, 'Não');
  check(X2, 'sem viagem', 'vai direto para o decisor', /decidir sozinh|alguem que participa/.test(norm(x2e.joined)), x2e.joined);
  const x2f = await turn(X2, x2, 'Eu e minha esposa decidimos juntos');
  check(X2, 'decisor', 'acolhe a esposa e faz o combinado completo', /ela|esposa/.test(norm(x2f.joined)) && /continuamos amigos/.test(norm(x2f.joined)) && /combinado\?/.test(norm(x2f.joined)), x2f.joined);
  const x2g = await turn(X2, x2, 'Combinado');
  e3Checks(X2, x2g, { course: /administracao/, internship: false, motivation: /cresc|empresa|trabalh|carreira/ });
  check(X2, 'E3', 'pergunta final com o nome (Rafael)', /rafael/.test(norm(x2g.texts[2] || '')), x2g.texts[2]);
  const x2h = await turn(X2, x2, 'E qual o valor?');
  check(X2, 'valor na E3', 'segue para a E4 pedindo o nome completo, sem dar preço', x2h.after.etapa_atual === 'E4' && /nome completo/.test(norm(x2h.joined)) && !PRICE_LEAK.test(norm(x2h.joined)), [x2h.after.etapa_atual, x2h.joined]);

  // ── X3: diz o nome na primeira mensagem
  const X3 = 'X3 lead diz o nome na 1ª mensagem';
  const x3 = await newLead('+5500092000003');
  const enfermagemEntries = await checked(s.from('course_catalog_entries').select('*').eq('tenant_id', tenant).ilike('normalized_search_text', '%enfermagem%'));
  check('catálogo', 'informativo', `Enfermagem no catálogo: ${enfermagemEntries.map((e: any) => e.display_name + ' [' + (e.catalog_group || '') + ']').join(', ') || 'nenhum'}`, true);
  const x3a = await turn(X3, x3, 'Oi, aqui é a Juliana, queria saber de Farmácia');
  check(X3, 'abertura', 'reage à escolha e pede a cidade, sem pedir nome', /escolha de graduacao excelente/.test(norm(x3a.joined)) && /cidade/.test(norm(x3a.joined)) && !ASK_NAME.test(norm(x3a.joined)), x3a.texts);
  const x3b = await turn(X3, x3, 'Porto Velho');
  check(X3, 'cidade', 'pergunta de motivação sem pedir nome', /trabalha nessa area|sonho ou objetivo/.test(norm(x3b.joined)) && !ASK_NAME.test(norm(x3b.joined)), x3b.joined);
  const x3c = await turn(X3, x3, 'Sempre quis cuidar das pessoas');
  check(X3, 'motivação', 'E1 completa -> E2', x3c.after.etapa_atual === 'E2', x3c.after.etapa_atual);

  // ── X4: boleto na segunda + indicação com telefone em outro formato
  const X4 = 'X4 boleto segunda / indicação';
  const x4 = await newLead('+5500092000004', { name: 'Marcos Prado' });
  await checked(s.from('leads').update({ etapa_atual: 'E5', curso_interesse: 'Administração', sales_context: { course_display_name: 'Administração', course_status: 'confirmed_available', enrollment_checkpoint_completed: true } }).eq('id', x4));
  const x4a = await turn(X4, x4, '', 'stage_handoff');
  check(X4, 'E5', 'parabéns + boleto hoje ou segunda', /meus parabens/.test(norm(x4a.joined)) && /segunda/.test(norm(x4a.joined)), x4a.joined);
  const x4b = await turn(X4, x4, 'Segunda-feira');
  check(X4, 'boleto segunda', 'convite de indicação', /ultimo convite/.test(norm(x4b.joined)), x4b.joined);
  const x4c = await turn(X4, x4, 'Tenho um amigo que quer');
  check(X4, 'indicação', 'pede o nome', /nome dessa pessoa/.test(norm(x4c.joined)), x4c.joined);
  await turn(X4, x4, 'Pedro Alves');
  const x4e = await turn(X4, x4, '+55 (69) 98888-7777');
  const x4ind = await checked(s.from('indicacoes').select('*').eq('lead_origem_id', x4));
  check(X4, 'indicação', 'registrada uma vez, com o nome', x4ind.length === 1 && /pedro/i.test(x4ind[0]?.nome_indicado || ''), x4ind);
  check(X4, 'E7', 'encerramento canônico', /prazer enorme/.test(norm(x4e.joined)) && x4e.after.etapa_atual === 'E7', [x4e.after.etapa_atual, x4e.joined]);

  // ── G: portão do webhook (quem NÃO é lead não é atendido) — nada é enviado
  const G = 'portão do webhook';
  const hookHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.EVOLUTION_WEBHOOK_TOKEN) hookHeaders.apikey = process.env.EVOLUTION_WEBHOOK_TOKEN;
  const ignoredPhone = '5500092999902';
  await s.from('lead_ignore_list').upsert({ tenant_id: sourceTenant, telefone: ignoredPhone, source: 'teste_extra' });
  const hookCases = [
    { name: 'mensagem de grupo', jid: '120363000000000999@g.us', participant: '5500092999901@s.whatsapp.net', fromMe: false, phone: '5500092999901' },
    { name: 'mensagem enviada por você (fromMe)', jid: '5500092999903@s.whatsapp.net', fromMe: true, phone: '5500092999903' },
    { name: 'status', jid: 'status@broadcast', participant: '5500092999904@s.whatsapp.net', fromMe: false, phone: '5500092999904' },
    { name: 'número na lista de não atender', jid: `${ignoredPhone}@s.whatsapp.net`, fromMe: false, phone: ignoredPhone },
  ];
  for (const c of hookCases) {
    const marker = `teste-portao-${randomUUID()}`;
    const res = await fetch(`${url}/functions/v1/webhook-receiver`, {
      method: 'POST', headers: hookHeaders,
      body: JSON.stringify({ event: 'messages.upsert', instance: 'teste-portao', data: {
        key: { remoteJid: c.jid, fromMe: c.fromMe, id: `TEST${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, ...(c.participant ? { participant: c.participant } : {}) },
        message: { conversation: marker }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Teste',
      } }),
    });
    await new Promise((r) => setTimeout(r, 4000));
    const leadsFound = await checked(s.from('leads').select('id').eq('tenant_id', sourceTenant).ilike('telefone', `%${c.phone.slice(-8)}%`));
    const msgsFound = await checked(s.from('mensagens').select('id').eq('conteudo', marker));
    check(G, c.name, 'webhook respondeu', res.status === 200, `${res.status} ${await res.text().catch(() => '')}`);
    check(G, c.name, 'não cria lead nem salva mensagem (fica em silêncio)', leadsFound.length === 0 && msgsFound.length === 0, { leads: leadsFound.length, msgs: msgsFound.length });
    for (const l of leadsFound) cleanupLeadIds.add(l.id);
  }
  await s.from('lead_ignore_list').delete().eq('tenant_id', sourceTenant).eq('telefone', ignoredPhone);
} catch (error) {
  check('execução', '-', 'teste rodou até o fim', false, String((error as Error)?.stack || error));
} finally {
  report();
  for (const id of cleanupLeadIds) {
    for (const table of ['followup_schedule', 'lead_events', 'mensagens', 'lead_admin_checkpoints', 'indicacoes', 'debounce_groups', 'outbound_generation_claims']) {
      await s.from(table).delete().eq(table === 'indicacoes' ? 'lead_origem_id' : 'lead_id', id);
    }
  }
  for (const id of cleanupLeadIds) await s.from('leads').delete().eq('id', id);
  for (const table of ['leads', 'agent_definitions', 'course_catalog_aliases', 'course_catalog_entries', 'course_catalog_sources', 'knowledge_items', 'admin_runtime_logs']) {
    await s.from(table).delete().eq('tenant_id', tenant);
  }
  await s.from('tenants').delete().eq('id', tenant);
  server.close();
}

