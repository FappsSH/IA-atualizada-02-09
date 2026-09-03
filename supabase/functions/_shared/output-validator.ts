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
  'vamos continuar',
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

  next = next
    .replace(/\bAREA BASICA DE INGRESSO\b/gi, '')
    .replace(/\bABI\b/gi, '')
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

