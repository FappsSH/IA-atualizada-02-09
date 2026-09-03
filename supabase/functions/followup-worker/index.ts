// followup-worker — Executa follow-ups programados e personalizados.
// Cron: a cada 15 minutos.
// Para cada lead elegível:
//   1. Carrega contexto (lead, histórico, follow-ups anteriores)
//   2. Gera mensagem contextual via OpenAI (nunca repete)
//   3. Envia via whatsapp-sender
//   4. Agenda próxima tentativa ou encerra o ciclo
// deno-lint-ignore-file
// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chatCompletions } from '../_shared/openai-client.ts';
import { sendMessage } from '../_shared/pgmq.ts';
import { loadTenantRuntimeConfig } from '../_shared/runtime-config.ts';
import { buildGovernanceTagsPrompt } from '../_shared/message-governance.ts';

const TENANT_ID = Deno.env.get('TENANT_ID') ?? '00000000-0000-0000-0000-000000000001';

function resolveEditorialPrompt(config: Record<string, unknown> | null | undefined) {
    const override = typeof config?.prompt_override === 'string' ? config.prompt_override.trim() : '';
    const defaultPrompt = typeof config?.default_prompt === 'string' ? config.default_prompt.trim() : '';
    return override || defaultPrompt || '';
}

function renderDynamicPrompt(template: string, nome: string | null) {
    const leadName = nome ? `"${nome}"` : 'não coletado';
    return template
        .replace(/\{TIPO_CONTATO\}/g, 'O lead já conversou antes e parou de responder')
        .replace(/\{NOME_DO_LEAD\}/g, leadName)
        .replace(/\{PERIODO\}/g, 'retomada')
        .replace(/\$\{nome\}/g, leadName)
        .trim();
}

function isWithinBusinessHours(businessHours: any): boolean {
    if (!businessHours?.start || !businessHours?.end) return true;
    const now = new Date();
    const tz = businessHours.tz || 'America/Porto_Velho';
    const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const [h, m] = timeStr.split(':').map(Number);
    const currentMinutes = h * 60 + m;
    const [startH, startM] = businessHours.start.split(':').map(Number);
    const [endH, endM] = businessHours.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

serve(async (_req) => {
    const env = Deno.env.toObject();
    const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
    const runtimeConfig = await loadTenantRuntimeConfig(supabase, TENANT_ID, env);

    // Verifica horário comercial antes de processar
    const businessHours = runtimeConfig.businessHours;
    if (!isWithinBusinessHours(businessHours)) {
        console.log('[followup-worker] fora do horário comercial — pulando execução');
        return new Response(JSON.stringify({ processed: 0, skipped: true, motivo: 'fora_do_horario_comercial' }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Busca follow-ups pendentes com schedule_at vencido
    const { data: schedules, error } = await supabase
        .from('followup_schedule')
        .select('*')
        .eq('status', 'pending')
        .eq('tenant_id', TENANT_ID)
        .lte('schedule_at', new Date().toISOString())
        .order('schedule_at', { ascending: true })
        .limit(10);

    if (error) {
        console.error('[followup-worker] erro ao buscar schedules:', JSON.stringify(error));
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    if (!schedules?.length) {
        console.log('[followup-worker] nenhum follow-up pendente');
        return new Response(JSON.stringify({ processed: 0 }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    console.log(`[followup-worker] ${schedules.length} follow-up(s) para processar`);
    let processed = 0;
    let errors = 0;

    for (const schedule of schedules) {
        try {
            // Verifica se o lead ainda está ativo
            const { data: lead } = await supabase
                .from('leads')
                .select('id, nome, telefone, etapa_atual, curso_interesse, dor_principal, bloqueado')
                .eq('id', schedule.lead_id)
                .maybeSingle();

            if (!lead || lead.bloqueado || !['E1','E2','E3','E4','E5','E6'].includes(lead.etapa_atual)) {
                // Cancela se lead não for mais elegível
                await supabase
                    .from('followup_schedule')
                    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                    .eq('id', schedule.id);
                await logFollowup(supabase, schedule, lead, 'cancelled');
                console.log(`[followup-worker] lead ${schedule.lead_id} não elegível — cancelado`);
                continue;
            }

            // Carrega histórico recente
            const { data: recentMsgs } = await supabase
                .from('mensagens')
                .select('role, conteudo, created_at')
                .eq('lead_id', schedule.lead_id)
                .order('created_at', { ascending: false })
                .limit(20);

            const historyText = (recentMsgs ?? [])
                .reverse()
                .map((m) => `${m.role === 'user' ? 'Lead' : 'Consultor'}: ${m.conteudo}`)
                .join('\n');

            const sentMessages = (schedule.sent_messages ?? []) as Array<{ text: string; attempt: number }>;
            const sentTexts = sentMessages.map((m) => m.text);

            // Carrega personalidade do banco
            let personality = '';
            try {
                const { data: p } = await supabase
                    .from('agent_definitions')
                    .select('config')
                    .eq('subagent_key', 'PERSONALITY')
                    .eq('tenant_id', TENANT_ID)
                    .maybeSingle();
                const personalityPrompt = resolveEditorialPrompt(p?.config);
                if (personalityPrompt) {
                    personality = renderDynamicPrompt(personalityPrompt, lead.nome ?? null);
                }
            } catch (_) {}

            // Log de cada schedule processado (observabilidade)
async function logFollowup(supabase: any, schedule: any, lead: any, status: string, errorMsg?: string) {
    try {
        await supabase.from('followup_log').insert({
            tenant_id: TENANT_ID,
            lead_id: schedule.lead_id,
            schedule_id: schedule.id,
            attempt: schedule.attempt,
            status,
            error_message: errorMsg ?? null,
            lead_etapa: lead?.etapa_atual ?? null,
        });
    } catch (_) {}
}

const nome = lead.nome ?? 'Lead';
            const etapaNome = schedule.last_context?.etapa_atual ?? lead.etapa_atual;
            const curso = lead.curso_interesse ?? 'não informado';
            const dor = lead.dor_principal ?? 'não identificada';

            // Monta prompt para geração do follow-up
            const systemPrompt = `
Você é o agente comercial da Universidade Cruzeiro do Sul e atua como especialista de carreiras.
Você está retomando contato com um lead que parou de responder.
${personality || 'Seja humano, objetivo e alinhado ao processo comercial. Use mensagens curtas e com boa quebra de linha.'}
${buildGovernanceTagsPrompt(runtimeConfig.messagePolicy)}

CONTEXTO DO LEAD:
- Nome: ${nome}
- Etapa atual: ${etapaNome}
- Curso de interesse: ${curso}
- Dor principal: ${dor}
- Tentativa de follow-up #${schedule.attempt} de ${schedule.max_attempts}

HISTÓRICO DA CONVERSA:
${historyText || '(histórico vazio)'}

⚠️ VOCÊ JÁ ENVIOU ESTAS MENSAGENS DE FOLLOW-UP PARA ESTE LEAD:
${sentTexts.length > 0 ? sentTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n') : '(nenhuma ainda — esta é a primeira)'}

INSTRUÇÕES:
1. Gere UMA mensagem curta (máximo 2 parágrafos) em tom de WhatsApp.
2. NÃO repita nenhuma das mensagens anteriores listadas acima.
3. Seja contextual — retome de onde parou, mencione o assunto anterior.
4. Não use emojis. Não use jargões de vendedor.
5. A abordagem muda conforme a tentativa:
   - Tentativa 1 (30min): leve, como se estivesse curioso — "só passando pra ver se conseguiu ver a mensagem"
   - Tentativa 2 (1h): reforça valor — "lembrei de um ponto importante que não mencionei"
   - Tentativa 3 (3h): novo ângulo — aborda benefício diferente
   - Tentativa 4 (24h): mais direto — "a bolsa ainda está disponível, mas o prazo está acabando"
   - Tentativa 5 (48h): último esforço — "não quero ser chato, mas queria muito te ajudar nessa"
   - Tentativa 6 (72h): última tentativa — "se ainda tiver interesse, é só responder"
6. Gere APENAS o texto da mensagem, sem aspas, sem labels.
`.trim();

            const apiKey = runtimeConfig.openaiApiKey;
            const model = runtimeConfig.model.subagent ?? 'gpt-4.1';
            const temperature = Number(runtimeConfig.temperature ?? 0.8);

            const res = await chatCompletions(apiKey, {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: 'Gere a mensagem de follow-up personalizada para este lead.' },
                ],
                temperature,
                max_tokens: 300,
            });

            const followupText = res.choices?.[0]?.message?.content?.trim();
            if (!followupText) {
                await logFollowup(supabase, schedule, lead, 'error', 'modelo não gerou texto');
                console.warn(`[followup-worker] modelo não gerou texto para lead ${schedule.lead_id}`);
                errors++;
                continue;
            }

            // Envia via whatsapp-sender
            const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
            const sendRes = await fetch(senderUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    lead_id: lead.id,
                    telefone: lead.telefone,
                    text: followupText,
                }),
            });

            if (!sendRes.ok) {
                const errBody = await sendRes.text().catch(() => '');
                await logFollowup(supabase, schedule, lead, 'error', `whatsapp-sender ${sendRes.status}: ${errBody}`);
                console.error(`[followup-worker] whatsapp-sender erro ${sendRes.status}: ${errBody}`);
                errors++;
                continue;
            }

            // Registra mensagem enviada no histórico
            await supabase.from('mensagens').insert({
                tenant_id: TENANT_ID,
                lead_id: lead.id,
                role: 'assistant',
                conteudo: `[Follow-up #${schedule.attempt}] ${followupText}`,
                etapa_no_momento: lead.etapa_atual,
                created_at: new Date().toISOString(),
            });

            // Atualiza schedule atual
            const updatedSent = [
                ...sentMessages,
                { text: followupText, attempt: schedule.attempt, sent_at: new Date().toISOString() },
            ];

            if (schedule.attempt < schedule.max_attempts) {
                const nextAttempt = schedule.attempt + 1;
                const intervalMs = await getIntervalForAttempt(nextAttempt, supabase);
                const nextScheduleAt = new Date(Date.now() + intervalMs).toISOString();

                // Marca atual como sent
                await supabase
                    .from('followup_schedule')
                    .update({
                        status: 'sent',
                        sent_at: new Date().toISOString(),
                        sent_messages: updatedSent,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', schedule.id);

                // Cria próxima tentativa
                await supabase
                    .from('followup_schedule')
                    .upsert({
                        lead_id: schedule.lead_id,
                        tenant_id: TENANT_ID,
                        attempt: nextAttempt,
                        max_attempts: schedule.max_attempts,
                        schedule_at: nextScheduleAt,
                        trigger_reason: 'lead_parou',
                        last_context: schedule.last_context,
                        sent_messages: updatedSent,
                        status: 'pending',
                    }, { onConflict: 'lead_id,attempt', ignoreDuplicates: false });

                await logFollowup(supabase, schedule, lead, 'processed');
                console.log(`[followup-worker] lead ${lead.id} — follow-up #${schedule.attempt} enviado, #${nextAttempt} agendado p/ ${nextScheduleAt}`);
            } else {
                // Última tentativa — marca lead como inativo
                await supabase
                    .from('followup_schedule')
                    .update({
                        status: 'sent',
                        sent_at: new Date().toISOString(),
                        sent_messages: updatedSent,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', schedule.id);

                await supabase
                    .from('leads')
                    .update({ etapa_atual: 'inativo', updated_at: new Date().toISOString() })
                    .eq('id', lead.id);

                await logFollowup(supabase, schedule, lead, 'processed');
                console.log(`[followup-worker] lead ${lead.id} — follow-up #${schedule.attempt} enviado (último), lead → inativo`);
            }

            processed++;
        } catch (e) {
            console.error(`[followup-worker] erro processando schedule ${schedule.id}:`, String(e));
            await logFollowup(supabase, schedule, null, 'error', String(e)).catch(() => {});
            errors++;
        }
    }

    return new Response(
        JSON.stringify({ processed, errors, total: schedules.length }),
        { headers: { 'Content-Type': 'application/json' } },
    );
});

async function getIntervalForAttempt(attempt: number, supabase: any): Promise<number> {
    // Tenta ler da tabela de configuração (fallback para valores hardcoded)
    try {
        const { data } = await supabase
            .from('followup_config')
            .select('interval_minutes')
            .eq('tenant_id', TENANT_ID)
            .eq('attempt', attempt)
            .eq('enabled', true)
            .maybeSingle();
        if (data?.interval_minutes) {
            return data.interval_minutes * 60 * 1000;
        }
    } catch (_) {}
    // Fallback: valores originais
    const intervals: Record<number, number> = {
        1: 30 * 60 * 1000,
        2: 60 * 60 * 1000,
        3: 3 * 60 * 60 * 1000,
        4: 24 * 60 * 60 * 1000,
        5: 48 * 60 * 60 * 1000,
        6: 72 * 60 * 60 * 1000,
    };
    return intervals[attempt] ?? 24 * 60 * 60 * 1000;
}
