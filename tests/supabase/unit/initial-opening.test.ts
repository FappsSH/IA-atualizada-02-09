import { describe, expect, it } from 'vitest';
import {
  buildInitialE1WelcomeMessages,
  getTrustedOpeningFirstName,
  resolveInitialE1WelcomeMessageCount,
  shouldRunInitialE1Welcome,
} from '../../../supabase/functions/ai-processor/initial-opening.ts';

const messagePolicy = {
  greeting_rules: {
    morning: { start: '00:00', end: '23:59', text: 'Muito bom dia' },
  },
};

describe('initial E1 welcome contract', () => {
  it('monta exatamente 3 bolhas sem nome quando nome nao e confiavel', () => {
    const messages = buildInitialE1WelcomeMessages({
      leadSnapshot: { lead_first_name: 'Psicóloga', lead_name_confidence: 'uncertain' },
      messagePolicy,
      timeZone: 'America/Sao_Paulo',
    });

    expect(messages).toEqual([
      'Opa, Muito bom dia!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.\n\nÉ um prazer enorme falar com você!!',
      'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.\n\nSão pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
      'No que posso te ajudar hoje?',
    ]);
  });

  it('usa nome somente quando lead_name_confidence e trusted', () => {
    expect(getTrustedOpeningFirstName({
      lead_first_name: 'Jessica',
      lead_name_confidence: 'trusted',
    })).toBe('Jessica');

    expect(getTrustedOpeningFirstName({
      lead_first_name: 'Psicóloga',
      lead_name_confidence: 'trusted',
    })).toBe('');
  });

  it('roda antes do fluxo normal no primeiro contato E1', () => {
    expect(shouldRunInitialE1Welcome({
      stage: 'E1',
      history: [{ role: 'user', content: 'Voces tem Radiologia?' }],
      salesContext: {},
    })).toBe(true);
  });

  it('usa 2 bolhas quando primeiro inbound ja tem intencao comercial', () => {
    expect(resolveInitialE1WelcomeMessageCount({
      salesContext: {},
      firstInboundHasCommercialIntent: true,
    })).toBe(2);
  });

  it('usa 3 bolhas quando primeiro inbound nao tem intencao comercial', () => {
    expect(resolveInitialE1WelcomeMessageCount({
      salesContext: {},
      firstInboundHasCommercialIntent: false,
    })).toBe(3);
  });

  it('nao roda depois de concluida', () => {
    expect(shouldRunInitialE1Welcome({
      stage: 'E1',
      history: [{ role: 'user', content: 'oi' }],
      salesContext: { initial_welcome_status: 'completed' },
    })).toBe(false);
  });
});
