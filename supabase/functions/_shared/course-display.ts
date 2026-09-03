// Shared conversational course-display normalization.
// deno-lint-ignore-file
// @ts-nocheck

function normalizeSpaces(value: string) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeOverrideKey(value: string) {
  return normalizeSpaces(String(value || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' '))
    .trim();
}

const COURSE_DISPLAY_OVERRIDES: Record<string, string> = {
  'ciencia da computacao': 'Ciência da Computação',
  'analise de dados de alta performance': 'Análise de Dados de Alta Performance',
  'analise e desenvolvimento de sistemas': 'Análise e Desenvolvimento de Sistemas',
  'banco de dados': 'Banco de Dados',
  'ciberseguranca': 'Cibersegurança',
  'ciencia de dados': 'Ciência de Dados',
  'computacao em nuvem': 'Computação em Nuvem',
  'desenvolvimento back-end': 'Desenvolvimento Back-end',
  'desenvolvimento full stack': 'Desenvolvimento Full Stack',
  'desenvolvimento mobile': 'Desenvolvimento Mobile',
  'gestao da tecnologia da informacao': 'Gestão da Tecnologia da Informação',
  'inteligencia artificial': 'Inteligência Artificial',
  'internet das coisas': 'Internet das Coisas',
  'jogos digitais': 'Jogos Digitais',
  'redes de computadores': 'Redes de Computadores',
  'seguranca da informacao': 'Segurança da Informação',
  'sistemas para internet': 'Sistemas para Internet',
  'engenharia de computacao': 'Engenharia de Computação',
  'engenharia de software': 'Engenharia de Software',
  'ciencias biologicas': 'Ci\u00eancias Biol\u00f3gicas',
  'estetica e cosmetica': 'Est\u00e9tica e Cosm\u00e9tica',
  'gestao da saude publica': 'Gest\u00e3o da Sa\u00fade P\u00fablica',
  'gestao hospitalar': 'Gest\u00e3o Hospitalar',
  'farmacia': 'Farm\u00e1cia',
  'nutricao': 'Nutri\u00e7\u00e3o',
  'terapias integrativas e complementares': 'Terapias Integrativas e Complementares',
};

export function stripInternalCourseMarkers(value: string) {
  return normalizeSpaces(
    String(value || '')
      .replace(/\(\s*AREA BASICA DE INGRESSO\s*\)/gi, '')
      .replace(/\(\s*ABI\s*\)/gi, '')
      .replace(/\(\s*P\s*EGRESSO[^)]*\)/gi, '')
      .replace(/\(\s*EGRESSO[^)]*\)/gi, '')
      .replace(/\bAREA BASICA DE INGRESSO\b/gi, '')
      .replace(/\bABI\b/gi, '')
      .replace(/\bP\s*EGRESSO\b/gi, '')
      .replace(/\bCST\s+EM\s+/gi, '')
      .replace(/\bCST\b/gi, '')
      .replace(/\bTECNOLOGO\s+EM\s+/gi, '')
      .replace(/\bTECNOLOGO\s+EM\s+/gi, ''),
  );
}

export function extractAcademicLine(value: string) {
  const raw = String(value || '');
  if (/\(\s*bacharelado\s*\)/i.test(raw)) return 'Bacharelado';
  if (/\(\s*licenciatura\s*\)/i.test(raw)) return 'Licenciatura';
  if (/\(\s*tecnologo\s*\)/i.test(raw) || /\(\s*tecnólogo\s*\)/i.test(raw)) return 'Tecnologo';
  if (/\(\s*tecnico\s*\)/i.test(raw) || /\(\s*técnico\s*\)/i.test(raw)) return 'Tecnico';
  return '';
}

export function normalizeDisplayLabel(value: string) {
  return normalizeSpaces(
    String(value || '')
      .toLocaleLowerCase('pt-BR')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toLocaleUpperCase('pt-BR') + part.slice(1))
      .join(' '),
  );
}

export function getCourseDisplayName(rawCourse: string | null | undefined, options?: { includeLine?: boolean }) {
  const base = normalizeDisplayLabel(
    stripInternalCourseMarkers(String(rawCourse || ''))
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b[A-Z]{2,6}\d{2,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  if (!base) return '';
  const displayOverride = COURSE_DISPLAY_OVERRIDES[normalizeOverrideKey(base)];
  const conversationalBase = displayOverride || base;
  if (options?.includeLine) {
    const line = extractAcademicLine(String(rawCourse || ''));
    return line ? `${conversationalBase} (${line})` : conversationalBase;
  }
  return conversationalBase;
}
