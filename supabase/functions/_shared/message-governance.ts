// Message governance rules shared across prompt building and final delivery.
// deno-lint-ignore-file
// @ts-nocheck

export interface GreetingRule {
  start: string;
  end: string;
  text: string;
}

export interface MessagePolicy {
  general_rules: string;
  greeting_rules: {
    morning: GreetingRule;
    afternoon: GreetingRule;
    night: GreetingRule;
  };
  formatting: {
    force_separate_messages: boolean;
    insert_blank_line_in_long_messages: boolean;
    long_message_char_threshold: number;
    sentences_per_block: number;
    example_message_1: string;
    example_message_2: string;
  };
  forbidden_chars: string;
}

export const DEFAULT_MESSAGE_POLICY: MessagePolicy = {
  general_rules: '',
  greeting_rules: {
    morning: { start: '06:00', end: '11:59', text: 'Muito bom dia' },
    afternoon: { start: '12:00', end: '17:59', text: 'Muito boa tarde' },
    night: { start: '18:00', end: '05:59', text: 'Muito boa noite' },
  },
  formatting: {
    force_separate_messages: false,
    insert_blank_line_in_long_messages: true,
    long_message_char_threshold: 240,
    sentences_per_block: 2,
    example_message_1: '',
    example_message_2: '',
  },
  forbidden_chars: '',
};

const DEFAULT_TIME_ZONE = 'America/Porto_Velho';

export function normalizeMessagePolicy(raw: Record<string, unknown> | null | undefined): MessagePolicy {
  const policy = raw || {};
  return {
    general_rules: typeof policy.general_rules === 'string'
      ? policy.general_rules
      : DEFAULT_MESSAGE_POLICY.general_rules,
    greeting_rules: {
      morning: {
        ...DEFAULT_MESSAGE_POLICY.greeting_rules.morning,
        ...(policy.greeting_rules?.morning || {}),
      },
      afternoon: {
        ...DEFAULT_MESSAGE_POLICY.greeting_rules.afternoon,
        ...(policy.greeting_rules?.afternoon || {}),
      },
      night: {
        ...DEFAULT_MESSAGE_POLICY.greeting_rules.night,
        ...(policy.greeting_rules?.night || {}),
      },
    },
    formatting: {
      ...DEFAULT_MESSAGE_POLICY.formatting,
      ...(policy.formatting || {}),
    },
    forbidden_chars: typeof policy.forbidden_chars === 'string'
      ? policy.forbidden_chars
      : DEFAULT_MESSAGE_POLICY.forbidden_chars,
  };
}

function toMinutes(value: string) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return (hour * 60) + minute;
}

function currentMinutesInTimezone(timeZone: string) {
  const timeStr = new Date().toLocaleTimeString('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hour, minute] = timeStr.split(':').map(Number);
  return (hour * 60) + minute;
}

function matchesTimeRange(nowMinutes: number, start: string, end: string) {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

export function getGreetingForNow(policy: MessagePolicy, timeZone = DEFAULT_TIME_ZONE) {
  const nowMinutes = currentMinutesInTimezone(timeZone);
  const rules = Object.values(policy.greeting_rules);
  const matched = rules.find((rule) => matchesTimeRange(nowMinutes, rule.start, rule.end));
  return matched?.text || DEFAULT_MESSAGE_POLICY.greeting_rules.morning.text;
}

function replaceLeadingGreeting(text: string, greeting: string) {
  return text.replace(
    /^(muito\s+)?(bom dia|boa tarde|boa noite|muito bom dia|muito boa tarde|muito boa noite)\b/iu,
    greeting,
  );
}

function sanitizeForbiddenCharacters(text: string, forbiddenChars: string) {
  if (!forbiddenChars) return text;
  const source = String(text || '');
  const preserveBulletHyphen = forbiddenChars.includes('-') && /^\s*-\s+\S+/m.test(source);
  const sanitizedForbiddenChars = preserveBulletHyphen
    ? Array.from(forbiddenChars).filter((char) => char !== '-').join('')
    : forbiddenChars;
  if (!sanitizedForbiddenChars) return source;
  const escaped = Array.from(sanitizedForbiddenChars)
    .map((char) => char.replace(/[-\\\]^]/g, '\\$&'))
    .join('');

  try {
    return source.replace(new RegExp(`[${escaped}]`, 'g'), '');
  } catch {
    return source;
  }
}

function splitSentences(text: string) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeInlineWhitespace(text: string) {
  const raw = String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (/^\s*[-*]\s+\S+/m.test(raw)) {
    return raw
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ');
  }

  return raw
    .replace(/\n\s*\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinSentencesForBubble(sentences: string[], policy: MessagePolicy) {
  if (!sentences.length) return '';
  const separator = policy.formatting.insert_blank_line_in_long_messages ? '\n\n' : ' ';
  return sentences.join(separator).trim();
}

function splitVisualBlocks(text: string) {
  const raw = String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!raw) return [];

  if (raw.includes('\n\n')) {
    return raw
      .split(/\n\s*\n/g)
      .map((block) => normalizeInlineWhitespace(block))
      .filter(Boolean);
  }

  return splitSentences(normalizeInlineWhitespace(raw));
}

function normalizeForMatch(text: string) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildE1OpeningTriptych(text: string) {
  const blocks = splitVisualBlocks(text);
  if (blocks.length < 5) return null;

  const normalizedBlocks = blocks.map((block) => normalizeForMatch(block));
  const pleasureIndex = normalizedBlocks.findIndex((block) => block.includes('prazer enorme falar com voce'));
  const congratsIndex = normalizedBlocks.findIndex((block) =>
    block.includes('parabenizar pela iniciativa')
    || block.includes('parabenizo pela iniciativa')
    || block.includes('parabens pela iniciativa')
  );
  const praiseIndex = normalizedBlocks.findIndex((block) =>
    block.includes('fazemos questao de acompanhar')
    || block.includes('meus parabens')
  );
  const questionIndex = normalizedBlocks.findIndex((block) => block.includes('no que posso te ajudar hoje'));

  if (pleasureIndex !== 1) return null;
  if (congratsIndex < 2 || praiseIndex !== congratsIndex + 1) return null;
  if (questionIndex !== praiseIndex + 1) return null;

  const firstBubble = blocks.slice(0, pleasureIndex + 1).join('\n\n').trim();
  const secondBubble = blocks.slice(congratsIndex, praiseIndex + 1).join('\n\n').trim();
  const thirdBubble = blocks.slice(questionIndex).join('\n\n').trim();

  if (!firstBubble || !secondBubble || !thirdBubble) return null;
  return [firstBubble, secondBubble, thirdBubble].join('\n---\n');
}

export function hasExplicitMessageBoundaries(text: string) {
  return /\n\s*-{3,}\s*\n|\n\s*-{3,}\s*$|^\s*-{3,}\s*\n/gm.test(String(text || ''));
}

export function splitTextForMessagePolicy(text: string, policy: MessagePolicy) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];

  if (hasExplicitMessageBoundaries(rawText)) {
    return rawText
      .split(/\n\s*-{3,}\s*\n|\n\s*-{3,}\s*$|^\s*-{3,}\s*\n/gm)
      .map((part) => part.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
      .filter(Boolean);
  }

  if (/^\s*[-*]\s+\S+/m.test(rawText)) {
    return [rawText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()];
  }

  const blocks = splitVisualBlocks(rawText);
  if (!blocks.length) return [];

  const blockSize = Math.max(1, Number(policy.formatting.sentences_per_block || 2));
  const maxChars = Math.max(80, Number(policy.formatting.long_message_char_threshold || 240));
  const enforceBlockCount = Boolean(policy.formatting.force_separate_messages);
  const bubbles: string[] = [];
  let currentBlocks: string[] = [];

  for (const block of blocks) {
    const candidateBlocks = [...currentBlocks, block];
    const candidate = joinSentencesForBubble(candidateBlocks, policy);

    if (
      currentBlocks.length > 0
      && (
        candidate.length > maxChars
        || (enforceBlockCount && candidateBlocks.length > blockSize)
      )
    ) {
      bubbles.push(joinSentencesForBubble(currentBlocks, policy));
      currentBlocks = [block];
      continue;
    }

    currentBlocks = candidateBlocks;
  }

  if (currentBlocks.length > 0) {
    bubbles.push(joinSentencesForBubble(currentBlocks, policy));
  }

  return bubbles.filter(Boolean);
}

function formatLongMessage(text: string, policy: MessagePolicy, options?: { preserveAtomicBubble?: boolean }) {
  if (options?.preserveAtomicBubble) return text.trim();
  if (!policy.formatting.insert_blank_line_in_long_messages) return text;
  const threshold = Math.max(1, Number(policy.formatting.long_message_char_threshold || 240));
  if (text.length <= threshold) return text.trim();
  return splitTextForMessagePolicy(text, policy).join('\n---\n').trim();
}

export function normalizeStructuredText(params: {
  text: string;
  policy: MessagePolicy;
  preserveExplicitBoundaries?: boolean;
}) {
  const keepBoundaries = params.preserveExplicitBoundaries !== false;
  const explicitBoundaries = keepBoundaries && hasExplicitMessageBoundaries(String(params.text || ''));
  const normalizedParts = splitTextForMessagePolicy(String(params.text || ''), params.policy)
    .map((part) => formatLongMessage(part, params.policy, { preserveAtomicBubble: explicitBoundaries }))
    .map((part) => part.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean);

  return {
    hasExplicitMessageBoundaries: explicitBoundaries || normalizedParts.length > 1,
    text: (explicitBoundaries || normalizedParts.length > 1)
      ? normalizedParts.join('\n---\n').replace(/(\n---\n){2,}/g, '\n---\n').trim()
      : normalizedParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

export function applyMessageGovernance(params: {
  text: string;
  policy: MessagePolicy;
  stageAtual?: string | null;
  timeZone?: string;
}) {
  let sourceText = String(params.text || '');
  const stageAtual = String(params.stageAtual || '').trim().toUpperCase();

  if (stageAtual === 'E1' && !hasExplicitMessageBoundaries(sourceText) && buildE1OpeningTriptych(sourceText)) {
    sourceText = buildE1OpeningTriptych(sourceText) || sourceText;
  }

  const explicitBoundaries = hasExplicitMessageBoundaries(sourceText);

  const parts = explicitBoundaries
    ? sourceText
      .split(/\n\s*-{3,}\s*\n|\n\s*-{3,}\s*$|^\s*-{3,}\s*\n/gm)
      .map((part) => part.trim())
      .filter(Boolean)
    : [sourceText];

  const governedParts = parts.map((part, index) => {
    let next = part;

    next = formatLongMessage(next, params.policy, { preserveAtomicBubble: explicitBoundaries });
    next = sanitizeForbiddenCharacters(next, String(params.policy.forbidden_chars || ''));
    next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return next;
  }).filter(Boolean);

  return normalizeStructuredText({
    text: explicitBoundaries ? governedParts.join('\n---\n') : governedParts.join('\n\n'),
    policy: params.policy,
    preserveExplicitBoundaries: true,
  }).text;
}

export function buildGovernanceTagsPrompt(policy: MessagePolicy) {
  const greetingText = [
    `${policy.greeting_rules.morning.start}-${policy.greeting_rules.morning.end}: ${policy.greeting_rules.morning.text}`,
    `${policy.greeting_rules.afternoon.start}-${policy.greeting_rules.afternoon.end}: ${policy.greeting_rules.afternoon.text}`,
    `${policy.greeting_rules.night.start}-${policy.greeting_rules.night.end}: ${policy.greeting_rules.night.text}`,
  ].join(' | ');

  return `
TAGS DE GOVERNANCA DISPONIVEIS
- regras_gerais: trate estas regras como obrigatorias e com prioridade maxima. Se alguma regra comecar com "Nao" ou contiver "NAO", considere proibicao absoluta.\n${policy.general_rules || '(nenhuma regra geral configurada)'}
- saudacao_por_horario: use a saudacao exata conforme a faixa de horario configurada. Regras atuais: ${greetingText}
- estrutura_mensagem: respeite a estrutura configurada para separar mensagens e criar blocos com linha em branco quando necessario.
- exemplo_estrutura_1: ${policy.formatting.example_message_1 || '(nenhum exemplo configurado)'}
- exemplo_estrutura_2: ${policy.formatting.example_message_2 || '(nenhum exemplo configurado)'}
- caracteres_nao_permitidos: nao use os seguintes caracteres na resposta final: ${policy.forbidden_chars || '(nenhum configurado)'}
`.trim();
}
