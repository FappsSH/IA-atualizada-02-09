// Utility helpers to mask common PII before logs/tests snapshots.
// deno-lint-ignore-file

const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\d{4}|\d{4})-?\d{4}\b/g;

const DEFAULT_REDACT_FIELDS = new Set([
  'text',
  'content',
  'message',
  'body',
  'prompt',
  'response',
  'input',
  'output',
]);

export function redactPII(value: string): string {
  if (!value) return value;

  return value
    .replace(CPF_REGEX, '[CPF]')
    .replace(CNPJ_REGEX, '[CNPJ]')
    .replace(EMAIL_REGEX, '[EMAIL]')
    .replace(PHONE_REGEX, '[PHONE]');
}

export function redactObject<T>(value: T, redactFields = DEFAULT_REDACT_FIELDS): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, redactFields)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
    if (typeof entryValue === 'string' && redactFields.has(key)) {
      return [key, redactPII(entryValue)];
    }

    if (entryValue && typeof entryValue === 'object') {
      return [key, redactObject(entryValue, redactFields)];
    }

    return [key, entryValue];
  });

  return Object.fromEntries(entries) as T;
}
