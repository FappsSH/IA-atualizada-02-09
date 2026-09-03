// Shared trusted lead-name resolution.
// deno-lint-ignore-file
// @ts-nocheck

function normalize(text: string) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSoft(text: string) {
  return normalize(text).toLowerCase();
}

const GENERIC_NON_PERSON_TOKENS = new Set([
  'admin',
  'administracao',
  'administrativo',
  'advogado',
  'advogada',
  'amigo',
  'amiga',
  'atendente',
  'atendimento',
  'auxiliar',
  'cliente',
  'comprador',
  'compradora',
  'consultor',
  'consultora',
  'contato',
  'coordenador',
  'coordenadora',
  'diretor',
  'diretora',
  'doutor',
  'doutora',
  'dr',
  'dra',
  'enfermeiro',
  'enfermeira',
  'estetica',
  'esteticista',
  'financeiro',
  'fonoaudiologa',
  'fonoaudiologo',
  'gerente',
  'lead',
  'loja',
  'marketing',
  'medica',
  'medico',
  'nutricionista',
  'odontologa',
  'odontologo',
  'paciente',
  'pessoa',
  'perfil',
  'prof',
  'professor',
  'professora',
  'proprietario',
  'proprietaria',
  'psicologa',
  'psicologo',
  'recepcao',
  'recepcionista',
  'rh',
  'secretaria',
  'secretario',
  'senhor',
  'senhora',
  'sr',
  'sra',
  'suporte',
  'tecnica',
  'tecnico',
  'terapeuta',
  'vendedor',
  'vendedora',
]);

function cleanCandidate(raw: string) {
  return normalize(raw)
    .replace(/[|/@#()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeNonPersonLabel(candidate: string) {
  const normalized = normalizeSoft(candidate);
  if (!normalized) return true;
  if (/\d/.test(normalized)) return true;
  if (normalized.includes('@') || normalized.includes('http')) return true;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 5) return true;

  const blockedWhole = [
    'bom dia',
    'boa tarde',
    'boa noite',
    'olá',
    'ola',
    'oi',
    'ooi',
    'oie',
  ];
  if (blockedWhole.includes(normalized)) return true;

  const roleWordCount = words.filter((word) => GENERIC_NON_PERSON_TOKENS.has(word)).length;
  if (roleWordCount >= 1 && words.length <= 2) return true;
  if (roleWordCount >= 2) return true;

  if (!words.every((word) => /^[a-zA-ZÀ-ÿ'-]+$/.test(word))) return true;
  return false;
}

function titleCaseName(candidate: string) {
  return normalize(candidate)
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function evaluateConfidence(candidate: string) {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned || looksLikeNonPersonLabel(cleaned)) {
    return { cleaned: '', normalized: '', confidence: 'none' as const };
  }

  const words = normalizeSoft(cleaned).split(' ').filter(Boolean);
  if (words.length >= 2 && words.length <= 4) {
    return {
      cleaned: titleCaseName(cleaned),
      normalized: normalizeSoft(cleaned),
      confidence: 'trusted' as const,
    };
  }

  if (words.length === 1 && words[0].length >= 3 && !GENERIC_NON_PERSON_TOKENS.has(words[0])) {
    return {
      cleaned: titleCaseName(cleaned),
      normalized: normalizeSoft(cleaned),
      confidence: 'uncertain' as const,
    };
  }

  return { cleaned: '', normalized: '', confidence: 'none' as const };
}

export function extractFirstName(personName: string | null | undefined) {
  const cleaned = titleCaseName(String(personName || ''));
  return cleaned.split(/\s+/).filter(Boolean)[0] || '';
}

export function resolveTrustedLeadName(params: {
  verifiedName?: string | null;
  pushName?: string | null;
  notifyName?: string | null;
  existingTrustedName?: string | null;
}) {
  const candidates = [
    { source: 'verified_name', raw: String(params.verifiedName || '').trim() },
    { source: 'push_name', raw: String(params.pushName || '').trim() },
    { source: 'notify_name', raw: String(params.notifyName || '').trim() },
  ].filter((item) => item.raw);

  for (const candidate of candidates) {
    const evaluated = evaluateConfidence(candidate.raw);
    if (evaluated.confidence === 'trusted') {
      return {
        rawContactName: candidate.raw,
        leadPersonName: evaluated.cleaned,
        leadFirstName: extractFirstName(evaluated.cleaned),
        leadNameSource: candidate.source,
        leadNameConfidence: 'trusted',
        leadNameNormalized: evaluated.normalized,
        leadNameUsed: true,
      };
    }

    if (evaluated.confidence === 'uncertain') {
      return {
        rawContactName: candidate.raw,
        leadPersonName: null,
        leadFirstName: '',
        leadNameSource: candidate.source,
        leadNameConfidence: 'uncertain',
        leadNameNormalized: evaluated.normalized,
        leadNameUsed: false,
      };
    }
  }

  const existingTrustedName = titleCaseName(String(params.existingTrustedName || ''));
  return {
    rawContactName: candidates[0]?.raw || null,
    leadPersonName: existingTrustedName || null,
    leadFirstName: existingTrustedName ? extractFirstName(existingTrustedName) : '',
    leadNameSource: candidates[0]?.source || null,
    leadNameConfidence: existingTrustedName ? 'trusted' : 'none',
    leadNameNormalized: existingTrustedName ? normalizeSoft(existingTrustedName) : '',
    leadNameUsed: Boolean(existingTrustedName),
  };
}
