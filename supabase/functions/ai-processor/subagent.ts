// subagent.ts - runtime editorial driven by dashboard prompts
// deno-lint-ignore-file
// @ts-nocheck

import { GUARDED_TOOLS, passesGuard, guardFailureMessage } from '../_shared/confirmation-guard.ts';
import { detectLoop, hashArgs, type ToolCallRecord } from '../_shared/loop-detector.ts';
import { chatCompletions, type ChatMessage } from '../_shared/openai-client.ts';
import { buildGovernanceTagsPrompt } from '../_shared/message-governance.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { TOOL_IMPL, type ToolContext } from './tools.ts';
import { fetchKnowledgeItems, knowledgeItemsToPrompt } from './knowledge.ts';
import { detectCatalogIntentWithHistory, detectContextualReplyKind, isMediaPlaceholderMessage } from './catalog-resolver.ts';
import { classifyInboundAgainstStageState, derivePendingCriterion, getNextE1Criterion, getNextE2Criterion } from './stage-state.ts';
import { extractFirstName } from '../_shared/lead-name.ts';
import { getCourseDisplayName } from '../_shared/course-display.ts';
import { buildE3PresentationMessages } from './e3-presentation.ts';

export type Subagent = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7';

const TOOLS_BY_SUBAGENT: Record<Subagent, string[]> = {
  E1: ['ler_lead', 'atualizar_lead', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
  E2: ['ler_lead', 'atualizar_lead', 'avancar_etapa', 'acionar_handoff', 'notificar_admin'],
  E3: ['ler_lead', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
  E4: ['ler_lead', 'atualizar_lead', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
  E5: ['ler_lead', 'registrar_matricula', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
  E6: ['ler_lead', 'registrar_indicacao', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
  E7: ['ler_lead', 'avancar_etapa', 'acionar_handoff', 'consultar_conhecimento', 'notificar_admin'],
};

const STAGE_FALLBACKS: Record<Subagent, string> = {
  E1: 'Objetivo da etapa E1: criar conexao, identificar nome, cidade, curso de interesse e dor principal antes de avancar.',
  E2: 'Objetivo da etapa E2: antecipar objecoes, confirmar decisor e alinhar o combinado antes da apresentacao.',
  E3: 'Objetivo da etapa E3: apresentar curso, instituicao e suporte conectando com a motivacao do lead, sem falar preco ou desconto.',
  E4: 'Objetivo da etapa E4: coletar nome completo para proposta, pausar nos checkpoints administrativos e conduzir negociacao sem dizer valor ou inventar desconto.',
  E5: 'Objetivo da etapa E5: parabenizar pela matricula concluida e definir a data do boleto.',
  E6: 'Objetivo da etapa E6: validar se o lead gostou do atendimento e se recomendaria para outra pessoa antes de pedir indicacao.',
  E7: 'Objetivo da etapa E7: preparar os indicados e encerrar a conversa com elegancia.',
};

export const SYSTEM_PROMPTS = STAGE_FALLBACKS;

const DEFAULT_HELTON_PERSONALITY = `
IDENTIDADE GLOBAL
- Voce e Helton, especialista em carreiras.

POSTURA GLOBAL OBRIGATORIA
- humano
- acolhedor
- leve
- genuinamente curioso
- seguro
- ativo na conducao
- entusiasmado com proporcao
- profissional sem soar como script

NAO SOAR COMO
- formulario
- chatbot
- catalogo
- sistema

REGRAS GLOBAIS DE CONVERSA
- uma pergunta por vez
- aproveite informacoes ja dadas
- interprete respostas semanticamente quando houver seguranca
- nunca repita pergunta ja respondida
- nao valide toda resposta
- nao agradeca toda informacao
- nao elogie qualquer coisa
- nao use frases de preenchimento
- nao reinicie atendimento na troca de etapa
- nunca revele ferramenta, etapa, sistema, CRM ou automacao

MULETAS PROIBIDAS
- vamos seguir
- vamos continuar
- proxima etapa
- proximos passos
- avancando
- etapa concluida
- recebido
- pronto
- qualquer coisa me chama
- pode ficar tranquilo
- obrigado por compartilhar
- agradeco pelo interesse

FALLBACKS E TEXTOS ESTRUTURAIS
- mesmo quando a resposta vier de fallback ou regra estrutural, a redacao precisa continuar humana, breve e natural.
`.trim();

function normalizeMessageText(text: string): string {
  if (!text) return text;
  const normalizedParts = text
    .replace(/\n?\s*-{3,}\s*\n?/g, '\n---\n')
    .replace(/(\n---\n){2,}/g, '\n---\n')
    .split('\n---\n')
    .map((part) => part.replace(/\n{3,}/g, '\n\n').trim())
    .filter((part) => part.length > 0);

  const uniqueParts: string[] = [];
  const seen = new Set<string>();

  for (const part of normalizedParts) {
    const normalized = part
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueParts.push(part);
  }

  return uniqueParts.join('\n\n').trim();
}

function normalizeSoft(text: string) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assistantHistoryCount(history: Array<{ role?: string; content?: string }>) {
  return (history || []).filter((item) => item?.role === 'assistant' && String(item?.content || '').trim()).length;
}

function deriveSpeakableCourseName(currentCourseInterest: string, salesContext: Record<string, unknown>) {
  const explicitCourse = String(currentCourseInterest || '').trim();
  if (explicitCourse) return getCourseDisplayName(explicitCourse);
  const fallbackBase = String(salesContext.curso_base_nome || '').trim();
  return getCourseDisplayName(fallbackBase) || null;
}

function looksLikePureGreeting(message: string) {
  const normalized = normalizeSoft(message);
  if (!normalized) return false;
  return [
    'oi',
    'ola',
    'olá',
    'oie',
    'oii',
    'oii',
    'bom dia',
    'boa tarde',
    'boa noite',
    'e ai',
    'ei',
    'hey',
    'oila',
  ].includes(normalized);
}

function userAcceptedSameSegmentAlternatives(message: string) {
  const normalized = normalizeSoft(message);
  if (!normalized) return false;
  return [
    'sim',
    'pode mostrar',
    'pode me mostrar',
    'me mostra',
    'mostrar outras opcoes',
    'me mostrar outras opcoes',
    'pode me mostrar outras opcoes',
    'outras opcoes dessa area',
    'outras opcoes da area',
    'quero ver as opcoes',
  ].some((pattern) => normalized.includes(pattern));
}

export function shouldSendInitialE1Opening(params: {
  subagent: Subagent;
  history: Array<{ role?: string; content?: string }>;
  latestUserMessage: string;
}) {
  return false;
}

function buildInitialE1Opening(leadFirstName: string, greeting: string) {
  const nameChunk = leadFirstName ? ` ${leadFirstName}` : '';
  return [
    `Opa, ${greeting}${nameChunk}!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.`,
    'É um prazer enorme falar com você!!',
    'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.',
    'São pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
    'No que posso te ajudar hoje?',
  ].join('\n\n');
}

function buildE1CompletionAcknowledgement(params: {
  latestUserMessage: string;
  courseName: string | null;
}) {
  const normalized = normalizeForCourseDetection(params.latestUserMessage || '');
  const courseChunk = params.courseName ? ` de ${params.courseName}` : '';

  if (normalized.includes('ja trabalho') || normalized.includes('trabalho na area') || normalized.includes('atuo na area')) {
    return `Que legal saber que voce ja trabalha na area${courseChunk}!`;
  }

  if (normalized.includes('sonho') || normalized.includes('objetivo')) {
    return `Que bonito saber que essa graduacao${courseChunk} faz sentido para voce!`;
  }

  return 'Perfeito!';
}

function buildE1ConfirmedAvailableAskCityReply(params: {
  leadFirstName: string;
  courseName: string | null;
}) {
  const courseLabel = String(params.courseName || 'essa graduacao').trim();
  const nameChunk = params.leadFirstName ? `, ${params.leadFirstName}` : '';
  return `${courseLabel} e uma escolha excelente${nameChunk}.\n\nMe diz so de qual cidade voce fala?`;
}

function buildE1AskMotivationReply() {
  return 'Perfeito!!\n\nAgora me conta: voce ja trabalha na area ou isso e um sonho ou objetivo pessoal para voce?';
}

function buildE2AgreementReply(params?: { decisionParticipant?: string | null }) {
  const participant = String(params?.decisionParticipant || '').trim();
  const participantLabel = (() => {
    if (!participant) return '';
    if (participant === 'essa pessoa') return 'essa pessoa';
    if (['mae', 'mãe', 'esposa', 'namorada', 'filha', 'socia', 'sócia'].includes(participant.toLowerCase())) {
      return `a sua ${participant}`;
    }
    return `o seu ${participant}`;
  })();
  const participantAck = participant
    ? `Excelente!! E se ${participantLabel} tiver qualquer duvida tambem, pode ficar a vontade para me mandar. Vai ser um prazer responder voces.\n\n`
    : '';

  return `${participantAck}Deixa eu combinar uma coisa com voce: se nao fizer sentido e nao encaixar no seu bolso o que eu vou te apresentar agora, voce me da um "nao ficou legal pra mim" sincero e continuamos amigos, sem problema.\n\nMas se fizer sentido pra voce e encaixar no seu bolso, garantimos essa oportunidade indo para a inscricao. Combinado?`;
}

function normalizeCourseModality(value: unknown) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (normalized.includes('ead')) return 'ead';
  if (normalized.includes('semipresencial')) return 'semipresencial';
  return null;
}

function buildE2TravelMoveReply(params: {
  latestUserMessage: string;
  modality?: string | null;
}) {
  const modality = normalizeCourseModality(params.modality);
  const reason = normalizeForCourseDetection(params.latestUserMessage || '').includes('mud')
    ? 'essa mudanca'
    : 'essa viagem';
  const nextQuestion = 'E uma decisao importante assim sobre seus estudos, normalmente voce decide por voce mesmo ou costuma conversar com alguem antes?';

  if (modality === 'ead') {
    return `Perfeito!! Mesmo com ${reason}, voce consegue estudar tranquilamente, porque o seu curso e EAD.\n\nVoce pode assistir as aulas no dia e no horario que melhor encaixarem na sua rotina. So precisa ficar atento as datas, mas os tutores vao estar te lembrando ao longo do curso.\n\n${nextQuestion}`;
  }

  if (modality === 'semipresencial') {
    return `Excelente!! Mesmo com ${reason}, voce consegue continuar estudando normalmente, porque o seu curso e semipresencial.\n\nVoce consegue acompanhar as aulas ao vivo pela plataforma de onde estiver.\n\n${nextQuestion}`;
  }

  return `Perfeito!! Obrigado por me avisar sobre ${reason}.\n\nEu vou considerar isso com cuidado para te orientar sem inventar nada sobre o funcionamento do curso.\n\n${nextQuestion}`;
}

function buildE2ConditionalPriceReply() {
  return 'Perfeito!! Pode ficar a vontade, eu vou fazer questao de te passar o valor.\n\nSo quero te apresentar primeiro o curso e a nossa metodologia, para voce entender direitinho como funciona e, se surgir alguma duvida, eu ja esclareco. Tudo bem assim?';
}

function sanitizeStageHandoffText(text: string, trigger: string, subagent: Subagent) {
  if (!text || trigger !== 'stage_handoff' || subagent === 'E1') return text;

  const normalized = (value: string) => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1) return text;

  const praiseMarkers = [
    'parabens',
    'parabéns',
    'excelente escolha',
    'que inspirador',
    'que legal saber disso',
    'escolher seguir um sonho',
    'faz toda diferenca',
    'faz toda diferença',
    'admiravel',
    'admirável',
  ];

  while (paragraphs.length > 1) {
    const first = normalized(paragraphs[0]);
    if (!praiseMarkers.some((marker) => first.includes(normalized(marker)))) break;
    paragraphs.shift();
  }

  return paragraphs.join('\n\n').trim() || text;
}

function promptFingerprint(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `p${Math.abs(hash)}`;
}

function isPromptTraceEnabled(env: Record<string, string | undefined>) {
  const raw = String(env.DEBUG_PROMPT_TRACE || env.LOG_SUBAGENT_PROMPTS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function promptPreview(text: string, max = 600) {
  return (text || '').slice(0, max).replace(/\s+/g, ' ').trim();
}

function getHourInTimezone(timeZone: string) {
  const timeStr = new Date().toLocaleTimeString('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return Number(timeStr.split(':')[0] || 0);
}

function getPeriodo(timeZone = 'America/Porto_Velho') {
  const hora = getHourInTimezone(timeZone);
  if (hora < 12) return 'manha';
  if (hora < 18) return 'tarde';
  return 'noite';
}

function getTipoContato(trigger: string) {
  if (trigger === 'stage_handoff') {
    return 'Voce esta continuando a conversa imediatamente apos a etapa anterior, sem esperar nova mensagem do lead';
  }
  return trigger === 'whatsapp_inbound'
    ? 'O lead entrou em contato primeiro'
    : 'Voce esta prospectando este lead';
}

function renderDynamicPrompt(template: string, trigger: string, nomeDoLead: string | null, timeZone = 'America/Porto_Velho') {
  const nome = nomeDoLead ? `"${nomeDoLead}"` : 'ainda nao coletado';
  const tipoContato = getTipoContato(trigger);
  const periodo = getPeriodo(timeZone);
  return template
    .replace(/\{TIPO_CONTATO\}/g, tipoContato)
    .replace(/\{NOME_DO_LEAD\}/g, nome)
    .replace(/\{PERIODO\}/g, periodo)
    .replace(/\$\{nome\}/g, nome)
    .replace(/\$\{periodo\}/g, periodo)
    .replace(/\$\{fluxo === 'PASSIVO' \? 'O lead entrou em contato primeiro' : 'Voce esta prospectando este lead'\}/g, tipoContato)
    .trim();
}

function buildKernelContext(input: { trigger: string; nomeDoLead: string | null; subagent: Subagent; timeZone?: string }) {
  const nome = input.nomeDoLead ? `"${input.nomeDoLead}"` : 'ainda nao coletado';
  const timeZone = input.timeZone || 'America/Porto_Velho';
  return `
KERNEL DO SISTEMA
- O prompt da dashboard e a fonte editorial de verdade deste agente.
- O bloco REGRAS GERAIS da dashboard tem prioridade maxima sobre qualquer estilo, exemplo antigo ou tendencia do modelo de improvisar.
- O bloco PERSONALITY define identidade, tom, estilo e regras globais.
- O bloco da etapa atual define o processo comercial desta fase.
- Se existir conflito entre memorias antigas e os prompts da dashboard, siga os prompts da dashboard.
- Se uma regra da dashboard disser "Nao", trate isso como proibicao absoluta.
- Use ferramentas apenas quando forem necessarias para consultar dados, atualizar lead, avancar etapa, registrar matricula, registrar indicacao, consultar conhecimento ou notificar admin.
- Nunca invente politicas, precos, cursos ou regras fora do que estiver no conhecimento disponivel.
- Dentro de uma mesma mensagem de WhatsApp, use linha em branco apenas para separar blocos visuais da mesma bolha.
- So use uma linha contendo apenas --- quando precisar abrir uma NOVA bolha de WhatsApp de forma intencional.
- Quebra de linha interna nunca significa nova bolha por si so.

CONTEXTO DINAMICO
- Etapa atual: ${input.subagent}
- Tipo de contato: ${getTipoContato(input.trigger)}
- Nome do lead: ${nome}
- Periodo: ${getPeriodo(timeZone)}
- Se o trigger for stage_handoff, assuma a conversa imediatamente nesta etapa, sem pedir permissao e sem esperar nova resposta do lead.
- Se o trigger for stage_handoff e a etapa atual nao for E1, a etapa anterior ja terminou sua validacao final. Nao repita parabens, elogios, comemoracao da decisao ou resumo da etapa anterior. Comece apenas pela primeira acao propria desta etapa.
`.trim();
}

function normalizeForCourseDetection(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCourseQueryCandidate(text: string) {
  const normalized = normalizeForCourseDetection(text)
    .replace(/\baudio transcrito\b/g, ' ')
    .replace(/\b(eu|a|o|as|os|uma|um)\b/g, ' ')
    .replace(/\b(voces|voce|tem|temos|oferece|ofertam|possui|existe|quero|queria|gostaria|saber|sobre|curso|cursos|graduacao|graduacoes|faculdade|de|do|da|dos|das|pra|para|ai|informacoes|informacao|tenho|interesse|estou|pensando|fazer|nao)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || normalizeForCourseDetection(text);
}

function simplifyCourseQuery(query: string) {
  return normalizeForCourseDetection(query)
    .replace(/\b(ead|semipresencial|presencial|hibrido|noturno|matutino|vespertino)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIntentText(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeCurrentCourseFollowup(message: string) {
  const normalized = normalizeIntentText(message);
  if (!normalized) return false;

  const exact = new Set([
    'como funciona',
    'como e',
    'como é',
    'qual valor',
    'quais valores',
    'quanto custa',
    'quanto e',
    'quanto é',
    'tem bolsa',
    'qual a duracao',
    'qual a duração',
    'quanto tempo dura',
    'qual modalidade',
    'ead',
    'semipresencial',
    'presencial',
  ]);
  if (exact.has(normalized)) return true;

  const patterns = [
    'como funciona o curso',
    'como funciona essa graduacao',
    'como funciona essa graduação',
    'quero saber mais',
    'me fala mais',
    'me explique melhor',
    'quero mais informacoes',
    'quero mais informações',
    'sobre valores',
    'sobre o valor',
    'sobre bolsa',
    'sobre a bolsa',
    'sobre duracao',
    'sobre duração',
    'sobre modalidade',
  ];
  return patterns.some((pattern) => normalized.includes(pattern));
}

function hasAnyCourseLookup(toolCalls: Array<{ name: string; args: unknown; result?: unknown; blocked?: boolean }>) {
  return toolCalls.some((call) => {
    if (call.name !== 'consultar_conhecimento') return false;
    const args = call.args as Record<string, unknown> | undefined;
    return String(args?.tipo || '').toLowerCase() === 'course';
  });
}

function hasSuccessfulCourseLookup(toolCalls: Array<{ name: string; args: unknown; result?: unknown; blocked?: boolean }>) {
  return toolCalls.some((call) => {
    if (call.name !== 'consultar_conhecimento') return false;
    const args = call.args as Record<string, unknown> | undefined;
    const result = call.result as Record<string, unknown> | undefined;
    return String(args?.tipo || '').toLowerCase() === 'course'
      && String(result?.match_status || '').toLowerCase() === 'found';
  });
}

function formatLeadFirstName(name: string | null | undefined) {
  return extractFirstName(name);
}

function normalizeCatalogText(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAreaLabel(area: string | null | undefined) {
  const raw = String(area || '').trim();
  if (!raw) return '';
  return raw;
}

function titleCaseNormalized(value: string) {
  return String(value || '')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .trim();
}

function normalizeDisplayLabel(value: string) {
  return String(value || '')
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase('pt-BR') + part.slice(1))
    .join(' ')
    .trim();
}

function stripInternalCourseMarkers(value: string) {
  return String(value || '')
    .replace(/\(\s*AREA BASICA DE INGRESSO\s*\)/gi, '')
    .replace(/\(\s*ABI\s*\)/gi, '')
    .replace(/\(\s*P\s*EGRESSO[^)]*\)/gi, '')
    .replace(/\(\s*EGRESSO[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBaseCourseName(value: string) {
  return getCourseDisplayName(value);
}

function extractAcademicLine(value: string) {
  const raw = String(value || '');
  if (/\(\s*bacharelado\s*\)/i.test(raw)) return 'Bacharelado';
  if (/\(\s*licenciatura\s*\)/i.test(raw)) return 'Licenciatura';
  if (/\(\s*tecnologo\s*\)/i.test(raw) || /\(\s*tecnólogo\s*\)/i.test(raw)) return 'Tecnologo';
  if (/\(\s*tecnico\s*\)/i.test(raw) || /\(\s*técnico\s*\)/i.test(raw)) return 'Tecnico';
  return '';
}

function uniqueByNormalized(items: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const item of items) {
    const key = normalizeCatalogText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function buildE1CourseLineReply(leadFirstName: string, listedCourses: string[]) {
  const courseName = extractBaseCourseName(listedCourses[0] || '');
  const lines = uniqueByNormalized(
    listedCourses.map((course) => extractAcademicLine(course)).filter(Boolean),
  );

  if (!courseName || lines.length <= 1) return null;

  const personalizedLead = leadFirstName ? `, ${leadFirstName}` : '';

  return [
    `${courseName} e uma escolha muito bacana${personalizedLead}!`,
    '',
    'Como ela tem caminhos diferentes de formacao, quero so entender qual faz mais sentido para voce.',
    '',
    `*${courseName}*`,
    '',
    ...lines.map((line) => `- ${line}`),
    '',
    'Qual linha voce pretende seguir?',
  ].join('\n');
}

function buildE1AreaReply(leadFirstName: string, requestedArea: string, listedCourses: string[]) {
  const areaName = normalizeDisplayLabel(requestedArea);
  const courses = uniqueByNormalized(
    listedCourses.map((course) => extractBaseCourseName(course)).filter(Boolean),
  );

  if (!areaName || courses.length === 0) return null;

  const personalizedLead = leadFirstName ? `, ${leadFirstName}` : '';

  return [
    `Boa escolha${personalizedLead}!! ${areaName} tem bastante opção por aqui.`,
    '',
    'Olha só algumas das graduações que temos nessa área:',
    '',
    `*${areaName}*`,
    '',
    ...courses.map((course) => `- ${course}`),
    '',
    'Qual desses mais combina com o que você está buscando?',
  ].join('\n');
}

function buildCatalogAreaQuestionReply() {
  return 'Temos bastante opções de graduação por aqui!!\n\nPra eu conseguir ser mais assertivo e não te mandar uma lista enorme de cursos de uma vez, me conta qual área você mais se identifica.';
}

function buildE1SelectedCatalogCourseReply(courseName: string) {
  const courseLabel = extractBaseCourseName(courseName) || courseName || 'Esse curso';
  return `${courseLabel} é uma excelente escolha!! Esse curso temos sim por aqui.\n\nMe confirma de qual cidade você é, por gentileza?`;
}

function buildDeterministicCatalogReply(params: {
  leadFirstName: string;
  latestUserMessage: string;
  lookupMode: string;
  subagent: Subagent;
  currentCity: string;
  result: Record<string, unknown>;
}) {
  return null;
  const matchStatus = String(params.result.match_status || '').toLowerCase();
  const matchedCourses = Array.isArray(params.result.matched_courses) ? params.result.matched_courses.filter(Boolean) : [];
  const listedCourses = Array.isArray(params.result.listed_courses) ? params.result.listed_courses.filter(Boolean) : [];
  const requestedArea = formatAreaLabel(String(params.result.requested_area || ''));

  if (params.lookupMode === 'specific' || params.lookupMode === 'specific_or_related') {
    if (matchStatus === 'found' && matchedCourses.length > 0) {
      if (params.subagent === 'E1' && !params.currentCity) {
        return `${extractBaseCourseName(String(matchedCourses[0] || 'Essa graduacao'))} e uma escolha muito bacana, ${params.leadFirstName}!\n\nQuero entender seu contexto direitinho por aqui.\n\nMe confirma agora de qual cidade voce fala?`;
      }
      return `${extractBaseCourseName(String(matchedCourses[0] || 'Essa graduacao'))} e uma escolha muito bacana, ${params.leadFirstName}!`;
    }

    if (matchStatus === 'not_found') {
      if (requestedArea) {
        return `Entendi o que voce procura, ${params.leadFirstName}.\n\nEssa graduacao especifica ainda nao esta entre as opcoes disponiveis por aqui.\n\nNessa area de ${requestedArea} temos outras possibilidades. Posso te apresentar?`;
      }
      return `Entendi o que voce procura, ${params.leadFirstName}.\n\nEssa graduacao especifica ainda nao esta entre as opcoes disponiveis por aqui.\n\nPosso te apresentar alternativas parecidas?`;
    }

    if (matchStatus === 'ambiguous_found' && listedCourses.length > 0) {
      const e1LineReply = params.subagent === 'E1' ? buildE1CourseLineReply(params.leadFirstName, listedCourses) : null;
      if (e1LineReply) return e1LineReply;
      return `Perfeito, ${params.leadFirstName}.\n\nMe diz qual dessas voce quer seguir?`;
    }
  }

  if (params.lookupMode.startsWith('browse') && matchStatus === 'browse_found') {
    const e1AreaReply = params.subagent === 'E1' ? buildE1AreaReply(params.leadFirstName, requestedArea, listedCourses) : null;
    if (e1AreaReply) return e1AreaReply;
    return 'Perfeito!\n\nVoce ja tem algum dessa area em especifico? Ou posso listar aqui pra voce todos que temos?';
  }

  if (params.lookupMode.startsWith('browse')) {
    if (matchStatus === 'browse_found') {
      return 'Perfeito! Nós temos alguns cursos excelentes nessa área.\n\nVocê já tem algum dessa área em específico? Ou posso listar aqui pra você todos que temos?';
    }

    if (matchStatus === 'browse_not_found') {
      return `${params.leadFirstName}, essa area em especifico nao ofertamos por enquanto.\n\nVoce tem algum outro curso ou area em mente?`;
    }
  }

  return null;
}

function buildCourseLookupFactStore(result: Record<string, unknown>, subagent: Subagent) {
  const matchStatus = String(result?.match_status || '').toLowerCase();
  const matchedCourses = Array.isArray(result?.matched_courses) ? result.matched_courses.filter(Boolean) : [];
  const listedCourses = Array.isArray(result?.listed_courses) ? result.listed_courses.filter(Boolean) : [];
  const listedAreas = Array.isArray(result?.listed_areas) ? result.listed_areas.filter(Boolean) : [];
  const firstItem = Array.isArray(result?.items) ? result.items[0] : null;

  const shared = {
    match_status: matchStatus || null,
    course_status: matchStatus === 'found'
      ? 'confirmed_available'
      : matchStatus === 'ambiguous_found'
        ? 'ambiguous_available'
        : matchStatus === 'not_found'
          ? 'confirmed_unavailable'
          : matchStatus === 'browse_areas_found'
            ? 'catalog_exploration'
          : matchStatus === 'browse_found'
            ? 'catalog_area_selected'
            : matchStatus === 'browse_not_found'
              ? 'segment_unavailable'
              : null,
    course_display_name: extractBaseCourseName(String(matchedCourses[0] || firstItem?.nome || '')) || null,
    course_line: extractAcademicLine(String(matchedCourses[0] || firstItem?.nome || '')) || null,
    requested_area: formatAreaLabel(String(result?.requested_area || '')) || null,
    available_course_lines: Array.isArray(result?.available_course_lines)
      ? result.available_course_lines.filter(Boolean).map((line) => String(line))
      : [],
    available_areas: listedAreas.map((area) => formatAreaLabel(String(area || ''))).filter(Boolean),
    listed_course_display_names: listedCourses.map((course) => extractBaseCourseName(String(course || ''))).filter(Boolean),
    related_area_course_display_names: Array.isArray(result?.related_area_courses)
      ? result.related_area_courses.map((course) => getCourseDisplayName(String(course || ''))).filter(Boolean)
      : [],
  };

  if (subagent === 'E1' || subagent === 'E2') {
    return shared;
  }

  return {
    ...shared,
    modalidade: firstItem?.modalidade || null,
    duracao: firstItem?.duracao || null,
    grau: firstItem?.grau || null,
  };
}

async function forceCourseLookup(params: {
  ctx: ToolContext;
  messages: ChatMessage[];
  out: SubagentOutput;
  query: string;
  lookupModeHint?: string | null;
}) {
  const args = { tipo: 'course', query: params.query, lookup_mode_hint: params.lookupModeHint || null };
  let result: unknown;
  try {
    result = await (TOOL_IMPL as any).consultar_conhecimento(params.ctx, args);
  } catch (error) {
    result = {
      error: String(error),
      total: 0,
      items: [],
      tipo_busca: 'structured_course_catalog',
      nota: 'Falha ao consultar catalogo oficial.',
    };
  }
  const factStore = buildCourseLookupFactStore(result as Record<string, unknown>, (params.ctx.env.CURRENT_SUBAGENT as Subagent) || 'E1');
  const structuredResult = (() => {
    try {
      return JSON.stringify(factStore ?? null, null, 2);
    } catch {
      return String(factStore ?? null);
    }
  })();
  params.messages.push({
    role: 'system',
    content: [
      'RESULTADO DA CONSULTA OBRIGATORIA DE CURSO',
      '- Esta consulta foi executada automaticamente pelo backend antes da resposta textual.',
      '- Trate o bloco abaixo como a fonte oficial para confirmar ou negar disponibilidade do curso.',
      '- O resultado da tool controla os FATOS, mas o jeito de falar deve seguir primeiro o prompt da etapa atual, a PERSONALITY e as regras da dashboard.',
      '- Nao diga que existe curso sem usar este resultado.',
      '- Nao diga que nao existe curso sem usar este resultado.',
      '- So considere curso encontrado quando `match_status` for `found`.',
      '- Se `match_status` for `found`, isso significa curso confirmado como ofertado.',
      '- Em E1, quando `match_status` for `found`, deixe claro para o lead que esse curso e uma opcao ofertada por aqui.',
      '- Em E1, depois de confirmar disponibilidade, a PERSONALITY pode reagir brevemente e de forma humana a escolha do lead antes da pergunta obrigatoria seguinte.',
      '- Em E1 e E2, voce so pode verbalizar o nome do curso e a linha academica, se realmente precisar pedir escolha entre Bacharelado e Licenciatura.',
      '- Em E1 e E2, NAO verbalize modalidade, duracao, semestres, grade, metodologia, instituicao, suporte, preco, bolsa ou qualquer detalhe de produto.',
      '- Se `match_status` for `ambiguous_found`, significa que o curso existe, mas ha mais de uma linha valida para ele, como bacharelado e licenciatura.',
      '- Se `match_status` for `ambiguous_found`, liste as opcoes de `listed_courses` e pergunte qual linha o lead quer seguir.',
      '- Se `match_status` for `ambiguous_found`, NAO avance etapa, NAO peca cidade e espere o lead escolher a linha.',
      '- Se `match_status` for `browse_found`, significa que a consulta por area, modalidade, grau ou filtro encontrou cursos validos.',
      '- Se `match_status` for `browse_found`, liste os cursos de `listed_courses` e pergunte qual opcao interessou mais.',
      '- Se `match_status` for `browse_found`, NAO avance etapa, NAO peca cidade e espere o lead escolher um curso ou refinar o filtro.',
      '- Se `match_status` for `not_found`, trate como curso especificamente indisponivel por aqui.',
      '- Se `match_status` for `not_found`, NAO peca cidade, NAO faca perguntas da etapa comercial e NAO avance etapa.',
      '- Se `match_status` for `not_found`, explique de forma humana que essa graduacao especifica nao esta entre as opcoes ofertadas por aqui.',
      '- Se `match_status` for `not_found`, mantenha o redirecionamento dentro da mesma area/segmento oficial de `requested_area`.',
      '- Se `match_status` for `not_found`, ofereca ajuda para mostrar alternativas proximas da mesma area antes de listar cursos.',
      '- Se `match_status` for `not_found`, a formulacao exata deve seguir o prompt da etapa. Nao revele backend, catalogo, consulta interna ou wording tecnico se o prompt proibir isso.',
      '- Se `match_status` for `not_found`, conduza apenas para outra opcao da mesma area, mantendo uma unica pergunta por vez.',
      '- Se `match_status` for `browse_found`, liste apenas cursos reais do mesmo segmento encontrado.',
      '- Se `match_status` for `browse_not_found`, informe a ausencia de opcoes para esse segmento usando o estilo editorial da etapa e peca outra area ou curso especifico sem linguagem tecnica.',
      '- Se houver `error`, trate como falha tecnica de consulta e nao invente disponibilidade.',
      '',
      structuredResult,
    ].join('\n'),
  });
  params.out.toolCalls.push({ name: 'consultar_conhecimento', args, result });
  return result;
}

async function loadPromptConfig(supabase: any, tenantId: string, key: string) {
  const { data } = await supabase
    .from('agent_definitions')
    .select('config')
    .eq('tenant_id', tenantId)
    .eq('subagent_key', key)
    .maybeSingle();

  return data?.config ?? {};
}

function resolveEditorialPrompt(config: Record<string, unknown>, fallback = '') {
  const override = typeof config?.prompt_override === 'string' ? config.prompt_override.trim() : '';
  const defaultPrompt = typeof config?.default_prompt === 'string' ? config.default_prompt.trim() : '';
  return override || defaultPrompt || fallback;
}

function buildIntelligenceContext(intelligence?: Record<string, unknown> | null) {
  if (!intelligence) return '';

  return `\n\nMEMORIA COMERCIAL ESTRUTURADA
- INTENCAO IDENTIFICADA: ${intelligence.intent || 'nao identificada'}
- ESTAGIO DE COMPRA: ${intelligence.buying_stage || 'nao identificado'}
- TEMPERATURA DO LEAD: ${intelligence.temperature || 'nao identificada'}
- OBJECAO PRINCIPAL: ${intelligence.primary_objection || 'nenhuma'}
- URGENCIA: ${intelligence.urgency || 'nao identificada'}
- PROXIMA MELHOR ACAO: ${intelligence.next_best_action || 'nao definida'}
- LEAD PRONTO PARA PROPOSTA: ${intelligence.proposal_ready ? 'sim' : 'nao'}
- LEAD PRONTO PARA MATRICULA: ${intelligence.enrollment_ready ? 'sim' : 'nao'}
- PRECISA HANDOFF: ${intelligence.needs_handoff ? 'sim' : 'nao'}
- RESUMO COMERCIAL: ${intelligence.summary || 'sem resumo'}

REGRAS DE USO
- O processo da etapa atual continua sendo a base.
- Se a intencao real do lead estiver mais avancada, adapte a conversa sem perder o controle comercial.
- Se a proxima melhor acao for responder pergunta ou tratar objecao, faca isso antes de tentar avancar.
- Se o lead estiver pronto para proposta ou matricula, conduza com objetividade.`;
}

export interface InboundMessage {
  text: string;
  received_at: string;
  delay_ms?: number;
}

export interface SubagentInput {
  subagent: Subagent;
  leadId: string;
  telefone: string;
  etapaAtual: string;
  recentUserMessages: string[];
  history: ChatMessage[];
  messages?: InboundMessage[];
  trigger: string;
  nomeDoLead: string | null;
  supabase: any;
  tenantId: string;
  env: Record<string, string>;
  messagePolicy?: Record<string, unknown> | null;
  intelligence?: Record<string, unknown> | null;
  leadSnapshot?: Record<string, unknown> | null;
  regenerationContext?: {
    allowedIntent: string;
    speakableFacts: Record<string, unknown>;
    forbiddenTopics: string[];
    originalOutput: string;
  } | null;
}

export interface SubagentOutput {
  text?: string;
  atomicMessages?: string[];
  toolCalls: Array<{ name: string; args: unknown; result?: unknown; blocked?: boolean }>;
  handoff: boolean;
  avancou: boolean;
  iterations: number;
  responseOrigin?: string;
  deterministicReplyUsed?: boolean;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  outputBeforeGovernance?: string | null;
  stageContractViolation?: boolean;
  forbiddenTopicsDetected?: string[];
  regenerationTriggered?: boolean;
  regeneratedOutput?: string | null;
  originalOutput?: string | null;
  pendingCriterionBefore?: string | null;
  pendingCriterionAfter?: string | null;
  allowedIntent?: string | null;
  processAction?: string | null;
  conversationalBehavior?: string | null;
  speakableFacts?: Record<string, unknown> | null;
  personalityPromptId?: string | null;
  stagePromptId?: string | null;
  rawModelOutput?: string | null;
  institutionalClaimsPending?: string[];
}

function buildVirtualLeadSnapshot(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
  statePatch: Record<string, unknown>;
}) {
  const lead = { ...(params.leadSnapshot || {}) } as Record<string, unknown>;
  const salesContext = { ...((lead.sales_context || {}) as Record<string, unknown>) };
  const patch = params.statePatch || {};

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'cidade') {
      lead.cidade = value;
      continue;
    }
    if (key === 'pending_criterion') continue;
    if (key === 'motivacao_principal' || key === 'line_selection_required' || key === 'linha_formacao') {
      salesContext[key] = value;
      continue;
    }
    salesContext[key] = value;
  }

  lead.sales_context = salesContext;
  return lead;
}

function buildStageContractContext(params: {
  stage: string;
  pendingCriterionBefore: string | null;
  pendingCriterionAfter: string | null;
  stageMatched: boolean;
  currentCourseInterest: string;
  currentCity: string;
  leadSnapshot: Record<string, unknown> | null | undefined;
}) {
  const salesContext = { ...((params.leadSnapshot?.sales_context || {}) as Record<string, unknown>) };
  const effectiveCourseInterest = String(params.leadSnapshot?.curso_interesse || params.currentCourseInterest || '').trim();
  const effectiveCity = String(params.leadSnapshot?.cidade || params.currentCity || '').trim();
  const courseLine = String(salesContext.linha_formacao || '').trim() || null;
  const courseStatus = String(salesContext.course_status || '').trim() || null;
  const requestedCourse = String(salesContext.requested_course || '').trim() || null;
  const requestedArea = String(salesContext.requested_area_name || '').trim() || null;
  const relatedAreaCourses = Array.isArray(salesContext.related_area_courses)
    ? salesContext.related_area_courses.filter(Boolean).map((item) => getCourseDisplayName(String(item))).filter(Boolean)
    : [];
  const availableCourseLines = Array.isArray(salesContext.available_course_lines)
    ? salesContext.available_course_lines.filter(Boolean).map((item) => String(item))
    : [];
  const availableAreas = Array.isArray(salesContext.available_catalog_areas)
    ? salesContext.available_catalog_areas.filter(Boolean).map((item) => String(item))
    : [];
  const speakableCourseName = deriveSpeakableCourseName(effectiveCourseInterest, salesContext);
  const speakableCourseLine = ['E1', 'E2'].includes(params.stage) ? null : courseLine;
  const speakableFacts: Record<string, unknown> = {
    course_name: speakableCourseName,
    course_line: speakableCourseLine,
    course_status: courseStatus,
    city: effectiveCity || null,
    pending_criterion_before: params.pendingCriterionBefore,
    pending_criterion_after: params.pendingCriterionAfter,
  };
  if (requestedCourse) speakableFacts.requested_course = requestedCourse;
  if (requestedArea) speakableFacts.requested_area = requestedArea;
  if (relatedAreaCourses.length > 0) speakableFacts.related_area_courses = relatedAreaCourses;
  if (availableCourseLines.length > 0) speakableFacts.available_course_lines = availableCourseLines;
  if (availableAreas.length > 0) speakableFacts.available_areas = availableAreas;
  if (salesContext.course_was_selected_from_offered_list === true && speakableCourseName) {
    speakableFacts.selected_course = speakableCourseName;
    speakableFacts.course_was_selected_from_offered_list = true;
    speakableFacts.immutable_facts = [
      'este e o curso escolhido pelo lead',
      'o curso foi selecionado da lista apresentada',
      'nao oferecer outros cursos sem pedido explicito',
      'nao declarar esse curso indisponivel se catalogo confirmou disponibilidade',
    ];
  }

  if (params.stage === 'E1') {
    const nextCriterion = getNextE1Criterion({ leadSnapshot: params.leadSnapshot });

    if (nextCriterion === 'course_line') {
      return {
        processAction: 'ask_course_line',
        conversationalBehavior: 'present_only_real_available_lines_and_wait_for_choice',
        allowedIntent: 'confirm_course_exists_and_ask_only_for_real_available_line_choice',
        speakableFacts,
      };
    }

    if (nextCriterion === 'alternative_course_selection') {
      return {
        processAction: 'present_segment_options_and_wait_selection',
        conversationalBehavior: 'present_only_real_same_segment_options_and_wait_for_new_choice',
        allowedIntent: 'present_same_segment_alternatives_and_wait_for_specific_course_choice',
        speakableFacts,
      };
    }

    if (nextCriterion === 'catalog_area_selection') {
      return {
        processAction: 'present_real_areas_and_wait_selection',
        conversationalBehavior: 'present_only_real_catalog_areas_and_wait_for_area_choice',
        allowedIntent: 'present_real_catalog_areas_and_ask_which_area_matches_best',
        speakableFacts,
      };
    }

    if (nextCriterion === 'course_selection') {
      return {
        processAction: 'present_area_courses_and_wait_selection',
        conversationalBehavior: 'present_only_real_area_courses_and_wait_for_specific_course_choice',
        allowedIntent: 'present_real_courses_from_selected_area_and_wait_for_course_choice',
        speakableFacts,
      };
    }

    if (nextCriterion === 'new_direction') {
      return {
        processAction: 'ask_for_new_direction',
        conversationalBehavior: 'explain_absence_naturally_without_inventing_segment',
        allowedIntent: 'explain_unavailable_course_without_known_segment_and_ask_for_new_direction',
        speakableFacts,
      };
    }

    if (nextCriterion === 'city') {
      return {
        processAction: 'ask_city',
        conversationalBehavior: courseStatus === 'confirmed_available' && courseLine
          ? 'acknowledge_course_or_line_choice_and_ask_city'
          : 'acknowledge_course_or_line_choice_and_ask_city',
        allowedIntent: 'confirm_course_available_and_ask_city',
        speakableFacts,
      };
    }

    if (nextCriterion === 'motivation') {
      return {
        processAction: 'ask_motivation',
        conversationalBehavior: 'confirm_course_is_offered_if_relevant_and_make_a_natural_transition_without_sounding_like_checklist',
        allowedIntent: 'confirm_course_available_and_ask_motivation',
        speakableFacts,
      };
    }

    if (params.pendingCriterionBefore === 'motivation' && params.pendingCriterionAfter === null) {
      return {
        processAction: 'advance_to_E2',
        conversationalBehavior: 'briefly_acknowledge_relevant_motivation_before_handoff',
        allowedIntent: 'contextual_acknowledgement_and_advance',
        speakableFacts,
      };
    }
  }

  if (params.stage === 'E2') {
    if (params.pendingCriterionAfter === 'vaccine_availability') {
      return {
        processAction: 'ask_vaccine_availability',
        conversationalBehavior: 'introduce_the_question_naturally',
        allowedIntent: 'natural_transition_and_ask_vaccine_availability',
        speakableFacts,
      };
    }
    if (params.pendingCriterionAfter === 'vaccine_decider') {
      return {
        processAction: 'ask_vaccine_decider',
        conversationalBehavior: 'transition_naturally_from_previous_answer',
        allowedIntent: 'natural_transition_and_ask_vaccine_decider',
        speakableFacts,
      };
    }
    if (params.pendingCriterionAfter === 'vaccine_agreement') {
      const agreementStatus = String(salesContext.e2_commercial_agreement_status || '').trim();
      return {
        processAction: agreementStatus === 'conditional_price_pending_confirmation'
          ? 'confirm_course_presentation_before_price'
          : 'ask_vaccine_agreement',
        conversationalBehavior: agreementStatus === 'conditional_price_pending_confirmation'
          ? 'validate_price_request_confirm_value_will_be_sent_and_ask_permission_to_present_course_first'
          : 'transition_naturally_without_sounding_mechanical',
        allowedIntent: agreementStatus === 'conditional_price_pending_confirmation'
          ? 'confirm_value_will_be_sent_then_ask_permission_to_present_course_and_methodology_first'
          : 'natural_transition_and_ask_vaccine_agreement',
        speakableFacts,
      };
    }
  }

  return {
    processAction: 'follow_stage_contract',
    conversationalBehavior: params.stageMatched
      ? 'preserve_contextual_continuity_with_human_tone'
      : 'follow_prompt_normally',
    allowedIntent: params.stageMatched
      ? 'contextual_continuity_with_stage_contract'
      : 'follow_stage_prompt_normally',
    speakableFacts,
  };
}

async function refreshStageContractAfterLookup(params: {
  input: SubagentInput;
  history: ChatMessage[];
  messages: ChatMessage[];
  out: SubagentOutput;
}) {
  const { data: refreshedLead } = await params.input.supabase
    .from('leads')
    .select('curso_interesse, cidade, sales_context')
    .eq('id', params.input.leadId)
    .maybeSingle();

  const refreshedLeadSnapshot = params.input.leadSnapshot
    ? {
      ...(params.input.leadSnapshot || {}),
      curso_interesse: refreshedLead?.curso_interesse ?? params.input.leadSnapshot?.curso_interesse ?? null,
      cidade: refreshedLead?.cidade ?? params.input.leadSnapshot?.cidade ?? null,
      sales_context: refreshedLead?.sales_context ?? params.input.leadSnapshot?.sales_context ?? {},
    }
    : (refreshedLead || null);

  const refreshedPendingCriterion = derivePendingCriterion({
    stage: params.input.etapaAtual,
    leadSnapshot: refreshedLeadSnapshot,
    history: params.history,
  });

  const refreshedStageContract = buildStageContractContext({
    stage: params.input.etapaAtual,
    pendingCriterionBefore: refreshedPendingCriterion,
    pendingCriterionAfter: refreshedPendingCriterion,
    stageMatched: false,
    currentCourseInterest: String(refreshedLead?.curso_interesse || '').trim(),
    currentCity: String(refreshedLead?.cidade || '').trim(),
    leadSnapshot: refreshedLeadSnapshot,
  });

  params.out.pendingCriterionBefore = refreshedPendingCriterion || null;
  params.out.pendingCriterionAfter = refreshedPendingCriterion || null;
  params.out.allowedIntent = refreshedStageContract.allowedIntent;
  params.out.processAction = refreshedStageContract.processAction;
  params.out.conversationalBehavior = refreshedStageContract.conversationalBehavior;
  params.out.speakableFacts = refreshedStageContract.speakableFacts;

  params.messages.push({
    role: 'system',
    content: [
      'CONTRATO POS-CONSULTA OBRIGATORIO',
      '- A consulta de curso ja atualizou o estado real do lead para este mesmo turno.',
      '- Ignore qualquer contrato anterior que tenha sido montado antes da consulta.',
      `- PROCESS_ACTION atualizado: ${refreshedStageContract.processAction}.`,
      `- CONVERSATIONAL_BEHAVIOR atualizado: ${refreshedStageContract.conversationalBehavior}.`,
      `- ALLOWED_INTENT atualizado: ${refreshedStageContract.allowedIntent}.`,
      `- SPEAKABLE_FACTS atualizados: ${JSON.stringify(refreshedStageContract.speakableFacts || {})}.`,
      '- Use somente esse estado atualizado para responder agora.',
      '- Nao antecipe cidade ou motivacao quando o estado pedir escolha de linha ou nova escolha de curso.',
      '- Nao mencione area, segmento ou alternativas se esses dados nao estiverem presentes em SPEAKABLE_FACTS.',
    ].join('\n'),
  });
}

export async function runSubagent(input: SubagentInput): Promise<SubagentOutput> {
  const allowed = TOOLS_BY_SUBAGENT[input.subagent];
  const toolSpecs = allowed.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
  const timeZone = input.env.BUSINESS_HOURS_TZ || 'America/Porto_Velho';
  const tracePrompts = isPromptTraceEnabled(input.env);

  const [personalityConfig, stageConfig] = await Promise.all([
    loadPromptConfig(input.supabase, input.tenantId, 'PERSONALITY').catch(() => ({})),
    loadPromptConfig(input.supabase, input.tenantId, input.subagent).catch(() => ({})),
  ]);

  const personalityPrompt = resolveEditorialPrompt(personalityConfig, DEFAULT_HELTON_PERSONALITY);
  const stagePrompt = resolveEditorialPrompt(stageConfig, STAGE_FALLBACKS[input.subagent]);
  const personalityPromptId = promptFingerprint(personalityPrompt || '');
  const stagePromptId = promptFingerprint(stagePrompt || '');

  const kernelPrompt = buildKernelContext({ ...input, timeZone });
  const renderedPersonality = personalityPrompt
    ? renderDynamicPrompt(personalityPrompt, input.trigger, input.nomeDoLead, timeZone)
    : '';

  const governancePrompt = buildGovernanceTagsPrompt(input.messagePolicy || {});
  let prompt = [kernelPrompt, governancePrompt, renderedPersonality, stagePrompt].filter(Boolean).join('\n\n');

  try {
    const unifiedKnowledgeItems = await fetchKnowledgeItems({
      supabase: input.supabase,
      tenantId: input.tenantId,
      limit: 32,
    });
    const unifiedKnowledgePrompt = knowledgeItemsToPrompt(unifiedKnowledgeItems);
    if (unifiedKnowledgePrompt) {
      prompt += unifiedKnowledgePrompt;
    }
  } catch (error) {
    console.warn(`[subagent] erro ao montar base de conhecimento unificada: ${error}`);
  }

  prompt += buildIntelligenceContext(input.intelligence);

  let history = input.history;
  if (input.messages && input.messages.length > 1) {
    const baseTime = new Date(input.messages[0].received_at).getTime();
    const multiEntries: ChatMessage[] = input.messages.map((message) => {
      const delaySec = Math.round((new Date(message.received_at).getTime() - baseTime) / 1000);
      const delayLabel = delaySec === 0 ? '(agora)' : `(${delaySec}s depois)`;
      return { role: 'user' as const, content: `${delayLabel} ${message.text}` };
    });

    const lastUserIdx = history
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.role === 'user')
      .pop()?.index;

    if (lastUserIdx !== undefined) {
      history = [
        ...history.slice(0, lastUserIdx),
        ...multiEntries,
        ...history.slice(lastUserIdx + 1),
      ];
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: prompt },
    ...history,
  ];
  const promptId = promptFingerprint(prompt);

  if (tracePrompts) {
    console.log(`[subagent] prompt_loaded stage=${input.subagent} prompt_id=${promptId} chars=${prompt.length} preview="${promptPreview(prompt)}"`);
    console.log(`[subagent] prompt_parts stage=${input.subagent} personality_chars=${renderedPersonality.length} stage_chars=${stagePrompt.length} knowledge_appended=${prompt.includes('BASE DE CONHECIMENTO')}`);
  }

  const toolCallRecords: ToolCallRecord[] = [];
  const out: SubagentOutput = {
    toolCalls: [],
    handoff: false,
    avancou: false,
    iterations: 0,
    responseOrigin: 'llm_free_generation',
    deterministicReplyUsed: false,
    fallbackUsed: false,
    fallbackReason: null,
    outputBeforeGovernance: null,
    stageContractViolation: false,
    forbiddenTopicsDetected: [],
    regenerationTriggered: false,
    regeneratedOutput: null,
    originalOutput: null,
  };
  const apiKey = input.env.OPENAI_API_KEY;
  const model = input.env.OPENAI_MODEL_SUBAGENT ?? 'gpt-4.1';
  const temperature = Number(input.env.OPENAI_TEMPERATURE ?? 0.8);
  const maxIterations = Number(input.env.OPENAI_MAX_ITERATIONS_SUBAGENT ?? 10);

  const ctx: ToolContext = {
    supabase: input.supabase,
    tenantId: input.tenantId,
    leadId: input.leadId,
    telefone: input.telefone,
    env: {
      ...input.env,
      CURRENT_SUBAGENT: input.subagent,
    },
  };

  const latestUserMessage = [...(input.recentUserMessages || [])].filter(Boolean).slice(-1)[0]
    || [...history].reverse().find((item) => item.role === 'user')?.content
    || '';
  const { data: leadContext } = await input.supabase
    .from('leads')
    .select('nome, lead_person_name, lead_first_name, lead_name_confidence, curso_interesse, cidade, modalidade, sales_context')
    .eq('id', input.leadId)
    .maybeSingle();
  const leadFirstName = String(leadContext?.lead_first_name || '').trim()
    || formatLeadFirstName(String(leadContext?.lead_person_name || leadContext?.nome || input.nomeDoLead || ''));
  if (shouldSendInitialE1Opening({
    subagent: input.subagent,
    history,
    latestUserMessage,
  })) {
    out.text = '';
    out.responseOrigin = 'structural_fallback';
    out.fallbackUsed = true;
    out.fallbackReason = 'initial_e1_opening_disabled';
    out.outputBeforeGovernance = out.text;
    return out;
  }
  if (false && input.etapaAtual === 'E3') {
    const e3Pending = derivePendingCriterion({
      stage: input.etapaAtual,
      leadSnapshot: input.leadSnapshot || leadContext || null,
      history,
    });
    const e3SalesContext = { ...((leadContext?.sales_context || input.leadSnapshot?.sales_context || {}) as Record<string, unknown>) };

    if (e3Pending === 'presentation' && e3SalesContext.e3_presentation_complete !== true) {
      const presentation = buildE3PresentationMessages({
        leadSnapshot: input.leadSnapshot || leadContext || null,
      });
      out.text = normalizeMessageText(presentation.messages.join('\n\n'));
      out.atomicMessages = presentation.messages;
      out.rawModelOutput = out.text;
      out.outputBeforeGovernance = out.text;
      out.deterministicReplyUsed = true;
      out.responseOrigin = 'structural_fallback';
      out.processAction = 'present_e3_structured_blocks';
      out.allowedIntent = 'present_institution_then_course_then_questions';
      out.conversationalBehavior = 'send_three_separate_e3_blocks_in_official_order';
      out.pendingCriterionBefore = 'presentation';
      out.pendingCriterionAfter = 'interest_signal';
      out.speakableFacts = presentation.facts;
      out.institutionalClaimsPending = presentation.pendingClaims;

      await input.supabase
        .from('leads')
        .update({
          sales_context: {
            ...e3SalesContext,
            e3_presentation_complete: true,
            e3_presentation_completed_at: new Date().toISOString(),
            e3_presentation_blocks_sent: ['institution', 'course', 'closing_question'],
            e3_institutional_claims_pending: presentation.pendingClaims,
            pending_criterion: 'interest_signal',
            last_agent_question_type: 'interest_signal',
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.leadId);

      return out;
    }
  }
  if (isMediaPlaceholderMessage(latestUserMessage)) {
    out.text = normalizeMessageText(
      'Nao consegui entender seu audio por aqui.\n\nPode me mandar em texto ou reenviar o audio, por favor?',
    );
    out.responseOrigin = 'structural_fallback';
    out.fallbackUsed = true;
    out.fallbackReason = 'media_placeholder';
    out.outputBeforeGovernance = out.text;
    return out;
  }
  const currentCourseInterest = String(leadContext?.curso_interesse || '').trim();
  const currentCity = String(leadContext?.cidade || '').trim();
  const currentSalesContext = { ...(leadContext?.sales_context || {}) } as Record<string, unknown>;
  const stageState = classifyInboundAgainstStageState({
    stage: input.etapaAtual,
    leadSnapshot: input.leadSnapshot || leadContext || null,
    history,
    latestUserMessage,
  });
  const pendingCriterionBefore = derivePendingCriterion({
    stage: input.etapaAtual,
    leadSnapshot: input.leadSnapshot || leadContext || null,
    history,
  });
  const virtualLeadSnapshot = stageState.matched
    ? buildVirtualLeadSnapshot({
      leadSnapshot: input.leadSnapshot || leadContext || null,
      statePatch: stageState.statePatch || {},
    })
    : (input.leadSnapshot || leadContext || null);
  const pendingCriterionAfter = derivePendingCriterion({
    stage: input.etapaAtual,
    leadSnapshot: virtualLeadSnapshot,
    history,
  });
  const stageContract = buildStageContractContext({
    stage: input.etapaAtual,
    pendingCriterionBefore,
    pendingCriterionAfter,
    stageMatched: stageState.matched,
    currentCourseInterest,
    currentCity,
    leadSnapshot: virtualLeadSnapshot,
  });
  const stabilizedStageContract = input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_course_line'
    && pendingCriterionAfter === 'city'
    ? {
      ...stageContract,
      processAction: 'ask_city',
      conversationalBehavior: 'acknowledge_course_or_line_choice_and_ask_city',
      allowedIntent: 'confirm_course_available_and_ask_city',
      speakableFacts: {
        ...(stageContract.speakableFacts || {}),
        pending_criterion_before: pendingCriterionBefore,
        pending_criterion_after: 'city',
      },
    }
    : input.etapaAtual === 'E1'
        && stageState.classificationReason === 'resolved_pending_motivation'
        && pendingCriterionAfter === null
      ? {
        ...stageContract,
        processAction: 'complete_stage',
        conversationalBehavior: 'optional_short_contextual_acknowledgement',
        allowedIntent: 'complete_e1_and_handoff_to_e2',
        speakableFacts: {
          ...(stageContract.speakableFacts || {}),
          pending_criterion_before: pendingCriterionBefore,
          pending_criterion_after: null,
        },
      }
      : stageContract;
  out.pendingCriterionBefore = pendingCriterionBefore || null;
  out.pendingCriterionAfter = pendingCriterionAfter || null;
  out.allowedIntent = stabilizedStageContract.allowedIntent;
  out.processAction = stabilizedStageContract.processAction;
  out.conversationalBehavior = stabilizedStageContract.conversationalBehavior;
  out.speakableFacts = stabilizedStageContract.speakableFacts;
  out.personalityPromptId = personalityPromptId;
  out.stagePromptId = stagePromptId;
  if (false && (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_city'
    && pendingCriterionAfter === 'motivation'
  )) {
    out.text = normalizeMessageText(buildE1AskMotivationReply());
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'handle_travel_or_move_and_ask_vaccine_decider';
    out.allowedIntent = 'handle_travel_or_move_with_confirmed_modality_then_ask_decision_maker';
    out.conversationalBehavior = 'contextual_objection_handling_without_generic_routine_question';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_motivation'
    && pendingCriterionAfter === null
  )) {
    out.text = normalizeMessageText(buildE1CompletionAcknowledgement({
      latestUserMessage,
      courseName: deriveSpeakableCourseName(currentCourseInterest, currentSalesContext),
    }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'ask_vaccine_agreement';
    out.allowedIntent = 'acknowledge_decision_participant_then_ask_commercial_agreement';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && stageState.classificationReason === 'resolved_pending_vaccine_1_travel_or_move'
    && pendingCriterionAfter === 'vaccine_decider'
  )) {
    out.text = normalizeMessageText(buildE2TravelMoveReply({
      latestUserMessage,
      modality: currentSalesContext.modalidade_oferta || currentSalesContext.delivery_mode || leadContext?.modalidade || null,
    }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'confirm_course_presentation_before_price';
    out.allowedIntent = 'confirm_value_will_be_sent_then_ask_permission_to_present_course_and_methodology_first';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && stageState.classificationReason === 'resolved_pending_vaccine_2'
    && pendingCriterionAfter === 'vaccine_agreement'
  )) {
    out.text = normalizeMessageText(buildE2AgreementReply({
      decisionParticipant: String(stageState.statePatch?.e2_decision_participant || currentSalesContext.e2_decision_participant || '').trim() || null,
    }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && stageState.classificationReason === 'conditional_price_pending_confirmation'
    && pendingCriterionAfter === 'vaccine_agreement'
  )) {
    out.text = normalizeMessageText(buildE2ConditionalPriceReply());
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    return out;
  }
  if (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'selected_catalog_course'
    && String(stageState.statePatch?.curso_interesse || '').trim()
  ) {
    const selectedCourse = String(stageState.statePatch.curso_interesse || '').trim();
    await forceCourseLookup({ ctx, messages, out, query: selectedCourse, lookupModeHint: 'specific' });
    await refreshStageContractAfterLookup({
      input,
      history,
      messages,
      out,
    });
    out.pendingCriterionBefore = 'course_selection';
    out.pendingCriterionAfter = 'city';
    out.allowedIntent = 'confirm_selected_course_and_continue_e1';
    out.processAction = 'confirm_selected_course_and_continue_e1';
    out.conversationalBehavior = 'recognize_chosen_course_confirm_available_and_ask_city_without_relisting_catalog';
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      course_name: selectedCourse,
      course_status: 'confirmed_available',
      pending_criterion_before: 'course_selection',
      pending_criterion_after: 'city',
    };
    messages.push({
      role: 'system',
      content: [
        'SELECAO DE CURSO DO CATALOGO RESOLVIDA',
        `- O lead escolheu um curso real da lista apresentada: ${selectedCourse}.`,
        '- Nao liste cursos novamente.',
        '- Nao ofereca alternativas espontaneamente.',
        '- Confirme de forma humana que essa graduacao e ofertada por aqui.',
        '- Depois peca somente a cidade do lead.',
        '- A PERSONALITY deve escrever a resposta; a estrutura apenas definiu a acao.',
      ].join('\n'),
    });
  }
  if (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'selected_catalog_area'
    && String(stageState.statePatch?.selected_area || stageState.statePatch?.requested_area_name || '').trim()
  ) {
    const selectedArea = String(stageState.statePatch.selected_area || stageState.statePatch.requested_area_name || '').trim();
    await forceCourseLookup({ ctx, messages, out, query: selectedArea, lookupModeHint: 'browse_area' });
    await refreshStageContractAfterLookup({
      input,
      history,
      messages,
      out,
    });
    const forcedLookupResult = out.toolCalls[out.toolCalls.length - 1]?.result as Record<string, unknown> | undefined;
    const relatedAreaCourses = Array.isArray(forcedLookupResult?.related_area_courses)
      ? forcedLookupResult.related_area_courses.filter(Boolean).map((course: unknown) => getCourseDisplayName(String(course))).filter(Boolean)
      : [];
    const requestedArea = String(forcedLookupResult?.requested_area || selectedArea).trim();
    out.pendingCriterionBefore = 'catalog_area_selection';
    out.pendingCriterionAfter = 'course_selection';
    out.allowedIntent = relatedAreaCourses.length > 0
      ? 'present_real_courses_from_selected_area_and_wait_for_course_choice'
      : 'handle_empty_selected_area_without_silence';
    out.processAction = relatedAreaCourses.length > 0
      ? 'present_area_courses_and_wait_selection'
      : 'handle_empty_catalog_area';
    out.conversationalBehavior = 'human_bridge_then_area_course_list_without_catalog_voice';
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      course_status: relatedAreaCourses.length > 0 ? 'catalog_area_selected' : 'catalog_area_empty',
      requested_area: requestedArea,
      related_area_courses: relatedAreaCourses,
      pending_criterion_before: 'catalog_area_selection',
      pending_criterion_after: 'course_selection',
    };
    messages.push({
      role: 'system',
      content: [
        'AREA DO CATALOGO RESOLVIDA NESTE TURNO',
        `- Area escolhida pelo lead: ${requestedArea}.`,
        `- Cursos reais disponiveis nesta area: ${JSON.stringify(relatedAreaCourses)}.`,
        '- O turno NAO termina apenas salvando area.',
        '- Se houver cursos reais, reaja humanamente e liste somente esses cursos.',
        '- Use formato obrigatorio com titulo da area em negrito e bullets dos cursos.',
        '- Depois pergunte qual curso mais combina com o que o lead esta buscando.',
        '- Se nao houver curso real, responda humanamente sem ficar silencioso e peca outra area ou graduacao.',
        '- Nao peca cidade, motivacao, modalidade ou detalhe de curso agora.',
        '- Nao use voz de catalogo, sistema ou formulario.',
        '- A PERSONALITY deve escrever a ponte; a estrutura apenas definiu fatos e acao.',
      ].join('\n'),
    });
  }
  const contextualReplyKind = stageState.matched
    ? String(stageState.pendingCriterion || stageState.lastAgentQuestionType || pendingCriterionBefore || 'contextual_response')
    : detectContextualReplyKind(latestUserMessage, history);
  const allowFreshIntentParsing = input.trigger !== 'stage_handoff';
  const catalogIntent = !allowFreshIntentParsing || stageState.matched
    ? { matched: false, mode: null, query: '', rawQuery: latestUserMessage }
    : detectCatalogIntentWithHistory(latestUserMessage, history);
  const catalogAreaSelectionIntent = input.etapaAtual === 'E1'
    && allowFreshIntentParsing
    && String(currentSalesContext.course_status || '') === 'catalog_exploration'
    ? {
      matched: true,
      mode: 'browse_area' as const,
      query: latestUserMessage.trim(),
      rawQuery: latestUserMessage,
    }
    : null;
  const catalogCourseSelectionIntent = input.etapaAtual === 'E1'
    && allowFreshIntentParsing
    && String(currentSalesContext.course_status || '') === 'catalog_area_selected'
    ? {
      matched: true,
      mode: 'specific' as const,
      query: latestUserMessage.trim(),
      rawQuery: latestUserMessage,
    }
    : null;
  const fallbackBrowseIntent = input.etapaAtual === 'E1'
    && allowFreshIntentParsing
    && String(currentSalesContext.course_status || '') === 'segment_options_available'
    && String(currentSalesContext.requested_area_name || '').trim()
    && userAcceptedSameSegmentAlternatives(latestUserMessage)
    ? {
      matched: true,
      mode: 'browse' as const,
      query: String(currentSalesContext.requested_area_name || '').trim(),
      rawQuery: latestUserMessage,
    }
    : null;
  const effectiveCatalogIntent = catalogAreaSelectionIntent || catalogCourseSelectionIntent || fallbackBrowseIntent || catalogIntent;
  const greetingOnlyFollowup = looksLikePureGreeting(latestUserMessage);
  const canUseCourseLookupInStage = ['E1', 'E3'].includes(input.etapaAtual);
  const shouldUseCurrentCourseContext = canUseCourseLookupInStage
    && allowFreshIntentParsing
    && Boolean(currentCourseInterest)
    && looksLikeCurrentCourseFollowup(latestUserMessage)
    && !effectiveCatalogIntent.matched;
  const mustConsultCourseBeforeReply = canUseCourseLookupInStage
    && !contextualReplyKind && effectiveCatalogIntent.matched
    && !greetingOnlyFollowup
    && ['specific', 'specific_or_related', 'browse', 'browse_area', 'browse_filter', 'browse_catalog'].includes(String(effectiveCatalogIntent.mode || ''));

  if (contextualReplyKind === 'city') {
    messages.push({
      role: 'system',
      content: [
        'A ultima mensagem do lead e resposta de CIDADE para a pergunta anterior do agente.',
        `Cidade informada agora: ${latestUserMessage}.`,
        currentCourseInterest
          ? `Curso ja confirmado no contexto atual: ${currentCourseInterest}.`
          : 'Ainda nao ha curso confirmado no lead salvo.',
        'NAO trate essa mensagem como nova consulta de curso.',
        'NAO chame consultar_conhecimento para essa resposta.',
        'Salve a cidade silenciosamente se ainda nao estiver salva e continue o fluxo normal da etapa.',
        'A redacao deve seguir exclusivamente o prompt da etapa e as regras da dashboard.',
      ].join('\n'),
    });
  }

  if (contextualReplyKind === 'motivation') {
    messages.push({
      role: 'system',
      content: [
        'A ultima mensagem do lead e resposta de MOTIVACAO/RELACAO COM A AREA para a pergunta anterior do agente.',
        currentCourseInterest
          ? `Curso atual confirmado: ${currentCourseInterest}.`
          : 'Ainda nao ha curso confirmado no lead salvo.',
        currentCity
          ? `Cidade atual salva: ${currentCity}.`
          : 'Cidade ainda nao esta salva no lead.',
        'NAO trate essa mensagem como nova consulta de curso.',
        'NAO chame consultar_conhecimento para essa resposta.',
        'Continue o fluxo normal da etapa conforme o prompt editorial.',
      ].join('\n'),
    });
  }

  if (stageState.matched && !['city', 'motivation'].includes(String(contextualReplyKind || ''))) {
    messages.push({
      role: 'system',
      content: [
        `A ultima mensagem do lead resolve o criterio pendente atual: ${stageState.pendingCriterion || pendingCriterionBefore || 'contexto atual'}.`,
        `Classificacao estrutural aplicada: ${stageState.classification}.`,
        `Motivo estrutural: ${stageState.classificationReason}.`,
        'NAO trate essa mensagem como nova intencao, nova consulta ou novo assunto.',
        'NAO sobrescreva curso, area, etapa ou estado validado com base nessa mensagem.',
        'Responda com continuidade contextual, alinhada ao prompt e a PERSONALITY, sem reabrir criterio ja concluido.',
      ].join('\n'),
    });
  }

  messages.push({
    role: 'system',
    content: [
      `CONTRATO ESTRUTURAL DA ETAPA ATUAL`,
      `- Etapa atual: ${input.etapaAtual}.`,
      `- Criterio pendente antes da mensagem atual: ${pendingCriterionBefore || 'nenhum'}.`,
      `- Criterio pendente depois da mensagem atual: ${pendingCriterionAfter || 'nenhum'}.`,
      `- Ultima pergunta relevante do agente: ${stageState.lastAgentQuestionType || pendingCriterionBefore || 'nenhuma'}.`,
      input.etapaAtual === 'E1'
        ? '- Em E1, curso validado internamente NAO significa curso apresentado ao lead.'
        : '- Siga estritamente o criterio pendente atual antes de abrir novo assunto.',
      ['E1', 'E2'].includes(input.etapaAtual)
        ? '- Em E1 e E2, e proibido verbalizar modalidade, duracao, semestres, grade, metodologia, instituicao, suporte, preco, bolsa, desconto ou qualquer detalhe de produto. Excecao unica: E2 pode verbalizar modalidade confirmada quando PROCESS_ACTION tratar viagem/mudanca real.'
        : '- Verbalize apenas o que a etapa atual permite.',
      `- PROCESS_ACTION: ${stabilizedStageContract.processAction}.`,
      `- CONVERSATIONAL_BEHAVIOR: ${stabilizedStageContract.conversationalBehavior}.`,
      `- ALLOWED_INTENT: ${stabilizedStageContract.allowedIntent}.`,
      `- SPEAKABLE_FACTS: ${JSON.stringify(stabilizedStageContract.speakableFacts || {})}.`,
      '- A estrutura define O QUE precisa acontecer.',
      '- A PERSONALITY define COMO isso entra naturalmente na conversa.',
      '- Nao reduza a resposta a uma pergunta seca se houver espaco para reacao contextual breve e proporcional.',
      '- Nunca reabra criterio ja concluido.',
      '- Se o criterio depois da mensagem atual for nenhum, nao invente nova pergunta; faca a transicao/avance permitido pela etapa.',
      '- Se `course_status` for `ambiguous_available`, use SOMENTE `available_course_lines` e nunca invente linha placeholder.',
      '- Se `course_status` for `catalog_exploration`, liste SOMENTE `available_areas`, nao peca cidade, nao peca motivacao e espere a escolha de area.',
      '- Se `course_status` for `catalog_area_selected`, liste SOMENTE cursos reais de `related_area_courses` e espere a escolha do curso.',
      '- Se `course_status` for `segment_options_available`, nao peca cidade, nao peca motivacao, nao avance e espere uma nova escolha de curso.',
      '- Se `course_status` for `segment_unavailable`, nao fale em mesma area ou segmento quando `requested_area` estiver vazio.',
    ].join('\n'),
  });

  if (input.regenerationContext) {
    const forbiddenTopics = input.regenerationContext.forbiddenTopics || [];
    const extraEditorialRules: string[] = [];
    if (forbiddenTopics.some((topic) => String(topic).includes('flow_narration') || String(topic).includes('flow_progress_narration'))) {
      extraEditorialRules.push('- Proibido narrar processo, progresso, etapa, continuidade ou proximos passos.');
      extraEditorialRules.push('- Faca a pergunta de forma direta e humana, sem explicar o fluxo.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('repeated_city'))) {
      extraEditorialRules.push('- Proibido repetir o nome da cidade informado pelo lead.');
      extraEditorialRules.push('- Use no maximo uma reacao curta e passe para a proxima pergunta.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unnecessary_single_line_mention'))) {
      extraEditorialRules.push('- Proibido verbalizar Bacharelado, Licenciatura ou outra linha unica interna nesta resposta.');
      extraEditorialRules.push('- Mencione apenas o nome comercial do curso.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('ungrounded_output'))) {
      extraEditorialRules.push('- Proibido mencionar area, segmento, cursos relacionados, alternativas proximas ou qualquer classificacao inferida.');
      extraEditorialRules.push('- Use somente os fatos explicitamente presentes em speakable_facts.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('catalog_selection_loop'))) {
      extraEditorialRules.push('- O lead ja escolheu um curso da lista apresentada.');
      extraEditorialRules.push('- Proibido listar cursos, oferecer alternativas ou voltar para a area.');
      extraEditorialRules.push('- Confirme humanamente o curso escolhido como ofertado e peca somente a cidade.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unavailable_dead_end_tone'))) {
      extraEditorialRules.push('- Curso indisponivel nao pode soar como beco sem saida.');
      extraEditorialRules.push('- Nao use "Infelizmente", "mas estou aqui para ajudar", "por favor me fale/informe" ou tom burocratico.');
      extraEditorialRules.push('- Reconheca a escolha de forma humana, diga que a graduacao especifica nao esta entre as opcoes e preserve a oportunidade.');
      extraEditorialRules.push('- Se houver requested_area e related_area_courses, conduza para alternativas reais da mesma linha.');
      extraEditorialRules.push('- Se nao houver segmento confiavel, peca nova direcao de forma leve e comercial.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('segment_unavailable_inferred_area'))) {
      extraEditorialRules.push('- Sem segmento confiavel: proibido mencionar fisica, ciencias exatas, area relacionada, curso relacionado, alternativas proximas ou segmento parecido.');
      extraEditorialRules.push('- Diga somente que essa graduacao especifica nao esta disponivel por aqui e pergunte qual outra graduacao ou area a pessoa considera.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unauthorized_stage_fact:instituicao') || String(topic).includes('unauthorized_stage_fact:institui'))) {
      extraEditorialRules.push('- Proibido mencionar instituicao, universidade ou "aqui na instituicao" nesta resposta.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unauthorized_stage_fact:early_stage_course_details'))) {
      extraEditorialRules.push('- Proibido apresentar produto, detalhes do curso ou qualquer informacao editorial fora do que a etapa permite.');
    }

    messages.push({
      role: 'system',
      content: [
        'REGENERACAO OBRIGATORIA DE RESPOSTA',
        `- A saida anterior violou o contrato estrutural da etapa ${input.etapaAtual}.`,
        `- Allowed intent: ${input.regenerationContext.allowedIntent}.`,
        `- Speakable facts: ${JSON.stringify(input.regenerationContext.speakableFacts || {})}.`,
        `- Forbidden topics detected: ${(input.regenerationContext.forbiddenTopics || []).join(', ') || 'nenhum informado'}.`,
        `- Original output proibido: ${input.regenerationContext.originalOutput || '(vazio)'}.`,
        '- Preserve o mesmo estado comercial e NAO avance etapa.',
        '- Nao invente texto estrutural proprio, nao use voz seca, nao use template fixo.',
        '- Reescreva a resposta agora usando a mesma PERSONALITY e o mesmo prompt da etapa.',
        '- Corrija somente a redacao editorial/comportamental; mantenha intactos stage, process_action, conversational_behavior e speakable_facts.',
        '- Se houver `flow_narration`, faca a pergunta/ponte diretamente sem narrar processo, etapa, continuidade ou progresso.',
        '- Se houver `repeated_city`, NAO repita o nome da cidade do lead; use no maximo uma reacao curta e siga.',
        '- Se houver `unnecessary_single_line_mention`, NAO verbalize Bacharelado/Licenciatura quando existe so uma linha interna.',
        '- Se houver `ungrounded_output`, NAO adicione area, segmento, curso relacionado ou fato que nao esteja em speakable_facts.',
        ...extraEditorialRules,
        '- Responda apenas com a nova mensagem final permitida para o lead.',
      ].join('\n'),
    });
  }

  if (shouldUseCurrentCourseContext) {
    const currentCourseQuery = buildCourseQueryCandidate(currentCourseInterest);
    if (currentCourseQuery && !hasAnyCourseLookup(out.toolCalls)) {
      if (tracePrompts) {
        console.log(`[subagent] current_course_followup_lookup stage=${input.subagent} prompt_id=${promptId} course="${currentCourseInterest}" message="${latestUserMessage}"`);
      }
      await forceCourseLookup({ ctx, messages, out, query: currentCourseQuery, lookupModeHint: 'specific' });
      await refreshStageContractAfterLookup({
        input,
        history,
        messages,
        out,
      });
      messages.push({
        role: 'system',
        content: [
          `O lead ja tem um curso confirmado no contexto atual: ${currentCourseInterest}.`,
          `A ultima mensagem "${latestUserMessage}" NAO e um pedido para buscar um novo curso.`,
          'Interprete a mensagem como uma pergunta de continuidade sobre o curso ja escolhido.',
          'Responda sobre o curso atual usando o contexto e o retorno mais recente da consulta.',
          'Nao diga que o curso nao existe, a menos que a propria consulta do curso atual retorne `match_status = not_found` para esse mesmo curso.',
          'Nao troque o assunto para outro curso sem o lead pedir explicitamente.',
        ].join('\n'),
      });
    }
  }

  if (mustConsultCourseBeforeReply && !hasAnyCourseLookup(out.toolCalls)) {
    const initialQuery = buildCourseQueryCandidate(effectiveCatalogIntent.query || latestUserMessage);
    if (initialQuery) {
      if (tracePrompts) {
        console.log(`[subagent] preflight_course_lookup stage=${input.subagent} prompt_id=${promptId} query="${initialQuery}"`);
      }
      await forceCourseLookup({ ctx, messages, out, query: initialQuery, lookupModeHint: String(effectiveCatalogIntent.mode || '') || null });
      await refreshStageContractAfterLookup({
        input,
        history,
        messages,
        out,
      });
      const forcedLookupResult = out.toolCalls[out.toolCalls.length - 1]?.result as Record<string, unknown> | undefined;
      messages.push({
        role: 'system',
        content: [
          'A ultima mensagem do lead mencionou um curso especifico e a consulta obrigatoria no catalogo oficial ja foi executada.',
          'Regras obrigatorias para responder agora:',
          '- O retorno da tool define os fatos, mas a redacao final deve obedecer primeiro ao prompt da etapa atual, a PERSONALITY e as regras da dashboard.',
          '- So considere curso confirmado quando `match_status` for `found`.',
          '- Na E1, se `match_status` for `found` e a cidade ainda nao tiver sido confirmada, o proximo passo e reagir brevemente de forma humana a escolha e entao pedir a cidade.',
          '- Se `match_status` for `ambiguous_found`, o curso existe, mas o lead precisa escolher a linha correta.',
          '- Se `match_status` for `ambiguous_found`, liste somente as linhas reais presentes em `available_course_lines` e pergunte qual linha ele quer seguir.',
          '- Se `match_status` for `ambiguous_found`, NAO siga para cidade, motivacao ou avancar_etapa.',
          '- Se `match_status` for `browse_found`, liste os cursos de `listed_courses` e pergunte qual opcao interessou mais.',
          '- Se `match_status` for `browse_found`, NAO siga para cidade, motivacao ou avancar_etapa.',
          '- Se `match_status` for `not_found`, nao invente disponibilidade.',
          '- Se `match_status` for `not_found`, NAO siga com o processo comercial, NAO peca cidade e NAO faca pergunta de motivacao.',
          '- Se `match_status` for `not_found`, nao use wording tecnico como "catalogo", "consulta", "sistema" ou "nao localizei" se o prompt da etapa proibir isso.',
          '- Se `match_status` for `not_found` com `requested_area` e `related_area_courses`, reconheca a escolha, diga que essa graduacao especifica nao esta entre as opcoes, preserve a oportunidade nessa mesma linha e ofereca/lista somente alternativas reais desse segmento.',
          '- Se `match_status` for `not_found` com `requested_area` e `related_area_courses`, nao jogue imediatamente para outra area ou outro curso livre.',
          '- Se `match_status` for `not_found` sem `requested_area` ou sem alternativas reais, peca nova direcao de forma humana, sem tom burocratico, sem "Infelizmente", sem "por favor me informe".',
          '- Se `match_status` for `browse_not_found`, mantenha a mesma logica editorial e peca outra area, modalidade, grau ou curso especifico sem linguagem tecnica.',
          '- Se o lead pedir outra opcao da mesma area, consulte novamente o conhecimento com a nova busca antes de listar cursos.',
          '- Se houver falha tecnica na consulta, explique brevemente que o catalogo oficial nao respondeu agora e nunca confirme curso por suposicao.',
          `- Curso para exibir ao lead: ${extractBaseCourseName(String(forcedLookupResult?.matched_courses?.[0] || '')) || '(nao confirmado)'}.`,
          '- Nao use frase pronta, template fixo ou voz estrutural propria.',
        ].join('\n'),
      });

      if (
        input.etapaAtual === 'E1'
        && String(effectiveCatalogIntent.mode || '') === 'browse_catalog'
      ) {
        out.pendingCriterionBefore = 'course';
        out.pendingCriterionAfter = 'catalog_area_selection';
        out.allowedIntent = 'explain_many_courses_and_ask_area_to_be_assertive';
        out.processAction = 'ask_catalog_area';
        out.conversationalBehavior = 'human_explanation_before_area_question';
        messages.push({
          role: 'system',
          content: [
            'EXPLORACAO AMPLA DE CATALOGO',
            '- O lead pediu para conhecer cursos/opcoes/graduações em geral.',
            '- Nao liste cursos ainda.',
            '- Explique brevemente que existem muitas opcoes de graduacao.',
            '- Fale em primeira pessoa: para eu te mostrar melhor e nao te mandar lista enorme de uma vez.',
            '- Pergunte somente com qual area o lead mais se identifica.',
            '- Nao use frases meta como "perguntar sobre a area ajuda", "essa pergunta ajuda" ou "para fins de".',
            '- Evite voz de formulario, catalogo ou chatbot.',
            '- A PERSONALITY deve escrever a resposta; nao copie template fixo.',
          ].join('\n'),
        });
      }

      const relatedAreaCourses = Array.isArray(forcedLookupResult?.related_area_courses)
        ? forcedLookupResult.related_area_courses.filter(Boolean).map((course: unknown) => getCourseDisplayName(String(course))).filter(Boolean)
        : [];
      const requestedArea = String(forcedLookupResult?.requested_area || '').trim();
      if (
        input.etapaAtual === 'E1'
        && relatedAreaCourses.length > 0
        && requestedArea
        && ['browse', 'browse_area', 'browse_filter'].includes(String(effectiveCatalogIntent.mode || ''))
      ) {
        out.pendingCriterionBefore = 'catalog_area_selection';
        out.pendingCriterionAfter = 'course_selection';
        out.allowedIntent = 'present_real_courses_from_selected_area_and_wait_for_course_choice';
        out.processAction = 'present_area_courses_and_wait_selection';
        out.conversationalBehavior = 'human_bridge_then_area_course_list_without_catalog_voice';
        out.speakableFacts = {
          ...(out.speakableFacts || {}),
          course_status: 'catalog_area_selected',
          requested_area: requestedArea,
          related_area_courses: relatedAreaCourses,
          pending_criterion_before: 'catalog_area_selection',
          pending_criterion_after: 'course_selection',
        };
        messages.push({
          role: 'system',
          content: [
            'AREA DO CATALOGO ESCOLHIDA',
            `- Area escolhida: ${requestedArea}.`,
            '- Reaja humanamente e de forma curta a escolha da area.',
            '- Liste somente os cursos reais de `related_area_courses`.',
            '- Use formato obrigatório:',
            `*${requestedArea}*`,
            '- Nome do curso',
            '- Nome do curso',
            '- Depois pergunte qual curso mais combina com o que o lead esta buscando.',
            '- Nao use "Atualmente", "Para isso", "alem desse curso" ou voz de catalogo.',
            '- A PERSONALITY deve escrever a ponte; a estrutura apenas define lista e acao.',
          ].join('\n'),
        });
      }

      if (false && (
        input.etapaAtual === 'E1'
        && String(out.processAction || '').trim() === 'ask_city'
      )) {
        out.pendingCriterionBefore = 'course';
        out.pendingCriterionAfter = 'city';
        out.allowedIntent = 'confirm_course_available_and_ask_city';
        out.processAction = 'ask_city';
        out.conversationalBehavior = 'acknowledge_course_or_line_choice_and_ask_city';
        out.speakableFacts = {
          ...(out.speakableFacts || {}),
          city: null,
          pending_criterion_before: 'course',
          pending_criterion_after: 'city',
        };
        out.text = normalizeMessageText(buildE1ConfirmedAvailableAskCityReply({
          leadFirstName,
          courseName: deriveSpeakableCourseName(String(out.speakableFacts?.course_name || currentCourseInterest || ''), currentSalesContext),
        }));
        out.rawModelOutput = out.text;
        out.outputBeforeGovernance = out.text;
        out.deterministicReplyUsed = true;
        out.responseOrigin = 'structural_fallback';
        return out;
      }
    }
  }

  for (let i = 0; i < maxIterations; i += 1) {
    out.iterations = i + 1;

    if (tracePrompts) {
      console.log(`[subagent] llm_call stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} messages=${messages.length}`);
    }

    const res = await chatCompletions(apiKey, {
      model,
      messages,
      tools: toolSpecs,
      tool_choice: input.regenerationContext ? 'none' : 'auto',
      parallel_tool_calls: true,
      temperature,
    });

    const msg = res.choices[0]?.message;
    if (!msg) break;
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      if (mustConsultCourseBeforeReply && !hasAnyCourseLookup(out.toolCalls)) {
        const query = buildCourseQueryCandidate(latestUserMessage);
        if (query) {
          if (tracePrompts) {
            console.log(`[subagent] force_course_lookup stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} query="${query}"`);
          }
          await forceCourseLookup({ ctx, messages, out, query, lookupModeHint: String(effectiveCatalogIntent.mode || '') || null });
          const forcedLookupResult = out.toolCalls[out.toolCalls.length - 1]?.result as Record<string, unknown> | undefined;
          messages.push({
            role: 'system',
            content: 'CONSULTA OBRIGATORIA DE CURSO EXECUTADA PELO SISTEMA. Agora responda apenas com base no retorno da tool consultar_conhecimento. Os fatos devem seguir a tool, mas a redacao deve seguir o prompt da etapa, a PERSONALITY e as regras da dashboard. Nao use frase pronta ou voz estrutural propria.',
          });
          if (tracePrompts) {
            console.log(`[subagent] prompt_preserved_after_forced_lookup stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} system_messages=${messages.filter((item) => item.role === 'system').length}`);
          }
          continue;
        }
      }

      if (mustConsultCourseBeforeReply && !hasSuccessfulCourseLookup(out.toolCalls)) {
        const lastCourseLookup = [...out.toolCalls]
          .reverse()
          .find((call) => call.name === 'consultar_conhecimento' && String((call.args as any)?.tipo || '').toLowerCase() === 'course');

        const previousQuery = String((lastCourseLookup?.args as any)?.query || '').trim();
        const simplifiedQuery = simplifyCourseQuery(previousQuery);
        if (simplifiedQuery && simplifiedQuery !== previousQuery) {
          if (tracePrompts) {
            console.log(`[subagent] retry_course_lookup stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} previous_query="${previousQuery}" simplified_query="${simplifiedQuery}"`);
          }
          await forceCourseLookup({ ctx, messages, out, query: simplifiedQuery, lookupModeHint: String(effectiveCatalogIntent.mode || '') || null });
          await refreshStageContractAfterLookup({
            input,
            history,
            messages,
            out,
          });
          messages.push({
            role: 'system',
            content: 'UMA SEGUNDA CONSULTA DE CURSO FOI EXECUTADA COM QUERY SIMPLIFICADA. Agora responda apenas com base no retorno da tool consultar_conhecimento. Os fatos devem seguir a tool, mas a redacao deve seguir o prompt da etapa e as regras da dashboard. `found` confirma curso. `ambiguous_found` pede escolha da linha. `browse_found` confirma lista por area/filtro.',
          });
          if (tracePrompts) {
            console.log(`[subagent] prompt_preserved_after_retry_lookup stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} system_messages=${messages.filter((item) => item.role === 'system').length}`);
          }
          continue;
        }
      }

      const rawText = msg.content ?? undefined;
      out.rawModelOutput = rawText || null;
      out.text = rawText ? normalizeMessageText(rawText) : rawText;
      out.outputBeforeGovernance = out.text || null;
      if (input.regenerationContext) {
        out.originalOutput = input.regenerationContext.originalOutput || null;
        out.regeneratedOutput = out.text || null;
        out.regenerationTriggered = true;
        out.stageContractViolation = true;
        out.forbiddenTopicsDetected = [...(input.regenerationContext.forbiddenTopics || [])];
        out.responseOrigin = 'llm_regeneration';
      }
      if (out.text) {
        out.text = sanitizeStageHandoffText(out.text, input.trigger, input.subagent);
      }
      break;
    }

    for (const call of calls) {
      const name = call.function.name;
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }

      toolCallRecords.push({ name, argsHash: hashArgs(args) });
      if (detectLoop(toolCallRecords)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: '[loop-detector] mesma tool/args 3x - abortado',
        });
        out.toolCalls.push({ name, args, blocked: true, result: 'loop' });
        continue;
      }

      if (GUARDED_TOOLS.has(name) && !passesGuard({ toolName: name, recentUserMessages: input.recentUserMessages })) {
        const failure = guardFailureMessage(name);
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: failure });
        out.toolCalls.push({ name, args, blocked: true, result: failure });
        continue;
      }

      const impl = (TOOL_IMPL as any)[name];
      if (!impl) {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: `[unknown-tool:${name}]` });
        continue;
      }

      try {
        if (tracePrompts) {
          console.log(`[subagent] tool_call stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} tool=${name} args=${JSON.stringify(args)}`);
        }
        const result = await impl(ctx, args);
        if (name === 'acionar_handoff' && result?.ok !== false) out.handoff = true;
        if (name === 'avancar_etapa' && result?.ok === true) out.avancou = true;
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result ?? null) });
        out.toolCalls.push({ name, args, result });
        if (tracePrompts) {
          console.log(`[subagent] tool_result stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} tool=${name} result_chars=${JSON.stringify(result ?? null).length}`);
        }
      } catch (error) {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: `[error] ${String(error)}` });
        out.toolCalls.push({ name, args, result: { error: String(error) } });
      }
    }

    if (out.handoff) break;
  }

  return out;
}

export { TOOLS_BY_SUBAGENT, STAGE_FALLBACKS };
