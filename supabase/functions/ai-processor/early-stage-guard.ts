// Guards for E1/E2 forbidden course presentation.
// deno-lint-ignore-file
// @ts-nocheck

function normalizeText(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textIncludesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function mentionsEarlyStageCourseDetails(text: string | undefined) {
  return detectForbiddenEarlyStageTopics(text).length > 0;
}

export function detectForbiddenEarlyStageTopics(text: string | undefined) {
  const normalized = normalizeText(text || '');
  if (!normalized) return [];

  const topics = [
    'modalidade',
    'ead',
    'semipresencial',
    'presencial',
    'duracao',
    'duracao',
    'semestres',
    'anos',
    'grade',
    'disciplinas',
    'areas de atuacao',
    'mercado',
    'metodologia',
    'encontros presenciais',
    'funcionamento das aulas',
    'instituicao',
    'suporte academico',
    'estrutura',
    'preco',
    'bolsa',
    'desconto',
    'condicao comercial',
    'base solida',
    'foco em',
    'politicas publicas',
    'areas que pode atuar',
    'areas em que pode atuar',
    'mercado de trabalho',
    'voce vai aprender',
    'vai aprender',
    'aprender muito sobre',
    'o curso oferece',
    'oportunidades de atuacao',
  ];

  return topics.filter((topic) => normalized.includes(topic));
}

export function detectAmbiguousCourseLineViolations(
  text: string | undefined,
  allowedLines: string[] | undefined,
) {
  const normalized = normalizeText(text || '');
  const normalizedAllowedLines = new Set(
    (allowedLines || [])
      .map((line) => normalizeText(line))
      .filter(Boolean),
  );
  if (!normalized || normalizedAllowedLines.size === 0) return [];

  const violations: string[] = [];
  for (const line of normalizedAllowedLines) {
    if (!normalized.includes(line)) {
      violations.push(`missing_course_line:${line}`);
    }
  }

  const knownLines = ['bacharelado', 'licenciatura'];
  for (const line of knownLines) {
    if (normalized.includes(line) && !normalizedAllowedLines.has(line)) {
      violations.push(`invalid_course_line:${line}`);
    }
  }

  const placeholderPatterns = [
    'outra linha',
    'outras linhas',
    'outras opcoes',
    'alternativas',
    'alternativas nessa area',
    'outras opcoes parecidas',
    'ou similares',
  ];
  for (const pattern of placeholderPatterns) {
    if (normalized.includes(pattern)) {
      violations.push(`placeholder_line:${pattern}`);
    }
  }

  return violations;
}

export function detectSegmentUnavailableViolations(
  text: string | undefined,
  requestedArea: string | null | undefined,
  relatedAreaCourses: string[] | undefined,
) {
  const normalized = normalizeText(text || '');
  const hasRequestedArea = Boolean(normalizeText(String(requestedArea || '')));
  const hasRelatedCourses = Array.isArray(relatedAreaCourses) && relatedAreaCourses.filter(Boolean).length > 0;
  if (!normalized || hasRequestedArea || hasRelatedCourses) return [];

  const forbiddenPatterns = [
    'mesma area',
    'nessa area',
    'nesta area',
    'nesse segmento',
    'neste segmento',
    'area semelhante',
    'opcoes parecidas nessa area',
  ];

    return forbiddenPatterns
        .filter((pattern) => normalized.includes(pattern))
        .map((pattern) => `invalid_segment_reference:${pattern}`);
}

export function detectUnnecessarySingleLineMention(
  text: string | undefined,
  allowedLines: string[] | undefined,
  pendingCriterion: string | null | undefined,
) {
  const normalized = normalizeText(text || '');
  const normalizedAllowedLines = (allowedLines || [])
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (!normalized || normalizedAllowedLines.length !== 1 || pendingCriterion === 'course_line') return [];

  const line = normalizedAllowedLines[0];
  if (line && normalized.includes(line)) {
    return [`unnecessary_single_line_mention:${line}`];
  }

  return [];
}

export function detectEarlyStageCourseLineLeak(params: {
  text: string | undefined;
  stage: string | null | undefined;
  pendingCriterion: string | null | undefined;
  courseStatus: string | null | undefined;
}) {
  const normalized = normalizeText(params.text || '');
  const stage = String(params.stage || '').toUpperCase();
  const pendingCriterion = String(params.pendingCriterion || '').trim();
  const courseStatus = String(params.courseStatus || '').trim();

  if (!normalized) return [];
  if (!['E1', 'E2'].includes(stage)) return [];
  if (stage === 'E1' && (pendingCriterion === 'course_line' || courseStatus === 'ambiguous_available')) return [];

  const forbiddenPatterns = [
    'tecnologo',
    'tecnólogo',
    'bacharelado',
    'licenciatura',
    'cst',
    'modalidade',
    'duracao',
    'duração',
  ];

  return forbiddenPatterns
    .filter((pattern) => normalized.includes(normalizeText(pattern)))
    .map((pattern) => `early_stage_course_detail_violation:${normalizeText(pattern)}`);
}

export function buildE1AskCityFallback(course: string) {
  const courseLabel = String(course || 'esse curso').trim();
  return `${courseLabel} faz bastante sentido para muita gente que busca esse caminho.\n\nMe diz so de qual cidade voce fala?`;
}

export function buildE1AskMotivationFallback(course: string) {
  const courseLabel = String(course || 'esse curso').trim();
  return `Faz sentido voce olhar para ${courseLabel}.\n\nAgora me conta: voce ja trabalha na area ou isso representa um sonho ou objetivo pessoal para voce?`;
}

export function buildE2AvailabilityFallback() {
  return 'Antes de eu seguir, preciso alinhar uma coisa com voce.\n\nTem alguma viagem mais longa ou mudanca planejada que possa atrapalhar seu inicio?';
}

export function buildE2DecisionFallback() {
  return 'Perfeito.\n\nNuma decisao como essa, voce costuma decidir sozinho ou conversa com alguem antes?';
}
