// Hybrid sales intelligence for the SDR.
// Combines deterministic signal detection with an LLM classifier and persists
// a structured commercial memory on the lead.
// deno-lint-ignore-file
// @ts-nocheck

import { chatCompletions } from '../_shared/openai-client.ts';

export interface LeadIntelligence {
  intent: 'greeting' | 'question' | 'qualification' | 'objection' | 'price' | 'proposal' | 'enrollment' | 'human_help' | 'followup' | 'other';
  buying_stage: 'cold' | 'aware' | 'considering' | 'proposal' | 'decision';
  temperature: 'cold' | 'warm' | 'hot';
  primary_objection: 'none' | 'price' | 'time' | 'trust' | 'bureaucracy' | 'other';
  urgency: 'low' | 'medium' | 'high';
  next_best_action: 'qualify' | 'answer_question' | 'handle_objection' | 'present_offer' | 'send_proposal' | 'ask_for_payment' | 'confirm_enrollment' | 'handoff';
  confidence: number;
  summary: string;
  needs_handoff: boolean;
  asked_price_early: boolean;
  asked_discount: boolean;
  payment_confirmed: boolean;
  proposal_ready: boolean;
  enrollment_ready: boolean;
  last_user_message: string;
  suggested_stage: string | null;
  updated_at: string;
}

function normalize(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

function deriveSignals(message: string, etapaAtual: string) {
  const normalized = normalize(message);

  const askedPrice = includesAny(normalized, [
    'quanto custa',
    'qual o valor',
    'qual valor',
    'quanto e',
    'preco',
    'mensalidade',
    'parcela',
    'quanto fica',
  ]);

  const askedDiscount = includesAny(normalized, [
    'desconto',
    'consegue melhorar',
    'faz um valor melhor',
    'tem bolsa maior',
    'consegue abaixar',
  ]);

  const paymentConfirmed = includesAny(normalized, [
    'ja paguei',
    'paguei',
    'fiz o pix',
    'enviei o comprovante',
    'boleto pago',
    'pagamento feito',
  ]);

  const wantsHuman = includesAny(normalized, [
    'quero falar com humano',
    'quero falar com atendente',
    'me passa pra alguem',
    'quero falar com uma pessoa',
    'quero atendimento humano',
  ]);

  const objectionPrice = askedPrice || askedDiscount || includesAny(normalized, [
    'nao cabe',
    'ta caro',
    'caro pra mim',
    'sem condicoes',
    'nao consigo pagar',
  ]);

  const objectionTime = includesAny(normalized, [
    'sem tempo',
    'correria',
    'rotina puxada',
    'trabalho muito',
    'nao tenho tempo',
    'horario apertado',
  ]);

  const enrollmentReady = paymentConfirmed || includesAny(normalized, [
    'pode matricular',
    'pode fazer minha matricula',
    'quero me matricular',
    'vamos fechar',
    'quero garantir minha vaga',
  ]);

  const proposalReady =
    askedPrice ||
    includesAny(normalized, [
      'me passa a proposta',
      'me manda os valores',
      'quero ver as condicoes',
      'como fica pra fechar',
    ]) ||
    ['E4', 'E5'].includes(etapaAtual);

  return {
    askedPrice,
    askedDiscount,
    paymentConfirmed,
    wantsHuman,
    objectionPrice,
    objectionTime,
    proposalReady,
    enrollmentReady,
  };
}

function fallbackIntelligence(message: string, etapaAtual: string): LeadIntelligence {
  const now = new Date().toISOString();
  const signals = deriveSignals(message, etapaAtual);

  let intent: LeadIntelligence['intent'] = 'other';
  let buyingStage: LeadIntelligence['buying_stage'] = 'aware';
  let temperature: LeadIntelligence['temperature'] = 'warm';
  let objection: LeadIntelligence['primary_objection'] = 'none';
  let urgency: LeadIntelligence['urgency'] = 'medium';
  let nextBestAction: LeadIntelligence['next_best_action'] = 'answer_question';
  let suggestedStage: string | null = etapaAtual || 'E1';
  let needsHandoff = false;

  if (signals.wantsHuman) {
    intent = 'human_help';
    nextBestAction = 'handoff';
    needsHandoff = true;
    temperature = 'warm';
  } else if (signals.paymentConfirmed) {
    intent = 'enrollment';
    buyingStage = 'decision';
    temperature = 'hot';
    urgency = 'high';
    nextBestAction = 'confirm_enrollment';
    suggestedStage = 'E5';
  } else if (signals.askedDiscount) {
    intent = 'objection';
    buyingStage = 'proposal';
    temperature = 'hot';
    objection = 'price';
    urgency = 'high';
    nextBestAction = 'handoff';
    needsHandoff = true;
    suggestedStage = 'E4';
  } else if (signals.askedPrice) {
    intent = 'price';
    buyingStage = ['E1', 'E2', 'E3'].includes(etapaAtual) ? 'considering' : 'proposal';
    temperature = 'hot';
    objection = signals.objectionPrice ? 'price' : 'none';
    nextBestAction = ['E1', 'E2', 'E3'].includes(etapaAtual) ? 'present_offer' : 'send_proposal';
    suggestedStage = ['E1', 'E2', 'E3'].includes(etapaAtual) ? 'E4' : etapaAtual;
  } else if (signals.objectionPrice || signals.objectionTime) {
    intent = 'objection';
    buyingStage = 'considering';
    temperature = 'warm';
    objection = signals.objectionPrice ? 'price' : 'time';
    nextBestAction = 'handle_objection';
  } else if (includesAny(normalize(message), ['bom dia', 'boa tarde', 'boa noite', 'oi', 'ola'])) {
    intent = 'greeting';
    buyingStage = 'aware';
    temperature = 'warm';
    nextBestAction = 'qualify';
  } else if (message.includes('?')) {
    intent = 'question';
    buyingStage = 'considering';
    nextBestAction = 'answer_question';
  } else {
    intent = 'qualification';
    buyingStage = 'aware';
    nextBestAction = 'qualify';
  }

  return {
    intent,
    buying_stage: buyingStage,
    temperature,
    primary_objection: objection,
    urgency,
    next_best_action: nextBestAction,
    confidence: 0.55,
    summary: message.substring(0, 220) || 'Sem resumo disponível.',
    needs_handoff: needsHandoff,
    asked_price_early: signals.askedPrice && ['E1', 'E2', 'E3'].includes(etapaAtual),
    asked_discount: signals.askedDiscount,
    payment_confirmed: signals.paymentConfirmed,
    proposal_ready: signals.proposalReady,
    enrollment_ready: signals.enrollmentReady,
    last_user_message: message,
    suggested_stage: suggestedStage,
    updated_at: now,
  };
}

function sanitizeClassification(raw: any, fallback: LeadIntelligence): LeadIntelligence {
  if (!raw || typeof raw !== 'object') return fallback;
  const allowedKeys = [
    'intent',
    'buying_stage',
    'temperature',
    'primary_objection',
    'urgency',
    'next_best_action',
    'confidence',
    'summary',
    'needs_handoff',
    'asked_price_early',
    'asked_discount',
    'payment_confirmed',
    'proposal_ready',
    'enrollment_ready',
    'last_user_message',
    'suggested_stage',
  ];
  const sanitizedRaw: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      sanitizedRaw[key] = raw[key];
    }
  }
  return {
    ...fallback,
    ...sanitizedRaw,
    confidence: Number(raw.confidence ?? fallback.confidence),
    updated_at: new Date().toISOString(),
  };
}

export async function classifyLeadMessage(params: {
  apiKey: string;
  model: string;
  etapaAtual: string;
  lastUserMessage: string;
  historyText: string;
  leadSnapshot?: Record<string, unknown> | null;
}): Promise<LeadIntelligence> {
  const fallback = fallbackIntelligence(params.lastUserMessage, params.etapaAtual);
  if (!params.apiKey || !params.lastUserMessage?.trim()) {
    return fallback;
  }

  const system = `Voce eh um classificador comercial para um SDR educacional.
Retorne APENAS um JSON valido com estas chaves:
intent, buying_stage, temperature, primary_objection, urgency, next_best_action,
confidence, summary, needs_handoff, asked_price_early, asked_discount,
payment_confirmed, proposal_ready, enrollment_ready, suggested_stage.

Valores permitidos:
- intent: greeting, question, qualification, objection, price, proposal, enrollment, human_help, followup, other
- buying_stage: cold, aware, considering, proposal, decision
- temperature: cold, warm, hot
- primary_objection: none, price, time, trust, bureaucracy, other
- urgency: low, medium, high
- next_best_action: qualify, answer_question, handle_objection, present_offer, send_proposal, ask_for_payment, confirm_enrollment, handoff
- suggested_stage: E1, E2, E3, E4, E5, E6, E7, handoff, encerrado ou null

Considere o processo comercial como base, mas classifique a situacao real do lead.
Nao adicione markdown, comentarios ou texto fora do JSON.`;

  const user = `ETAPA ATUAL: ${params.etapaAtual}
ULTIMA MENSAGEM DO LEAD:
${params.lastUserMessage}

HISTORICO RECENTE:
${params.historyText || '(sem historico)'}

LEAD SNAPSHOT:
${JSON.stringify(params.leadSnapshot || {}, null, 2)}`;

  try {
    const response = await chatCompletions(params.apiKey, {
      model: params.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 350,
    });

    const content = response.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content);
    return sanitizeClassification(parsed, fallback);
  } catch (_) {
    return fallback;
  }
}

export async function persistLeadIntelligence(params: {
  supabase: any;
  leadId: string;
  intelligence: LeadIntelligence;
  currentLead?: {
    sales_context?: Record<string, unknown> | null;
    proposta_enviada_em?: string | null;
    pronto_matricula_em?: string | null;
  } | null;
}) {
  const now = new Date().toISOString();
  const currentSalesContext = { ...(params.currentLead?.sales_context || {}) } as Record<string, unknown>;
  const updatePayload: Record<string, unknown> = {
    sales_context: {
      ...currentSalesContext,
      ...params.intelligence,
    },
    ultima_classificacao_em: now,
    ultimo_resumo_ia: params.intelligence.summary,
    updated_at: now,
  };

  if (params.intelligence.proposal_ready && !params.currentLead?.proposta_enviada_em) {
    updatePayload.proposta_enviada_em = now;
  }
  if (params.intelligence.enrollment_ready && !params.currentLead?.pronto_matricula_em) {
    updatePayload.pronto_matricula_em = now;
  }

  await params.supabase
    .from('leads')
    .update(updatePayload)
    .eq('id', params.leadId);
}

export async function registerLeadEvent(params: {
  supabase: any;
  tenantId: string;
  leadId: string;
  eventType: string;
  eventKey: string;
  payload?: Record<string, unknown>;
}) {
  const { error } = await params.supabase
    .from('lead_events')
    .insert({
      tenant_id: params.tenantId,
      lead_id: params.leadId,
      event_type: params.eventType,
      event_key: params.eventKey,
      payload: params.payload ?? {},
    });

  if (error && !String(error.message || '').includes('duplicate')) {
    throw error;
  }

  return !error;
}

export async function logLeadRuntimeEvent(params: {
  supabase: any;
  tenantId: string;
  leadId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  const { error } = await params.supabase
    .from('lead_events')
    .insert({
      tenant_id: params.tenantId,
      lead_id: params.leadId,
      event_type: params.eventType,
      event_key: `${params.eventType}_${Date.now()}_${crypto.randomUUID()}`,
      payload: params.payload ?? {},
    });

  if (error) {
    console.warn(`[lead_events] falha ao registrar ${params.eventType}: ${String(error.message || error)}`);
    return false;
  }

  return true;
}

export async function sendAdminAlert(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  leadId: string;
  telefone: string;
  motivo: string;
  detalhes?: string;
}) {
  const senderUrl = `${params.supabaseUrl}/functions/v1/whatsapp-sender`;
  const text = params.detalhes || params.motivo;
  return fetch(senderUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.serviceRoleKey}`,
    },
    body: JSON.stringify({
      lead_id: params.leadId,
      telefone: params.telefone,
      text,
      skip_governance: true,
    }),
  });
}
