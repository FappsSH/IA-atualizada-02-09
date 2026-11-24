import { describe, expect, it } from 'vitest';
import { getInboundSkipReason } from '../../../supabase/functions/_shared/inbound-filter.ts';

describe('getInboundSkipReason', () => {
  it('aceita conversa individual', () => {
    expect(getInboundSkipReason({ remoteJid: '5569999999999@s.whatsapp.net', fromMe: false })).toBeNull();
    expect(getInboundSkipReason({ remoteJid: '227328340836570@lid', remoteJidAlt: '5569999999999@s.whatsapp.net' })).toBeNull();
  });
  it('ignora grupos mesmo com participante identificado', () => {
    expect(getInboundSkipReason({
      remoteJid: '120363135175170900@g.us',
      participant: '227328340836570@lid',
      participantAlt: '556993610191@s.whatsapp.net',
    })).toBe('group_message');
    expect(getInboundSkipReason({ remoteJid: '556993985714-1550100866@g.us' })).toBe('group_message');
  });
  it('ignora status, listas de transmissao e canais', () => {
    expect(getInboundSkipReason({ remoteJid: 'status@broadcast' })).toBe('status_broadcast');
    expect(getInboundSkipReason({ remoteJid: '123@newsletter' })).toBe('broadcast_or_channel');
  });
  it('ignora mensagens enviadas pelo proprio numero', () => {
    expect(getInboundSkipReason({ remoteJid: '5569999999999@s.whatsapp.net', fromMe: true })).toBe('from_me');
  });
});
