// Structural E3 presentation builder.
// deno-lint-ignore-file
// @ts-nocheck

import { getTrustedOpeningFirstName } from './initial-opening.ts';
import { getCourseDisplayName } from '../_shared/course-display.ts';

function normalizeModality(value: unknown) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (normalized.includes('ead')) return 'EAD';
  if (normalized.includes('semipresencial')) return 'semipresencial';
  return '';
}

export function formatDurationYearsFromSemesters(semesters: unknown) {
  const value = Number(semesters || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const fullYears = Math.floor(value / 2);
  const hasHalf = value % 2 === 1;
  if (fullYears <= 0 && hasHalf) return 'meio ano';
  if (hasHalf) return `${fullYears} ${fullYears === 1 ? 'ano' : 'anos'} e meio`;
  return `${fullYears} ${fullYears === 1 ? 'ano' : 'anos'}`;
}

// Mensagem curta logo abaixo da imagem da instituição (decisão do administrador, 25/11):
// diz do que a imagem fala, sem explicar cada ponto.
export const E3_IMAGE_CAPTION = 'Essa imagem resume um pouco de quem é a Cruzeiro do Sul: a nossa tradição, o reconhecimento do MEC, o diploma, a plataforma, a tutoria e a flexibilidade pra você estudar do seu jeito. Dá uma olhadinha com calma!!';

export function buildE3PresentationMessages(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
  authorizedFacts?: Array<Record<string, unknown>>;
}) {
  const lead = params.leadSnapshot || {};
  const salesContext = { ...(lead.sales_context || {}) } as Record<string, unknown>;
  const authorizedFacts = Array.isArray(params.authorizedFacts) ? params.authorizedFacts : [];
  const factByKey = new Map(authorizedFacts.map((fact) => [String(fact.claim_key || ''), fact]));
  const hasFact = (key: string) => factByKey.has(key);
  const courseName = getCourseDisplayName(String(
    salesContext.course_display_name || salesContext.curso_base_nome || lead.curso_interesse || 'seu curso',
  ));
  const durationSemesters = Number(salesContext.duration_semesters || salesContext.duracao_semestres || 0);
  const durationText = durationSemesters > 0
    ? `${durationSemesters} semestres`
    : String(salesContext.duration_text || salesContext.duracao || '').trim();
  const durationYears = formatDurationYearsFromSemesters(durationSemesters)
    || String(salesContext.duration_years_text || '').trim();
  const modality = normalizeModality(salesContext.modalidade_oferta || salesContext.delivery_mode || lead.modalidade);
  const hasInternship = typeof salesContext.has_internship === 'boolean'
    ? salesContext.has_internship
    : null;
  const motivation = String(salesContext.motivacao_principal || lead.dor_principal || '').trim();
  const firstName = getTrustedOpeningFirstName(lead);

  const modalityFacts = authorizedFacts
    .filter((fact) => fact.category === 'course_methodology')
    .map((fact) => String(fact.content || '').trim())
    .filter(Boolean);
  const tutoringFacts = authorizedFacts
    .filter((fact) => fact.category === 'tutoring')
    .map((fact) => String(fact.content || '').trim())
    .filter(Boolean);

  const city = String(lead.cidade || salesContext.cidade || '').trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => (index > 0 && ['de', 'do', 'da', 'dos', 'das'].includes(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
  const durationSentence = durationText && durationYears
    ? `A graduação em ${courseName} dura ${durationText}, ou seja, ${durationYears}.`
    : durationText
      ? `A graduação em ${courseName} dura ${durationText}.`
      : `Sobre a graduação em ${courseName}:`;
  const modalitySentence = modality === 'EAD'
    ? ' Ela é 100% EAD, então você assiste às aulas no dia e horário que encaixarem melhor na sua rotina, só respeitando as datas do calendário acadêmico.'
    : modality === 'semipresencial'
      ? ' Ela é semipresencial: nos primeiros semestres as aulas são ao vivo pela plataforma, então você acompanha de onde estiver, numa experiência bem próxima da sala de aula.'
      : '';
  const internshipSentence = hasInternship === true
    ? `E ela tem estágio, que você pode fazer ${city ? `aí em ${city} mesmo` : 'na sua própria cidade'}, caso não consiga se deslocar até o polo.`
    : hasInternship === false
      ? 'E ela não tem estágio, então você não precisa se preocupar com deslocamento nessa parte da formação.'
      : '';

  const courseMessage = [
    `${durationSentence}${modalitySentence}`.trim(),
    internshipSentence,
  ].filter(Boolean).join('\n\n');

  const motivationKey = motivation.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const motivationMessage = !motivation
    ? `E essa formação foi pensada para você construir sua trajetória nessa área com segurança.`
    : /(famili|seguir os passos|\b(pai|mae|irma|irmao|tio|tia|avo|avos)\b)/.test(motivationKey)
      ? `E seguir esse caminho que já faz parte da sua família é muito especial. Essa formação é justamente o que vai te dar a base para construir a sua própria história nessa área.`
      : /(cresc|promoc|promov|cargo|empresa|carreira)/.test(motivationKey)
        ? `E pensando no seu objetivo de crescer onde você trabalha, essa formação é justamente o que vai fortalecer sua atuação e abrir espaço para você assumir novas responsabilidades.`
        : /(trabalh|atuo|atua|auxiliar|tecnic|ja sou|na pratica)/.test(motivationKey)
          ? `E como você já trabalha nessa área, essa formação vem para fortalecer e aprofundar o que você já vive na prática, com a base que faltava para você ir além.`
          : /(sonho|sempre quis|vontade|desde)/.test(motivationKey)
            ? `E isso tem tudo a ver com esse sonho que você me contou. Essa formação é justamente o caminho para você transformar essa vontade em realidade.`
            : `E isso tem tudo a ver com o objetivo que você me contou. Essa formação é justamente o caminho para construir o que você está buscando nessa área.`;

  const closing = firstName
    ? `De todos esses pontos que eu te apresentei ${firstName}, quais foram os que você mais gostou e que mais fizeram sentido pra você?`
    : 'De todos esses pontos que eu te apresentei, quais foram os que você mais gostou e que mais fizeram sentido pra você?';

  const expectedClaims = [
    'institution_is_university',
    'institution_diploma_international_recognition',
    'institution_university_advantage_vs_college',
    'institution_60_plus_years',
    'institution_maximum_mec_rating',
    'institution_maximum_mec_since_beginning',
    'tutoring_full_journey_support',
    'tutoring_deadline_reminders',
    'tutoring_awarded',
    'tutoring_best_in_brazil',
  ];
  const pendingClaims = expectedClaims.filter((key) => !hasFact(key));

  return {
    messages: [
      courseMessage,
      motivationMessage,
      closing,
    ],
    pendingClaims,
    facts: {
      course_display_name: courseName,
      duration_semesters: durationSemesters || null,
      duration_years: durationYears || null,
      modality: modality || null,
      has_internship: hasInternship,
      e3_authorized_facts: authorizedFacts,
    },
  };
}
