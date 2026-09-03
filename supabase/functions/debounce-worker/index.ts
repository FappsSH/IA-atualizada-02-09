// debounce-worker - Consolida mensagens inbound do mesmo lead em janela de 3s.
// Faz duas leituras da fila para capturar mensagens que chegam durante a janela.
// deno-lint-ignore-file
// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { readMessage, deleteMessage, sendMessage } from '../_shared/pgmq.ts';
import { logLeadRuntimeEvent } from '../ai-processor/intelligence.ts';
import { claimWorkerLock, releaseWorkerLock } from '../_shared/processing-claims.ts';

const Q_INBOUND = 'messages_vendas';
const Q_AI = 'ai_processing_vendas';

const DEBOUNCE_WINDOW_MS = 3_000;
const REREAD_DELAY_MS = 1_500;
const MAX_BATCH = 20;

interface InboundMessage {
  text: string;
  received_at: string;
  delay_ms: number;
}

interface InboundMsg {
  lead_id: string;
  tenant_id: string;
  telefone: string;
  etapa_atual: string;
  text: string;
  inbound_message_id?: string | null;
  nome_lead?: string | null;
  recent_user_messages: string[];
  history: Array<{ role: string; conteudo: string }>;
  received_at: string;
  trigger: string;
  instance?: string;
}

interface BufferSlot {
  msgIds: number[];
  items: InboundMsg[];
}

async function buildFreshConversationSnapshot(supabase: any, leadId: string) {
  const [{ data: lead }, { data: recentMsgs }, { data: recentUserOnly }] = await Promise.all([
    supabase
      .from('leads')
      .select('etapa_atual, nome')
      .eq('id', leadId)
      .maybeSingle(),
    supabase
      .from('mensagens')
      .select('role, conteudo, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('mensagens')
      .select('conteudo, created_at')
      .eq('lead_id', leadId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(6),
  ]);

  const history = (recentMsgs ?? [])
    .reverse()
    .map((item: any) => ({ role: item.role, content: item.conteudo ?? '' }))
    .filter((item: any) => item.content !== '');

  const recentUserMessages = (recentUserOnly ?? [])
    .slice()
    .reverse()
    .map((item: any) => item?.conteudo ?? '')
    .filter(Boolean)
    .slice(-3);

  return {
    etapaAtual: lead?.etapa_atual ?? null,
    nomeLead: lead?.nome ?? null,
    history,
    recentUserMessages,
  };
}

async function triggerAiProcessor(times: number) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('[debounce] nao foi possivel disparar ai-processor: SUPABASE_URL/SERVICE_ROLE_KEY ausentes');
    return;
  }

  for (let i = 0; i < times; i++) {
    const res = await fetch(`${supabaseUrl}/functions/v1/ai-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ trigger: 'pipeline_kick' }),
    }).catch((error) => {
      console.error('[debounce] erro ao disparar ai-processor:', String(error));
      return null;
    });

    if (res && !res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[debounce] disparo do ai-processor retornou ${res.status}: ${err}`);
    }
  }
}

async function drainIntoBuffer(supabase: any, buffer: Map<string, BufferSlot>) {
  for (let i = 0; i < MAX_BATCH; i++) {
    const { data, error } = await readMessage(supabase, Q_INBOUND, 60);
    if (error) {
      console.error('[debounce] readMessage error:', JSON.stringify(error));
      break;
    }
    const row = data?.[0];
    if (!row) break;

    const payload = row.message as InboundMsg;
    const key = payload.lead_id;
    if (!buffer.has(key)) buffer.set(key, { msgIds: [], items: [] });
    const slot = buffer.get(key)!;
    slot.msgIds.push(row.msg_id);
    slot.items.push(payload);
  }
}

async function sendConsolidated(supabase: any, buffer: Map<string, BufferSlot>): Promise<number> {
  let consolidated = 0;
  for (const [leadId, slot] of buffer) {
    const text = slot.items.map((m) => m.text.trim()).filter(Boolean).join('\n').trim();
    const last = slot.items[slot.items.length - 1];
    const snapshot = await buildFreshConversationSnapshot(supabase, leadId).catch(() => null);
    const etapaAtual = snapshot?.etapaAtual || last.etapa_atual;
    const nomeLead = snapshot?.nomeLead ?? last.nome_lead ?? null;
    const history = snapshot?.history ?? last.history;
    const recentUserMessages = snapshot?.recentUserMessages ?? last.recent_user_messages;

    const baseTime = new Date(slot.items[0].received_at).getTime();
    const messages: InboundMessage[] = slot.items.map((m) => ({
      text: m.text,
      received_at: m.received_at,
      delay_ms: new Date(m.received_at).getTime() - baseTime,
    }));
    const messageIds = slot.items
      .map((m) => m.inbound_message_id || null)
      .filter(Boolean);
    const firstMessageAt = slot.items[0]?.received_at || null;
    const lastMessageAt = slot.items[slot.items.length - 1]?.received_at || null;
    const debounceGroupId = crypto.randomUUID();
    const processingJobId = crypto.randomUUID();
    const outboundGenerationKey = [
      last.tenant_id,
      leadId,
      firstMessageAt || '',
      lastMessageAt || '',
      messageIds.join(','),
    ].join(':');

    try {
      await supabase
        .from('debounce_groups')
        .insert({
          id: debounceGroupId,
          tenant_id: last.tenant_id,
          lead_id: leadId,
          processing_job_id: processingJobId,
          outbound_generation_key: outboundGenerationKey,
          inbound_message_ids: messageIds,
          first_message_at: firstMessageAt,
          last_message_at: lastMessageAt,
          consolidated_text: text,
          status: 'queued',
        });
    } catch {
      return consolidated;
    }

    console.log(`[debounce] consolidando lead ${leadId}, ${messages.length} msgs em rajada, texto: "${text}"`);

    await logLeadRuntimeEvent({
      supabase,
      tenantId: last.tenant_id,
      leadId,
      eventType: 'test_debounce_assignment',
      payload: {
        worker_run_id: processingJobId,
        assigned_debounce_group_id: debounceGroupId,
        group_claimed_at: new Date().toISOString(),
        group_closed_at: lastMessageAt,
        included_in_processing: true,
        next_group_id_if_late: null,
        messages: slot.items.map((item) => ({
          message_id: item.inbound_message_id || null,
          assigned_debounce_group_id: debounceGroupId,
          included_in_processing: true,
        })),
      },
    }).catch(() => {});

    await logLeadRuntimeEvent({
      supabase,
      tenantId: last.tenant_id,
      leadId,
      eventType: 'test_debounce_consolidated',
      payload: {
        etapa_atual: etapaAtual,
        telefone: last.telefone,
        texto_consolidado: text,
        debounce_group_id: debounceGroupId,
        processing_job_id: processingJobId,
        outbound_generation_key: outboundGenerationKey,
        message_count: messages.length,
        inbound_message_ids: messageIds,
        messages,
        claim_attempted: true,
        claim_success: true,
        group_status: 'queued',
        consolidated_at: new Date().toISOString(),
      },
    }).catch(() => {});

    const { error: sendErr } = await sendMessage(supabase, Q_AI, {
      lead_id: leadId,
      tenant_id: last.tenant_id,
      telefone: last.telefone,
      etapa_atual: etapaAtual,
      text,
      messages,
      nome_lead: nomeLead,
      recent_user_messages: recentUserMessages,
      history,
      inbound_message_ids: messageIds,
      debounce_group_id: debounceGroupId,
      processing_job_id: processingJobId,
      outbound_generation_key: outboundGenerationKey,
      last_received_at: last.received_at,
      message_count: slot.items.length,
      consolidated_at: new Date().toISOString(),
      trigger: 'debounced',
      instance: last.instance,
    });

    if (sendErr) {
      console.error('[debounce] sendMessage error:', JSON.stringify(sendErr));
      continue;
    }

    console.log(`[debounce] enfileirado em ${Q_AI} para lead ${leadId}`);

    await logLeadRuntimeEvent({
      supabase,
      tenantId: last.tenant_id,
      leadId,
      eventType: 'test_ai_queue_enqueued',
      payload: {
        etapa_atual: etapaAtual,
        telefone: last.telefone,
        texto_consolidado: text,
        debounce_group_id: debounceGroupId,
        processing_job_id: processingJobId,
        outbound_generation_key: outboundGenerationKey,
        group_status: 'processing',
        message_count: messages.length,
        queued_at: new Date().toISOString(),
      },
    }).catch(() => {});

    try {
      await supabase
        .from('debounce_groups')
        .update({
          status: 'processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', debounceGroupId);
    } catch {
      return null;
    }

    for (const id of slot.msgIds) {
      await deleteMessage(supabase, Q_INBOUND, id);
    }
    consolidated += 1;
  }
  return consolidated;
}

serve(async (_req) => {
  const supabase = createServiceClient();
  const workerRunId = crypto.randomUUID();
  const lockName = 'debounce-worker:messages_vendas';
  const lockAcquired = await claimWorkerLock({
    supabase,
    lockName,
    holderId: workerRunId,
    ttlSeconds: 20,
  }).catch(() => false);

  if (!lockAcquired) {
    console.log('[debounce] skipped: already_claimed');
    return new Response(JSON.stringify({ processed: 0, skipped: 'already_claimed' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
  const buffer = new Map<string, BufferSlot>();

  const startedAt = Date.now();
  await drainIntoBuffer(supabase, buffer);

  if (buffer.size === 0) {
    console.log('[debounce] nenhuma mensagem encontrada');
    return new Response(JSON.stringify({ processed: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(
    `[debounce] rodada 1: ${buffer.size} lead(s), ${[...buffer.values()].reduce((a, s) => a + s.items.length, 0)} mensagens`,
  );

  await new Promise((r) => setTimeout(r, REREAD_DELAY_MS));

  const beforeCount = [...buffer.values()].reduce((a, s) => a + s.items.length, 0);
  await drainIntoBuffer(supabase, buffer);
  const afterCount = [...buffer.values()].reduce((a, s) => a + s.items.length, 0);
  const novasMsgs = afterCount - beforeCount;

  console.log(`[debounce] rodada 2: +${novasMsgs} mensagens capturadas (total ${afterCount})`);

  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, DEBOUNCE_WINDOW_MS - elapsed);
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }

  const consolidated = await sendConsolidated(supabase, buffer);

  if (consolidated > 0) {
    await triggerAiProcessor(consolidated);
  }

  console.log(`[debounce] concluido - consolidated: ${consolidated}`);

  return new Response(
    JSON.stringify({
      processed: buffer.size,
      consolidated,
      leads: Array.from(buffer.keys()),
      mensagens_totais: afterCount,
      mensagens_segunda_rodada: novasMsgs,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  } finally {
    await releaseWorkerLock({
      supabase,
      lockName,
      holderId: workerRunId,
    });
  }
});
