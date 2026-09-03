// Initial E1 opening contract. Keep this outside subagent generation.
// deno-lint-ignore-file
// @ts-nocheck

import { getGreetingForNow, normalizeMessagePolicy } from '../_shared/message-governance.ts';

function assistantHistoryCount(history: Array<{ role?: string; content?: string }>) {
  return (history || []).filter((item) => item?.role === 'assistant' && String(item?.content || '').trim()).length;
}

export function getTrustedOpeningFirstName(leadSnapshot: Record<string, unknown> | null | undefined) {
  const confidence = String(leadSnapshot?.lead_name_confidence || '').trim().toLowerCase();
  const firstName = String(leadSnapshot?.lead_first_name || '').trim();
  if (confidence !== 'trusted') return '';
  if (!firstName) return '';

  const normalized = firstName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (['helton', 'perfeito', 'cliente', 'contato', 'psicologa', 'psicologo'].includes(normalized)) {
    return '';
  }

  return firstName;
}

export function buildInitialE1WelcomeMessages(params: {
  leadSnapshot: Record<string, unknown> | null | undefined;
  messagePolicy?: Record<string, unknown> | null;
  timeZone?: string | null;
}) {
  const policy = normalizeMessagePolicy(params.messagePolicy || {});
  const greeting = getGreetingForNow(policy, params.timeZone || 'America/Porto_Velho');
  const firstName = getTrustedOpeningFirstName(params.leadSnapshot);
  const nameChunk = firstName ? ` ${firstName}` : '';

  return [
    `Opa, ${greeting}${nameChunk}!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.\n\nÉ um prazer enorme falar com você!!`,
    'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.\n\nSão pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
    'No que posso te ajudar hoje?',
  ];
}

export function shouldRunInitialE1Welcome(params: {
  stage: string | null | undefined;
  history: Array<{ role?: string; content?: string }>;
  salesContext: Record<string, unknown> | null | undefined;
}) {
  if (String(params.stage || '') !== 'E1') return false;

  const context = { ...(params.salesContext || {}) };
  const status = String(context.initial_welcome_status || '').trim().toLowerCase();
  const completedAt = String(context.initial_greeting_completed_at || '').trim();
  const sentIndexes = Array.isArray(context.initial_welcome_sent_indexes)
    ? context.initial_welcome_sent_indexes
    : [];

  if (status === 'completed' || completedAt) return false;
  if (sentIndexes.length > 0) return true;
  return assistantHistoryCount(params.history || []) === 0;
}

export function resolveInitialE1WelcomeMessageCount(params: {
  salesContext: Record<string, unknown> | null | undefined;
  firstInboundHasCommercialIntent: boolean;
}) {
  const context = { ...(params.salesContext || {}) };
  const persisted = Number(context.initial_welcome_expected_count || 0);
  if (Number.isInteger(persisted) && persisted >= 2 && persisted <= 3) return persisted;
  return params.firstInboundHasCommercialIntent ? 2 : 3;
}
