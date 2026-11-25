// Final outbound validator for WhatsApp-safe assistant text.
// deno-lint-ignore-file
// @ts-nocheck

function normalize(text: string) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOCKED_PARAGRAPH_PATTERNS = [
  'avancar_etapa',
  'registrar_matricula',
  'registrar_indicacao',
  'consultar_conhecimento',
  'subagente',
  'handoff',
  'crm',
  'proxima etapa',
  'próxima etapa',
  'proximos passos',
  'próximos passos',
  'etapa concluida',
  'etapa concluída',
  'agora vou para outra etapa',
  'vamos seguir',
  'vamos avancar',
  'vamos avanÃ§ar',
  'vamos continuar',
  'para seguirmos',
  'para continuarmos',
  'estou aqui para ajudar',
  'mas estou aqui para ajudar',
  'recebido',
  'informacao recebida',
  'informação recebida',
];

const RAW_CATALOG_PATTERNS = [
  'area basica de ingresso',
  'abi',
  'p egresso',
  'egresso',
];

function sanitizeParagraph(paragraph: string) {
  let next = String(paragraph || '').trim();
  if (!next) return '';

  // Remove a frase inteira (nunca corta no meio da frase).
  next = next
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/estou aqui|estou por aqui|estou [àa] disposi[cç][aã]o|fico [àa] disposi[cç][aã]o|se precisar de (mais )?alguma|se precisar de qualquer|se tiver (mais |outras |qualquer |alguma )?(d[uú]vidas?|pergunta)|pode perguntar|qualquer (coisa|d[uú]vida),? ([eé] s[oó] |me )?(chamar|chama|falar|perguntar)/i.test(sentence))
    .join(' ');

  // Spec PERSONALITY: sem "para te ajudar melhor" / "para eu entender melhor" (tira só a expressão).
  next = next
    .replace(/\b(para|pra) (te ajudar|eu te ajudar|eu entender|entender) melhor,?\s*/gi, '')
    .replace(/(^|[.!?]\s+)([a-zà-ú])/g, (_m, lead, ch) => `${lead}${ch.toUpperCase()}`);

  next = next
    .replace(/\bAREA BASICA DE INGRESSO\b/gi, '')
    .replace(/\bABI\b/gi, '')
    .replace(/\bCST\s+EM\s+/gi, '')
    .replace(/\b(é|e)\s+um\s+tecn[oó]logo\b/gi, '$1 uma graduação tecnológica')
    .replace(/\bum\s+tecn[oó]logo\b/gi, 'uma graduação tecnológica')
    .replace(/\bTecn[oó]logo\b/gi, 'graduação')
    .replace(/\bAstrof[ií]sica\s+Qu[aâ]ntica\b/gi, 'essa graduação específica')
    .replace(/\bgradua[cç][aã]o em essa gradua[cç][aã]o espec[ií]fica\b/gi, 'graduação específica')
    .replace(/^\s*e?\s*para seguirmos,?\s*/gi, '')
    .replace(/^\s*e?\s*para continuarmos,?\s*/gi, '')
    .replace(/\bpara seguirmos,?\s*poderia me informar\b/gi, 'me informa')
    .replace(/\bpara continuarmos,?\s*poderia me informar\b/gi, 'me informa')
    .replace(/\bP\s*EGRESSO\b/gi, '')
    .replace(/\bEGRESSO\b/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return next;
}

export function validateOutboundText(text: string) {
  const source = String(text || '').trim();
  if (!source) {
    return { text: source, changed: false, reasons: [] as string[] };
  }

  const reasons: string[] = [];
  const parts = source
    .split(/\n---\n|\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const kept = parts
    .map((part) => sanitizeParagraph(part))
    .filter((part) => {
      const normalized = normalize(part);
      if (!normalized) {
        reasons.push('empty_after_sanitize');
        return false;
      }
      if (BLOCKED_PARAGRAPH_PATTERNS.some((pattern) => normalized.includes(normalize(pattern)))) {
        reasons.push(`blocked_phrase:${normalized.slice(0, 80)}`);
        return false;
      }
      return true;
    });

  let next = kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  if (RAW_CATALOG_PATTERNS.some((pattern) => normalize(next).includes(normalize(pattern)))) {
    next = sanitizeParagraph(next);
    reasons.push('raw_catalog_marker_removed');
  }

  const changed = next !== source || reasons.length > 0;
  return { text: next || source, changed, reasons };
}
