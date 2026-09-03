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
      || normalized.includes('apresentacao fizer sentido')
      || normalized.includes('apresentação fizer sentido')
    )
  );
}

const FLOW_NARRATION_PATTERNS = [
  'para seguirmos',
  'para seguir',
  'vamos seguir',
  'seguindo',
  'vamos avancar',
  'vamos avançar',
  'para avancarmos',
  'para avançarmos',
  'vamos continuar',
  'para continuar',
  'para continuarmos',
  'vamos prosseguir',
  'para prosseguir',
  'proximo passo',
  'próximo passo',
  'proximos passos',
  'próximos passos',
  'proxima etapa',
  'próxima etapa',
  'agora vamos',
  'agora seguimos',
  'dando continuidade',
  'continuando o processo',
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
}) {
  const normalized = normalizeText(params.text || '');
  const violations: string[] = [];
  const allowE2AgreementBolsa =
    params.stage === 'E2'
    && String(params.processAction || '').trim() === 'ask_vaccine_agreement'
    && isAllowedE2AgreementLanguage(params.text);
  const allowE2TravelMoveModality =
    params.stage === 'E2'
    && (
      String(params.processAction || '').trim() === 'handle_travel_or_move_and_ask_vaccine_decider'
      || (
        String(params.pendingCriterion || '').trim() === 'vaccine_decider'
        && textIncludesAny(normalizeText(params.latestUserMessage || ''), ['viagem', 'viajar', 'mudanca', 'mudança', 'mudar'])
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

  const flowNarrationDetected = textIncludesAny(normalized, FLOW_NARRATION_PATTERNS);
  if (flowNarrationDetected) {
    violations.push(...FLOW_NARRATION_PATTERNS
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

  const repeatedCityDetected = params.contextualReplyKind === 'city'
    && (() => {
      const rawCity = normalizeText(params.savedCity || params.latestUserMessage || '')
        .replace(/^sou de /, '')
        .replace(/^moro em /, '')
        .replace(/^resido em /, '')
        .trim();
      return Boolean(rawCity) && normalized.includes(rawCity);
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

  const deniedStagePatterns = (STAGE_POLICIES[String(params.stage || '')]?.deny || []).filter((pattern) => {
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

  const actionPatterns: Record<string, string[]> = {
    ask_city: ['qual cidade', 'de qual cidade', 'de onde voce fala', 'de onde você fala', 'em qual cidade', 'de que cidade'],
    ask_motivation: ['ja trabalha na area', 'já trabalha na área', 'sonho ou objetivo pessoal', 'representa um sonho'],
    ask_course_line: ['qual linha', 'bacharelado', 'licenciatura'],
    present_real_areas_and_wait_selection: ['qual area mais se identifica', 'qual area faz mais sentido', 'qual dessas areas'],
    present_area_courses_and_wait_selection: ['qual desses cursos', 'qual curso mais te interessou', 'qual opcao interessou'],
    present_segment_options_and_wait_selection: ['qual dessas opcoes', 'qual dessas opções', 'qual desses cursos', 'qual opcao', 'qual opção', 'qual delas'],
    ask_for_new_direction: ['outra graduacao', 'outra graduação', 'outra area', 'outra área', 'alguma outra opcao', 'alguma outra opção'],
    ask_vaccine_availability: ['viagem', 'mudanca', 'mudança'],
    ask_vaccine_decider: ['decide sozinho', 'conversa com alguem', 'conversa com alguém'],
    ask_vaccine_agreement: ['combinado', 'se a bolsa ficar boa', 'seguimos para inscricao', 'seguimos para inscrição'],
  };
  const processAction = String(params.processAction || '').trim();
  if (processAction && actionPatterns[processAction]) {
    const matchesExpectedQuestion = textIncludesAny(normalized, actionPatterns[processAction]);
    if (!matchesExpectedQuestion && processAction !== 'advance_to_E2') {
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
