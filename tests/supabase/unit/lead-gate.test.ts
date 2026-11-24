import { describe, expect, it } from 'vitest';
import {
  canonicalLeadPhone,
  evaluatePriorRelationship,
  parseAdminLeadCommand,
} from '../../../supabase/functions/_shared/lead-gate.ts';

describe('canonicalLeadPhone', () => {
  it('normaliza celular brasileiro com e sem nono digito', () => {
    expect(canonicalLeadPhone('+55 69 99372-0268')).toBe('5569993720268');
    expect(canonicalLeadPhone('556993720268')).toBe('5569993720268');
    expect(canonicalLeadPhone('5569993720268')).toBe('5569993720268');
    expect(canonicalLeadPhone('5569993720268@s.whatsapp.net')).toBe('5569993720268');
    expect(canonicalLeadPhone('69993720268')).toBe('5569993720268');
  });
  it('nao adiciona nono digito em telefone fixo', () => {
    expect(canonicalLeadPhone('556932221234')).toBe('556932221234');
  });
});

describe('parseAdminLeadCommand', () => {
  it('entende ignorar e atender', () => {
    expect(parseAdminLeadCommand('ignorar 5569993720268')).toEqual({ action: 'ignore', phone: '5569993720268' });
    expect(parseAdminLeadCommand('Atender +55 (69) 99372-0268')).toEqual({ action: 'allow', phone: '5569993720268' });
    expect(parseAdminLeadCommand('não atender 69993720268')).toEqual({ action: 'ignore', phone: '5569993720268' });
  });
  it('nao confunde confirmacoes de checkpoint com comando', () => {
    expect(parseAdminLeadCommand('Já enviei')).toBeNull();
    expect(parseAdminLeadCommand('Matricula concluida')).toBeNull();
    expect(parseAdminLeadCommand('ignorar')).toBeNull();
  });
});

describe('evaluatePriorRelationship', () => {
  const now = 1_795_500_000;
  it('lead novo: so a mensagem atual', () => {
    expect(evaluatePriorRelationship({
      currentMessageId: 'ABC',
      currentTimestampSec: now,
      messages: [{ key: { id: 'ABC', fromMe: false }, messageTimestamp: now }],
      contacts: [{ remoteJid: 'x@s.whatsapp.net', createdAt: new Date(now * 1000).toISOString() }],
    })).toEqual({ prior: false, reason: null });
  });
  it('contato com conversa antiga', () => {
    expect(evaluatePriorRelationship({
      currentMessageId: 'ABC',
      currentTimestampSec: now,
      messages: [{ key: { id: 'OLD', fromMe: false }, messageTimestamp: now - 86400 }],
    }).prior).toBe(true);
  });
  it('contato para quem o dono ja mandou mensagem', () => {
    expect(evaluatePriorRelationship({
      currentTimestampSec: now,
      messages: [{ key: { id: 'X', fromMe: true }, messageTimestamp: now - 5 }],
    })).toEqual({ prior: true, reason: 'owner_already_messaged_contact' });
  });
  it('contato salvo antes (agenda sincronizada)', () => {
    expect(evaluatePriorRelationship({
      currentTimestampSec: now,
      contacts: [{ createdAt: new Date((now - 3 * 86400) * 1000).toISOString() }],
    })).toEqual({ prior: true, reason: 'contact_known_before' });
  });
  it('contato salvo na agenda (isSaved da Evolution)', () => {
    expect(evaluatePriorRelationship({
      currentTimestampSec: now,
      contacts: [{ isSaved: true, createdAt: new Date(now * 1000).toISOString() }],
    })).toEqual({ prior: true, reason: 'saved_contact' });
  });
  it('rajada de mensagens do mesmo lead novo nao conta como conversa antiga', () => {
    expect(evaluatePriorRelationship({
      currentMessageId: 'M3',
      currentTimestampSec: now,
      messages: [
        { key: { id: 'M1', fromMe: false }, messageTimestamp: now - 20 },
        { key: { id: 'M2', fromMe: false }, messageTimestamp: now - 10 },
      ],
    }).prior).toBe(false);
  });
});
