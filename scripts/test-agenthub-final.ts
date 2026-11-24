import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Teste oficial de aceite da AgentHub (spec canônica + adendo de 24/11/2026).
// Roda contra o Supabase LOCAL, num tenant isolado, com uma Evolution simulada:
// nenhuma mensagem vai para o WhatsApp real.
// Run: node --env-file=.env.local --experimental-strip-types scripts/test-agenthub-final.ts
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
const reportPath = process.env.AGENTHUB_TEST_REPORT || 'agenthub-final-test-report.json';
const sourceTenant = '00000000-0000-0000-0000-000000000001';
const tenant = randomUUID();
const adminPhone = '+5500090900999';
const port = Number(process.env.AGENTHUB_TEST_PORT || 18084);
const keys = ['PERSONALITY', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];

type Sent = { to: string; kind: 'text' | 'media'; text: string; id: string; mediaHash?: string };
const sent: Sent[] = [];
const checks: Array<{ scenario: string; turn: string; check: string; pass: boolean; detail?: string }> = [];
const transcript: Array<Record<string, unknown>> = [];
const cleanupLeadIds = new Set<string>();

const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const questions = (t: string) => (String(t).match(/\?/g) || []).length;

const FORBIDDEN_ALWAYS = /vou verificar|vou consultar|vou checar|aguarde|um momento|estou analisando|proxima etapa|proximo passo|vamos seguir|vamos avancar|para seguirmos|so para concluir|para concluir|infelizmente|nao localizei|consultei|recebi sua pergunta|estou aqui para ajudar|estou a disposicao|para te ajudar melhor|para eu entender melhor|checkpoint|administrativ|\bcst\b|tecnologo|proxima etapa|nessa etapa do|etapa do processo/;
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
    check(scenario, label, 'sem emoji e sem travessão longo', !/[\u{1F300}-\u{1FAFF}—]/u.test(joined), joined);
    check(scenario, label, 'sem saudação repetida', !/\b(bom dia|boa tarde|boa noite)\b/.test(norm(texts.filter((t) => !/eu sou helton/i.test(t)).join(' '))), joined);
  }
  for (const st of r.stages) {
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

  // ── CENÁRIO PRINCIPAL E1 → E7 ───────────────────────────────────────────────
  const M = 'principal';
  const lead = await newLead('+5500091000001', { name: 'João Silva' });

  const t1 = await turn(M, lead, 'Oi');
  check(M, 'Oi', 'abertura com exatamente 3 mensagens', t1.texts.length === 3, t1.texts);
  check(M, 'Oi', 'abertura: apresentação do Helton', /eu sou helton, especialista em carreiras/.test(norm(t1.texts[0])), t1.texts[0]);
  check(M, 'Oi', 'abertura: "No que posso te ajudar hoje?"', /no que posso te ajudar hoje/.test(norm(t1.texts[2])), t1.texts[2]);

  const t2 = await turn(M, lead, 'Quero saber sobre Farmácia');
  check(M, 'curso', 'reação canônica à escolha', /escolha de graduacao excelente/.test(norm(t2.joined)) && /oportunidades/.test(norm(t2.joined)), t2.joined);
  check(M, 'curso', 'pede a cidade', /cidade/.test(norm(t2.joined)), t2.joined);
  check(M, 'curso', 'não verbaliza disponibilidade', !/disponivel|ofertad|temos esse curso|opcoes disponiveis/.test(norm(t2.joined)), t2.joined);
  check(M, 'curso', 'uma pergunta só', questions(t2.joined) <= 1, t2.joined);

  const t3 = await turn(M, lead, 'Sou de Porto Velho');
  check(M, 'cidade', 'pergunta de motivação', /trabalha nessa area|sonho ou objetivo/.test(norm(t3.joined)), t3.joined);
  check(M, 'cidade', 'não repete a cidade nem elogia o curso de novo', !/porto velho|escolha de graduacao/.test(norm(t3.joined)), t3.joined);
  check(M, 'cidade', 'estado: pendente = motivation', t3.after.sales_context?.pending_criterion === 'motivation', t3.after.sales_context?.pending_criterion);

  const t4 = await turn(M, lead, 'Minha família toda fez, quero fazer também');
  check(M, 'motivação', 'E1 completa -> E2', t4.after.etapa_atual === 'E2', t4.after.etapa_atual);
  check(M, 'motivação', 'reação menciona família/caminho', /familia|caminho/.test(norm(t4.texts[0] || '')), t4.texts);
  check(M, 'motivação', 'reação sem pergunta e vacina 1 em mensagem separada', t4.texts.length >= 2 && questions(t4.texts[0]) === 0 && /viagem|mudanca/.test(norm(t4.texts[t4.texts.length - 1])), t4.texts);

  const t5 = await turn(M, lead, 'Não tenho viagem nem mudança');
  check(M, 'sem viagem', 'vai direto para o decisor', /decidir sozinho|alguem que participa/.test(norm(t5.joined)), t5.joined);
  check(M, 'sem viagem', 'não reage à resposta operacional', !/que bom|otimo|legal saber|perfeito/.test(norm(t5.joined)), t5.joined);

  const t6 = await turn(M, lead, 'Converso com meu marido');
  check(M, 'decisor', 'convida o marido para tirar dúvidas', /se ele tiver|ele pode|duvida/.test(norm(t6.joined)), t6.joined);
  check(M, 'decisor', 'combinado completo (as duas metades)', /nao ficou legal/.test(norm(t6.joined)) && /continuamos amigos/.test(norm(t6.joined)) && /inscricao/.test(norm(t6.joined)) && /combinado\?/.test(norm(t6.joined)), t6.joined);
  check(M, 'decisor', 'sem "posso te apresentar"', !/posso te apresentar|posso te fazer um combinado/.test(norm(t6.joined)), t6.joined);

  const t7 = await turn(M, lead, 'Vai depender do valor');
  check(M, 'depende do valor', 'resposta canônica (vai passar os valores, antes apresenta)', /vou te passar os valores/.test(norm(t7.joined)) && /tudo bem assim\?/.test(norm(t7.joined)), t7.joined);
  check(M, 'depende do valor', 'não repete o combinado', !/continuamos amigos/.test(norm(t7.joined)), t7.joined);
  check(M, 'depende do valor', 'continua na E2', t7.after.etapa_atual === 'E2', t7.after.etapa_atual);

  const t8 = await turn(M, lead, 'Pode ser');
  const e3Texts = t8.texts;
  const e3Media = t8.out.filter((m) => m.kind === 'media').length;
  check(M, 'E3', 'avançou para E3', t8.after.etapa_atual === 'E3', t8.after.etapa_atual);
  check(M, 'E3', 'imagem da instituição enviada', e3Media === 1, e3Media);
  check(M, 'E3', 'imagem vai antes dos textos', t8.out[0]?.kind === 'media', t8.out.map((m) => m.kind));
  const expectedImageHash = createHash('md5').update(readFileSync(new URL('../supabase/functions/whatsapp-sender/assets/informacao-instituicao.jpeg', import.meta.url))).digest('hex');
  check(M, 'E3', 'é a imagem oficial da instituição', t8.out.find((m) => m.kind === 'media')?.mediaHash === expectedImageHash, t8.out.find((m) => m.kind === 'media')?.mediaHash);
  check(M, 'E3', 'exatamente 3 mensagens de texto', e3Texts.length === 3, e3Texts);
  check(M, 'E3', 'msg 1: curso + semestres + anos + modalidade', /farmacia/.test(norm(e3Texts[0])) && /\d+ semestres/.test(norm(e3Texts[0])) && /\d+ anos/.test(norm(e3Texts[0])) && /ead|semipresencial/.test(norm(e3Texts[0])), e3Texts[0]);
  check(M, 'E3', 'msg 1: estágio (bacharelado de saúde tem estágio, na cidade da pessoa)', /estagio/.test(norm(e3Texts[0] + e3Texts[1])) && /cidade|desloc|polo/.test(norm(e3Texts[0] + e3Texts[1])), e3Texts);
  check(M, 'E3', 'msg 2: liga o curso ao objetivo (família)', /familia|caminho/.test(norm(e3Texts[1])), e3Texts[1]);
  check(M, 'E3', 'msg 3: pergunta "mais gostou e mais fizeram sentido"', /mais gostou/.test(norm(e3Texts[2])) && /sentido/.test(norm(e3Texts[2])), e3Texts[2]);
  check(M, 'E3', 'textos não repetem a imagem (MEC, diploma, tradição, plataforma, tutoria) nem inventam', !/(premiad|\bmec\b|conceito institucional|nota maxima|diploma|reconhecid|60 anos|tradicao|blackboard|tutor|abrir muitas portas|se destacar)/.test(norm(e3Texts.join(' '))), e3Texts);
  check(M, 'E3', 'sem bloco institucional em texto e sem metadata', !/claim_key|metadata|comunicacao comercial pode/.test(norm(t8.joined)), t8.joined);

  const t9 = await turn(M, lead, 'Quanto tempo de estágio tem?');
  check(M, 'E3 dúvida', 'responde a dúvida sem reapresentar', !/mais gostou/.test(norm(t9.joined)) && t9.texts.length <= 2, t9.texts);
  check(M, 'E3 dúvida', 'continua na E3', t9.after.etapa_atual === 'E3', t9.after.etapa_atual);
  check(M, 'E3 dúvida', 'não reenvia a imagem', t9.out.every((m) => m.kind !== 'media'), t9.out.map((m) => m.kind));

  const t10 = await turn(M, lead, 'Gostei muito do estágio poder ser aqui na minha cidade');
  check(M, 'E3 -> E4', 'pede nome completo', /nome completo/.test(norm(t10.joined)), t10.joined);
  check(M, 'E3 -> E4', 'está na E4', t10.after.etapa_atual === 'E4', t10.after.etapa_atual);

  const t11 = await turn(M, lead, 'Maria Silva Pereira');
  check(M, 'nome completo', 'fala de proposta sem compromisso', /proposta/.test(norm(t11.joined)) && /compromisso/.test(norm(t11.joined)), t11.joined);
  check(M, 'nome completo', 'alerta ao admin no formato padronizado', t11.toAdmin.some((m) => /^alerta interno: lead solicitou proposta para o curso de/i.test(m.text) && /nome completo do lead: maria silva pereira/i.test(m.text) && /motivo:/i.test(m.text)), t11.toAdmin.map((m) => m.text));
  check(M, 'nome completo', 'nenhum alerta extra ao admin', t11.toAdmin.length === 1, t11.toAdmin.map((m) => m.text));
  const pauseProbe = await turn(M, lead, 'E aí, já tem a proposta?');
  check(M, 'pausa', 'durante a pausa nada é enviado ao lead', pauseProbe.out.length === 0, pauseProbe.texts);

  await resolveCheckpoint(M, lead, 'proposal_send', 'Proposta enviada para Maria Silva Pereira');
  const t12 = await turn(M, lead, '', 'stage_handoff');
  check(M, 'retomada', 'proposta ligada ao objetivo (família) e ao decisor (marido)', /familia|caminho/.test(norm(t12.joined)) && /marido|ele/.test(norm(t12.joined)), t12.joined);
  check(M, 'retomada', 'pede retorno até o fim do dia', /fim do dia/.test(norm(t12.joined)), t12.joined);
  check(M, 'retomada', 'nenhuma frase cortada', !t12.texts.some((t) => /\b(e|de|para|com|que|eu)$/.test(norm(t).trim())), t12.texts);

  const t13 = await turn(M, lead, 'Quero fazer a matrícula');
  check(M, 'matrícula', 'pausa invisível (sem narrar processo)', !/encaminh|libera|aguard/.test(norm(t13.joined)), t13.joined);
  await resolveCheckpoint(M, lead, 'enrollment_processing', 'Matrícula concluída');
  const t14 = await turn(M, lead, '', 'stage_handoff');
  check(M, 'E5', 'parabéns canônico', /meus parabens/.test(norm(t14.joined)) && /oficialmente/.test(norm(t14.joined)), t14.joined);
  check(M, 'E5', 'pergunta do boleto hoje ou segunda', /boleto/.test(norm(t14.joined)) && /hoje/.test(norm(t14.joined)) && /segunda/.test(norm(t14.joined)), t14.joined);
  check(M, 'E5', 'não diz "quase lá"', !/quase la|vamos fazer a sua matricula/.test(norm(t14.joined)), t14.joined);

  const t15 = await turn(M, lead, 'Consigo pagar só na quarta');
  check(M, 'outra data', 'registra a data', /registrada/.test(norm(t15.joined)), t15.joined);
  check(M, 'E6', 'convite direto de indicação (sem pergunta de satisfação)', /ultimo convite/.test(norm(t15.joined)) && /indicar/.test(norm(t15.joined)) && !/gostou do atendimento|recomendaria/.test(norm(t15.joined)), t15.joined);

  const t16 = await turn(M, lead, 'Tenho sim, minha irmã');
  check(M, 'indicação', 'pede o nome da pessoa', /nome dessa pessoa/.test(norm(t16.joined)), t16.joined);
  const t17 = await turn(M, lead, 'Ana Souza');
  check(M, 'indicação', 'pede o telefone', /telefone/.test(norm(t17.joined)) && !/curso|area|cidade/.test(norm(t17.joined)), t17.joined);
  const t18 = await turn(M, lead, '69 99999-0000');
  const indications = await checked(s.from('indicacoes').select('*').eq('lead_origem_id', lead));
  check(M, 'indicação', 'indicação registrada', indications.length === 1, indications);
  check(M, 'E7', 'encerramento canônico', /prazer enorme/.test(norm(t18.joined)) && /contato nosso/.test(norm(t18.joined)), t18.joined);
  check(M, 'E7', 'lead em E7', t18.after.etapa_atual === 'E7', t18.after.etapa_atual);

  // ── RAMOS ───────────────────────────────────────────────────────────────────
  const R1 = 'primeira mensagem já com curso';
  const r1 = await newLead('+5500091000101');
  const r1a = await turn(R1, r1, 'Olá, quero saber sobre Pedagogia');
  check(R1, 'abertura', '2 mensagens de boas-vindas + reação ao curso', !r1a.texts.some((t) => /no que posso te ajudar/.test(norm(t))) && /escolha de graduacao excelente/.test(norm(r1a.joined)), r1a.texts);
  check(R1, 'abertura', 'sem nome confiável, sem vocativo e sem pedir nome', !/como posso te chamar|seu nome/.test(norm(r1a.joined)), r1a.joined);

  const R2 = 'pedido amplo e área';
  const r2 = await newLead('+5500091000102', { name: 'Carla Souza' });
  await turn(R2, r2, 'Oi');
  const r2a = await turn(R2, r2, 'Quais cursos vocês têm?');
  check(R2, 'pedido amplo', 'pergunta a área sem despejar lista', /area/.test(norm(r2a.joined)) && !/^- /m.test(r2a.joined), r2a.joined);
  const r2b = await turn(R2, r2, 'Tecnologia');
  check(R2, 'área', 'lista cursos reais e não diz que não há opções', /^- /m.test(r2b.joined) && !/nao temos|nao ha opcoes|infelizmente/.test(norm(r2b.joined)), r2b.joined);

  const R3 = 'curso fora das opções';
  const r3 = await newLead('+5500091000103', { name: 'Paulo Lima' });
  await turn(R3, r3, 'Oi');
  const r3a = await turn(R3, r3, 'Quero fazer Psicoterapia');
  check(R3, 'indisponível', 'explica com humanidade e oferece no máximo 5 alternativas', (r3a.joined.match(/^- /gm) || []).length <= 5 && /\?/.test(r3a.joined), r3a.joined);

  const R4 = 'linha bacharelado/licenciatura';
  const r4 = await newLead('+5500091000104', { name: 'Bruna Alves' });
  await turn(R4, r4, 'Oi');
  const r4a = await turn(R4, r4, 'Quero Ciências Biológicas');
  check(R4, 'linha', 'pergunta a linha com as linhas reais', /bacharelado/.test(norm(r4a.joined)) && /licenciatura/.test(norm(r4a.joined)), r4a.joined);

  const R5 = 'mudança + decide sozinho + combinado direto';
  const r5 = await newLead('+5500091000105', { name: 'Diego Rocha' });
  await turn(R5, r5, 'Oi');
  await turn(R5, r5, 'Quero Administração');
  await turn(R5, r5, 'Ariquemes');
  await turn(R5, r5, 'Sempre foi meu sonho');
  const r5a = await turn(R5, r5, 'Vou me mudar para Cuiabá no ano que vem');
  check(R5, 'mudança', 'explica pela modalidade real e pergunta o decisor', /plataforma|ead|rotina/.test(norm(r5a.joined)) && /decidir sozinho|alguem que participa/.test(norm(r5a.joined)) && !/entendi/.test(norm(r5a.joined)), r5a.joined);
  const r5b = await turn(R5, r5, 'Eu mesmo decido');
  check(R5, 'decide sozinho', 'sem reação e direto ao combinado', /combinado\?/.test(norm(r5b.joined)) && !/decide sozinho|perfeito|otimo/.test(norm(r5b.joined)), r5b.joined);
  const r5c = await turn(R5, r5, 'Combinado');
  check(R5, 'combinado direto', 'vai para a E3', r5c.after.etapa_atual === 'E3', r5c.after.etapa_atual);
  check(R5, 'E3', 'imagem da instituição enviada antes dos textos', r5c.out[0]?.kind === 'media' && r5c.out.filter((m) => m.kind === 'media').length === 1, r5c.out.map((m) => m.kind));
  check(R5, 'E3', 'textos não repetem a imagem nem inventam', !/(premiad|\bmec\b|diploma|reconhecid|60 anos|tradicao|blackboard|tutor|abrir muitas portas|se destacar)/.test(norm(r5c.texts.join(' '))), r5c.texts);
  check(R5, 'E3', 'liga o curso ao sonho', /sonho/.test(norm(r5c.texts[1] || '')), r5c.texts);

  const R6 = 'recusa de indicação';
  const r6 = await newLead('+5500091000106', { name: 'Lucas Dias' });
  await checked(s.from('leads').update({ etapa_atual: 'E6', curso_interesse: 'Administração', sales_context: { course_display_name: 'Administração', course_status: 'confirmed_available' } }).eq('id', r6));
  const r6a = await turn(R6, r6, '', 'stage_handoff');
  check(R6, 'convite', 'convite direto', /ultimo convite/.test(norm(r6a.joined)), r6a.joined);
  const r6b = await turn(R6, r6, 'Não tenho ninguém agora');
  check(R6, 'recusa', '"Tranquilo!!" e encerramento', /tranquilo/.test(norm(r6b.joined)) && /prazer enorme/.test(norm(r6b.joined)) && !/obrigado pela sinceridade/.test(norm(r6b.joined)), r6b.joined);
} catch (error) {
  check('execução', '-', 'teste rodou até o fim', false, String((error as Error)?.stack || error));
} finally {
  report();
  for (const id of cleanupLeadIds) {
    for (const table of ['followup_schedule', 'lead_events', 'mensagens', 'lead_admin_checkpoints', 'indicacoes', 'debounce_groups', 'outbound_generation_claims']) {
      await s.from(table).delete().eq(table === 'indicacoes' ? 'lead_origem_id' : 'lead_id', id);
    }
  }
  for (const table of ['leads', 'agent_definitions', 'course_catalog_aliases', 'course_catalog_entries', 'course_catalog_sources', 'knowledge_items', 'admin_runtime_logs']) {
    await s.from(table).delete().eq('tenant_id', tenant);
  }
  await s.from('tenants').delete().eq('id', tenant);
  server.close();
}
