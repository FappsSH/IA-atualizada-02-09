// subagent.ts - runtime editorial driven by dashboard prompts
// deno-lint-ignore-file
// @ts-nocheck

import { GUARDED_TOOLS, passesGuard, guardFailureMessage } from '../_shared/confirmation-guard.ts';
import { detectLoop, hashArgs, type ToolCallRecord } from '../_shared/loop-detector.ts';
import { chatCompletions, type ChatMessage } from '../_shared/openai-client.ts';
import { buildGovernanceTagsPrompt } from '../_shared/message-governance.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { TOOL_IMPL, type ToolContext } from './tools.ts';
import { fetchKnowledgeItems, getAuthorizedKnowledgeFacts, knowledgeItemsToPrompt } from './knowledge.ts';
import { detectCatalogIntentWithHistory, detectContextualReplyKind, isMediaPlaceholderMessage } from './catalog-resolver.ts';
import { classifyInboundAgainstStageState, derivePendingCriterion, getNextE1Criterion, getNextE2Criterion, looksLikeE3DoubtOrObjection } from './stage-state.ts';
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

function normalizeMessageText(text: string, preserveAtomicSeparators = false): string {
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

  return uniqueParts.join(preserveAtomicSeparators ? '\n---\n' : '\n\n').trim();
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
  const displayName = String(salesContext.course_display_name || '').trim();
  if (displayName) return getCourseDisplayName(displayName);
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

function buildInitialE1Opening(_leadFirstName: string, _greeting: string) {
  return '';
}

function buildE1CompletionAcknowledgement(params: {
  latestUserMessage: string;
  courseName: string | null;
}) {
  const normalized = normalizeSoft(params.latestUserMessage);
  if (normalized.includes('trabalho') || normalized.includes('area') || normalized.includes('atuo')) {
    return 'Excelente!!';
  }
  if (normalized.includes('sonho') || normalized.includes('sempre quis') || normalized.includes('objetivo')) {
    return 'Que legal!!';
  }
  if (normalized.includes('gosto') || normalized.includes('identifico') || normalized.includes('afinidade')) {
    return 'Muito bom!!';
  }
  return 'Perfeito!!';
}

function buildE1ConfirmedAvailableAskCityReply(_params: {
  leadFirstName: string;
  courseName: string | null;
}) {
  return '';
}

function buildE1AskMotivationReply() {
  return 'Perfeito!!\n\nMe conta, você já trabalha nessa área ou essa graduação representa um sonho ou objetivo pessoal pra você?';
}

function buildE2AgreementReply(_params?: { leadFirstName?: string | null; decisionParticipant?: string | null }) {
  return '';
}

function buildE2AvailabilityReply(_params?: { leadFirstName?: string | null }) {
  return '';
}

function buildE2DecisionReply(_params?: { leadFirstName?: string | null }) {
  return '';
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

function buildE2TravelMoveReply(_params: {
  latestUserMessage: string;
  modality?: string | null;
}) {
  return '';
}

function buildE2ConditionalPriceReply() {
  return '';
}

function sanitizeStageHandoffText(text: string, trigger: string, subagent: Subagent) {
  if (!text || trigger !== 'stage_handoff' || subagent === 'E1' || subagent === 'E3') return text;

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

function sanitizeE1CompleteStageText(text: string, processAction: string | null | undefined) {
  if (!text || String(processAction || '').trim() !== 'complete_stage') {
    return { text, applied: false, reason: null as string | null, before: text, after: text };
  }

  const normalized = (value: string) => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const forbiddenPatterns = [
    'viagem',
    'viajar',
    'mudanca',
    'mudar',
    'proximos meses',
    'interferir no inicio',
    'disponibilidade futura',
    'documentacao',
    'matricula',
    'processo',
    'proxima etapa',
    'proximo passo',
    'deixa eu te perguntar',
    'tambem quero saber',
    'me conta',
    'voce tem',
    'voce esta pronto',
    'na e2',
    'etapa e2',
    'subagente e2',
    'vou te ajudar com os passos',
    'indisponivel',
    'indispon?vel',
    'outras areas',
    'outras ?reas',
    'outra area',
    'outra ?rea',
    'outro curso',
    'vou verificar',
    'vou consultar',
    'vou checar',
    'vou buscar informacoes',
    'vou buscar informa??es',
    'estou verificando',
    'estou consultando',
    'estou analisando',
    'aguarde',
    'um momento',
    'so um momento',
    's? um momento',
  ];

  const keepSentence = (sentence: string) => {
    const candidate = sentence.trim();
    if (!candidate) return false;
    const value = normalized(candidate);
    if (candidate.includes('?')) return false;
    return !forbiddenPatterns.some((pattern) => value.includes(normalized(pattern)));
  };

  const sanitized = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph
      .split(/(?<=[.!?])\s+/)
      .filter(keepSentence)
      .join(' ')
      .trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return {
    text: sanitized,
    applied: sanitized !== text,
    reason: sanitized !== text ? 'e1_complete_stage_next_stage_leakage' : null,
    before: text,
    after: sanitized,
  };
}

function sanitizeE2CurrentCriterionText(text: string | undefined, processAction: string | null | undefined, latestUserMessage: string) {
  const original = normalizeMessageText(text || '');
  if (!original) return original;

  const action = String(processAction || '').trim();
  const latest = normalizeIntentText(latestUserMessage || '');
  const paragraphs = original.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length === 0) return original;

  if (action === 'ask_vaccine_decider') {
    const first = normalizeIntentText(paragraphs[0]);
    const looksLikeTravelNegative = ['nao tenho', 'não tenho', 'ate o momento nao', 'até o momento não'].some((item) => latest.includes(normalizeIntentText(item)));
    const validatesResolvedTravel = looksLikeTravelNegative
      && /\b(que bom|legal saber|otimo|perfeito|maravilha)\b/.test(first)
      && /\b(viagem|viajar|mudanca|mudar)\b/.test(first);
    if (validatesResolvedTravel && paragraphs.length > 1) {
      return paragraphs.slice(1).join('\n\n').trim();
    }
  }

  if (action === 'ask_vaccine_agreement') {
    const first = normalizeIntentText(paragraphs[0]);
    const selfDecision = ['eu mesmo', 'eu mesma', 'sozinho', 'so eu', 'só eu', 'decido'].some((item) => latest.includes(normalizeIntentText(item)));
    const agreementPreamble = /\b(vamos ao combinado|quero te fazer um combinado|quero fazer um combinado|quero te propor um combinado|posso te fazer um combinado|podemos fazer um combinado)\b/.test(first);
    if (agreementPreamble && paragraphs.length > 1) {
      return paragraphs.slice(1).join('\n\n').trim();
    }
    const validatesSelfDecision = selfDecision
      && /\b(perfeito|otimo|legal|show|maravilha)\b/.test(first)
      && !/\b(nao fizer sentido|nao encaixar|nao ficou legal|combinado)\b/.test(first);
    if (validatesSelfDecision && paragraphs.length > 1) {
      return paragraphs.slice(1).join('\n\n').trim();
    }
  }

  if (action === 'ask_vaccine_agreement') {
    return original
      .replace(/\s*,?\s*que est[aá] dispon[ií]vel na modalidade [^.\n?]+/gi, '')
      .replace(/\s*,?\s*dispon[ií]vel na modalidade [^.\n?]+/gi, '')
      .trim();
  }

  return original;
}

function promptActionLabel(value: unknown) {
  const action = String(value || '').trim();
  if (action === 'vaccine_availability') return 'travel_or_move_availability';
  if (action === 'vaccine_decider') return 'decision_participant';
  if (action === 'vaccine_agreement') return 'commercial_agreement';
  if (action === 'ask_vaccine_availability') return 'ask_travel_or_move_availability';
  if (action === 'ask_vaccine_decider') return 'ask_decision_participant';
  if (action === 'ask_vaccine_agreement') return 'present_commercial_agreement';
  return action;
}

function promptSafeJson(value: unknown) {
  return JSON.stringify(value || {}, (_key, currentValue) => {
    if (typeof currentValue === 'string') return promptActionLabel(currentValue);
    return currentValue;
  });
}

function sanitizeAuthorizedFactForPrompt(fact: Record<string, unknown>) {
  const allowedKeys = new Set(['claim_key', 'title', 'titulo', 'fact', 'fato', 'content', 'conteudo', 'text', 'texto', 'value', 'valor', 'stage', 'modality', 'modalidade', 'category', 'categoria']);
  const internalValuePattern = /(comunicacao comercial pode|comunica[cç][aã]o comercial pode|o agente pode|usar esse fato|metadata|instru[cç][aã]o|apresentar como)/i;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fact || {})) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === 'string' && internalValuePattern.test(value)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sanitizeAuthorizedFactsForPrompt(facts: Array<Record<string, unknown>>) {
  return (facts || [])
    .map((fact) => sanitizeAuthorizedFactForPrompt(fact))
    .filter((fact) => Object.keys(fact).length > 0);
}

function splitE3AtomicMessages(text: string | undefined) {
  return normalizeMessageText(text || '', true)
    .split('\n---\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

function coerceE3PresentationAtomicMessages(text: string | undefined) {
  const direct = splitE3AtomicMessages(text);
  if (direct.length !== 3) return direct;

  const finalParagraphs = direct[2]
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const questionIndex = finalParagraphs.findLastIndex((part) =>
    part.includes('?')
    && /(chamou.*atencao|fez sentido|mais gostou|mais sentido|mais chamou)/.test(normalizeIntentText(part))
  );
  if (questionIndex <= 0) return direct;

  return [
    direct[0],
    direct[1],
    finalParagraphs.slice(0, questionIndex).join('\n\n'),
    finalParagraphs.slice(questionIndex).join('\n\n'),
  ].filter(Boolean);
}

function extractE3MotivationAnchors(motivation: string) {
  const ignored = new Set([
    'sempre', 'mesmo', 'pessoal', 'porque', 'quero', 'queria', 'fazer', 'curso', 'area', 'graduacao', 'sonho', 'objetivo',
  ]);
  return [...new Set(
    normalizeIntentText(motivation)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5 && !ignored.has(token))
      .map((token) => token.slice(0, 4)),
  )].slice(0, 3);
}

function validateE3PresentationBlocks(params: {
  blocks: string[];
  courseName: string;
  modality: string;
  motivation: string;
  authorizedClaimKeys: string[];
}) {
  const blocks = params.blocks.map((block) => normalizeIntentText(block));
  const violations: string[] = [];
  if (blocks.length !== 4) return { valid: false, violations: ['invalid_message_count'] };

  const [institution, course, support, question] = blocks;
  if (!/(universidade|instituicao|cruzeiro|mec|diploma|reconhecimento|anos de mercado|historia)/.test(institution || '')) {
    violations.push('missing_institution_presentation');
  }
  const authorizedClaims = new Set(params.authorizedClaimKeys || []);
  if (authorizedClaims.has('institution_is_university') && !/(universidade|cruzeiro do sul)/.test(institution || '')) {
    violations.push('missing_institution_university_status');
  }
  if (authorizedClaims.has('institution_diploma_international_recognition') && !/(fora do brasil|exterior|outros paises|reconhecimento internacional|reconhecid[oa] internacionalmente|validade em outros paises)/.test(institution || '')) {
    violations.push('missing_international_diploma_recognition');
  }
  if (authorizedClaims.has('institution_university_advantage_vs_college') && !/(faculdade|centro universitario|diferencial|mesma forma)/.test(institution || '')) {
    violations.push('missing_university_advantage');
  }
  if (authorizedClaims.has('institution_60_plus_years') && !/\b6[0-9]\s*anos\b/.test(institution || '')) {
    violations.push('missing_institution_history');
  }
  if (authorizedClaims.has('institution_maximum_mec_rating') && !/(nota maxima|conceito maximo).*(mec)|mec.*(nota maxima|conceito maximo)/.test(institution || '')) {
    violations.push('missing_maximum_mec_rating');
  }
  if (authorizedClaims.has('institution_maximum_mec_since_beginning') && !/(desde o inicio|desde que comecou|desde quando comecamos|nota maxima.*mec|mec.*nota maxima)/.test(institution || '')) {
    violations.push('missing_maximum_mec_since_beginning');
  }

  const normalizedCourse = normalizeIntentText(String(params.courseName || '').split('(')[0].trim());
  const conciseCourse = normalizedCourse.replace(/^(cst em|bacharelado em|licenciatura em|tecnologo em)\s+/, '').trim();
  const normalizedModality = normalizeIntentText(params.modality || '');
  if (normalizedCourse && !course.includes(normalizedCourse) && (!conciseCourse || !course.includes(conciseCourse))) {
    violations.push('missing_course_name');
  }
  if (!/\b\d+\s*semestres?\b/.test(course) || !/\b\d+\s*anos?\b/.test(course)) violations.push('missing_course_duration');
  if (normalizedModality && !course.includes(normalizedModality)) violations.push('missing_course_modality');

  if (!/(tutor|suporte|acompanh|atendimento|professor|orienta|estrutura academica)/.test(support || '')) {
    violations.push('missing_academic_support');
  }
  const motivationSignal = /(sonho|objetivo|projeto|cresc|mudanc|area|carreira|sempre quis|vontade|construir)/.test(
    [institution, course, support, question].filter(Boolean).join(' '),
  );
  if (String(params.motivation || '').trim() && !motivationSignal) violations.push('missing_motivation_connection');
  const motivationAnchors = extractE3MotivationAnchors(String(params.motivation || ''));
  const presentationContent = [institution, course, support].filter(Boolean).join(' ');
  if (motivationAnchors.length > 0 && !motivationAnchors.some((anchor) => presentationContent.includes(anchor))) {
    violations.push('missing_specific_motivation_connection');
  }

  if (!question || !/(chamou.*atencao|fez sentido|mais gostou|mais sentido|mais chamou)/.test(question)) {
    violations.push('invalid_interest_question');
  }
  if (blocks.some((block) => /(carreira de sucesso|sucesso garantido)/.test(block))) {
    violations.push('unsupported_promotional_claim');
  }
  return { valid: violations.length === 0, violations };
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
- Nome confiavel disponivel, se ajudar naturalmente: ${nome}
- Nao use o nome como prefixo automatico, nem em perguntas consecutivas; use apenas quando acrescentar proximidade real.
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

function looksLikeE3SpecificQuestion(message: string) {
  const normalized = normalizeIntentText(message);
  if (!normalized) return false;
  if (/\b(valor|valores|preco|precos|bolsa|desconto|matricula|inscricao)\b/.test(normalized)) {
    return false;
  }

  const hasQuestionMarker = /(\?|como|qual|quais|quando|onde|funciona|funcionam|duvida|explica|me fala|me conta|queria saber)/.test(normalized);
  const hasE3Topic = /\b(tutor|tutores|tutoria|suporte|academico|professor|professores|aula|aulas|ead|semipresencial|presencial|modalidade|duracao|dura quanto|instituicao|universidade|diploma|mec|nota maxima)\b/.test(normalized);

  return hasQuestionMarker && hasE3Topic;
}

function looksLikeBroadCatalogRequest(message: string) {
  const normalized = normalizeIntentText(message);
  if (!normalized) return false;
  return /\b(quais|qual|conhecer|mostrar|ver|opcoes|opcao|cursos|graduacoes|graduacao)\b/.test(normalized)
    && /\b(cursos|graduacoes|graduacao|opcoes|opcao)\b/.test(normalized)
    && !/\b(radiologia|administracao|ciencias biologicas|analise e desenvolvimento|psicoterapia|astrofisica)\b/.test(normalized);
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

function buildE1CourseLineReply(_leadFirstName: string, _listedCourses: string[]) {
  return null;
}

function buildE1AreaReply(_leadFirstName: string, _requestedArea: string, _listedCourses: string[]) {
  return null;
}

function buildCatalogAreaQuestionReply() {
  return '';
}

function buildE1SelectedCatalogCourseReply(_courseName: string) {
  return '';
}

function buildDeterministicCatalogReply(_params: {
  leadFirstName: string;
  latestUserMessage: string;
  lookupMode: string;
  subagent: Subagent;
  currentCity: string;
  result: Record<string, unknown>;
}) {
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
    if (subagent === 'E1' && matchStatus === 'found') {
      return {
        course_display_name: shared.course_display_name,
      };
    }
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
      '- O bloco abaixo contem somente fatos que podem ser usados como contexto falavel.',
      '- Resultado positivo de disponibilidade foi consumido internamente e nao deve ser assunto da resposta.',
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
      '- Se `match_status` for `not_found`, use apenas esse estado factual e nao avance.',
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
  inboundResolution?: ReturnType<typeof classifyInboundAgainstStageState>;
  pendingCriterionBefore?: string | null;
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
  sanitizerApplied?: boolean;
  sanitizerReason?: string | null;
  sanitizerBefore?: string | null;
  sanitizerAfter?: string | null;
  llmTrace?: Record<string, unknown> | null;
}

function isLocalDebugLlmTraceEnabled(env: Record<string, string | undefined>) {
  const flag = String(env.DEBUG_LLM_TRACE || Deno.env.get('DEBUG_LLM_TRACE') || '').trim().toLowerCase() === 'true';
  if (!flag) return false;
  const url = String(
    env.NEXT_PUBLIC_SUPABASE_URL
      || env.SUPABASE_URL
      || Deno.env.get('NEXT_PUBLIC_SUPABASE_URL')
      || Deno.env.get('SUPABASE_URL')
      || '',
  ).trim();
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|kong)(?::|\/|$)/i.test(url) || url.includes('supabase_edge_runtime');
}

function sanitizeLlmTraceValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLlmTraceValue(item));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
      if (/(api[_-]?key|token|authorization|password|secret|service[_-]?role|bearer|cookie)/i.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeLlmTraceValue(rawValue);
      }
    }
    return result;
  }
  return value;
}

function traceMessages(messages: ChatMessage[]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    content: message.content ?? null,
    name: (message as any).name ?? null,
    tool_call_id: (message as any).tool_call_id ?? null,
    tool_calls: (message as any).tool_calls ?? null,
  }));
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

export function buildStageContractContext(params: {
  stage: string;
  pendingCriterionBefore: string | null;
  pendingCriterionAfter: string | null;
  stageMatched: boolean;
  currentCourseInterest: string;
  currentCity: string;
  leadSnapshot: Record<string, unknown> | null | undefined;
  authorizedFacts?: Array<Record<string, unknown>>;
  inboundResolution?: string;
  resolvedThisTurn?: unknown;
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
  const e3AuthorizedFacts = params.stage === 'E3' ? (params.authorizedFacts || []) : null;
  const speakableFacts: Record<string, unknown> = {
    course_name: speakableCourseName,
    course_line: speakableCourseLine,
    course_status: courseStatus,
    city: effectiveCity || null,
    pending_criterion_before: params.pendingCriterionBefore,
    pending_criterion_after: params.pendingCriterionAfter,
  };
  if (e3AuthorizedFacts) {
    speakableFacts.e3_authorized_facts = e3AuthorizedFacts;
    speakableFacts.e3_authorized_claim_keys = e3AuthorizedFacts.map((fact: any) => fact.claim_key).filter(Boolean);
  }
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
    speakableFacts.course_display_name = speakableCourseName;
    speakableFacts.e1_works_in_area = salesContext.e1_works_in_area === true;
    speakableFacts.e1_work_status_captured = typeof salesContext.e1_works_in_area === 'boolean';
    speakableFacts.resolved_this_turn = params.resolvedThisTurn ?? (params.inboundResolution === 'resolved_pending_city' ? 'city'
      : params.inboundResolution === 'resolved_pending_motivation' ? 'motivation'
      : courseStatus === 'confirmed_available' && params.pendingCriterionBefore === 'course' ? 'course' : null);
    speakableFacts.moment_type = speakableFacts.resolved_this_turn === 'course' || speakableFacts.resolved_this_turn === 'motivation'
      ? 'meaningful'
      : speakableFacts.resolved_this_turn === 'city'
        ? 'operational'
        : null;
    if (courseStatus === 'confirmed_available') {
      delete speakableFacts.available_course_lines;
      delete speakableFacts.related_area_courses;
      delete speakableFacts.requested_area;
    }

    if (nextCriterion === 'course_line') {
      return {
        processAction: 'ask_course_line',
        conversationalBehavior: 'present_available_lines_and_wait_choice',
        allowedIntent: 'ask_course_line',
        speakableFacts,
      };
    }

    if (nextCriterion === 'alternative_course_selection') {
      return {
        processAction: 'present_segment_options_and_wait_selection',
        conversationalBehavior: 'present_segment_options_and_wait_selection',
        allowedIntent: 'present_segment_options_and_wait_selection',
        speakableFacts,
      };
    }

    if (nextCriterion === 'catalog_area_selection') {
      return {
        processAction: 'present_real_areas_and_wait_selection',
        conversationalBehavior: 'present_catalog_areas_and_wait_selection',
        allowedIntent: 'present_real_areas_and_wait_selection',
        speakableFacts,
      };
    }

    if (nextCriterion === 'course_selection') {
      return {
        processAction: 'present_area_courses_and_wait_selection',
        conversationalBehavior: 'present_area_courses_and_wait_selection',
        allowedIntent: 'present_area_courses_and_wait_selection',
        speakableFacts,
      };
    }

    if (nextCriterion === 'new_direction') {
      return {
        processAction: 'ask_for_new_direction',
        conversationalBehavior: 'ask_for_new_direction',
        allowedIntent: 'ask_for_new_direction',
        speakableFacts,
      };
    }

    if (nextCriterion === 'city') {
      const askCitySpeakableFacts = {
        ...speakableFacts,
        e1_behavior: 'selected_course_to_city',
        resolved_this_turn: speakableFacts.resolved_this_turn || 'course',
      };
      delete askCitySpeakableFacts.course_status;
      delete askCitySpeakableFacts.immutable_facts;
      delete askCitySpeakableFacts.course_was_selected_from_offered_list;
      return {
        processAction: 'ask_city',
        conversationalBehavior: 'ask_city',
        allowedIntent: 'ask_city',
        speakableFacts: askCitySpeakableFacts,
      };
    }

    if (nextCriterion === 'motivation') {
      return {
        processAction: 'ask_motivation',
        conversationalBehavior: 'ask_motivation',
        allowedIntent: 'acknowledge_city_and_ask_motivation',
        speakableFacts: {
          ...speakableFacts,
          course_selection_reaction_allowed: false,
        },
      };
    }

    if (nextCriterion === null) {
      return {
        processAction: 'complete_stage',
        conversationalBehavior: 'complete_stage',
        allowedIntent: 'complete_e1_and_handoff_to_e2',
        speakableFacts: {
          ...speakableFacts,
          motivation: salesContext.motivacao_principal || params.leadSnapshot?.dor_principal || null,
          motivation_principal: salesContext.motivacao_principal || params.leadSnapshot?.dor_principal || null,
        },
      };
    }
  }

  if (params.stage === 'E2') {
    if (params.pendingCriterionAfter === 'vaccine_availability') {
      return {
        processAction: 'ask_vaccine_availability',
        conversationalBehavior: 'ask_vaccine_availability',
        allowedIntent: 'ask_vaccine_availability',
        speakableFacts,
      };
    }
    if (params.pendingCriterionAfter === 'vaccine_decider') {
      return {
        processAction: 'ask_vaccine_decider',
        conversationalBehavior: 'ask_vaccine_decider',
        allowedIntent: 'ask_vaccine_decider',
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
          ? 'confirm_course_presentation_before_price'
          : 'ask_vaccine_agreement',
        allowedIntent: agreementStatus === 'conditional_price_pending_confirmation'
          ? 'confirm_course_presentation_before_price'
          : 'ask_vaccine_agreement',
        speakableFacts,
      };
    }
  }

  if (params.stage === 'E3') {
    if (params.pendingCriterionAfter === 'presentation') {
      return {
        processAction: 'present_e3_structured_blocks',
        conversationalBehavior: 'send_three_presentation_blocks_then_interest_question',
        allowedIntent: 'present_institution_then_course_then_support_then_interest_question',
        speakableFacts: {
          ...speakableFacts,
          lead_motivation: salesContext.motivacao_principal || params.leadSnapshot?.dor_principal || null,
        },
      };
    }
  }

  if (params.stage === 'E4' && salesContext.proposal_checkpoint_completed === true) {
    const postProposalOpeningPending = salesContext.e4_post_proposal_opening_pending === true
      && salesContext.e4_post_proposal_opening_sent !== true;
    if (postProposalOpeningPending) {
      return {
        processAction: 'open_post_proposal_negotiation',
        conversationalBehavior: 'connect_sent_proposal_to_motivation_and_decision_context',
        allowedIntent: 'resume_after_admin_sent_proposal_without_representing_or_repreparing_it',
        speakableFacts: {
          ...speakableFacts,
          proposal_sent: true,
          motivation: salesContext.motivacao_principal || params.leadSnapshot?.dor_principal || null,
          decision_participant: salesContext.e2_decision_participant || null,
          decision_answer: salesContext.e2_vaccine_decider_answer || null,
          response_deadline: 'fim do dia',
        },
      };
    }
  }

  if (params.stage === 'E7') {
    if (salesContext.referral_registered === true || String(salesContext.pending_indication_phone || '').trim()) {
      return {
        processAction: 'prepare_referral_and_close',
        conversationalBehavior: 'prepare_referral_and_close',
        allowedIntent: 'prepare_registered_referral_without_requalifying_or_asking_new_referral',
        speakableFacts: {
          ...speakableFacts,
          indicated_name: String(salesContext.last_indicated_name || '').trim() || null,
        },
      };
    }
    return {
      processAction: 'human_final_closing',
      conversationalBehavior: 'close_without_reopening_sales_or_referral_collection',
      allowedIntent: 'close_conversation_without_new_questions',
      speakableFacts,
    };
  }

  return {
    processAction: 'follow_stage_contract',
    conversationalBehavior: params.stageMatched
      ? 'preserve_contextual_continuity'
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
  const preservedE3AuthorizedFacts = params.input.etapaAtual === 'E3'
    && Array.isArray(params.out.speakableFacts?.e3_authorized_facts)
    ? params.out.speakableFacts.e3_authorized_facts as Array<Record<string, unknown>>
    : undefined;
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
    pendingCriterionBefore: params.input.etapaAtual === 'E1' ? params.out.pendingCriterionBefore : refreshedPendingCriterion,
    pendingCriterionAfter: refreshedPendingCriterion,
    stageMatched: false,
    currentCourseInterest: String(refreshedLead?.curso_interesse || '').trim(),
    currentCity: String(refreshedLead?.cidade || '').trim(),
    leadSnapshot: refreshedLeadSnapshot,
    authorizedFacts: preservedE3AuthorizedFacts,
    resolvedThisTurn: params.input.etapaAtual === 'E1' ? params.out.speakableFacts?.resolved_this_turn : undefined,
  });

  if (params.input.etapaAtual !== 'E1') params.out.pendingCriterionBefore = refreshedPendingCriterion || null;
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
      `- PROCESS_ACTION atualizado: ${promptActionLabel(refreshedStageContract.processAction)}.`,
      `- CONVERSATIONAL_BEHAVIOR atualizado: ${promptActionLabel(refreshedStageContract.conversationalBehavior)}.`,
      `- ALLOWED_INTENT atualizado: ${promptActionLabel(refreshedStageContract.allowedIntent)}.`,
      `- SPEAKABLE_FACTS atualizados: ${promptSafeJson(refreshedStageContract.speakableFacts)}.`,
      '- Use somente esse estado atualizado para responder agora.',
      '- Nao antecipe cidade ou motivacao quando o estado pedir escolha de linha ou nova escolha de curso.',
      '- Nao mencione area, segmento ou alternativas se esses dados nao estiverem presentes em SPEAKABLE_FACTS.',
    ].join('\n'),
  });
}

export async function runSubagent(input: SubagentInput): Promise<SubagentOutput> {
  let allowed = TOOLS_BY_SUBAGENT[input.subagent];
  let toolSpecs = allowed.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
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
  const { data: leadContext } = await input.supabase
    .from('leads')
    .select('nome, lead_person_name, lead_first_name, lead_name_confidence, curso_interesse, cidade, modalidade, sales_context')
    .eq('id', input.leadId)
    .maybeSingle();
  const trustedLeadFirstName = String(leadContext?.lead_name_confidence || '').trim() === 'trusted'
    ? formatLeadFirstName(String(leadContext?.lead_first_name || leadContext?.lead_person_name || ''))
    : '';
  const leadFirstName = normalizeSoft(trustedLeadFirstName) === 'helton' ? '' : trustedLeadFirstName;

  const kernelPrompt = buildKernelContext({ ...input, timeZone });
  const renderedPersonality = personalityPrompt
    ? renderDynamicPrompt(personalityPrompt, input.trigger, leadFirstName || null, timeZone)
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

    if (false && e3Pending === 'presentation' && e3SalesContext.e3_presentation_complete !== true) {
      const authorizedFacts = await getAuthorizedKnowledgeFacts({
        supabase: input.supabase,
        tenantId: input.tenantId,
        stage: 'E3',
        modality: e3SalesContext.modalidade_oferta || e3SalesContext.delivery_mode || leadContext?.modalidade || null,
      });
      const presentation = buildE3PresentationMessages({
        leadSnapshot: input.leadSnapshot || leadContext || null,
        authorizedFacts,
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
            e3_presentation_blocks_sent: ['institution', 'course', 'study_experience', 'closing_question'],
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
  let authorizedFactsForStage: Array<Record<string, unknown>> = [];
  const stageState = input.inboundResolution || classifyInboundAgainstStageState({
    stage: input.etapaAtual,
    leadSnapshot: input.leadSnapshot || leadContext || null,
    history,
    latestUserMessage,
  });
  const pendingCriterionBefore = input.pendingCriterionBefore !== undefined ? input.pendingCriterionBefore
    : input.etapaAtual === 'E1' && Object.prototype.hasOwnProperty.call(input.regenerationContext?.speakableFacts || {}, 'pending_criterion_before')
      ? input.regenerationContext!.speakableFacts.pending_criterion_before as string | null : derivePendingCriterion({
    stage: input.etapaAtual,
    leadSnapshot: input.leadSnapshot || leadContext || null,
    history,
  });
  const normalizedLatestUserMessage = normalizeIntentText(latestUserMessage);
  const e2DecisionAloneResolved =
    input.etapaAtual === 'E2'
    && (pendingCriterionBefore === 'vaccine_decider' || stageState.pendingCriterion === 'vaccine_decider')
    && ['eu mesmo', 'eu mesma', 'sozinho', 'so eu', 'só eu'].some((pattern) => normalizedLatestUserMessage.includes(pattern))
    && normalizedLatestUserMessage.includes('decid');
  const virtualLeadSnapshot = stageState.matched || e2DecisionAloneResolved
    ? buildVirtualLeadSnapshot({
      leadSnapshot: input.leadSnapshot || leadContext || null,
      statePatch: e2DecisionAloneResolved
        ? {
          e2_decision_maker_status: 'resolved',
          e2_vaccine_decider_done: true,
          e2_decision_participant: latestUserMessage,
          pending_criterion: 'vaccine_agreement',
        }
        : stageState.statePatch || {},
    })
    : (input.leadSnapshot || leadContext || null);
  const pendingCriterionAfter = derivePendingCriterion({
    stage: input.etapaAtual,
    leadSnapshot: virtualLeadSnapshot,
    history,
  });
  if (
    input.etapaAtual === 'E1'
    && stageState.matched
    && ['resolved_pending_city', 'resolved_pending_motivation'].includes(String(stageState.classificationReason || ''))
  ) {
    allowed = allowed.filter((name) => name !== 'consultar_conhecimento');
    toolSpecs = allowed.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
  }
  const provisionalProcessAction = input.etapaAtual === 'E2'
    && stageState.classificationReason === 'resolved_pending_vaccine_1_travel_or_move'
    && pendingCriterionAfter === 'vaccine_decider'
    ? 'handle_travel_or_move_and_ask_vaccine_decider'
    : null;
  if (input.etapaAtual === 'E3' || provisionalProcessAction) {
    const modality = currentSalesContext.modalidade_oferta || currentSalesContext.delivery_mode || leadContext?.modalidade || null;
    const claims = await getAuthorizedKnowledgeFacts({
      supabase: input.supabase,
      tenantId: input.tenantId,
      stage: input.etapaAtual,
      modality,
      processAction: provisionalProcessAction,
    });
    const publishedGeneral = input.etapaAtual === 'E3'
      ? await fetchKnowledgeItems({
        supabase: input.supabase,
        tenantId: input.tenantId,
        types: ['general'],
        limit: 24,
        trackUsage: false,
      })
      : [];
    const generalFacts = publishedGeneral.map((item: any) => ({
      id: item.id,
      claim_key: item.key || item.id,
      category: 'institution',
      title: item.label || item.key || 'Informacao institucional',
      content: item.value?.content || item.value?.texto || item.value?.descricao || item.value?.resposta || '',
      scope: item.scope || 'global',
      stage: 'E3',
      status: item.status,
      priority: item.priority ?? 999,
      source_type: 'published_dashboard',
      authorized: true,
    }));
    const seenFacts = new Set<string>();
    authorizedFactsForStage = sanitizeAuthorizedFactsForPrompt([...claims, ...generalFacts])
      .filter((fact) => {
        const identity = String(fact.claim_key || fact.title || fact.content || '').trim();
        if (!identity || seenFacts.has(identity)) return false;
        seenFacts.add(identity);
        return true;
      });
  }
  const stageContract = buildStageContractContext({
    stage: input.etapaAtual,
    pendingCriterionBefore,
    pendingCriterionAfter,
    stageMatched: stageState.matched,
    currentCourseInterest,
    currentCity,
    leadSnapshot: virtualLeadSnapshot,
    authorizedFacts: authorizedFactsForStage,
    inboundResolution: stageState.classificationReason,
    resolvedThisTurn: input.regenerationContext?.speakableFacts?.resolved_this_turn,
  });
  let stabilizedStageContract = input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_course_line'
    && pendingCriterionAfter === 'city'
    ? {
      ...stageContract,
      processAction: 'ask_city',
      conversationalBehavior: 'ask_city',
      allowedIntent: 'ask_city',
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
      : input.etapaAtual === 'E3'
          && stageState.classificationReason === 'resolved_pending_e3_interest_signal'
          && pendingCriterionAfter === null
        ? {
          ...stageContract,
          processAction: 'complete_stage',
          conversationalBehavior: 'optional_short_contextual_acknowledgement_before_e4',
          allowedIntent: 'complete_e3_and_handoff_to_e4',
          speakableFacts: {
            ...(stageContract.speakableFacts || {}),
            pending_criterion_before: pendingCriterionBefore,
            pending_criterion_after: null,
          },
        }
      : stageContract;
  const e3CourseFollowup = input.etapaAtual === 'E3'
    && pendingCriterionBefore === 'interest_signal'
    && pendingCriterionAfter === 'interest_signal'
    && looksLikeE3DoubtOrObjection(latestUserMessage);
  if (e3CourseFollowup) {
    stabilizedStageContract = {
      ...stageContract,
      processAction: 'handle_e3_course_followup',
      conversationalBehavior: 'answer_e3_doubt_or_objection_with_authorized_current_course_facts',
      allowedIntent: 'handle_e3_doubt_or_objection_without_representing_or_advancing_stage',
      speakableFacts: {
        ...(stageContract.speakableFacts || {}),
        pending_criterion_before: pendingCriterionBefore,
        pending_criterion_after: pendingCriterionAfter,
        e3_specific_question: latestUserMessage,
      },
    };
  }
  out.pendingCriterionBefore = pendingCriterionBefore || null;
  out.pendingCriterionAfter = pendingCriterionAfter || null;
  out.allowedIntent = stabilizedStageContract.allowedIntent;
  out.processAction = stabilizedStageContract.processAction;
  out.conversationalBehavior = stabilizedStageContract.conversationalBehavior;
  out.speakableFacts = stabilizedStageContract.speakableFacts;
  if (
    input.etapaAtual === 'E3'
    && String(out.processAction || '') === 'present_e3_structured_blocks'
    && pendingCriterionAfter === 'presentation'
  ) {
    out.pendingCriterionBefore = 'presentation';
    out.pendingCriterionAfter = 'interest_signal';
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      pending_criterion_before: 'presentation',
      pending_criterion_after: 'interest_signal',
    };
  }
  if (authorizedFactsForStage.length > 0) {
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      authorized_facts: authorizedFactsForStage,
      authorized_claim_keys: authorizedFactsForStage.map((fact: any) => fact.claim_key).filter(Boolean),
    };
    messages.push({
      role: 'system',
      content: [
        'FACTS AUTORIZADOS PARA ESTE TURNO',
        '- Estes registros sao fatos autorizados para embasar a fala; nao recite a lista linha por linha.',
        '- Nao verbalize instrucao interna, metadata, regra de comunicacao, claim_key ou texto sobre o que a comunicacao comercial pode fazer.',
        `- AUTHORIZED_FACTS: ${JSON.stringify(authorizedFactsForStage)}.`,
        '- Se um claim desejado nao estiver nessa lista, nao verbalize nem crie substituto.',
      ].join('\n'),
    });
  }
  out.personalityPromptId = personalityPromptId;
  out.stagePromptId = stagePromptId;
  if (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_city'
    && pendingCriterionAfter === 'motivation'
  ) {
    out.text = normalizeMessageText(buildE1AskMotivationReply());
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'ask_motivation';
    out.allowedIntent = 'acknowledge_city_and_ask_motivation';
    out.conversationalBehavior = 'ask_motivation';
    return out;
  }
  if (
    input.etapaAtual === 'E1'
    && stageState.classificationReason === 'resolved_pending_motivation'
    && pendingCriterionAfter === null
  ) {
    out.text = normalizeMessageText(buildE1CompletionAcknowledgement({
      latestUserMessage,
      courseName: deriveSpeakableCourseName(currentCourseInterest, currentSalesContext),
    }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'complete_stage';
    out.allowedIntent = 'complete_e1_and_handoff_to_e2';
    out.conversationalBehavior = 'complete_stage';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && pendingCriterionAfter === 'vaccine_availability'
    && !String(stageState.classificationReason || '').trim()
  )) {
    out.text = normalizeMessageText(buildE2AvailabilityReply({ leadFirstName }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'ask_vaccine_availability';
    out.allowedIntent = 'ask_vaccine_availability';
    out.conversationalBehavior = 'ask_vaccine_availability';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && ['resolved_pending_vaccine_1_travel_or_move', 'resolved_pending_vaccine_1_negative'].includes(String(stageState.classificationReason || ''))
    && pendingCriterionAfter === 'vaccine_decider'
  )) {
    out.text = normalizeMessageText(buildE2DecisionReply({ leadFirstName }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'ask_vaccine_decider';
    out.allowedIntent = 'ask_vaccine_decider';
    out.conversationalBehavior = 'ask_vaccine_decider';
    return out;
  }
  if (false && (
    input.etapaAtual === 'E2'
    && ['resolved_pending_vaccine_2', 'resolved_pending_vaccine_2_from_last_question'].includes(String(stageState.classificationReason || ''))
    && pendingCriterionAfter === 'vaccine_agreement'
  )) {
    out.text = normalizeMessageText(buildE2AgreementReply({
      leadFirstName,
      decisionParticipant: String(stageState.statePatch?.e2_decision_participant || currentSalesContext.e2_decision_participant || '').trim() || null,
    }));
    out.rawModelOutput = out.text;
    out.outputBeforeGovernance = out.text;
    out.deterministicReplyUsed = true;
    out.responseOrigin = 'structural_fallback';
    out.processAction = 'ask_vaccine_agreement';
    out.allowedIntent = 'ask_vaccine_agreement';
    out.conversationalBehavior = 'ask_vaccine_agreement';
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
    out.processAction = 'ask_vaccine_agreement';
    out.allowedIntent = 'ask_vaccine_agreement';
    out.conversationalBehavior = 'ask_vaccine_agreement';
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
    out.conversationalBehavior = 'ask_city_after_catalog_course_selection';
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      course_name: selectedCourse,
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
        '- PROCESS_ACTION=ask_city.',
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
      ? 'present_area_courses_and_wait_selection'
      : 'handle_empty_selected_area_without_silence';
    out.processAction = relatedAreaCourses.length > 0
      ? 'present_area_courses_and_wait_selection'
      : 'handle_empty_catalog_area';
    out.conversationalBehavior = relatedAreaCourses.length > 0
      ? 'present_area_courses_and_wait_selection'
      : 'ask_catalog_area';
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
        '- Se houver cursos reais, liste somente esses cursos.',
        '- Use formato obrigatorio com titulo da area em negrito e bullets dos cursos.',
        '- Depois pergunte qual curso mais combina com o que o lead esta buscando.',
        '- Se nao houver curso real, peca outra area ou graduacao.',
        '- Nao peca cidade, motivacao, modalidade ou detalhe de curso agora.',
      ].join('\n'),
    });
  }
  const contextualReplyKind = stageState.matched
    ? String(stageState.pendingCriterion || stageState.lastAgentQuestionType || pendingCriterionBefore || 'contextual_response')
    : detectContextualReplyKind(latestUserMessage, history);
  const allowFreshIntentParsing = input.trigger !== 'stage_handoff';
  const e3PostPresentationTurn = input.etapaAtual === 'E3'
    && pendingCriterionBefore === 'interest_signal';
  const catalogIntent = !allowFreshIntentParsing || stageState.matched || e3PostPresentationTurn
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
  const broadCatalogRequest = input.etapaAtual === 'E1'
    && allowFreshIntentParsing
    && !stageState.matched
    && looksLikeBroadCatalogRequest(latestUserMessage);
  const greetingOnlyFollowup = looksLikePureGreeting(latestUserMessage);
  const canUseCourseLookupInStage = ['E1', 'E3'].includes(input.etapaAtual);
  const shouldUseCurrentCourseContext = canUseCourseLookupInStage
    && allowFreshIntentParsing
    && Boolean(currentCourseInterest)
    && (e3CourseFollowup || looksLikeCurrentCourseFollowup(latestUserMessage))
    && !effectiveCatalogIntent.matched;
  const mustLoadE3PresentationCourseFacts = input.etapaAtual === 'E3'
    && pendingCriterionAfter === 'presentation'
    && Boolean(currentCourseInterest);
  const mustConsultCourseBeforeReply = input.etapaAtual === 'E1'
    && !contextualReplyKind && effectiveCatalogIntent.matched
    && !broadCatalogRequest
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

  if (
    input.etapaAtual === 'E2'
    && String(out.processAction || stabilizedStageContract.processAction) === 'ask_vaccine_agreement'
    && pendingCriterionAfter === 'vaccine_agreement'
  ) {
    const participant = String(stageState.statePatch?.e2_decision_participant || currentSalesContext.e2_decision_participant || '').trim();
    const solo = participant === 'self' || /sozinh|eu mesmo|eu mesma|so eu/.test(normalizeIntentText(participant || latestUserMessage));
    if (participant && !solo) {
      out.conversationalBehavior = 'ask_vaccine_agreement';
      out.allowedIntent = 'ask_vaccine_agreement';
      messages.push({
        role: 'system',
        content: [
          'DECISOR COM TERCEIRO ENVOLVIDO',
          `- Pessoa citada na decisao: ${participant}.`,
          '- Antes do combinado, reconheca de forma curta, natural e contextual que essa pessoa participa da decisao. Nao elogie, nao repita a pergunta e nao invente uma resposta fixa.',
          '- No mesmo turno, faca o combinado comercial completo: se a apresentacao fizer sentido e a bolsa ficar boa, seguimos para inscricao.',
        ].join('\n'),
      });
    }
  }
  if (broadCatalogRequest) {
    out.pendingCriterionBefore = pendingCriterionBefore || 'course';
    out.pendingCriterionAfter = 'catalog_area_selection';
    out.allowedIntent = 'ask_catalog_area';
    out.processAction = 'ask_catalog_area';
    out.conversationalBehavior = 'ask_catalog_area';
    out.speakableFacts = {
      ...(out.speakableFacts || {}),
      course_status: 'catalog_exploration',
      pending_criterion_before: pendingCriterionBefore || 'course',
      pending_criterion_after: 'catalog_area_selection',
    };
    messages.push({
      role: 'system',
      content: [
        'EXPLORACAO AMPLA DE CATALOGO',
        '- O lead pediu para conhecer cursos/opcoes/graduações em geral.',
        '- Nao consulte nem liste cursos ainda.',
        '- Pergunte somente com qual area o lead mais se identifica.',
      ].join('\n'),
    });
  }

  if (
    input.etapaAtual === 'E3'
    && stageState.classificationReason === 'resolved_pending_e3_interest_signal'
    && pendingCriterionAfter === null
  ) {
    messages.push({
      role: 'system',
      content: [
        'E3 CONCLUIDA NESTE TURNO',
        '- A apresentacao da E3 ja foi enviada antes.',
        '- A ultima mensagem do lead indica que podemos seguir para valores/proposta.',
        '- Nao reapresente instituicao, curso, modalidade, duracao, tutoria ou claims.',
        '- Nao faca nova pergunta da E3.',
        '- A estrutura fara o handoff para E4.',
      ].join('\n'),
    });
  }

  if (input.etapaAtual === 'E7' && String(out.processAction || '') === 'prepare_referral_and_close') {
    messages.push({
      role: 'system',
      content: [
        'E7 COM INDICACAO JA REGISTRADA',
        '- A indicacao ja foi registrada antes.',
        '- Nao pergunte nome, telefone, curso, area ou cidade do indicado.',
        '- A indicacao registrada autoriza contato posterior com a pessoa indicada.',
        '- Encerre se nao houver mais duvidas.',
        '- Nao reabra venda, nao requalifique e nao peca nova indicacao.',
      ].join('\n'),
    });
  }

  if (input.etapaAtual === 'E7' && String(out.processAction || '') === 'human_final_closing') {
    messages.push({
      role: 'system',
      content: [
        'E7 SEM INDICACAO PENDENTE',
        '- Nao existe indicacao pendente para coletar neste turno.',
        '- Nao pergunte telefone, nome, curso, area ou cidade.',
        '- Nao fale em concluir matricula ou reabrir processo comercial.',
        '- Se o lead nao tem duvidas, encerre.',
      ].join('\n'),
    });
  }

  if (e3CourseFollowup) {
    messages.push({
      role: 'system',
      content: [
        'DUVIDA OU OBJECAO POS-APRESENTACAO NA E3',
        `- Mensagem do lead: ${latestUserMessage}.`,
        '- Entenda se e duvida, receio, impedimento ou pedido de esclarecimento sobre a graduacao atual e responda diretamente ao ponto real.',
        '- Use somente fatos autorizados em SPEAKABLE_FACTS/AUTHORIZED_FACTS.',
        '- Se o detalhe perguntado nao estiver confirmado nos fatos, nao invente. Diga com naturalidade que esse detalhe nao esta confirmado no momento e responda apenas o que estiver confirmado.',
        '- Nao reapresente os tres blocos da E3.',
        '- Nao trate como nova consulta de curso.',
        '- Nao avance para E4 apenas por existir duvida.',
        '- Responda em uma bolha. Use duas somente se a explicacao realmente precisar de separacao para ficar clara.',
        '- Para duas bolhas, use exatamente uma linha contendo somente --- entre elas. Para uma bolha, nao use ---.',
        '- Preserve PERSONALITY: seja proximo, espontaneo e seguro; conecte ao contexto do lead quando isso ajudar a resposta.',
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
      `- PROCESS_ACTION: ${promptActionLabel(out.processAction || stabilizedStageContract.processAction)}.`,
      `- CONVERSATIONAL_BEHAVIOR: ${promptActionLabel(out.conversationalBehavior || stabilizedStageContract.conversationalBehavior)}.`,
      `- ALLOWED_INTENT: ${promptActionLabel(out.allowedIntent || stabilizedStageContract.allowedIntent)}.`,
      `- SPEAKABLE_FACTS: ${promptSafeJson(out.speakableFacts || stabilizedStageContract.speakableFacts)}.`,
      ...(input.etapaAtual === 'E2' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_vaccine_availability' ? [
        '- RESPONSABILIDADE ATUAL: ask_vaccine_availability.',
        '- Aplique somente a vacina de viagem/mudanca como continuidade da conversa.',
        '- Modelo de estrutura: "[Nome], voce tem alguma viagem mais longa ou mudanca planejada para os proximos meses que possa interferir no inicio da graduacao?"',
        '- A PERSONALITY pode adaptar levemente o tom, mas deve manter a mesma intencao, uma unica pergunta e os elementos viagem/mudanca + proximos meses + interferir no inicio da graduacao.',
        '- Nao valide novamente motivacao, curso, cidade ou resposta anterior.',
        '- Nao use "Entendi", "Agora", "que bom", "para entender melhor" ou abertura de troca de etapa.',
        '- Nao narre formulario, etapa, consulta, verificacao, processamento ou espera.',
      ] : []),
      ...(input.etapaAtual === 'E1' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_city' ? [
        '- RESPONSABILIDADE ATUAL: meaningful_course_reaction + ask_city.',
        '- A reacao ao curso precisa ser comercial forte: escolha de graduacao excelente + oportunidades na area; nao use fala fria de interesse/se interessou.',
        '- Nao use tom frio de mero interesse; nao verbalize disponibilidade interna.',
      ] : []),
      ...(input.etapaAtual === 'E1' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_motivation' ? [
        '- RESPONSABILIDADE ATUAL: ask_motivation.',
        ...(out.speakableFacts?.e1_work_status_captured === true ? [
          '- A resposta sobre trabalho ja foi registrada. Reaja curto e pergunte somente se a graduacao representa sonho ou objetivo pessoal.',
          '- Nao repita a pergunta sobre trabalhar na area.',
        ] : [
          '- Pergunte diretamente se o lead ja trabalha nessa area ou se a graduacao representa sonho/objetivo pessoal.',
        ]),
        '- Nao use frase processual como "para entender melhor sua motivacao" e nao repita o nome do curso nessa hora.',
        '- Nao faca outra pergunta antes da pergunta principal.',
      ] : []),
      ...(input.etapaAtual === 'E1' && String(out.processAction || stabilizedStageContract.processAction) === 'complete_stage' ? [
        '- RESPONSABILIDADE ATUAL: react_contextually_to_resolved_motivation.',
        '- Faca no maximo UMA reacao contextual ao motivo resolvido.',
        '- Nao crie segunda validacao, nao pergunte nada e nao execute assunto da E2.',
      ] : []),
      ...(input.etapaAtual === 'E2' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_vaccine_decider' ? [
        '- RESPONSABILIDADE ATUAL: ask_decision_participant.',
        '- Modelo de estrutura: "E sobre a decisao de iniciar esse objetivo, voce decide sozinho/sozinha/por conta propria ou costuma conversar com alguem antes?"',
        '- Use "sozinha" se houver seguranca de genero feminino, "sozinho" se houver seguranca de genero masculino, e "por conta propria" quando nao houver seguranca.',
        '- A PERSONALITY pode adaptar levemente o tom, mas deve manter a mesma intencao e fazer uma unica pergunta sobre quem participa da decisao.',
        '- Quando nao houver viagem/mudanca real, va direto para a pergunta de decisor, sem validar ou celebrar dado operacional.',
        '- Nao fale a palavra matricula.',
      ] : []),
      ...(input.etapaAtual === 'E2' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_vaccine_decider' && String(currentSalesContext.e2_availability_objection_kind || '') === 'travel_or_move' ? [
        '- A pessoa informou uma viagem ou mudanca real. Resposta dela: ' + String(currentSalesContext.e2_vaccine_availability_answer || 'nao detalhada') + '.',
        '- Antes da pergunta sobre quem participa da decisao, escreva um primeiro paragrafo curto que reaja a esse contexto concreto de modo humano e util.',
        '- Se modalidade confirmada ajudar a explicar a situacao, pode menciona-la com precisao. Nao invente impacto, prazo, garantia ou solucao.',
        '- Essa reacao deve ser personalizada pela PERSONALITY, nunca frase fixa, e precisa ficar em paragrafo separado da pergunta do decisor.',
      ] : []),
      ...(input.etapaAtual === 'E2' && String(out.processAction || stabilizedStageContract.processAction) === 'ask_vaccine_agreement' ? [
        '- RESPONSABILIDADE ATUAL: present_commercial_agreement.',
        '- Modelo de estrutura: "[Nome], depois que eu apresentar pra voce sobre esse curso e voce sentir que nao faz sentido ou que nao encaixa no seu orcamento hoje, voce pode me dar um nao sincero e esta tudo bem. Mas se fizer sentido e a bolsa de estudos ficar boa, a gente ja segue para sua inscricao e garantimos essa oportunidade. Combinado?"',
        '- Se o lead respondeu que conversa com esposa, marido, pai, mae, familia ou outra pessoa, DEVE reconhecer curto antes do combinado, no sentido: "Perfeito, conversa com ela/ele sim e se surgir alguma duvida especifica pode me enviar."',
        '- Esse reconhecimento deve ser curto e natural; nao pode virar elogio, nao pode repetir a pergunta de decisor e nao pode substituir o combinado. Use ela para esposa/mae, ele para marido/pai, e pessoa/familia quando nao houver genero claro.',
        '- A PERSONALITY pode adaptar levemente o tom, mas deve manter: apresentar o curso, possibilidade de nao fazer sentido/nao encaixar no orcamento, permissao para nao sincero, bolsa de estudos ficar boa, seguir para inscricao, garantir oportunidade e confirmar com "Combinado?".',
        '- Se a decisao foi sozinho, nao valide nem elogie a independencia; comece diretamente pelo conteudo do combinado.',
        '- O combinado deve conter lado negativo, lado positivo e terminar em confirmacao.',
        '- Nao introduza, anuncie, peca permissao ou diga que vai fazer/apresentar o combinado.',
      ] : []),
      ...(input.etapaAtual === 'E3' && String(out.processAction || stabilizedStageContract.processAction) === 'present_e3_structured_blocks' ? [
        '- RESPONSABILIDADE ATUAL: execute integralmente a estrutura editorial definida no prompt da dashboard; ele e a unica fonte editorial da E3.',
        '- Entregue 3 mensagens de apresentacao ou 3 mensagens de apresentacao mais uma 4a pergunta final, exatamente como o prompt da dashboard determinar para este contexto.',
        '- Use uma linha contendo somente --- entre mensagens. Para 3 mensagens use 2 separadores; para 4 mensagens use 3 separadores.',
        '- FACTS e AUTHORIZED_FACTS apenas determinam o que e verdadeiro. A selecao, ordem, profundidade, tom e pergunta final pertencem exclusivamente ao prompt da dashboard.',
        '- PERSONALITY e obrigatoria na redacao: transforme fatos em conversa espontanea, entusiasta e proxima, conectada ao motivo real do lead.',
        `- MOTIVO CONFIRMADO DO LEAD: ${String(currentSalesContext.motivacao_principal || input.leadSnapshot?.dor_principal || 'nao informado')}.`,
        `- REFERENCIAS CENTRAIS DO MOTIVO: ${extractE3MotivationAnchors(String(currentSalesContext.motivacao_principal || input.leadSnapshot?.dor_principal || '')).join(', ') || 'nenhuma'}.`,
        '- Quando houver motivo confirmado, abra o PRIMEIRO bloco conectando naturalmente um beneficio a esse motivo especifico. Faca isso em uma frase organica, sem repetir a fala do lead e sem frase generica pronta sobre objetivos.',
        '- A apresentacao so esta completa se deixar claro, ja na abertura, que voce entendeu o motivo concreto desta pessoa.',
        '- Cada bloco precisa soar como Helton falando com esta pessoa, nunca como catalogo, ficha tecnica, texto institucional, lista de vantagens ou script lido.',
        '- Costure os fatos com transicoes naturais e valor pratico para o lead. Nao empilhe afirmacoes formais, abstratas ou genericas.',
        '- Selecione os diferenciais mais fortes para este lead e desenvolva valor pratico. Nao repita o mesmo diferencial, beneficio ou prova institucional em blocos diferentes.',
        '- Antes de enviar, releia como conversa: substitua qualquer sequencia de afirmacoes institucionais por uma explicacao humana, entusiasta e conectada a escolha desta pessoa.',
        '- A estrutura define somente quantidade e finalidade dos blocos. Ela nunca reduz a liberdade de escrita da PERSONALITY dentro dos fatos autorizados.',
        '- Dentro de cada bolha de apresentacao, organize as ideias em paragrafos curtos separados por uma linha em branco. A pergunta final permanece em seu proprio bloco.',
        '- Respeite integralmente regras da dashboard, incluindo caracteres nao permitidos. Nao use travessao longo.',
        '- Nunca verbalize metadata, instrucoes internas, claim_key ou frases sobre a comunicacao comercial.',
      ] : []),
      ...(input.etapaAtual === 'E4' && String(out.processAction || stabilizedStageContract.processAction) === 'open_post_proposal_negotiation' ? [
        '- RESPONSABILIDADE ATUAL: retomar somente depois de a proposta ja ter sido enviada pelo administrativo.',
        '- Escreva UMA mensagem com dois paragrafos curtos, sem usar ---.',
        '- Primeiro paragrafo: confirme que a pessoa pode conferir a oportunidade enviada e conecte a bolsa ao MOTIVO CONFIRMADO do lead de forma humana e especifica.',
        '- Segundo paragrafo: use o contexto real de decisao. Se `decision_participant` for self, deixe claro de forma natural que a decisao esta nas maos do proprio lead. Se houver outra pessoa, mencione somente a pessoa ou contexto realmente informado em `decision_answer` ou `decision_participant`, sem inventar nomes.',
        '- Peça uma resposta ate o fim do dia para garantir a oportunidade. A PERSONALITY escolhe a redacao; nao use frase congelada.',
        '- Proposta ja foi enviada. Nunca diga que vai preparar, organizar, enviar, atualizar, consultar ou verificar proposta.',
        '- Nao volte para apresentacao do curso, catalogo, cursos relacionados, perguntas de qualificacao, administrativo, checkpoint ou processo interno.',
        '- Nao invente valor, desconto, prazo diferente ou condicao nao presente em SPEAKABLE_FACTS.',
      ] : []),
      '- A estrutura define O QUE precisa acontecer.',
      '- Nunca reabra criterio ja concluido.',
      '- Use o nome do lead com parcimonia; nao abra toda resposta repetindo o nome.',
      ...(input.etapaAtual === 'E1' ? [
        '- Use course_display_name exatamente como nome falavel, preservando acentos. Nao verbalize chaves normalizadas.',
        '- Se e1_behavior=selected_course_to_city: valorize a escolha da graduacao, mencione oportunidades nessa area e peca a cidade.',
        '- Se e1_behavior=selected_course_to_city: nao verbalize disponibilidade, oferta, existencia no catalogo, temos esse curso ou equivalente.',
        '- Em complete_stage, nao faca pergunta e nao mencione documentacao, matricula, processo, proxima etapa ou assunto futuro. O runtime executara E2; nao execute E2 dentro de E1.',
      ] : []),
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
    const structuralCorrections: string[] = [];
    if (forbiddenTopics.some((topic) => String(topic).includes('flow_narration') || String(topic).includes('flow_progress_narration'))) {
      structuralCorrections.push('- Remova narracao de processo, progresso, etapa, continuidade ou proximos passos.');
      structuralCorrections.push('- Remova expressões detectadas como fluxo/processo, como "para seguir", "para continuar" ou equivalentes presentes em VIOLATIONS.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('repeated_city'))) {
      structuralCorrections.push('- Remova repeticao do nome da cidade ja informada pelo lead.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unnecessary_single_line_mention'))) {
      structuralCorrections.push('- Remova Bacharelado, Licenciatura ou outra linha unica interna desta resposta.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('missing_course_line') || String(topic).includes('invalid_course_line') || String(topic).includes('placeholder_line'))) {
      structuralCorrections.push('- Para curso ambiguo, use somente linhas reais de `available_course_lines` e aguarde escolha.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('technical_course_name_leak'))) {
      structuralCorrections.push('- Remova nome tecnico bruto, sigla CST, ABI, EGRESSO ou a palavra Tecnologo.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('ungrounded_output'))) {
      structuralCorrections.push('- Remova area, segmento, cursos relacionados, alternativas ou classificacao sem base em speakable_facts.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('catalog_selection_loop'))) {
      structuralCorrections.push('- Nao liste cursos, nao ofereca alternativas e nao volte para area quando o lead ja escolheu curso da lista.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unavailable_dead_end_tone'))) {
      structuralCorrections.push('- Use somente estado/fatos do contrato para curso indisponivel e nova direcao/alternativas autorizadas.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('missing_third_party_decider_acknowledgement'))) {
      structuralCorrections.push('- Se o lead citou esposa, marido, pai, mae, familia ou outra pessoa, reconheca curto: conversa com ela/ele sim e se surgir alguma duvida especifica pode me enviar; depois faca o combinado completo.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unexpected_self_introduction'))) {
      structuralCorrections.push('- Remova reapresentacao do Helton; a abertura inicial e responsabilidade estrutural e nao deve ser repetida.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unexpected_repeated_greeting'))) {
      structuralCorrections.push('- Remova saudacao por horario; saudacao so acontece na abertura inicial estrutural.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('repeated_course_praise_after_city'))) {
      structuralCorrections.push('- Cidade e dado operacional: remova elogio do curso/area/oportunidades e faca somente a pergunta de trabalho ou sonho/objetivo.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('weak_course_selection_reaction'))) {
      structuralCorrections.push('- Curso escolhido e momento significativo: use reacao comercial forte com escolha de graduacao excelente e oportunidades na area antes de pedir cidade.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('complete_stage_reopened_course_selection'))) {
      structuralCorrections.push('- E1 ja resolveu curso/cidade/motivacao; nao reabra escolha de curso, disponibilidade ou alternativas.');
      structuralCorrections.push('- Responda somente com reacao contextual curta ao motivo resolvido.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('missing_contextual_motivation_reaction'))) {
      structuralCorrections.push('- Em complete_stage da E1, reaja ao motivo especifico que o lead deu.');
      structuralCorrections.push('- Se for familia, mencione familia/caminho/seguir/tradicao de forma humana.');
      structuralCorrections.push('- A reacao precisa se conectar ao motivo especifico informado pelo lead.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('repeated_resolved_topic'))) {
      structuralCorrections.push('- Se o lead disse que nao tem viagem/mudanca, nao valide essa resposta; va direto para a pergunta de decisor.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('missing_travel_move_contextual_reaction'))) {
      structuralCorrections.push('- A pessoa informou viagem/mudanca real: escreva primeiro uma reacao curta, humana e util ao contexto dela; depois, em novo paragrafo, faca somente a pergunta de decisor.');
      structuralCorrections.push('- Nao use frase fixa, nao invente garantia e nao omita a reacao antes da pergunta.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('e3_missing_personalized_motivation_opening'))) {
      structuralCorrections.push('- Abra o primeiro bloco conectando explicitamente um beneficio real ao motivo concreto do lead; nao deixe essa conexao para o fim nem use frase generica.');
      structuralCorrections.push('- Reescreva em tom de conversa entusiasta e elimine repeticao de diferencial institucional entre blocos.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('duplicate_meaningful_reaction'))) {
      structuralCorrections.push('- Remova reacao duplicada ao mesmo motivo; E1 reage uma vez e E2 pergunta apenas o criterio atual.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('operational_answer_overvalidation'))) {
      structuralCorrections.push('- Dado operacional resolvido nao recebe elogio, celebracao ou validacao; siga diretamente para a responsabilidade atual.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('agreement_permission_preamble'))) {
      structuralCorrections.push('- O combinado comercial ja e a pergunta atual; remova pergunta de permissao para combinar, continuar ou apresentar.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('commercial_agreement_incomplete'))) {
      structuralCorrections.push('- O combinado comercial precisa conter orcamento, nao sincero/tudo bem, bolsa de estudos ficar boa, inscricao, oportunidade e Combinado.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('medical_vaccine_confusion') || String(topic).includes('question_mismatch:ask_vaccine_availability'))) {
      structuralCorrections.push('- Remova linguagem medica ou de saude; a pergunta permitida e comercial, sobre disponibilidade por viagem/mudanca.');
      structuralCorrections.push('- A pergunta permitida e somente sobre viagem longa ou mudanca planejada nos proximos meses.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('question_mismatch:ask_motivation'))) {
      structuralCorrections.push('- Para ask_motivation, pergunte se a pessoa ja trabalha na area OU se a graduacao representa sonho/objetivo pessoal.');
      structuralCorrections.push('- Nao troque por pergunta generica como o que motivou voce.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('question_mismatch:ask_vaccine_agreement') || String(topic).includes('repeated_resolved_criterion:vaccine_decider'))) {
      structuralCorrections.push('- Remova repeticao da pergunta sobre quem decide e siga para o combinado comercial.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('segment_unavailable_inferred_area'))) {
      structuralCorrections.push('- Sem segmento confiavel, remova area, curso relacionado, alternativas proximas ou segmento parecido.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('e7_final_closing_reopened_process'))) {
      structuralCorrections.push('- Em E7 final, remova telefone, curso, area, cidade, matricula ou reabertura de processo.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unauthorized_stage_fact:instituicao') || String(topic).includes('unauthorized_stage_fact:institui'))) {
      structuralCorrections.push('- Remova instituicao, universidade ou "aqui na instituicao" desta resposta.');
    }
    if (input.etapaAtual === 'E3' && forbiddenTopics.some((topic) => String(topic).includes('unauthorized_stage_fact'))) {
      structuralCorrections.push('- Em E3, remova claims que nao tenham claim_key em `e3_authorized_claim_keys`.');
    }
    if (forbiddenTopics.some((topic) => String(topic).includes('unauthorized_stage_fact:early_stage_course_details'))) {
      structuralCorrections.push('- Remova detalhes de produto ou informacao fora da etapa permitida.');
    }

    messages.push({
      role: 'system',
      content: [
        'REGENERACAO OBRIGATORIA DE RESPOSTA',
        `- A saida anterior violou o contrato estrutural da etapa ${input.etapaAtual}.`,
        `- PROCESS_ACTION: ${promptActionLabel(out.processAction || stabilizedStageContract.processAction)}.`,
        `- ALLOWED_INTENT: ${promptActionLabel(input.etapaAtual === 'E1' ? out.allowedIntent : input.regenerationContext.allowedIntent)}.`,
        `- SPEAKABLE_FACTS: ${promptSafeJson(input.etapaAtual === 'E1' ? out.speakableFacts : input.regenerationContext.speakableFacts)}.`,
        `- VIOLATIONS: ${(input.regenerationContext.forbiddenTopics || []).join(', ') || 'nenhuma informada'}.`,
        `- Original output proibido, somente para referencia do que NAO copiar: ${input.regenerationContext.originalOutput || '(vazio)'}.`,
        '- Preserve o mesmo estado comercial e NAO avance etapa.',
        '- Corrija somente as violacoes detectadas, preservando integralmente a PERSONALITY ativa e o prompt da etapa.',
        '- Mantenha a mesma responsabilidade estrutural e os mesmos fatos falaveis, sem expor nomes tecnicos internos.',
        '- Se process_action=complete_stage, nao faca pergunta e nao abra assunto futuro.',
        ...structuralCorrections,
        '- Responda apenas com a nova mensagem final permitida para o lead.',
      ].join('\n'),
    });
  }

  if (mustLoadE3PresentationCourseFacts || shouldUseCurrentCourseContext) {
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
      if (input.etapaAtual === 'E3' && (mustLoadE3PresentationCourseFacts || e3CourseFollowup)) {
        const lookupResult = out.toolCalls[out.toolCalls.length - 1]?.result as Record<string, unknown> | undefined;
        const courseItem = Array.isArray(lookupResult?.items) ? lookupResult.items[0] as Record<string, unknown> : null;
        const courseModality = String(courseItem?.modalidade || currentSalesContext.modalidade_oferta || leadContext?.modalidade || '').trim();
        const courseDuration = String(courseItem?.duracao || '').trim();
        allowed = allowed.filter((name) => name !== 'consultar_conhecimento');
        toolSpecs = allowed.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
        messages.push({
          role: 'system',
          content: [
            mustLoadE3PresentationCourseFacts
              ? 'DADOS DO CURSO CONFIRMADOS PARA A APRESENTACAO E3:'
              : 'DADOS DO CURSO CONFIRMADOS PARA A RESPOSTA DA E3:',
            `- Modalidade obrigatoria no bloco do curso: ${courseModality || 'nao informada'}.`,
            `- Duracao confirmada: ${courseDuration || 'nao informada'}.`,
            '- Bacharelado/Licenciatura e linha de formacao; nunca use como modalidade.',
            mustLoadE3PresentationCourseFacts
              ? '- A consulta de curso ja foi concluida. Nao chame consultar_conhecimento novamente; escreva agora a apresentacao em blocos.'
              : '- A consulta de curso ja foi concluida. Nao chame consultar_conhecimento novamente; responda somente a duvida ou objecao atual.',
          ].join('\n'),
        });
      }
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
          '- O retorno da tool define apenas fatos/estado.',
          '- So considere curso confirmado quando `match_status` for `found`.',
          '- Na E1, se `match_status` for `found` e a cidade ainda nao tiver sido confirmada, PROCESS_ACTION=ask_city.',
          '- Se `match_status` for `ambiguous_found`, o curso existe, mas o lead precisa escolher a linha correta.',
          '- Se `match_status` for `ambiguous_found`, liste somente as linhas reais presentes em `available_course_lines` e pergunte qual linha ele quer seguir.',
          '- Se `match_status` for `ambiguous_found`, NAO siga para cidade, motivacao ou avancar_etapa.',
          '- Se `match_status` for `browse_found`, liste os cursos de `listed_courses` e pergunte qual opcao interessou mais.',
          '- Se `match_status` for `browse_found`, NAO siga para cidade, motivacao ou avancar_etapa.',
          '- Se `match_status` for `not_found`, nao invente disponibilidade.',
          '- Se `match_status` for `not_found`, NAO siga com o processo comercial, NAO peca cidade e NAO faca pergunta de motivacao.',
          '- Se `match_status` for `not_found`, nao use wording tecnico como "catalogo", "consulta" ou "sistema".',
          '- Se `match_status` for `not_found` com `requested_area` e `related_area_courses`, use somente alternativas reais desse segmento.',
          '- Se `match_status` for `not_found` com `requested_area` e `related_area_courses`, nao jogue imediatamente para outra area ou outro curso livre.',
          '- Se `match_status` for `not_found` sem `requested_area` ou sem alternativas reais, PROCESS_ACTION=ask_for_new_direction.',
          '- Se `match_status` for `browse_not_found`, PROCESS_ACTION=ask_for_new_direction.',
          '- Se o lead pedir outra opcao da mesma area, consulte novamente o conhecimento com a nova busca antes de listar cursos.',
          '- Se houver falha tecnica na consulta, explique brevemente que o catalogo oficial nao respondeu agora e nunca confirme curso por suposicao.',
          `- Curso para exibir ao lead: ${extractBaseCourseName(String(forcedLookupResult?.matched_courses?.[0] || '')) || '(nao confirmado)'}.`,
        ].join('\n'),
      });

      if (
        input.etapaAtual === 'E1'
        && String(effectiveCatalogIntent.mode || '') === 'browse_catalog'
      ) {
        out.pendingCriterionBefore = 'course';
        out.pendingCriterionAfter = 'catalog_area_selection';
        out.allowedIntent = 'ask_catalog_area';
        out.processAction = 'ask_catalog_area';
        out.conversationalBehavior = 'ask_catalog_area';
        messages.push({
          role: 'system',
          content: [
            'EXPLORACAO AMPLA DE CATALOGO',
            '- O lead pediu para conhecer cursos/opcoes/graduações em geral.',
            '- Nao liste cursos ainda.',
            '- Pergunte somente com qual area o lead mais se identifica.',
            '- Nao use frases meta como "perguntar sobre a area ajuda", "essa pergunta ajuda" ou "para fins de".',
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
        out.allowedIntent = 'present_area_courses_and_wait_selection';
        out.processAction = 'present_area_courses_and_wait_selection';
        out.conversationalBehavior = 'present_area_courses_and_wait_selection';
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
        out.allowedIntent = 'ask_city';
        out.processAction = 'ask_city';
        out.conversationalBehavior = 'ask_city';
        out.speakableFacts = {
          ...(out.speakableFacts || {}),
          city: null,
          pending_criterion_before: 'course',
          pending_criterion_after: 'city',
        };
        messages.push({
          role: 'system',
          content: 'CURSO SELECIONADO DO CATALOGO: siga o contrato ask_city com a PERSONALITY ativa. Nao verbalize availability interna.',
        });
      }
    }
  }

  const debugLlmTraceEnabled = isLocalDebugLlmTraceEnabled(input.env);
  const updateLlmTrace = (extra: Record<string, unknown> = {}) => {
    if (!debugLlmTraceEnabled) return;
    out.llmTrace = sanitizeLlmTraceValue({
      ...(out.llmTrace || {}),
      lead_id: input.leadId,
      tenant_id: input.tenantId,
      subagent: input.subagent,
      stage_before: input.etapaAtual,
      trigger: input.trigger,
      model,
      effective_temperature: temperature,
      prompt_id: promptId,
      personality_prompt_id: personalityPromptId,
      stage_prompt_id: stagePromptId,
      personality: renderedPersonality,
      stage_prompt: stagePrompt,
      final_system_prompt: prompt,
      ordered_system_messages: messages
        .map((message, index) => ({ message, index }))
        .filter((entry) => entry.message.role === 'system')
        .map((entry) => ({
          index: entry.index,
          content: entry.message.content ?? null,
        })),
      messages_sent_to_model: traceMessages(messages),
      history,
      stage_contract: stabilizedStageContract,
      response_contract: {
        processAction: out.processAction || stabilizedStageContract.processAction || null,
        pendingCriterionBefore,
        pendingCriterionAfter,
        conversationalBehavior: out.conversationalBehavior || stabilizedStageContract.conversationalBehavior || null,
        allowedIntent: out.allowedIntent || stabilizedStageContract.allowedIntent || null,
        speakableFacts: out.speakableFacts || stabilizedStageContract.speakableFacts || null,
        classificationReason: stageState.classificationReason || null,
      },
      processAction: out.processAction || stabilizedStageContract.processAction || null,
      pendingCriterion: pendingCriterionAfter || null,
      pendingCriterionBefore,
      pendingCriterionAfter,
      conversationalBehavior: out.conversationalBehavior || stabilizedStageContract.conversationalBehavior || null,
      allowedIntent: out.allowedIntent || stabilizedStageContract.allowedIntent || null,
      speakableFacts: out.speakableFacts || stabilizedStageContract.speakableFacts || null,
      classificationReason: stageState.classificationReason || null,
      regeneration_context: input.regenerationContext || null,
      tool_results: out.toolCalls || [],
      first_raw_output: out.rawModelOutput || null,
      regeneration_output: out.regeneratedOutput || null,
      final_output_from_subagent: out.text || null,
      deterministic_reply_used: out.deterministicReplyUsed === true,
      fallback_used: out.fallbackUsed === true,
      fallback_reason: out.fallbackReason || null,
      ...extra,
    }) as Record<string, unknown>;
  };

  for (let i = 0; i < maxIterations; i += 1) {
    out.iterations = i + 1;
    const toolChoice = input.regenerationContext
      || (
        input.etapaAtual === 'E3'
        && String(out.processAction || stabilizedStageContract.processAction) === 'present_e3_structured_blocks'
      )
      ? 'none'
      : 'auto';

    if (tracePrompts) {
      console.log(`[subagent] llm_call stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} messages=${messages.length}`);
    }

    updateLlmTrace({
      phase: 'before_openai_call',
      iteration: i + 1,
      tool_choice: toolChoice,
    });

    const res = await chatCompletions(apiKey, {
      model,
      messages,
      tools: toolSpecs,
      tool_choice: toolChoice,
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
            content: 'CONSULTA OBRIGATORIA DE CURSO EXECUTADA PELO SISTEMA. O retorno da tool consultar_conhecimento atualizou apenas fatos/estado deste turno. Responda usando o estado atualizado e o contrato estrutural vigente.',
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
            content: 'UMA SEGUNDA CONSULTA DE CURSO FOI EXECUTADA COM QUERY SIMPLIFICADA. O retorno da tool consultar_conhecimento atualizou apenas fatos/estado deste turno. Responda usando o estado atualizado e o contrato estrutural vigente.',
          });
          if (tracePrompts) {
            console.log(`[subagent] prompt_preserved_after_retry_lookup stage=${input.subagent} iteration=${i + 1} prompt_id=${promptId} system_messages=${messages.filter((item) => item.role === 'system').length}`);
          }
          continue;
        }
      }

      const rawText = msg.content ?? undefined;
      const isE3Presentation = input.etapaAtual === 'E3'
        && String(out.processAction || '') === 'present_e3_structured_blocks';
      const isE3CourseFollowupReply = input.etapaAtual === 'E3'
        && String(out.processAction || '') === 'handle_e3_course_followup';
      out.rawModelOutput = rawText || null;
      out.text = rawText ? normalizeMessageText(rawText, isE3Presentation || isE3CourseFollowupReply) : rawText;
      out.outputBeforeGovernance = out.text || null;
      if (isE3Presentation) {
        const e3AtomicMessages = coerceE3PresentationAtomicMessages(out.text);
        const e3Validation = validateE3PresentationBlocks({
          blocks: e3AtomicMessages,
          courseName: String(currentCourseInterest || currentSalesContext.course_display_name || ''),
          modality: String(currentSalesContext.modalidade_oferta || currentSalesContext.delivery_mode || input.leadSnapshot?.modalidade || ''),
          motivation: String(currentSalesContext.motivacao_principal || input.leadSnapshot?.dor_principal || ''),
          authorizedClaimKeys: authorizedFactsForStage.map((fact: any) => String(fact?.claim_key || '')).filter(Boolean),
        });
        if (!e3Validation.valid && i < maxIterations - 1) {
          messages.push({
            role: 'system',
            content: [
              'VIOLACAO DA E3: ' + e3Validation.violations.join(', ') + '.',
              'Entregue exatamente 4 mensagens: 3 blocos de apresentacao e uma 4a pergunta final. Use uma linha contendo somente --- entre cada mensagem, totalizando 3 separadores.',
              ...(e3Validation.violations.includes('missing_specific_motivation_connection') ? [
                `O motivo concreto do lead e: ${String(currentSalesContext.motivacao_principal || input.leadSnapshot?.dor_principal || '')}.`,
                `Mencione naturalmente uma destas referencias no bloco de curso ou suporte: ${extractE3MotivationAnchors(String(currentSalesContext.motivacao_principal || input.leadSnapshot?.dor_principal || '')).join(', ')}.`,
                'Nao use frase generica sobre objetivos; deixe claro que entendeu o caso desta pessoa.',
              ] : []),
              ...(e3Validation.violations.some((item) => item.startsWith('missing_institution_') || ['missing_international_diploma_recognition', 'missing_university_advantage', 'missing_maximum_mec_rating', 'missing_maximum_mec_since_beginning'].includes(item)) ? [
                'O primeiro bloco deve integrar todos os diferenciais institucionais autorizados recebidos no contexto, sem omitir nenhum deles.',
              ] : []),
              'Siga integralmente o prompt da dashboard para conteudo, selecao de fatos, tom e pergunta final.',
              'Nao use fallback; escreva com PERSONALITY.',
            ].join('\n'),
          });
          continue;
        }
        if (e3Validation.valid) {
          out.atomicMessages = e3AtomicMessages;
          await input.supabase
            .from('leads')
            .update({
              sales_context: {
                ...currentSalesContext,
                e3_presentation_complete: true,
                e3_presentation_completed_at: new Date().toISOString(),
                e3_presentation_blocks_sent: ['institution', 'course', 'study_experience', 'closing_question'],
                e3_institutional_claims_pending: authorizedFactsForStage.map((fact: any) => fact.claim_key).filter(Boolean),
                e3_interest_signal_captured: false,
                pending_criterion: 'interest_signal',
                last_agent_question_type: 'interest_signal',
              },
              updated_at: new Date().toISOString(),
            })
            .eq('id', input.leadId);
        }
        if (!e3Validation.valid) {
          out.text = '';
          out.outputBeforeGovernance = null;
          out.atomicMessages = [];
          out.stageContractViolation = true;
          out.forbiddenTopicsDetected = [...(out.forbiddenTopicsDetected || []), ...e3Validation.violations];
          break;
        }
      } else if (isE3CourseFollowupReply && out.text) {
        const followupParts = splitE3AtomicMessages(out.text);
        if (followupParts.length <= 2) {
          out.atomicMessages = followupParts;
        } else {
          out.text = normalizeMessageText(out.text);
          out.outputBeforeGovernance = out.text;
          out.atomicMessages = [out.text];
        }
      }
      if (input.regenerationContext) {
        out.originalOutput = input.regenerationContext.originalOutput || null;
        out.regeneratedOutput = out.text || null;
        out.regenerationTriggered = true;
        out.stageContractViolation = true;
        out.forbiddenTopicsDetected = [...(input.regenerationContext.forbiddenTopics || [])];
        out.responseOrigin = 'llm_regeneration';
      }
      if (out.text) {
        if (
          input.etapaAtual === 'E1'
          && stageState.classificationReason === 'resolved_pending_motivation'
          && pendingCriterionAfter === null
        ) {
          out.processAction = 'complete_stage';
          out.allowedIntent = 'complete_e1_and_handoff_to_e2';
          out.conversationalBehavior = 'complete_stage';
          out.pendingCriterionAfter = null;
        }
        out.text = sanitizeStageHandoffText(out.text, input.trigger, input.subagent);
        if (input.etapaAtual === 'E1') {
          const sanitizerResult = sanitizeE1CompleteStageText(out.text, out.processAction);
          out.text = sanitizerResult.text;
          if (sanitizerResult.applied) {
            (out as any).sanitizerApplied = true;
            (out as any).sanitizerReason = sanitizerResult.reason;
            (out as any).sanitizerBefore = sanitizerResult.before;
            (out as any).sanitizerAfter = sanitizerResult.after;
          }
          if (input.regenerationContext) out.regeneratedOutput = out.text || null;
        }
        if (input.etapaAtual === 'E2') {
          const sanitizedE2Text = sanitizeE2CurrentCriterionText(out.text, out.processAction, latestUserMessage);
          if (sanitizedE2Text !== out.text) {
            (out as any).sanitizerApplied = true;
            (out as any).sanitizerReason = 'e2_resolved_operational_preamble';
            (out as any).sanitizerBefore = out.text;
            (out as any).sanitizerAfter = sanitizedE2Text;
            out.text = sanitizedE2Text;
            if (input.regenerationContext) out.regeneratedOutput = out.text || null;
          }
        }
      }
      updateLlmTrace({
        phase: input.regenerationContext ? 'after_regeneration_output' : 'after_first_raw_output',
        iteration: i + 1,
        first_raw_output: input.regenerationContext ? (out.originalOutput || null) : (out.rawModelOutput || null),
        regeneration_output: input.regenerationContext ? (out.regeneratedOutput || out.text || null) : null,
        final_output_from_subagent: out.text || null,
      });
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

    updateLlmTrace({
      phase: 'after_tool_results',
      iteration: i + 1,
      tool_results: out.toolCalls || [],
    });

    if (out.handoff) break;
  }

  updateLlmTrace({
    phase: 'returning_subagent_output',
    tool_results: out.toolCalls || [],
    first_raw_output: out.rawModelOutput || null,
    regeneration_output: out.regeneratedOutput || null,
    final_output_from_subagent: out.text || null,
  });

  return out;
}

export { TOOLS_BY_SUBAGENT, STAGE_FALLBACKS };
