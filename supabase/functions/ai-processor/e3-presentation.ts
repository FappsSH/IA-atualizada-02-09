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
}) {
  const lead = params.leadSnapshot || {};
  const salesContext = { ...(lead.sales_context || {}) } as Record<string, unknown>;
  const claims = { ...(salesContext.institutional_claims_authorized || {}) } as Record<string, unknown>;
  const tutorClaims = { ...(salesContext.tutor_claims_authorized || {}) } as Record<string, unknown>;
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
    'Vamos la entao, ja quero comecar te apresentando a Universidade Cruzeiro do Sul.',
    claims.university_status === true
      ? 'Esse ponto e importante porque voce esta falando com uma Universidade, nao apenas com uma faculdade isolada.'
      : '',
    claims.market_years === true
      ? 'A instituicao tambem tem uma historia forte no mercado educacional.'
      : '',
    claims.mec_score === true
      ? 'E trabalha com avaliacao institucional reconhecida dentro dos criterios oficiais.'
      : '',
  ].filter(Boolean);

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
    tutorClaims.awarded_best_brazil === true
      ? 'Pra finalizar, voce tera tutores acompanhando sua jornada, com suporte reconhecido dentro da instituicao.'
      : 'Pra finalizar, voce tera suporte de tutores durante a jornada, dentro do que o curso oferece oficialmente.',
  ].filter(Boolean);

  const closing = firstName
    ? `De todos esses pontos que eu trouxe pra voce ${firstName}, tem algum em especifico que voce tem alguma duvida?`
    : 'De todos esses pontos que eu trouxe pra voce, tem algum em especifico que ficou com duvida?';

  const pendingClaims = [];
  if (claims.international_recognition !== true) pendingClaims.push('international_recognition');
  if (claims.university_vs_faculty_difference !== true) pendingClaims.push('university_vs_faculty_difference');
  if (claims.market_years !== true) pendingClaims.push('market_years');
  if (claims.mec_score !== true) pendingClaims.push('mec_score');
  if (tutorClaims.awarded_best_brazil !== true) pendingClaims.push('tutor_awards_best_brazil');

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
    },
  };
}
