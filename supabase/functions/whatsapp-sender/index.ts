// whatsapp-sender: envia mensagens via Evolution API.
// deno-lint-ignore-file
// @ts-nocheck

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { checkTakeover } from '../_shared/takeover.ts';
import { loadTenantRuntimeConfig, resolveEdgeReachableUrl } from '../_shared/runtime-config.ts';
import { applyMessageGovernance, splitTextForMessagePolicy } from '../_shared/message-governance.ts';
import { logLeadRuntimeEvent } from '../ai-processor/intelligence.ts';
import type { MessagePolicy } from '../_shared/message-governance.ts';

const TENANT_ID = Deno.env.get('TENANT_ID') ?? '00000000-0000-0000-0000-000000000001';
const INTER_MESSAGE_DELAY_MS = 1500;

interface EvolutionSendResult {
  ok: boolean;
  status: number;
  messageId?: string;
  error?: string;
}

async function evolutionSendText(
  baseUrl: string,
  instanceName: string,
  apiKey: string,
  telefone: string,
  text: string,
): Promise<EvolutionSendResult> {
  const number = telefone.replace(/^\+/, '').replace(/@.*/, '');
  const url = `${baseUrl}/message/sendText/${instanceName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: JSON.stringify({
      number,
      text,
      options: {
        delay: 1200,
        presence: 'composing',
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errBody };
  }

  const data = await res.json().catch(() => ({}));
  return { ok: true, status: res.status, messageId: data?.key?.id };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitForWhatsappDelivery(text: string, policy: MessagePolicy) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];
  return splitTextForMessagePolicy(rawText, policy)
    .map((part) => String(part || '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean);
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { lead_id, text, skip_governance, subagente_usado, iteracoes, tool_calls } = body ?? {};
    const persistMessage = body?.persist_message !== false;
    const skipTakeover = body?.skip_takeover === true;
    let { telefone } = body ?? {};

    if (!text) {
      return new Response(
        JSON.stringify({ ok: false, error: 'campo "text" obrigatorio' }),
        { status: 400 },
      );
    }

    if (!lead_id && !telefone) {
      return new Response(
        JSON.stringify({ ok: false, error: '"lead_id" ou "telefone" obrigatorio' }),
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    if (lead_id && !skipTakeover) {
      const tk = await checkTakeover(supabase, lead_id);
      if (tk.paused) {
        return new Response(
          JSON.stringify({ ok: false, skipped: 'takeover', reason: tk.reason, until: tk.until }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    let resolvedLeadId = lead_id ?? null;
    let etapaAtual: string | null = null;
    let tenantId = TENANT_ID;

    if (!telefone && lead_id) {
      const { data: lead } = await supabase
        .from('leads')
        .select('telefone, etapa_atual, tenant_id')
        .eq('id', lead_id)
        .maybeSingle();

      if (!lead?.telefone) {
        return new Response(
          JSON.stringify({ ok: false, error: 'telefone nao resolvido para o lead_id' }),
          { status: 400 },
        );
      }

      telefone = lead.telefone;
      etapaAtual = lead.etapa_atual;
      tenantId = lead.tenant_id ?? TENANT_ID;
    } else if (lead_id) {
      const { data: lead } = await supabase
        .from('leads')
        .select('tenant_id, etapa_atual')
        .eq('id', lead_id)
        .maybeSingle();

      tenantId = lead?.tenant_id ?? TENANT_ID;
      etapaAtual = lead?.etapa_atual ?? etapaAtual;
    }

    const runtimeConfig = await loadTenantRuntimeConfig(supabase, tenantId);
    const evolutionBaseUrl = resolveEdgeReachableUrl(runtimeConfig.evolution.baseUrl);
    const evolutionApiKey = runtimeConfig.evolution.apiKey;
    const evolutionInstance = runtimeConfig.evolution.instanceName;

    if (!evolutionBaseUrl || !evolutionApiKey) {
      throw new Error('EVOLUTION_API_URL ou EVOLUTION_API_KEY nao configurados no tenant');
    }

    console.log(
      `[whatsapp-sender] enviando via ${evolutionBaseUrl} / instancia ${evolutionInstance} / destino ${telefone}`,
    );

    const governedText = skip_governance
        ? text
        : applyMessageGovernance({
          text,
          policy: runtimeConfig.messagePolicy,
          stageAtual: etapaAtual,
          timeZone: runtimeConfig.businessHours?.tz || 'America/Porto_Velho',
        });

    const partes = splitForWhatsappDelivery(governedText, runtimeConfig.messagePolicy);

    const resultados: EvolutionSendResult[] = [];
    const sentOutputParts: string[] = [];
    let lastMessageId: string | undefined;

    for (let i = 0; i < partes.length; i += 1) {
      const parte = partes[i];

      if (i > 0) {
        await sleep(INTER_MESSAGE_DELAY_MS);
      }

      const result = await evolutionSendText(
        evolutionBaseUrl,
        evolutionInstance,
        evolutionApiKey,
        telefone,
        parte,
      );

      resultados.push(result);
      if (result.messageId) {
        lastMessageId = result.messageId;
      }
      if (result.ok) {
        sentOutputParts.push(parte);
      }

      if (result.ok && resolvedLeadId && persistMessage) {
        await supabase.from('mensagens').insert({
          tenant_id: tenantId,
          lead_id: resolvedLeadId,
          role: 'assistant',
          conteudo: parte,
          etapa_no_momento: etapaAtual,
          subagente_usado: subagente_usado ?? null,
          iteracoes: iteracoes ?? null,
          tool_calls: tool_calls ?? null,
          whatsapp_message_id: result.messageId ?? null,
          created_at: new Date().toISOString(),
        });
      }

      if (!result.ok) {
        console.error(
          `[whatsapp-sender] falha no envio status=${result.status} error=${result.error ?? ''}`,
        );
        break;
      }
    }

    const firstError = resultados.find((result) => !result.ok)?.error ?? null;
    if (resolvedLeadId) {
      await logLeadRuntimeEvent({
        supabase,
        tenantId,
        leadId: resolvedLeadId,
        eventType: 'test_whatsapp_sender_result',
        payload: {
          etapa_atual: etapaAtual,
          subagente_usado: subagente_usado ?? null,
          iteracoes: iteracoes ?? null,
          mensagens_enviadas: resultados.filter((result) => result.ok).length,
          total_partes: partes.length,
          first_error: firstError,
          validated_output: String(text || ''),
          governed_output_parts: partes,
          sender_payload_parts: partes,
          sent_output_parts: sentOutputParts,
          final_output_source: body?.final_output_source || null,
          text_preview: String(governedText || '').slice(0, 500),
          logged_at: new Date().toISOString(),
        },
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({
        ok: resultados.length > 0 && resultados.every((result) => result.ok),
        mensagens_enviadas: resultados.filter((result) => result.ok).length,
        total_partes: partes.length,
        messageId: lastMessageId,
        first_error: firstError,
        governed_text: governedText,
        governed_output_parts: partes,
        sender_payload_parts: partes,
        sent_output_parts: sentOutputParts,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: String((error as Error).message) }),
      { status: 500 },
    );
  }
});
