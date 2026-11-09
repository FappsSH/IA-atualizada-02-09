// Global stage-state and contextual classification guards.
// deno-lint-ignore-file
// @ts-nocheck

export type PendingCriterion =
  | 'course'
  | 'course_line'
  | 'catalog_area_selection'
  | 'course_selection'
  | 'alternative_course_selection'
  | 'new_direction'
  | 'city'
  | 'motivation'
  | 'vaccine_availability'
  | 'vaccine_decider'
  | 'vaccine_agreement'
  | 'presentation'
  | 'interest_signal'
  | 'full_name'
  | 'proposal_admin_checkpoint'
  | 'negotiation'
  | 'enrollment_intent'
  | 'enrollment_admin_checkpoint'
  | 'boleto_date'
  | 'service_satisfaction'
  | 'service_recommendation'
  | 'referral_decision'
  | 'referral_name'
  | 'referral_phone'
  | 'referral_preparation'
  | 'final_question'
  | 'closing'
  | null;

function normalize(text: string) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s+/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(normalize(pattern)));
}

function hasValue(value: unknown) {
  const normalized = normalize(String(value || ''));
  return normalized.length > 0
    && !['none', 'null', 'undefined', 'nao informado', 'nao informada', 'sem informacao'].includes(normalized);
}

export function isE1CityResolved(state: Record<string, unknown> | null | undefined) {
  const salesContext = salesContextFrom(state);
  return salesContext.e1_city_confirmed === true && hasValue(state?.cidade);
}

function salesContextFrom(leadSnapshot: Record<string, unknown> | null | undefined) {
  return { ...(leadSnapshot?.sales_context || {}) } as Record<string, unknown>;
}

function isE1CityResolvedForCurrentFlow(leadSnapshot: Record<string, unknown> | null | undefined) {
  return isE1CityResolved(leadSnapshot);
}

function looksLikeResolvedCityReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  // A course request must never become a city after the catalog preflight.
  if (/\b(quero saber|saber sobre|interesse|curso|graduacao|voces tem)\b/.test(normalized)) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;

  if (
    normalized.startsWith('sou de ')
    || normalized.startsWith('moro em ')
    || normalized.startsWith('resido em ')
    || normalized.startsWith('sou do ')
    || normalized.startsWith('sou da ')
  ) {
    return true;
  }

  const blocked = new Set([
    'sim',
    'nao',
    'oi',
    'ola',
    'bom dia',
    'boa tarde',
    'boa noite',
    'bacharelado',
    'licenciatura',
  ]);
  if (blocked.has(normalized)) return false;

  const hasContextWord = words.some((word) => [
    'minha',
    'meu',
    'area',
    'trabalho',
    'atuo',
    'sonho',
    'objetivo',
    'bacharelado',
    'licenciatura',
  ].includes(word));

  return !hasContextWord;
}

function looksLikeContextualAffirmativeReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;

  if (includesAny(normalized, ['nao', 'n�o', 'nunca', 'sem viagem', 'sem mudanca', 'sem mudan�a'])) return false;

  return (
    ['sim', 'tenho', 'tenho sim', 'sim tenho', 'sim eu tenho', 'eu tenho', 'vou sim', 'preciso sim', 'talvez sim'].includes(normalized)
    || /^sim\b/.test(normalized)
    || /\b(eu )?tenho\b/.test(normalized)
  );
}

function looksLikeResolvedMotivationReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  const hasMotivationAnchor = includesAny(normalized, [
    'sonho',
    'sonhei',
    'quis fazer',
    'sempre quis',
    'sempre gostei',
    'objetivo',
    'realizacao pessoal',
    'realização pessoal',
    'oportunidade',
    'proposta',
    'familia',
    'família',
    'cresci vendo',
    'trabalha nisso',
    'trabalhar nisso',
    'area',
    'área',
    'profissao',
    'profissão',
    'especializar',
    'abrir portas',
    'profissao melhor',
    'profissão melhor',
  ]);
  const hasReasonConnector = includesAny(normalized, [
    'porque',
    'pois',
    'por isso',
    'pra',
    'para',
    'quero',
    'tenho',
    'sempre',
    'minha',
    'meu',
  ]);
  if (hasMotivationAnchor && hasReasonConnector) return true;

  if (includesAny(normalized, [
    'sempre quis',
    'sempre tive vontade',
    'meu sonho',
    'sonho',
    'objetivo',
    'para concurso',
    'prestar concurso',
    'concurso',
    'quero crescer',
    'crescer profissionalmente',
    'melhorar profissionalmente',
    'gosto da area',
    'gosto da área',
    'gosto muito da area',
    'gosto muito da área',
    'me identifico com a area',
    'me identifico com a área',
    'afinidade com a area',
    'afinidade com a área',
    'quero migrar',
    'mudar de area',
    'mudar de área',
    'trocar de area',
    'trocar de área',
    'ja trabalho',
    'trabalho na area',
    'para trabalhar',
    'surgiu uma oportunidade',
    'apareceu uma oportunidade',
    'oportunidade pra mim',
    'oportunidade para mim',
    'recebi uma proposta',
    'proposta de trabalho',
  ])) return true;

  const hasAffinityMotivation = /\bidentific\w*/.test(normalized)
    && includesAny(normalized, ['sempre', 'muito', 'area', '�rea', 'ela', 'curso', 'graduacao', 'gradua��o']);
  if (hasAffinityMotivation) return true;

  const hasIntent = includesAny(normalized, ['quero', 'preciso', 'tenho vontade', 'pretendo']);
  const hasCareerReason = includesAny(normalized, ['crescer', 'trabalhar', 'profissional', 'carreira', 'area', 'área', 'concurso']);
  return hasIntent && hasCareerReason;
}

function looksLikePositiveMotivationWorkReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  return /^(sim[,.! ]+)?(eu )?(ja )?(trabalho|atuo)\b/.test(normalized)
    || /^(sim[,.! ]+)?sou\s+\S.{1,}$/.test(normalized);
}
function looksLikePartialMotivationWorkReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  return includesAny(normalized, [
    'nao trabalho',
    'não trabalho',
    'nao atuo',
    'não atuo',
    'nunca trabalhei',
    'ainda nao trabalho',
    'ainda não trabalho',
    'nao trabalho na area',
    'não trabalho na área',
  ]);
}

export function getNextE1Criterion(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
}) {
  const lead = params.leadSnapshot || {};
  const salesContext = salesContextFrom(lead);
  const courseStatus = String(salesContext.course_status || '').trim();
  const catalogMode = String(salesContext.catalog_mode || '').trim();
  const courseValidated = salesContext.course_validated === true
    || courseStatus === 'confirmed_available'
    || hasValue(lead.curso_interesse);
  const lineRequired = salesContext.line_selection_required === true;
  const lineKnown = hasValue(salesContext.linha_formacao);
  const cityKnown = isE1CityResolvedForCurrentFlow(lead);
  const motivationKnown = hasValue(salesContext.motivacao_principal) || hasValue(lead.dor_principal);
  const storedPendingCriterion = String(salesContext.pending_criterion || '').trim();

  if (catalogMode === 'awaiting_area') return 'catalog_area_selection';
  if (catalogMode === 'awaiting_course') return 'course_selection';
  if (courseStatus === 'catalog_exploration') return 'catalog_area_selection';
  if (courseStatus === 'catalog_area_selected' && !courseValidated) return 'course_selection';
  if (courseStatus === 'ambiguous_available' || (lineRequired && !lineKnown)) return 'course_line';
  if (courseStatus === 'segment_options_available') return 'alternative_course_selection';
  if (
    storedPendingCriterion === 'motivation'
    && courseValidated
    && cityKnown
    && !motivationKnown
  ) return 'motivation';
  if (
    storedPendingCriterion === 'motivation'
    && courseValidated
    && cityKnown
    && motivationKnown
  ) return null;
  if (courseValidated && cityKnown && motivationKnown) return null;
  if (courseStatus === 'confirmed_unavailable' || courseStatus === 'segment_unavailable') return 'new_direction';
  if (!courseValidated) return 'course';
  if (!cityKnown) return 'city';
  if (!motivationKnown) return 'motivation';
  return null;
}

export function getNextCatalogAction(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
}) {
  const lead = params.leadSnapshot || {};
  const salesContext = salesContextFrom(lead);
  const catalogMode = String(salesContext.catalog_mode || '').trim();
  const selectedArea = String(salesContext.selected_area || salesContext.requested_area_name || '').trim();
  const currentCourse = String(lead.curso_interesse || salesContext.course_display_name || '').trim();

  if (catalogMode === 'awaiting_area' && !selectedArea) return 'ask_area';
  if (catalogMode === 'awaiting_area' && selectedArea) return 'present_area_courses';
  if (catalogMode === 'awaiting_course' && !currentCourse) return 'wait_or_select_course';
  if (catalogMode === 'awaiting_course' && currentCourse) return 'continue_normal_e1';
  return 'inactive';
}

function getE2AvailabilityStatus(salesContext: Record<string, unknown>) {
  if (String(salesContext.e2_availability_status || '').trim()) {
    return String(salesContext.e2_availability_status || '').trim();
  }
  return salesContext.e2_vaccine_availability_done === true ? 'resolved' : 'unresolved';
}

function getE2DecisionMakerStatus(salesContext: Record<string, unknown>) {
  if (String(salesContext.e2_decision_maker_status || '').trim()) {
    return String(salesContext.e2_decision_maker_status || '').trim();
  }
  return salesContext.e2_vaccine_decider_done === true ? 'resolved' : 'unresolved';
}

function getE2CommercialAgreementStatus(salesContext: Record<string, unknown>) {
  if (String(salesContext.e2_commercial_agreement_status || '').trim()) {
    return String(salesContext.e2_commercial_agreement_status || '').trim();
  }
  return salesContext.e2_vaccine_agreement_done === true ? 'resolved' : 'unresolved';
}

function extractDecisionParticipant(message: string) {
  const normalized = normalize(message);
  const pairs = [
    ['pai', 'pai'],
    ['mae', 'mãe'],
    ['marido', 'marido'],
    ['esposo', 'esposo'],
    ['esposa', 'esposa'],
    ['namorado', 'namorado'],
    ['namorada', 'namorada'],
    ['filho', 'filho'],
    ['filha', 'filha'],
    ['socio', 'sócio'],
    ['socia', 'sócia'],
    ['familiar', 'familiar'],
  ];
  const found = pairs.find(([key]) => normalized.includes(key));
  if (found) return found[1];
  if (includesAny(normalized, ['alguem', 'outra pessoa', 'familia'])) return 'essa pessoa';
  if (looksLikeSelfDecisionParticipant(normalized)) return 'self';
  return null;
}

function looksLikeSelfDecisionParticipant(normalized: string) {
  if (!normalized) return false;
  const words = new Set(normalized.split(' ').filter(Boolean));
  const hasFirstPerson = ['eu', 'meu', 'minha', 'mim'].some((word) => words.has(word));
  const hasDecisionVerb = ['decido', 'decidir', 'decisao', 'resolvo', 'responder'].some((word) => normalized.includes(word));
  const hasSoloQualifier = ['sozinho', 'sozinha'].some((word) => words.has(word));
  const hasSelfOnly = (
    (words.has('eu') && (words.has('mesmo') || words.has('mesma')))
    || normalized.includes('sou eu')
    || normalized.includes('so eu')
    || normalized.includes('somente eu')
    || normalized.includes('apenas eu')
    || normalized.includes('por mim')
  );
  const deniesThirdParty = words.has('nao') && (normalized.includes('so eu') || normalized.includes('somente eu') || normalized.includes('apenas eu'));
  return (hasFirstPerson && hasDecisionVerb) || (hasDecisionVerb && hasSoloQualifier) || hasSelfOnly || deniesThirdParty;
}

function looksLikeConditionalPriceAgreement(message: string) {
  const normalized = normalize(message);
  return includesAny(normalized, [
    'vai depender do valor',
    'dependendo do valor',
    'depende do valor',
    'depende da mensalidade',
    'se estiver no meu orçamento',
    'se estiver no meu orcamento',
    'preciso ver o valor',
    'quero saber o preço',
    'quero saber o preco',
    'quero ver o valor',
    'se couber no meu bolso',
  ]);
}

function looksLikeSimpleConfirmation(message: string) {
  const normalized = normalize(message);
  return includesAny(normalized, [
    'sim',
    'pode',
    'pode ser',
    'tudo bem',
    'ta bom',
    'tá bom',
    'esta bom',
    'está bom',
    'beleza',
    'claro',
    'ok',
    'okay',
    'certo',
    'combinado',
    'fechado',
    'vamos',
    'pode seguir',
    'positivo',
  ]);
}

function assistantPresentedCommercialAgreement(history: Array<{ role?: string; content?: string }>) {
  const normalized = normalize(
    [...(history || [])]
      .filter((item) => item?.role === 'assistant' && item?.content)
      .slice(-4)
      .map((item) => item.content || '')
      .join('\n\n')
  );
  if (!normalized) return false;
  return normalized.includes('combinado')
    && (
      normalized.includes('bolsa')
      || normalized.includes('inscricao')
      || normalized.includes('bolso')
      || normalized.includes('nao fizer sentido')
      || normalized.includes('se fizer sentido')
    );
}

export function getNextE2Criterion(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
}) {
  const salesContext = salesContextFrom(params.leadSnapshot);
  const availabilityStatus = getE2AvailabilityStatus(salesContext);
  const decisionMakerStatus = getE2DecisionMakerStatus(salesContext);
  const commercialAgreementStatus = getE2CommercialAgreementStatus(salesContext);

  if (availabilityStatus === 'unresolved') return 'vaccine_availability';
  if (decisionMakerStatus === 'unresolved') return 'vaccine_decider';
  if (commercialAgreementStatus === 'unresolved') return 'vaccine_agreement';
  if (commercialAgreementStatus === 'conditional_price_pending_confirmation') return 'vaccine_agreement';
  return null;
}

export function getE2StateSnapshot(leadSnapshot: Record<string, unknown> | null | undefined) {
  const salesContext = salesContextFrom(leadSnapshot);
  return {
    availability_status: getE2AvailabilityStatus(salesContext),
    decision_maker_status: getE2DecisionMakerStatus(salesContext),
    commercial_agreement_status: getE2CommercialAgreementStatus(salesContext),
    next_criterion: getNextE2Criterion({ leadSnapshot }),
  };
}

function latestAssistant(history: Array<{ role?: string; content?: string }>) {
  return [...(history || [])].reverse().find((item) => item?.role === 'assistant')?.content || '';
}

function assistantAskedE3InterestQuestion(history: Array<{ role?: string; content?: string }>) {
  const normalized = normalize(latestAssistant(history));
  return includesAny(normalized, [
    'o que mais chamou sua atencao',
    'o que mais chamou a sua atencao',
    'o que mais fez sentido',
    'qual ponto mais chamou sua atencao',
    'quais pontos voce mais gostou',
    'o que voce mais gostou',
  ]);
}

function assistantAskedIfLeadHasE3Doubts(history: Array<{ role?: string; content?: string }>) {
  const normalized = normalize(latestAssistant(history));
  return includesAny(normalized, [
    'tem alguma duvida',
    'tem mais alguma duvida',
    'se tiver alguma duvida',
    'se tiver mais alguma duvida',
    'ficou alguma duvida',
    'gostaria de saber mais alguma coisa',
    'tem algo mais que voce gostaria de saber',
  ]);
}

function looksLikeNoMoreE3Doubts(message: string) {
  const normalized = normalize(message);
  return [
    'nao',
    'nao tenho',
    'nenhuma',
    'nenhuma duvida',
    'nao tenho duvida',
    'nao tenho duvidas',
    'sem duvida',
    'sem duvidas',
    'tudo certo',
    'tudo esclarecido',
  ].includes(normalized);
}

export function looksLikeE3DoubtOrObjection(message: string) {
  const raw = String(message || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return false;

  const question = raw.includes('?')
    || /^(como|qual|quais|quando|onde|quanto|quantos|quantas|por que|porque|posso|pode|tem|terei|vou|vai|sera|sao|e possivel)\b/.test(normalized)
    || /\b(gostaria de saber|queria saber|me explica|me explique|me fala|me conta|tenho uma duvida|nao entendi)\b/.test(normalized)
    || (/\b(aula|aulas|tutor|tutores|duracao|modalidade|diploma|mec|universidade|curso|graduacao)\b/.test(normalized)
      && /\b(funciona|funcionam|acontece|acontecem|vai|vao|sera|serao|tem|terei)\b/.test(normalized));

  const objection = includesAny(normalized, [
    'nao gostei',
    'nao faz sentido',
    'nao quero',
    'nao posso',
    'nao consigo',
    'nao cabe no meu bolso',
    'nao encaixa no meu orcamento',
    'muito caro',
    'achei caro',
    'muito tempo',
    'achei muito tempo',
    'nao tenho tempo',
    'muito dificil',
    'achei dificil',
    'tenho receio',
    'tenho medo',
    'me preocupa',
    'me preocupo',
    'o problema e',
  ]);

  return question || objection;
}

function looksLikeMeaningfulE3InterestAnswer(message: string) {
  const normalized = normalize(message);
  if (!normalized || looksLikeE3DoubtOrObjection(message)) return false;
  if ([
    'sim', 'nao', 'ok', 'okay', 'certo', 'entendi', 'beleza', 'perfeito',
    'obrigado', 'obrigada', 'ta bom', 'esta bom',
  ].includes(normalized)) return false;
  return /[a-z]/i.test(normalized);
}

function looksLikePhoneReply(message: string) {
  return /^\+?\d{10,15}$/.test(String(message || '').replace(/[^\d+]/g, ''));
}

function looksLikeFullName(message: string) {
  const normalized = normalize(message);
  if (!normalized || looksLikePhoneReply(message)) return false;
  const words = normalized.split(' ').filter(Boolean);
  return words.length >= 2 && words.length <= 5 && words.every((word) => /^[a-z]+$/i.test(word) && word.length >= 2);
}

function looksLikeReferralName(message: string) {
  const normalized = normalize(message);
  if (!normalized || looksLikePhoneReply(message)) return false;
  if (includesAny(normalized, ['sim', 'nao', 'não', 'claro', 'com certeza', 'recomendo', 'recomendaria', 'ninguem', 'ninguém'])) return false;
  const words = normalized.split(' ').filter(Boolean);
  return words.length >= 1 && words.length <= 5 && words.every((word) => /^[a-z]+$/i.test(word) && word.length >= 2);
}

function extractFullNameCandidate(message: string) {
  const raw = String(message || '').trim();
  const cleaned = raw
    .replace(/^(meu\s+nome\s+completo\s+(?:e|é)\s+)/i, '')
    .replace(/^(meu\s+nome\s+(?:e|é)\s+)/i, '')
    .replace(/^(sou\s+)/i, '')
    .trim();
  return cleaned || raw;
}

function detectBoletoDateChoice(message: string) {
  const normalized = normalize(message);
  if (!normalized) return null;
  if (includesAny(normalized, ['hoje', 'ainda hoje'])) return { kind: 'today', label: 'hoje' };
  if (includesAny(normalized, ['proxima segunda', 'segunda feira', 'segunda-feira'])) {
    return { kind: 'next_monday', label: 'proxima segunda-feira' };
  }
  if (/\bdia\s+\d{1,2}\b/.test(normalized)) return { kind: 'custom', label: message.trim() };
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(message)) return { kind: 'custom', label: message.trim() };
  return null;
}

function assistantAskedProposalName(history: Array<{ role?: string; content?: string }>) {
  return includesAny(normalize(latestAssistant(history)), [
    'nome completo',
    'nao gera compromisso',
    'documento com as informacoes',
    'condicoes da bolsa',
  ]);
}

export function derivePendingCriterion(params: {
  stage: string;
  leadSnapshot: Record<string, unknown> | null | undefined;
  history: Array<{ role?: string; content?: string }>;
}) {
  const stage = String(params.stage || '').toUpperCase();
  const lead = params.leadSnapshot || {};
  const salesContext = salesContextFrom(lead);

  if (salesContext.proposal_checkpoint_pending === true) return 'proposal_admin_checkpoint';
  if (salesContext.enrollment_checkpoint_pending === true) return 'enrollment_admin_checkpoint';

  if (stage === 'E1') {
    return getNextE1Criterion({ leadSnapshot: lead });
  }

  if (stage === 'E2') {
    return getNextE2Criterion({ leadSnapshot: lead });
  }

  if (stage === 'E3') {
    if (salesContext.e3_presentation_complete !== true) return 'presentation';
    if (salesContext.e3_interest_signal_captured !== true) return 'interest_signal';
    return null;
  }

  if (stage === 'E4') {
    if (salesContext.proposal_checkpoint_completed !== true) {
      if (!looksLikeFullName(String(salesContext.proposal_full_name || '')) && !looksLikeFullName(String(lead.nome || ''))) return 'full_name';
      return 'proposal_admin_checkpoint';
    }
    if (salesContext.e4_negotiation_done !== true) return 'negotiation';
    if (salesContext.enrollment_intent_confirmed !== true) return 'enrollment_intent';
    if (salesContext.enrollment_checkpoint_completed !== true) return 'enrollment_admin_checkpoint';
    return null;
  }

  if (stage === 'E5') {
    return hasValue(salesContext.boleto_date_choice) ? null : 'boleto_date';
  }

  if (stage === 'E6') {
    if (salesContext.e6_satisfaction_collected !== true && salesContext.e6_feedback_collected !== true) return 'service_satisfaction';
    if (salesContext.e6_feedback_collected !== true) return 'service_recommendation';
    if (salesContext.e6_recommended_service === true) {
      if (!hasValue(salesContext.pending_indication_name) && salesContext.no_indication !== true) return 'referral_name';
      if (hasValue(salesContext.pending_indication_name) && salesContext.referral_registered !== true) return 'referral_phone';
    }
    return null;
  }

  if (stage === 'E7') {
    if (salesContext.referral_registered === true) return 'referral_preparation';
    if (salesContext.e7_closing_complete === true) return null;
    return 'final_question';
  }

  return null;
}

export function detectLastAgentQuestionType(params: {
  stage: string;
  text: string | undefined;
  pendingCriterion?: PendingCriterion;
}) {
  const normalized = normalize(params.text || '');
  if (!normalized) return null;
  const pending = params.pendingCriterion || null;
  if (pending) return pending;

  if (includesAny(normalized, ['qual cidade', 'de qual cidade', 'em que cidade'])) return 'city';
  if (includesAny(normalized, ['ja trabalha na area', 'sonho ou objetivo pessoal', 'esse curso representa um sonho'])) return 'motivation';
  if (includesAny(normalized, ['bacharelado ou licenciatura', 'qual linha'])) return 'course_line';
  if (includesAny(normalized, ['qual area mais se identifica', 'qual área mais se identifica', 'qual area faz mais sentido'])) return 'catalog_area_selection';
  if (includesAny(normalized, ['qual desses cursos', 'qual dessas opcoes', 'qual opcao interessou mais'])) return 'alternative_course_selection';
  if (includesAny(normalized, ['qual curso voce gostou mais', 'qual curso você gostou mais', 'qual curso mais te interessou'])) return 'course_selection';
  if (includesAny(normalized, ['viagem', 'mudanca'])) return 'vaccine_availability';
  if (includesAny(normalized, ['decide sozinho', 'conversa com alguem'])) return 'vaccine_decider';
  if (includesAny(normalized, ['combinado', 'bolsa ficar boa', 'seguimos para inscricao'])) return 'vaccine_agreement';
  if (includesAny(normalized, ['nome completo'])) return 'full_name';
  if (includesAny(normalized, ['hoje ou para a proxima segunda', 'boleto'])) return 'boleto_date';
  if (includesAny(normalized, ['gostou do atendimento'])) return 'service_satisfaction';
  if (includesAny(normalized, ['recomendaria esse atendimento', 'recomendaria para outra pessoa'])) return 'service_recommendation';
  if (includesAny(normalized, ['recomenda para outra pessoa'])) return 'referral_decision';
  if (includesAny(normalized, ['nome dessa pessoa', 'nome do indicado'])) return 'referral_name';
  if (includesAny(normalized, ['telefone dessa pessoa', 'telefone do indicado'])) return 'referral_phone';
  return null;
}

function normalizeCourseChoice(text: string) {
  return normalize(text)
    .replace(/\b(cst|abi|bacharelado|licenciatura|tecnologo|tecnologia em)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isExplicitMoreOptionsRequest(message: string) {
  const normalized = normalize(message);
  return includesAny(normalized, [
    'tem mais',
    'quais outros',
    'outros cursos',
    'outras opcoes',
    'outras opções',
    'nao gostei',
    'não gostei',
    'quero escolher outro',
    'quero ver outros',
  ]);
}

export function matchOfferedCourseSelection(message: string, offeredCourses: unknown[]) {
  if (isExplicitMoreOptionsRequest(message)) return null;

  const inbound = normalizeCourseChoice(message);
  if (!inbound) return null;

  const matches = (offeredCourses || [])
    .map((course) => String(course || '').trim())
    .filter(Boolean)
    .map((course) => ({ course, normalized: normalizeCourseChoice(course) }))
    .filter(({ normalized }) => {
      if (!normalized) return false;
      return normalized === inbound || normalized.includes(inbound) || inbound.includes(normalized);
    });

  const uniqueMatches = Array.from(new Map(matches.map((item) => [item.normalized, item.course])).values());
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

function matchCatalogAreaSelection(message: string, availableAreas: unknown[] = []) {
  const normalized = normalize(message);
  if (!normalized) return null;

  const officialAreas = (availableAreas || [])
    .map((area) => String(area || '').trim())
    .filter(Boolean);
  const fallbackOfficialAreas = [
    'Ambiental e Agro',
    'Criacao e Midia',
    'Design e Criacao',
    'Educacao',
    'Gastronomia',
    'Gestao e Negocios',
    'Juridico e Publico',
    'Saude e Beleza',
    'Tecnologia',
  ];
  const canonicalAreas = officialAreas.length > 0 ? officialAreas : fallbackOfficialAreas;
  const aliasByArea: Record<string, string[]> = {
    [normalize('Tecnologia')]: ['tecnologia', 'ti', 'sistemas', 'computacao', 'computador', 'dados', 'programacao', 'ciberseguranca'],
    [normalize('Saude e Beleza')]: ['saude', 'beleza', 'radiologia', 'enfermagem', 'farmacia', 'biomedicina', 'fisioterapia', 'nutricao', 'psicologia', 'estetica'],
    [normalize('Gestao e Negocios')]: ['gestao', 'negocios', 'administracao', 'contabilidade', 'rh', 'recursos humanos', 'logistica', 'marketing'],
    [normalize('Educacao')]: ['educacao', 'pedagogia', 'licenciatura', 'professor', 'ensino'],
    [normalize('Juridico e Publico')]: ['juridica', 'juridico', 'direito', 'publico', 'servico publico', 'gestao publica'],
    [normalize('Ambiental e Agro')]: ['ambiental', 'agro', 'agronomia', 'meio ambiente'],
    [normalize('Criacao e Midia')]: ['midia', 'comunicacao', 'publicidade', 'jornalismo', 'criacao'],
    [normalize('Design e Criacao')]: ['design', 'criacao', 'moda'],
    [normalize('Gastronomia')]: ['gastronomia', 'cozinha', 'culinaria'],
  };

  const areas = canonicalAreas.map((name) => {
    const key = normalize(name);
    return {
      name,
      patterns: [key, ...(aliasByArea[key] || [])],
    };
  });

  const matches = areas.filter((area) => area.patterns.some((pattern) => normalized.includes(pattern)));
  return matches.length === 1 ? matches[0].name : null;
}

export function classifyInboundAgainstStageState(params: {
  stage: string;
  leadSnapshot: Record<string, unknown> | null | undefined;
  history: Array<{ role?: string; content?: string }>;
  latestUserMessage: string;
}) {
  const stage = String(params.stage || '').toUpperCase();
  const latestUserMessage = String(params.latestUserMessage || '').trim();
  const normalized = normalize(latestUserMessage);
  const lead = params.leadSnapshot || {};
  const salesContext = salesContextFrom(lead);
  const pendingCriterion = derivePendingCriterion(params);
  const lastAgentQuestionType = String(salesContext.last_agent_question_type || detectLastAgentQuestionType({
    stage,
    text: latestAssistant(params.history),
  }) || '');

  const result = {
    pendingCriterion,
    lastAgentQuestionType: lastAgentQuestionType || null,
    classification: 'general_context',
    classificationReason: 'no_context_match',
    matched: false,
    explicitNewIntent: false,
    authorizedCourseChange: false,
    statePatch: {} as Record<string, unknown>,
  };

  if (!normalized) return result;

  if (stage === 'E1' && pendingCriterion === 'catalog_area_selection') {
    const selectedArea = matchCatalogAreaSelection(
      latestUserMessage,
      salesContext.available_catalog_areas || salesContext.available_areas || [],
    );
    if (selectedArea) {
      return {
        ...result,
        classification: 'contextual_catalog_area_selection',
        classificationReason: 'selected_catalog_area',
        matched: true,
        explicitNewIntent: true,
        authorizedCourseChange: true,
        statePatch: {
          selected_area: selectedArea,
          requested_area_name: selectedArea,
          catalog_mode: 'awaiting_course',
          course_status: 'catalog_area_selected',
          catalog_exploration_intent: true,
          pending_criterion: 'course_selection',
        },
      };
    }
  }

  if (stage === 'E1' && (pendingCriterion === 'course_selection' || pendingCriterion === 'alternative_course_selection')) {
    const selectedCourse = matchOfferedCourseSelection(latestUserMessage, salesContext.related_area_courses || salesContext.area_courses || []);
    if (selectedCourse) {
      return {
        ...result,
        classification: 'contextual_course_selection',
        classificationReason: 'selected_catalog_course',
        matched: true,
        authorizedCourseChange: true,
        statePatch: {
          curso_interesse: selectedCourse,
          course_display_name: selectedCourse,
          course_validated: true,
          course_status: 'confirmed_available',
          catalog_mode: 'inactive',
          catalog_exploration_intent: false,
          course_was_selected_from_offered_list: true,
          selected_area: salesContext.requested_area_name || salesContext.selected_area || null,
          pending_criterion: 'city',
        },
      };
    }
  }

  if (pendingCriterion === 'city' && looksLikeResolvedCityReply(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_city',
      matched: true,
      statePatch: { cidade: latestUserMessage, e1_city_confirmed: true, pending_criterion: 'motivation' },
    };
  }

  if (pendingCriterion === 'motivation' && looksLikeResolvedMotivationReply(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_motivation',
      matched: true,
      statePatch: { motivacao_principal: latestUserMessage, pending_criterion: null },
    };
  }

  if (pendingCriterion === 'motivation' && looksLikePositiveMotivationWorkReply(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_motivation',
      matched: true,
      statePatch: {
        e1_works_in_area: true,
        e1_work_status_answer: latestUserMessage,
        motivacao_principal: latestUserMessage,
        pending_criterion: null,
      },
    };
  }
  if (pendingCriterion === 'motivation' && looksLikePartialMotivationWorkReply(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'partial_pending_motivation_work_status',
      matched: true,
      statePatch: {
        e1_works_in_area: false,
        e1_work_status_answer: latestUserMessage,
        pending_criterion: 'motivation',
      },
    };
  }

  if (pendingCriterion === 'motivation' && includesAny(normalized, ['ja disse', 'já disse', 'eu ja disse', 'eu já disse'])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'motivation_already_answered_complaint',
      matched: true,
      statePatch: {
        pending_criterion: 'motivation',
      },
    };
  }

  if (
    (pendingCriterion === 'course_line' || String(salesContext.course_status || '').trim() === 'ambiguous_available')
    && includesAny(normalized, ['bacharelado', 'licenciatura'])
  ) {
    return {
      ...result,
      classification: 'contextual_course_line',
      classificationReason: 'resolved_pending_course_line',
      matched: true,
      statePatch: {
        linha_formacao: normalized.includes('licenciatura') ? 'Licenciatura' : 'Bacharelado',
        line_selection_required: false,
        course_validated: true,
        course_status: 'confirmed_available',
      },
    };
  }

  const availabilityReplyExplicitlyMentionsTravelOrMove = includesAny(normalized, [
    'nao tenho viagem',
    'nao vou viajar',
    'nao tenho mudanca',
    'nao vou me mudar',
    'sem viagem',
    'sem mudanca',
  ]);
  if (
    pendingCriterion === 'vaccine_availability'
    && (lastAgentQuestionType === 'vaccine_availability' || availabilityReplyExplicitlyMentionsTravelOrMove)
    && includesAny(normalized, ['nao', 'n~so', 'negativo', 'negativa', 'nao tenho viagem', 'nao vou viajar', 'nao tenho mudanca'])
  ) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_1_negative',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_answer: latestUserMessage,
        pending_criterion: 'vaccine_decider',
      },
    };
  }

  if (pendingCriterion === 'vaccine_availability' && includesAny(normalized, ['positivo', 'positiva'])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_1_contextual_affirmative',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_answer: latestUserMessage,
        e2_availability_objection_kind: 'travel_or_move',
        pending_criterion: 'vaccine_decider',
      },
    };
  }
  if (
    pendingCriterion === 'vaccine_availability'
    && lastAgentQuestionType === 'vaccine_availability'
    && looksLikeContextualAffirmativeReply(latestUserMessage)
  ) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_1_contextual_affirmative',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_answer: latestUserMessage,
        e2_availability_objection_kind: 'travel_or_move',
        pending_criterion: 'vaccine_decider',
      },
    };
  }

  if (pendingCriterion === 'vaccine_availability' && (
    includesAny(normalized, [
      'tenho viagem',
      'vou viajar',
      'preciso viajar',
      'talvez precise viajar',
      'vou me mudar',
      'vou mudar',
      'mudar de cidade',
      'mudar',
      'me mudar',
      'mudanca',
      'mudança',
      'tenho mudanca',
      'tenho uma mudanca',
      'tenho uma viagem',
      'proximo mes',
      'próximo mês',
      'interferir no inicio',
      'interferir no início',
      'atrapalhar o inicio',
      'atrapalhar o início',
    ])
  )) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_1_travel_or_move',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_answer: latestUserMessage,
        e2_availability_objection_kind: 'travel_or_move',
        pending_criterion: 'vaccine_decider',
      },
    };
  }

  if (false && pendingCriterion === 'availability_objection' && includesAny(normalized, [
    'consigo comecar normalmente',
    'consigo começar normalmente',
    'nao interfere',
    'não interfere',
    'nao atrapalha',
    'não atrapalha',
    'consigo iniciar',
    'da para comecar',
    'dá para começar',
  ])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_availability_objection',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_objection_answer: latestUserMessage,
      },
    };
  }

  if (false && pendingCriterion === 'availability_objection' && includesAny(normalized, [
    'pode seguir',
    'positivo',
    'pode continuar',
    'segue o atendimento',
    'pode prosseguir',
  ])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'availability_objection_still_pending',
      matched: true,
      statePatch: {
        e2_availability_status: 'objection_pending',
      },
    };
  }

  const decisionParticipant = pendingCriterion === 'vaccine_decider' ? extractDecisionParticipant(latestUserMessage) : null;
  const contextualDecisionParticipant =
    pendingCriterion === 'vaccine_availability'
    && lastAgentQuestionType === 'vaccine_decider'
      ? extractDecisionParticipant(latestUserMessage)
      : null;

  if (contextualDecisionParticipant || (
    pendingCriterion === 'vaccine_availability'
    && lastAgentQuestionType === 'vaccine_decider'
    && includesAny(normalized, [
      'decido com meu marido',
      'decido com minha esposa',
      'decido com ele',
      'decido com ela',
      'decidimos juntos',
      'so eu',
      'converso com',
      'falo com meu marido',
      'falo com minha esposa',
      'vejo com',
    ])
  )) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_2_from_last_question',
      matched: true,
      statePatch: {
        e2_decision_maker_status: 'resolved',
        e2_vaccine_decider_done: true,
        e2_vaccine_decider_answer: latestUserMessage,
        e2_decision_participant: contextualDecisionParticipant,
        pending_criterion: 'vaccine_agreement',
      },
    };
  }

  if (pendingCriterion === 'vaccine_decider' && (decisionParticipant || includesAny(normalized, [
    'decido com meu marido',
    'decido com minha esposa',
    'decido com ele',
    'decido com ela',
    'decidimos juntos',
    'so eu',
    'converso com',
    'falo com meu marido',
    'falo com minha esposa',
    'vejo com',
  ]))) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_2',
      matched: true,
      statePatch: {
        e2_decision_maker_status: 'resolved',
        e2_vaccine_decider_done: true,
        e2_vaccine_decider_answer: latestUserMessage,
        e2_decision_participant: decisionParticipant,
        pending_criterion: 'vaccine_agreement',
      },
    };
  }

  if (pendingCriterion === 'vaccine_agreement' && looksLikeConditionalPriceAgreement(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'conditional_price_pending_confirmation',
      matched: true,
      statePatch: {
        e2_commercial_agreement_status: 'conditional_price_pending_confirmation',
        e2_vaccine_agreement_done: false,
        e2_vaccine_agreement_answer: latestUserMessage,
        e2_price_condition: true,
        pending_criterion: 'vaccine_agreement',
      },
    };
  }

  if (
    pendingCriterion === 'vaccine_agreement'
    && getE2CommercialAgreementStatus(salesContext) === 'conditional_price_pending_confirmation'
    && looksLikeSimpleConfirmation(latestUserMessage)
  ) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_3_conditional_confirmation',
      matched: true,
      statePatch: {
        e2_commercial_agreement_status: 'resolved',
        e2_vaccine_agreement_done: true,
        e2_vaccine_agreement_answer: latestUserMessage,
        e2_price_condition: true,
        pending_criterion: null,
      },
    };
  }

  if (
    pendingCriterion === 'vaccine_agreement'
    && assistantPresentedCommercialAgreement(params.history)
    && looksLikeSimpleConfirmation(latestUserMessage)
  ) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_3',
      matched: true,
      statePatch: {
        e2_commercial_agreement_status: 'resolved',
        e2_vaccine_agreement_done: true,
        e2_vaccine_agreement_answer: latestUserMessage,
        pending_criterion: null,
      },
    };
  }

  if (pendingCriterion === 'vaccine_agreement' && includesAny(normalized, [
    'combinado',
    'sim',
    'se a bolsa ficar boa',
    'se fizer sentido',
    'seguimos sim',
  ])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_3',
      matched: true,
      statePatch: {
        e2_commercial_agreement_status: 'resolved',
        e2_vaccine_agreement_done: true,
        e2_vaccine_agreement_answer: latestUserMessage,
        pending_criterion: null,
      },
    };
  }

  const fullNameCandidate = extractFullNameCandidate(latestUserMessage);
  if (pendingCriterion === 'full_name' && looksLikeFullName(fullNameCandidate)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_full_name',
      matched: true,
      statePatch: {
        proposal_full_name: fullNameCandidate,
      },
    };
  }

  if (pendingCriterion === 'boleto_date' && detectBoletoDateChoice(latestUserMessage)) {
    const choice = detectBoletoDateChoice(latestUserMessage);
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_boleto_date',
      matched: true,
      statePatch: {
        boleto_date_choice: choice.kind,
        boleto_date_label: choice.label,
      },
    };
  }

  if (pendingCriterion === 'service_satisfaction' && includesAny(normalized, [
    'sim', 'nao', 'não', 'gostei', 'gostei bastante', 'foi bom', 'foi otimo', 'foi ótimo',
    'mais ou menos', 'nem tanto', 'nao gostei', 'não gostei', 'recomendo', 'recomendaria',
  ])) {
    const positive = !includesAny(normalized, ['nao', 'não', 'mais ou menos', 'nem tanto']);
    const alreadyRecommended = positive && includesAny(normalized, ['recomendo', 'recomendaria']);
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_service_satisfaction',
      matched: true,
      statePatch: {
        e6_satisfaction_collected: true,
        e6_satisfaction_positive: positive,
        e6_feedback_collected: alreadyRecommended || !positive,
        e6_recommended_service: alreadyRecommended ? true : !positive ? false : undefined,
        no_indication: positive ? false : true,
        pending_criterion: alreadyRecommended
          ? 'referral_name'
          : positive
            ? 'service_recommendation'
            : null,
      },
    };
  }

  if ((pendingCriterion === 'service_recommendation' || pendingCriterion === 'referral_decision') && includesAny(normalized, ['sim', 'nao', 'não', 'recomendo', 'recomendaria', 'com certeza'])) {
    const positive = includesAny(normalized, ['sim', 'recomendo', 'recomendaria', 'gostei', 'com certeza']);
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_referral_decision',
      matched: true,
      statePatch: {
        e6_feedback_collected: true,
        e6_recommended_service: positive,
        no_indication: positive ? false : true,
        pending_criterion: positive ? 'referral_name' : null,
      },
    };
  }

  if (pendingCriterion === 'referral_name' && looksLikeReferralName(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_referral_name',
      matched: true,
      statePatch: {
        pending_indication_name: latestUserMessage,
      },
    };
  }

  if (pendingCriterion === 'referral_phone' && looksLikePhoneReply(latestUserMessage)) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_referral_phone',
      matched: true,
      statePatch: {
        pending_indication_phone: latestUserMessage,
      },
    };
  }

  const resolvesE3InterestSignal = stage === 'E3'
    && pendingCriterion === 'interest_signal'
    && (
      (assistantAskedIfLeadHasE3Doubts(params.history) && looksLikeNoMoreE3Doubts(latestUserMessage))
      || (
        (lastAgentQuestionType === 'interest_signal' || assistantAskedE3InterestQuestion(params.history))
        && looksLikeMeaningfulE3InterestAnswer(latestUserMessage)
      )
      || includesAny(normalized, [
        'gostei',
        'tudo',
        'gostei de tudo',
        'todos os pontos',
        'todas as vantagens',
        'nao tenho duvidas',
        'sem duvidas',
        'nenhuma duvida',
        'quero ver os valores',
        'quero saber os valores',
        'valores',
        'valor',
        'preco',
      ])
    );

  if (resolvesE3InterestSignal) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_e3_interest_signal',
      matched: true,
      statePatch: {
        e3_interest_signal_captured: true,
      },
    };
  }

  if (stage === 'E4' && includesAny(normalized, [
    'quero fazer a matricula',
    'quero fazer matrícula',
    'quero matricular',
    'pode fazer a matricula',
    'pode fazer matrícula',
    'vamos fazer a matricula',
    'vamos fazer matrícula',
  ])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_enrollment_intent',
      matched: true,
      statePatch: {
        enrollment_intent_confirmed: true,
      },
    };
  }

  if (stage === 'E7') {
    return {
      ...result,
      classification: 'general_context',
      classificationReason: 'e7_final_context',
      matched: false,
    };
  }

  if (includesAny(normalized, ['quero saber', 'curso de', 'tem o curso', 'qual o valor', 'quanto custa'])) {
    return {
      ...result,
      classification: 'new_intent',
      classificationReason: 'explicit_new_intent',
      matched: false,
      explicitNewIntent: true,
    };
  }

  return result;
}
