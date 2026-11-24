// Portão de entrada: a AgentHub só atende quem é lead de verdade.
// Contatos que já conversavam com o número antes da AgentHub (equipe, alunos,
// amigos) e números marcados pelo administrador ficam em silêncio.
// deno-lint-ignore-file
// @ts-nocheck

export const PRIOR_RELATIONSHIP_WINDOW_SECONDS = 10 * 60;

/** Forma canônica: só dígitos, celular brasileiro sempre com o nono dígito. */
export function canonicalLeadPhone(value: string | null | undefined): string {
  let digits = String(value ?? '').replace(/@.*$/, '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (/^55\d{2}[6-9]\d{7}$/.test(digits)) {
    digits = `${digits.slice(0, 4)}9${digits.slice(4)}`;
  }
  return digits;
}

/** Comandos do administrador: "ignorar 5569..." e "atender 5569...". */
export function parseAdminLeadCommand(text: string | null | undefined): { action: 'ignore' | 'allow'; phone: string } | null {
  const normalized = String(text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const match = normalized.match(/^(ignorar|nao atender|atender)\s*:?\s*(\+?[\d\s().-]{10,20})\s*$/);
  if (!match) return null;
  const phone = canonicalLeadPhone(match[2]);
  if (phone.length < 12) return null;
  return { action: match[1] === 'atender' ? 'allow' : 'ignore', phone };
}

export async function isPhoneIgnored(supabase: any, tenantId: string, phone: string): Promise<boolean> {
  const canonical = canonicalLeadPhone(phone);
  if (!canonical) return false;
  const { data, error } = await supabase
    .from('lead_ignore_list')
    .select('telefone')
    .eq('tenant_id', tenantId)
    .eq('telefone', canonical)
    .maybeSingle();
  if (error) {
    console.error('[lead-gate] falha ao consultar lead_ignore_list', error.message);
    return false;
  }
  return !!data;
}

export async function setPhoneIgnored(params: {
  supabase: any;
  tenantId: string;
  phone: string;
  ignored: boolean;
  source: string;
  note?: string | null;
}) {
  const canonical = canonicalLeadPhone(params.phone);
  if (!canonical) return { ok: false, phone: canonical };
  if (params.ignored) {
    const { error } = await params.supabase
      .from('lead_ignore_list')
      .upsert({
        tenant_id: params.tenantId,
        telefone: canonical,
        source: params.source,
        note: params.note ?? null,
      }, { onConflict: 'tenant_id,telefone' });
    if (error) throw new Error(`lead_ignore_list upsert: ${error.message}`);
  } else {
    const { error } = await params.supabase
      .from('lead_ignore_list')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('telefone', canonical);
    if (error) throw new Error(`lead_ignore_list delete: ${error.message}`);
  }
  return { ok: true, phone: canonical };
}

function toEpochSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value !== null && 'low' in (value as any)) {
    return Number((value as any).low) || null;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Decide, a partir dos registros da Evolution, se o contato já tinha
 * relação com o número antes desta mensagem. Função pura para teste.
 */
export function evaluatePriorRelationship(params: {
  currentMessageId?: string | null;
  currentTimestampSec: number;
  messages?: Array<Record<string, any>>;
  contacts?: Array<Record<string, any>>;
  windowSeconds?: number;
}): { prior: boolean; reason: string | null } {
  const windowSeconds = params.windowSeconds ?? PRIOR_RELATIONSHIP_WINDOW_SECONDS;
  const threshold = params.currentTimestampSec - windowSeconds;

  for (const message of params.messages || []) {
    const id = String(message?.key?.id ?? message?.keyId ?? '');
    if (params.currentMessageId && id === params.currentMessageId) continue;
    if (message?.key?.fromMe === true) return { prior: true, reason: 'owner_already_messaged_contact' };
    const ts = toEpochSeconds(message?.messageTimestamp);
    if (ts !== null && ts < threshold) return { prior: true, reason: 'older_conversation_found' };
  }

  for (const contact of params.contacts || []) {
    if (contact?.isSaved === true) return { prior: true, reason: 'saved_contact' };
    const createdAt = toEpochSeconds(contact?.createdAt);
    if (createdAt !== null && createdAt < threshold) return { prior: true, reason: 'contact_known_before' };
  }

  return { prior: false, reason: null };
}

function extractRecords(payload: any): Array<Record<string, any>> {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.messages?.records)) return payload.messages.records;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

async function evolutionPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json().catch(() => null);
}

/** Consulta a Evolution. Em caso de erro, não bloqueia (fail-open) e informa o motivo. */
export async function checkPriorRelationship(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  remoteJids: string[];
  currentMessageId?: string | null;
  currentTimestampSec: number;
}): Promise<{ prior: boolean; reason: string | null; error?: string }> {
  if (!params.baseUrl || !params.apiKey || !params.instanceName) {
    return { prior: false, reason: null, error: 'evolution_not_configured' };
  }
  const jids = [...new Set(params.remoteJids.filter(Boolean))];
  const instance = encodeURIComponent(params.instanceName);
  const messages: Array<Record<string, any>> = [];
  const contacts: Array<Record<string, any>> = [];
  const errors: string[] = [];

  for (const jid of jids) {
    try {
      const found = await evolutionPost(params.baseUrl, params.apiKey, `/chat/findMessages/${instance}`, {
        where: { key: { remoteJid: jid } },
        page: 1,
        offset: 25,
      });
      messages.push(...extractRecords(found));
    } catch (error) {
      errors.push(String(error));
    }
    try {
      const found = await evolutionPost(params.baseUrl, params.apiKey, `/chat/findContacts/${instance}`, {
        where: { remoteJid: jid },
      });
      contacts.push(...extractRecords(found));
    } catch (error) {
      errors.push(String(error));
    }
  }

  const result = evaluatePriorRelationship({
    currentMessageId: params.currentMessageId,
    currentTimestampSec: params.currentTimestampSec,
    messages,
    contacts,
  });
  return errors.length && !result.prior ? { ...result, error: errors.join(' | ') } : result;
}
