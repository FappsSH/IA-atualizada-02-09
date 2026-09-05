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
  const firstName = getTrustedOpeningFirstName(lead);

  const institutionFacts = [
    'Vamos la entao, quero te apresentar alguns pontos importantes da Cruzeiro do Sul.',
    hasFact('institution_is_university')
      ? String(factByKey.get('institution_is_university')?.content || '')
      : '',
    hasFact('institution_diploma_international_recognition')
      ? String(factByKey.get('institution_diploma_international_recognition')?.content || '')
      : '',
    hasFact('institution_university_advantage_vs_college')
      ? String(factByKey.get('institution_university_advantage_vs_college')?.content || '')
      : '',
    hasFact('institution_60_plus_years')
      ? String(factByKey.get('institution_60_plus_years')?.content || '')
      : '',
    hasFact('institution_maximum_mec_rating')
      ? String(factByKey.get('institution_maximum_mec_rating')?.content || '')
      : '',
    hasFact('institution_maximum_mec_since_beginning')
      ? String(factByKey.get('institution_maximum_mec_since_beginning')?.content || '')
      : '',
  ].filter(Boolean);

  const modalityFacts = authorizedFacts
    .filter((fact) => fact.category === 'course_methodology')
    .map((fact) => String(fact.content || '').trim())
    .filter(Boolean);
  const tutoringFacts = authorizedFacts
    .filter((fact) => fact.category === 'tutoring')
    .map((fact) => String(fact.content || '').trim())
    .filter(Boolean);

  const courseFacts = [
    `Sobre ${courseName}, a ideia aqui e te mostrar de forma bem clara como essa formacao pode encaixar no seu momento.`,
    durationText && durationYears
      ? `O curso tem duracao de ${durationText}, ou seja, em ${durationYears} voce ja pode estar com seu diploma em maos.`
      : durationText
        ? `O curso tem duracao de ${durationText}.`
        : '',
    modality === 'EAD'
      ? 'A forma de estudo e EAD, entao voce consegue conciliar melhor com a rotina que ja tem.'
      : '',
    modality === 'semipresencial'
      ? 'A forma de estudo e semipresencial, com acompanhamento pela plataforma conforme funcionamento autorizado do curso.'
      : '',
    ...modalityFacts,
    ...tutoringFacts,
  ].filter(Boolean);

  const closing = firstName
    ? `De todos esses pontos que eu trouxe pra voce ${firstName}, tem algum em especifico que voce tem alguma duvida?`
    : 'De todos esses pontos que eu trouxe pra voce, tem algum em especifico que ficou com duvida?';

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
      institutionFacts.join('\n\n'),
      courseFacts.join('\n\n'),
      closing,
    ],
    pendingClaims,
    facts: {
      course_display_name: courseName,
      duration_semesters: durationSemesters || null,
      duration_years: durationYears || null,
      modality: modality || null,
      e3_authorized_facts: authorizedFacts,
    },
  };
}
