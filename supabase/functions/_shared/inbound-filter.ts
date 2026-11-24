// Decide se uma mensagem recebida pela Evolution pode abrir/continuar conversa de lead.
// Somente conversas individuais (1:1) entram no funil. Grupos, status, listas de
// transmissão e canais nunca viram lead.
// deno-lint-ignore-file
// @ts-nocheck

const NON_LEAD_JID = /(@g\.us|@broadcast|@newsletter)$/i;

export function getInboundSkipReason(key: any): string | null {
  if (!key) return 'missing_key';
  if (key.fromMe) return 'from_me';
  const remoteJid = String(key.remoteJid ?? '').trim();
  if (!remoteJid) return null;
  if (remoteJid === 'status@broadcast') return 'status_broadcast';
  if (NON_LEAD_JID.test(remoteJid)) {
    return remoteJid.toLowerCase().endsWith('@g.us') ? 'group_message' : 'broadcast_or_channel';
  }
  return null;
}
