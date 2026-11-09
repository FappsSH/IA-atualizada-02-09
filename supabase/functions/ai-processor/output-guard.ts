// Global personality/output guard for all stages.
// deno-lint-ignore-file
// @ts-nocheck

import {
  mentionsEarlyStageCourseDetails,
  detectForbiddenEarlyStageTopics,
  detectUnnecessarySingleLineMention,
  detectEarlyStageCourseLineLeak,
} from './early-stage-guard.ts';

function normalizeText(text: string) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textIncludesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

function looksLikeQuestion(text: string | undefined) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (raw.includes('?')) return true;

  const normalized = normalizeText(raw);
  return textIncludesAny(normalized, [
    'qual ',
    'quais ',
    'voce ja trabalha',
    'você já trabalha',
    'sonho ou objetivo pessoal',
    'representa um sonho',
    'decide sozinho',
    'conversa com alguem',
    'conversa com alguém',
    'combinado',
    'se a bolsa ficar boa',
  ]);
}

function containsE2AvailabilityLeakage(text: string) {
  return textIncludesAny(text, [
    'viagem',
    'viajar',
    'mudanca',
    'mudança',
    'mudar',
    'mudanca planejada',
    'mudança planejada',
    'proximos meses',
    'próximos meses',
    'interferir no inicio da graduacao',
    'interferir no início da graduação',
    'disponibilidade futura',
    'na e2',
    'etapa e2',
    'subagente e2',
    'vou te ajudar com os passos',
  ]);
}

function containsCourseAvailabilityInternalStateLeakage(text: string) {
  const hasCourseSubject = textIncludesAny(text, [
    'curso',
    'graduacao',
    'graduação',
    'opcao',
    'opção',
    'farmacia',
    'farmácia',
  ]);
  const hasAvailabilityMeaning = textIncludesAny(text, [
    'esta disponivel',
    'está disponível',
    'disponivel por aqui',
    'disponível por aqui',
    'disponivel para voce',
    'disponível para você',
    'e ofertado',
    'é ofertado',
    'ofertada por aqui',
    'opcao ofertada',
    'opção ofertada',
    'temos esse curso',
    'temos este curso',
    'temos essa graduacao',
    'temos essa graduação',
    'oferecemos esse curso',
    'oferecemos essa graduacao',
    'oferecemos essa graduação',
    'contamos com esse curso',
    'existe no catalogo',
    'existe no catálogo',
  ]);
  return hasCourseSubject && hasAvailabilityMeaning;
}

function isAllowedE2AgreementLanguage(text: string | undefined) {
  const normalized = normalizeText(text || '');
  if (!normalized) return false;
  return (
    normalized.includes('bolsa')
    && (
      normalized.includes('combinado')
      || normalized.includes('seguimos para a inscricao')
      || normalized.includes('seguimos para a inscrição')
      || normalized.includes('se fizer sentido')
      || normalized.includes('nao encaixa no seu orcamento')
      || normalized.includes('não encaixa no seu orçamento')
      || normalized.includes('nao sincero')
      || normalized.includes('não sincero')
      || normalized.includes('apresentacao fizer sentido')
      || normalized.includes('apresentação fizer sentido')
    )
  );
}

const FLOW_NARRATION_PATTERNS = [
  'para seguirmos',
  'para seguir',
  'antes de seguir',
  'antes de seguirmos',
  'vamos seguir',
  'seguindo',
  'vamos avancar',
  'vamos avançar',
  'para avancarmos',
  'para podermos avancar',
  'para podermos seguir',
  'para que possamos seguir',
  'antes de avancarmos',
  'para avançarmos',
  'vamos continuar',
  'para continuar',
  'para continuarmos',
  'so para concluir',
  'só para concluir',
  'para concluir',
  'para concluirmos',
  'so para finalizar',
  'só para finalizar',
  'para finalizar',
  'antes de finalizar',
  'vamos prosseguir',
  'para prosseguir',
  'proximo passo',
  'próximo passo',
  'proximos passos',
  'próximos passos',
  'proxima etapa',
  'próxima etapa',
  'agora vamos',
  'agora, vamos',
  'agora seguimos',
  'agora falta apenas',
  'falta apenas',
  'dando continuidade',
  'para darmos continuidade',
  'darmos continuidade',
  'continuando o processo',
  'vou verificar',
  'vou consultar',
  'vou checar',
  'estou verificando',
  'estou consultando',
  'estou analisando',
  'aguarde',
  'um momento',
  'so um momento',
  's? um momento',
  'so para garantir',
  's? para garantir',
  'vou buscar informacoes',
  'vou buscar informa??es',
  'vou te passar algumas informacoes',
  'quero te propor um combinado',
  'quero te fazer um combinado',
  'quero fazer um combinado',
  'chegamos ao combinado',
  'vou te passar algumas informa??es',
];

const FLOW_PROGRESS_REGEXES = [
  /\bisso nos ajuda a (avancar|continuar|prosseguir|seguir)\b/,
  /\b(com isso|assim|agora) (podemos|conseguimos) (avancar|continuar|prosseguir|seguir)\b/,
  /\bessa informacao permite (continuar|seguir|avancar)\b/,
  /\b(libera|desbloqueia) (o )?(proximo passo|atendimento|processo)\b/,
  /\bfaz (o )?(processo|atendimento) (seguir|andar|avancar)\b/,
  /\bdamos continuidade\b/,
];

const SYSTEM_NARRATION_PATTERNS = [
  'etapa concluida',
  'etapa concluída',
  'crm',
  'automacao',
  'automação',
  'sistema',
  'fluxo',
  'checkpoint',
];

function systemNarrationMatches(normalized: string) {
  return SYSTEM_NARRATION_PATTERNS.filter((pattern) => {
    const normalizedPattern = normalizeText(pattern);
    if (normalizedPattern === 'sistema') {
      return /\bsistema\b/.test(normalized);
    }
    if (normalizedPattern === 'crm') {
      return /\bcrm\b/.test(normalized);
    }
    return normalized.includes(normalizedPattern);
  });
}

const TECHNICAL_COURSE_NAME_PATTERNS = [
  /\bcst\b/i,
  /\babi\b/i,
  /\btecn[oó]logo\b/i,
  /\barea basica de ingresso\b/i,
  /\bp\s*egresso\b/i,
];

const UNAVAILABLE_DEAD_END_PATTERNS = [
  'infelizmente',
  'estou aqui para ajudar',
  'mas estou aqui para ajudar',
  'feliz em ajudar',
  'ficarei feliz em ajudar',
  'por favor me fale',
  'por favor me informe',
  'nao localizei',
  'nÃ£o localizei',
  'nao encontramos em nosso catalogo',
  'nÃ£o encontramos em nosso catÃ¡logo',
];

const STAGE_POLICIES = {
  E1: {
    deny: ['modalidade', 'duracao', 'preco', 'bolsa', 'desconto', 'instituicao', 'instituição'],
  },
  E2: {
    deny: ['modalidade', 'duracao', 'preco', 'bolsa', 'desconto', 'instituicao', 'instituição'],
  },
  E3: {
    deny: ['desconto especial', 'condicao comercial', 'condição comercial'],
  },
  E4: {
    deny: ['modalidade como preferencia', 'pausar o fluxo', 'o admin', 'a equipe administrativa'],
  },
  E5: {
    deny: ['modalidade', 'vamos vender', 'revalidar matricula', 'revalidar matrícula'],
  },
  E6: {
    deny: ['curso do indicado', 'cidade do indicado', 'area do indicado', 'área do indicado'],
  },
  E7: {
    deny: ['nova indicacao', 'nova indicação', 'nova venda', 'requalificar'],
  },
} as Record<string, { deny: string[] }>;

const E3_CLAIM_GUARD_PATTERNS = [
  { claimKey: 'institution_maximum_mec_since_beginning', patterns: ['desde quando comecamos', 'desde quando começamos'] },
  { claimKey: 'tutoring_deadline_reminders', patterns: ['tutores lembram', 'lembrar das datas', 'lembram das datas', 'lembrar os prazos', 'lembram os prazos'] },
  { claimKey: 'tutoring_best_in_brazil', patterns: ['melhores tutores do brasil', 'melhores do brasil'] },
  { claimKey: 'semipresencial_live_online_classes', patterns: ['aulas ao vivo nos primeiros semestres', 'aulas ao vivo pela plataforma de onde estiver'] },
  { claimKey: 'ead_flexible_study_schedule', patterns: ['dia e horario que quiser', 'dia e horário que quiser'] },
  { claimKey: 'institution_university_advantage_vs_college', patterns: ['faculdade ou centro universitario nao', 'faculdade ou centro universitário não'] },
  { claimKey: 'institution_is_university', patterns: ['nao apenas com uma faculdade isolada', 'não apenas com uma faculdade isolada'] },
  { claimKey: 'tutoring_full_journey_support', patterns: ['tutores vao te acompanhar do comeco ao fim', 'tutores vão te acompanhar do começo ao fim', 'acompanhar do comeco ao fim', 'acompanhar do começo ao fim'] },
];

export function detectPersonalityOutputViolations(params: {
  stage: string;
  text: string | undefined;
  latestUserMessage?: string;
  savedCity?: string | null;
  contextualReplyKind?: string | null;
  processAction?: string | null;
  courseStatus?: string | null;
  requestedArea?: string | null;
  relatedAreaCourses?: string[];
  availableCourseLines?: string[];
  pendingCriterion?: string | null;
  e3AuthorizedClaimKeys?: string[];
  e2AvailabilityObjectionKind?: string | null;
  leadMotivation?: string | null;
}) {
  const normalized = normalizeText(params.text || '');
  const violations: string[] = [];
  const allowE2AgreementBolsa =
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && isAllowedE2AgreementLanguage(params.text);
  const isE2TravelMoveResolution =
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_decider'
    && String(params.e2AvailabilityObjectionKind || '').trim() === 'travel_or_move';
  const allowE2TravelMoveModality =
    isE2TravelMoveResolution
    || (
      params.stage === 'E2'
      && (
        String(params.processAction || '').trim() === 'handle_travel_or_move_and_ask_vaccine_decider'
        || (
          String(params.pendingCriterion || '').trim() === 'vaccine_decider'
          && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['viagem', 'viajar', 'mudanca', 'mudança', 'mudar'])
        )
      )
    );
  const allowE2ConditionalMethodology =
    params.stage === 'E2'
    && String(params.pendingCriterion || '').trim() === 'vaccine_agreement'
    && textIncludesAny(normalized, ['valor', 'preco', 'preço'])
    && normalized.includes('metodologia');

  if (!normalized) {
    return {
      personality_guard_triggered: false,
      personality_violations: [],
      flow_narration_detected: false,
      repeated_fact_detected: false,
      ungrounded_output_detected: false,
      unauthorized_stage_fact_detected: false,
      final_personality_valid: true,
    };
  }

  const allowE3NaturalPresentationTransition =
    params.stage === 'E3'
    && String(params.processAction || '').trim() === 'present_e3_structured_blocks'
    && /agora[,]? vamos (falar|conhecer|olhar|ver).{0,80}(curso|graduacao)/.test(normalized);
  const applicableFlowNarrationPatterns = allowE3NaturalPresentationTransition
    ? FLOW_NARRATION_PATTERNS.filter((pattern) => !['agora vamos', 'agora, vamos'].includes(pattern))
    : FLOW_NARRATION_PATTERNS;
  const flowNarrationDetected = textIncludesAny(normalized, applicableFlowNarrationPatterns);
  if (flowNarrationDetected) {
    violations.push(...applicableFlowNarrationPatterns
      .filter((pattern) => normalized.includes(normalizeText(pattern)))
      .map((pattern) => `flow_narration:${pattern}`));
  }

  const flowProgressNarrationDetected = FLOW_PROGRESS_REGEXES.some((regex) => regex.test(normalized));
  if (flowProgressNarrationDetected) {
    violations.push('flow_progress_narration');
  }

  const systemNarrationPatterns = systemNarrationMatches(normalized);
  if (systemNarrationPatterns.length > 0) {
    violations.push(...systemNarrationPatterns.map((pattern) => `system_narration:${pattern}`));
  }

  const unavailableDeadEndDetected = params.stage === 'E1'
    && ['segment_options_available', 'segment_unavailable'].includes(String(params.courseStatus || '').trim())
    && textIncludesAny(normalized, UNAVAILABLE_DEAD_END_PATTERNS);
  if (unavailableDeadEndDetected) {
    violations.push(...UNAVAILABLE_DEAD_END_PATTERNS
      .filter((pattern) => normalized.includes(normalizeText(pattern)))
      .map((pattern) => `unavailable_dead_end_tone:${pattern}`));
  }

  const confirmedE3CourseContradiction =
    params.stage === 'E3'
    && String(params.courseStatus || '').trim() === 'confirmed_available'
    && textIncludesAny(normalized, [
      'curso nao esta disponivel',
      'curso nao esta disponivel no momento',
      'nao temos esse curso',
      'nao oferecemos esse curso',
      'curso indisponivel',
    ]);
  if (confirmedE3CourseContradiction) {
    violations.push('confirmed_e3_course_contradiction');
  }

  if (
    params.stage === 'E1'
    && ['ask_city', 'ask_motivation', 'complete_stage'].includes(String(params.processAction || '').trim())
    && textIncludesAny(normalized, ['eu sou helton', 'sou helton', 'especialista em carreiras'])
  ) {
    violations.push('unexpected_self_introduction');
  }

  if (
    params.stage === 'E1'
    && ['ask_city', 'ask_motivation', 'complete_stage'].includes(String(params.processAction || '').trim())
    && textIncludesAny(normalized, ['muito bom dia', 'muito boa tarde', 'muito boa noite', 'opa, muito'])
  ) {
    violations.push('unexpected_repeated_greeting');
  }

  const repeatedCityDetected = (() => {
    if (params.stage !== 'E1') return false;
    const rawCity = normalizeText(params.savedCity || params.latestUserMessage || '')
      .replace(/^sou de /, '')
      .replace(/^moro em /, '')
      .replace(/^resido em /, '')
      .trim();
    if (!rawCity || !normalized.includes(rawCity)) return false;
    return params.contextualReplyKind === 'city'
      || String(params.processAction || '').trim() === 'ask_motivation'
      || String(params.pendingCriterion || '').trim() === 'motivation';
  })();
  if (repeatedCityDetected) {
    violations.push('redundant_city_restatement');
  }

  const singleLineMentionViolations = ['E1', 'E2'].includes(String(params.stage || ''))
    ? detectUnnecessarySingleLineMention(
      params.text,
      params.availableCourseLines || [],
      params.pendingCriterion || null,
    )
    : [];
  violations.push(...singleLineMentionViolations);

  const earlyStageForbiddenTopics = ['E1', 'E2'].includes(String(params.stage || ''))
    ? detectForbiddenEarlyStageTopics(params.text)
    : [];
  const filteredEarlyStageForbiddenTopics = earlyStageForbiddenTopics.filter((topic) => {
    const normalizedTopic = normalizeText(topic);
    if (allowE2AgreementBolsa && normalizedTopic === 'bolsa') return false;
    if (allowE2TravelMoveModality && ['modalidade', 'ead', 'semipresencial', 'presencial', 'funcionamento das aulas'].includes(normalizedTopic)) return false;
    if (allowE2ConditionalMethodology && normalizedTopic === 'metodologia') return false;
    return true;
  });
  const earlyStageDetailsDetected = filteredEarlyStageForbiddenTopics.length > 0;
  if (earlyStageDetailsDetected) {
    violations.push('early_stage_course_detail_violation');
    violations.push('unauthorized_stage_fact:early_stage_course_details');
  }

  const earlyStageCourseLineLeakViolations = detectEarlyStageCourseLineLeak({
    text: params.text,
    stage: params.stage,
    pendingCriterion: params.pendingCriterion,
    courseStatus: params.courseStatus,
  });
  violations.push(...earlyStageCourseLineLeakViolations);

  const e3Motivation = normalizeText(String(params.leadMotivation || ''));
  const e3FirstBlock = String(params.text || '').split(/\n\s*---\s*\n/)[0] || '';
  const e3OpeningWords = normalizeText(e3FirstBlock);
  const e3MotivationTokens = e3Motivation.split(' ').filter((word) => word.length >= 5 && !['sempre', 'mesmo', 'pessoal', 'porque', 'quero', 'queria', 'fazer', 'curso', 'area', 'graduacao', 'sonho', 'objetivo'].includes(word));
  const e3WorkMotivation = /trabalh|atuar|profiss/.test(e3Motivation);
  const e3OpeningConnectsMotivation = e3WorkMotivation
    ? /trabalh|atua|profiss/.test(e3OpeningWords)
    : e3MotivationTokens.length === 0 || e3MotivationTokens.some((word) => e3OpeningWords.includes(word) || (word.length >= 7 && e3OpeningWords.includes(word.slice(0, -2))));
  if (
    params.stage === 'E3'
    && String(params.processAction || '').trim() === 'present_e3_structured_blocks'
    && e3Motivation
    && !e3OpeningConnectsMotivation
  ) {
    violations.push('e3_missing_personalized_motivation_opening');
  }

  const e3AuthorizedClaimKeys = new Set((params.e3AuthorizedClaimKeys || []).map((key) => String(key || '').trim()));
  const e3DeniedClaimPatterns = String(params.stage || '') === 'E3'
    ? E3_CLAIM_GUARD_PATTERNS
      .filter((item) => !e3AuthorizedClaimKeys.has(item.claimKey))
      .flatMap((item) => item.patterns)
    : [];
  const baseDeniedStagePatterns = [
    ...(STAGE_POLICIES[String(params.stage || '')]?.deny || []),
    ...e3DeniedClaimPatterns,
  ];
  const deniedStagePatterns = baseDeniedStagePatterns.filter((pattern) => {
    const normalizedPattern = normalizeText(pattern);
    if (allowE2AgreementBolsa && normalizedPattern === 'bolsa') return false;
    if (allowE2TravelMoveModality && normalizedPattern === 'modalidade') return false;
    return true;
  });
  const deniedStageFactDetected = deniedStagePatterns.some((pattern) => normalized.includes(normalizeText(pattern)));
  if (deniedStageFactDetected) {
    violations.push(...deniedStagePatterns
      .filter((pattern) => normalized.includes(normalizeText(pattern)))
      .map((pattern) => `unauthorized_stage_fact:${pattern}`));
  }

  const segmentUnavailableUngroundedDetected =
    params.courseStatus === 'segment_unavailable'
    && !normalizeText(params.requestedArea || '')
    && (!Array.isArray(params.relatedAreaCourses) || params.relatedAreaCourses.length === 0)
    && textIncludesAny(normalized, [
      'mesma area',
      'nessa area',
      'area semelhante',
      'area proxima',
      'área próxima',
      'areas relacionadas',
      'áreas relacionadas',
      'area de ciencias exatas',
      'ciencias exatas',
      'ci\u00eancias exatas',
      'fisica',
      'f\u00edsica',
      'área de ciências exatas',
      'segmento parecido',
      'curso relacionado',
      'cursos relacionados',
      'relacionados',
      'relacionadas',
      'alternativas proximas',
      'alternativas próximas',
    ]);
  if (segmentUnavailableUngroundedDetected) {
    violations.push('ungrounded_output:segment_unavailable_inferred_area');
  }

  if (TECHNICAL_COURSE_NAME_PATTERNS.some((pattern) => pattern.test(String(params.text || '')))) {
    violations.push('technical_course_name_leak');
  }

  if (String(params.processAction || '').trim() === 'complete_stage' && looksLikeQuestion(params.text)) {
    violations.push('question_after_stage_complete');
  }

  if (
    params.stage === 'E1'
    && String(params.courseStatus || '').trim() === 'confirmed_available'
    && String(params.processAction || '').trim() === 'ask_city'
    && containsCourseAvailabilityInternalStateLeakage(normalized)
  ) {
    violations.push('internal_state_leakage:course_availability');
  }


  if (
    params.stage === 'E2'
    && (
      containsCourseAvailabilityInternalStateLeakage(normalized)
      || (textIncludesAny(normalized, ['temos o curso', 'curso de', 'graduacao em']) && textIncludesAny(normalized, ['disponivel', 'ofertado', 'ofertada']))
    )
  ) {
    violations.push('internal_state_leakage:course_availability');
  }


  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'ask_city'
    && textIncludesAny(normalized, ['interesse em', 'interessado', 'interessada', 'se interessou', 'se interessar', 'fico feliz em saber que voce tem interesse', 'entender melhor', 'me informe'])
  ) {
    violations.push('weak_course_selection_reaction');
  }

  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'complete_stage'
    && containsE2AvailabilityLeakage(normalized)
  ) {
    violations.push('next_stage_leakage:e2_vaccine_availability');
  }
  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'complete_stage'
    && textIncludesAny(normalized, ['indisponivel', 'indispon?vel', 'outra area', 'outra ?rea', 'outras areas', 'outras ?reas', 'outro curso', 'outros cursos'])
  ) {
    violations.push('complete_stage_reopened_course_selection');
  }

  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'complete_stage'
  ) {
    const inbound = normalizeText(params.latestUserMessage || '');
    const familyMotivation = textIncludesAny(inbound, ['familia', 'fam�lia', 'mae', 'm�e', 'pai', 'marido', 'esposa']);
    const familyReaction = textIncludesAny(normalized, ['familia', 'fam�lia', 'caminho', 'seguir', 'tradicao', 'tradi��o']);
    const dreamMotivation = textIncludesAny(inbound, ['sonho', 'sonhei', 'sempre quis', 'objetivo']);
    const dreamReaction = textIncludesAny(normalized, ['sonho', 'objetivo', 'realizar', 'conquistar', 'caminho']);
    const workMotivation = textIncludesAny(inbound, ['trabalho', 'trabalha', 'atuo', 'area', '�rea', 'concurso', 'proposta', 'oportunidade']);
    const workReaction = textIncludesAny(normalized, ['trabalho', 'profissional', 'area', 'área', 'concurso', 'oportunidade', 'experiencia', 'experiência', 'caminho']);
    const shortIntensifierReaction = /^(excelente|que legal|muito bom|perfeito)!!$/.test(normalized);
    if (
      !shortIntensifierReaction
      && ((familyMotivation && !familyReaction)
      || (dreamMotivation && !dreamReaction)
      || (workMotivation && !workReaction))
    ) {
      violations.push('missing_contextual_motivation_reaction');
    }
  }


  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'complete_stage'
    && textIncludesAny(normalized, [
      'ja trabalha na area',
      'já trabalha na área',
      'sonho ou objetivo pessoal',
      'representa um sonho',
      'objetivo pessoal',
      'objetivo profissional',
    ])
  ) {
    violations.push('repeated_resolved_criterion:motivation');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'complete_stage'
    && textIncludesAny(normalized, [
      'combinado',
      'se a bolsa ficar boa',
      'dependendo do valor',
      'se fizer sentido',
      'se couber no bolso',
      'sim, dependendo das condicoes',
      'sim, dependendo das condições',
      'decide sozinho',
      'conversa com alguem',
      'conversa com alguém',
      'viagem',
      'mudanca',
      'mudança',
    ])
  ) {
    violations.push('repeated_resolved_criterion:commercial_agreement');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && textIncludesAny(normalized, [
      'decide por voce mesmo',
      'decide por você mesmo',
      'decide sozinho',
      'costuma conversar com alguem',
      'costuma conversar com alguém',
      'conversa com alguem antes',
      'conversa com alguém antes',
    ])
  ) {
    violations.push('repeated_resolved_criterion:vaccine_decider');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['converso com', 'falo com', 'vou ver com', 'marido', 'esposa', 'pai', 'mae', 'mãe', 'familia', 'família'])
  ) {
    const hasThirdPartyAck = textIncludesAny(normalized, [
      'conversa com ele',
      'conversa com ela',
      'converse com ele',
      'converse com ela',
      'fala com ele',
      'fala com ela',
      'fale com ele',
      'fale com ela',
      'duvida especifica',
      'dúvida específica',
      'se surgir alguma duvida',
      'se surgir alguma dúvida',
    ]);
    if (!hasThirdPartyAck) {
      violations.push('missing_third_party_decider_acknowledgement');
    }
  }

if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'ask_motivation'
    && textIncludesAny(normalized, ['oportunidades', 'mercado', 'area da saude', 'area cheia', 'excelente escolha', 'escolha de graduacao excelente', 'fico feliz em saber que voce tem interesse', 'valorizo sua escolha'])
  ) {
    violations.push('repeated_course_praise_after_city');
  }


  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'ask_motivation'
    && normalizeText(params.latestUserMessage || '').length >= 3
    && normalized.includes(normalizeText(params.latestUserMessage || ''))
  ) {
    violations.push('redundant_city_restatement');
  }


  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_decider'
    && textIncludesAny(normalized, ['viagem', 'viajar', 'mudanca', 'mudan�a', 'mudar'])
  ) {
    violations.push('repeated_resolved_topic');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_availability'
    && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['familia', 'consultorio', 'objetivo'])
    && textIncludesAny(normalized, ['familia', 'consultorio', 'objetivo', 'plano de abrir'])
  ) {
    violations.push('duplicate_meaningful_reaction');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_decider'
    && textIncludesAny(normalized, ['viagem', 'viajar', 'mudanca', 'mudar', 'programada', 'planejada'])
  ) {
    violations.push('operational_answer_overvalidation');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_availability'
    && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['converso com', 'marido', 'esposa', 'mae', 'm�e', 'pai', 'familia', 'fam�lia', 'eu mesmo', 'eu mesma', 'sozinho', 'so eu', 's� eu', 'decido'])
  ) {
    violations.push('repeated_previous_question_after_decider_answer');
  }

  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'ask_motivation'
    && textIncludesAny(normalized, ['para entender melhor sua motivacao', 'para entender melhor sua motiva��o', 'gostaria de saber um pouco mais sobre o que te motiva', 'agora falta apenas entender sua motivacao', 'agora falta apenas entender sua motiva��o'])
  ) {
    violations.push('motivation_process_preamble');
  }
  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'ask_motivation'
    && /\?/.test(String(params.text || '').split(/\n+/)[0] || '')
    && textIncludesAny(normalized, ['ja trabalha', 'j� trabalha', 'representa um sonho', 'objetivo pessoal'])
    && textIncludesAny(normalized, ['o que te motiva', 'o que te motivou', 'qual sua motivacao', 'qual sua motiva��o'])
  ) {
    violations.push('motivation_opening_should_be_statement');
  }
  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['eu mesmo', 'eu mesma', 'sozinho', 'so eu', 'decido'])
    && textIncludesAny(normalized, ['perfeito', 'otimo', 'legal', 'show', 'maravilha', 'decide sozinho', 'decide sozinha', 'decide por conta propria', 'decisao por conta propria', 'toma a decisao sozinho', 'toma a decisao sozinha', 'sabemos que voce toma a decisao sozinho', 'sabemos que voce toma a decisao sozinha'])
  ) {
    violations.push('operational_answer_overvalidation');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && textIncludesAny(normalized, ['posso te fazer um combinado', 'podemos fazer um combinado', 'posso fazer um combinado', 'posso seguir', 'posso te apresentar', 'posso apresentar', 'esta preparado', 'vamos ao combinado', 'quero te apresentar o combinado', 'quero apresentar o combinado', 'quero fazer questao de te apresentar um combinado', 'combinado comercial', 'quero te propor um combinado', 'chegamos ao combinado', 'quero te fazer um combinado', 'quero fazer um combinado'])
  ) {
    violations.push('agreement_permission_preamble');
  }

  if (
    params.stage === 'E2'
    && ['ask_vaccine_availability', 'ask_vaccine_decider', 'ask_vaccine_agreement'].includes(String(params.processAction || '').trim())
    && !isE2TravelMoveResolution
    && (
      textIncludesAny(normalized, ['entendi', 'para entender melhor', 'so preciso saber', 'só preciso saber'])
      || (String(params.processAction || '').trim() !== 'ask_vaccine_agreement' && normalized.includes('agora'))
    )
  ) {
    violations.push('e2_forbidden_preamble');
  }

  if (isE2TravelMoveResolution) {
    const paragraphs = String(params.text || '')
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    const reaction = paragraphs[0] || '';
    const hasContextualReaction = paragraphs.length >= 2
      && !reaction.includes('?')
      && normalizeText(reaction).split(' ').filter(Boolean).length >= 5;
    if (!hasContextualReaction) {
      violations.push('missing_travel_move_contextual_reaction');
    }
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_decider'
    && textIncludesAny(normalized, ['matricula', 'matr�cula'])
  ) {
    violations.push('e2_decider_used_matricula');
  }
  if (
    params.stage === 'E3'
    && textIncludesAny(normalized, ['comunicacao comercial pode', 'o agente pode', 'metadata', 'claim_key', 'instrucao interna', 'instrucoes internas', 'regra de comunicacao'])
  ) {
    violations.push('internal_metadata_leak');
  }

  if (
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
  ) {
    const hasNegativeSide = textIncludesAny(normalized, ['nao fizer sentido', 'nao encaixar no bolso', 'nao encaixa no seu orcamento', 'não encaixa no seu orçamento', 'nao ficou legal']);
    const hasNoProblemSide = textIncludesAny(normalized, ['sem problema', 'continuamos amigos', 'tudo bem', 'nao sincero', 'não sincero']);
    const hasPositiveSide = textIncludesAny(normalized, ['inscricao'])
      && textIncludesAny(normalized, ['bolsa de estudos'])
      && textIncludesAny(normalized, ['se fizer sentido', 'encaixar no bolso', 'bolsa ficar boa', 'bolsa de estudos ficar boa', 'garantimos essa oportunidade', 'garantir essa oportunidade']);
    const hasAgreementAsk = textIncludesAny(normalized, ['combinado']);
    if (!hasNegativeSide || !hasNoProblemSide || !hasPositiveSide || !hasAgreementAsk) {
      violations.push('commercial_agreement_incomplete');
    }
  }

  if (
    params.stage === 'E1'
    && String(params.processAction || '').trim() === 'complete_stage'
    && textIncludesAny(normalized, ['vacina', 'vacinas', 'covid', 'imunizacao'])
  ) {
    violations.push('medical_vaccine_confusion');
  }

  if (
    params.stage === 'E2'
    && textIncludesAny(normalized, ['vacina', 'vacinas', 'covid', 'imunizacao'])
  ) {
    violations.push('medical_vaccine_confusion');
  }

  if (
    params.stage === 'E7'
    && String(params.processAction || '').trim() === 'human_final_closing'
    && textIncludesAny(normalized, [
      'telefone',
      'matricula',
      'matrÃ­cula',
      'curso',
      'cidade',
      'seguir adiante',
      'seguir',
    ])
  ) {
    violations.push('e7_final_closing_reopened_process');
  }

  const actionPatterns: Record<string, string[]> = {
    ask_city: ['qual cidade', 'de qual cidade', 'de onde voce fala', 'de onde você fala', 'em qual cidade', 'de que cidade'],
    ask_motivation: ['ja trabalha na area', 'já trabalha na área', 'sonho ou objetivo pessoal', 'representa um sonho', 'o que te motivou', 'que te motivou', 'te motivou a escolher', 'qual sua motivacao', 'qual sua motivacao principal'],
    ask_course_line: ['qual linha', 'bacharelado', 'licenciatura'],
    present_real_areas_and_wait_selection: ['qual area mais se identifica', 'qual area faz mais sentido', 'qual dessas areas'],
    present_area_courses_and_wait_selection: ['qual desses cursos', 'qual curso mais te interessou', 'qual opcao interessou'],
    present_segment_options_and_wait_selection: ['qual dessas opcoes', 'qual dessas opções', 'qual desses cursos', 'qual opcao', 'qual opção', 'qual delas'],
    ask_for_new_direction: ['outra graduacao', 'outra graduação', 'outra area', 'outra área', 'alguma outra opcao', 'alguma outra opção'],
    ask_vaccine_availability: ['viagem', 'mudanca', 'mudança'],
    ask_vaccine_decider: ['decide sozinho', 'decide sozinha', 'por conta propria', 'por conta própria', 'costuma decidir sozinho', 'costuma decidir sozinha', 'alguem que participa', 'alguém que participa', 'participa com voce', 'participa com você', 'conversa com alguem', 'conversa com alguém'],
    ask_vaccine_agreement: ['combinado', 'bolsa ficar boa', 'bolsa de estudos ficar boa', 'inscricao', 'inscrição'],
  };
  const processAction = String(params.processAction || '').trim();
  if (processAction && actionPatterns[processAction]) {
    const matchesExpectedQuestion = textIncludesAny(normalized, actionPatterns[processAction]);
    if (!matchesExpectedQuestion && processAction !== 'advance_to_E2' && !(processAction === 'ask_vaccine_agreement' && isAllowedE2AgreementLanguage(params.text))) {
      violations.push(`question_mismatch:${processAction}`);
    }
  }

  return {
    personality_guard_triggered: violations.length > 0,
    personality_violations: violations,
    flow_narration_detected: flowNarrationDetected,
    repeated_fact_detected: repeatedCityDetected,
    ungrounded_output_detected: segmentUnavailableUngroundedDetected,
    unauthorized_stage_fact_detected: earlyStageDetailsDetected || deniedStageFactDetected,
    final_personality_valid: violations.length === 0,
  };
}
