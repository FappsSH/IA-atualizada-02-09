import type { MessagePolicy } from '@/lib/types';

const DEFAULT_GREETING_RULES = {
  morning: { start: '06:00', end: '11:59', text: 'Muito bom dia' },
  afternoon: { start: '12:00', end: '17:59', text: 'Muito boa tarde' },
  night: { start: '18:00', end: '05:59', text: 'Muito boa noite' },
};

const DEFAULT_FORMATTING = {
  force_separate_messages: false,
  insert_blank_line_in_long_messages: true,
  long_message_char_threshold: 240,
  sentences_per_block: 2,
  example_message_1: '',
  example_message_2: '',
};

export const DEFAULT_MESSAGE_POLICY: MessagePolicy = {
  general_rules: '',
  greeting_rules: DEFAULT_GREETING_RULES,
  formatting: DEFAULT_FORMATTING,
  forbidden_chars: '',
};

export function normalizeMessagePolicy(raw: Partial<MessagePolicy> | null | undefined): MessagePolicy {
  return {
    general_rules: typeof raw?.general_rules === 'string'
      ? raw.general_rules
      : DEFAULT_MESSAGE_POLICY.general_rules,
    greeting_rules: {
      morning: {
        ...DEFAULT_GREETING_RULES.morning,
        ...(raw?.greeting_rules?.morning || {}),
      },
      afternoon: {
        ...DEFAULT_GREETING_RULES.afternoon,
        ...(raw?.greeting_rules?.afternoon || {}),
      },
      night: {
        ...DEFAULT_GREETING_RULES.night,
        ...(raw?.greeting_rules?.night || {}),
      },
    },
    formatting: {
      ...DEFAULT_FORMATTING,
      ...(raw?.formatting || {}),
    },
    forbidden_chars: typeof raw?.forbidden_chars === 'string'
      ? raw.forbidden_chars
      : DEFAULT_MESSAGE_POLICY.forbidden_chars,
  };
}
