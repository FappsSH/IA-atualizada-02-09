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
  return String(value || '').trim().length > 0;
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

  if (catalogMode === 'awaiting_area') return 'catalog_area_selection';
  if (catalogMode === 'awaiting_course') return 'course_selection';
  if (courseStatus === 'catalog_exploration') return 'catalog_area_selection';
  if (courseStatus === 'catalog_area_selected' && !courseValidated) return 'course_selection';
  if (courseStatus === 'ambiguous_available' || (lineRequired && !lineKnown)) return 'course_line';
  if (courseStatus === 'segment_options_available') return 'alternative_course_selection';
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
  return null;
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
  return includesAny(normalized, ['sim', 'pode', 'pode ser', 'tudo bem', 'beleza', 'claro', 'ok', 'combinado']);
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
      if (!hasValue(salesContext.proposal_full_name) && !hasValue(lead.nome)) return 'full_name';
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
    if (salesContext.e6_feedback_collected !== true) return 'referral_decision';
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
  if (includesAny(normalized, ['recomenda para outra pessoa', 'gostou do atendimento'])) return 'referral_decision';
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
    pendingCriterion,
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

  if (pendingCriterion === 'motivation' && includesAny(normalized, [
    'sempre quis',
    'meu sonho',
    'objetivo',
    'para concurso',
    'prestar concurso',
    'quero fazer ele para concurso',
    'quero crescer',
    'quero migrar',
    'ja trabalho',
    'trabalho na area',
    'para trabalhar',
  ])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_motivation',
      matched: true,
      statePatch: { motivacao_principal: latestUserMessage, pending_criterion: null },
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

  if (pendingCriterion === 'vaccine_availability' && includesAny(normalized, ['nao', 'nao tenho viagem', 'nao vou viajar', 'nao tenho mudanca'])) {
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_vaccine_1_negative',
      matched: true,
      statePatch: {
        e2_availability_status: 'resolved',
        e2_vaccine_availability_done: true,
        e2_vaccine_availability_answer: latestUserMessage,
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

  if (pendingCriterion === 'vaccine_decider' && (decisionParticipant || includesAny(normalized, [
    'eu que decido',
    'decido sozinho',
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

  if (pendingCriterion === 'referral_decision' && includesAny(normalized, ['sim', 'nao', 'não', 'recomendo', 'recomendaria', 'gostei'])) {
    const positive = includesAny(normalized, ['sim', 'recomendo', 'recomendaria', 'gostei']);
    return {
      ...result,
      classification: 'contextual_response',
      classificationReason: 'resolved_pending_referral_decision',
      matched: true,
      statePatch: {
        e6_feedback_collected: true,
        e6_recommended_service: positive,
        no_indication: positive ? false : true,
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

  if (stage === 'E3' && includesAny(normalized, [
    'gostei',
    'nao tenho duvidas',
    'não tenho dúvidas',
    'sem duvidas',
    'sem dúvidas',
    'nenhuma duvida',
    'nenhuma dúvida',
    'quero ver os valores',
    'quero saber os valores',
    'valores',
    'valor',
    'preco',
    'preço',
  ])) {
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
