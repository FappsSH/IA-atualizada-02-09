import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const functionsUrl = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || `${supabaseUrl}/functions/v1`;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const webhookToken = process.env.EVOLUTION_WEBHOOK_TOKEN || 'fapps_cruzeiro';
const tenantId = '00000000-0000-0000-0000-000000000001';
const adminPhone = `+${String(process.env.ADMIN_PHONE || '5569993720268').replace(/\D/g, '')}`;
const mockPort = Number(process.env.E2E_EVOLUTION_MOCK_PORT || 18081);
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type SentMessage = {
    url: string;
    body: any;
    messageId: string;
};

type TurnTrace = {
    user: string;
    stageBefore: string | null;
    stageAfter: string | null;
    pendingCriterion: string | null;
    processAction: string | null;
    finalOutput: string;
    sentParts: string[];
    violations: string[];
};

let originalTenantConfig: Record<string, unknown> | null = null;
let server: ReturnType<typeof createServer> | null = null;
const sentMessages: SentMessage[] = [];

function requireLocalEnv() {
    expect(serviceKey, 'SUPABASE_SERVICE_ROLE_KEY ausente').not.toBe('');
    expect(supabaseUrl, 'Supabase local obrigatorio').toMatch(/127\.0\.0\.1|localhost/);
}

function readBody(req: IncomingMessage) {
    return new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
    });
}

async function startEvolutionMock() {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const messageId = `mock-${Date.now()}-${sentMessages.length + 1}`;
        if (String(req.url || '').includes('/message/sendText/')) {
            sentMessages.push({ url: String(req.url || ''), body, messageId });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: { id: messageId }, ok: true }));
    });
    server.listen(mockPort, '0.0.0.0');
    await once(server, 'listening');
}

async function stopEvolutionMock() {
    if (!server) return;
    server.close();
    await once(server, 'close');
    server = null;
}

async function updateTenantConfig(patch: Record<string, unknown>) {
    const { data, error } = await supabase
        .from('tenants')
        .select('config')
        .eq('id', tenantId)
        .maybeSingle();
    if (error) throw error;
    if (!originalTenantConfig) originalTenantConfig = data?.config || {};
    const next = { ...(data?.config || {}), ...patch };
    const { error: updateError } = await supabase
        .from('tenants')
        .update({ config: next, updated_at: new Date().toISOString() })
        .eq('id', tenantId);
    if (updateError) throw updateError;
}

async function restoreTenantConfig() {
    if (!originalTenantConfig) return;
    await supabase
        .from('tenants')
        .update({ config: originalTenantConfig, updated_at: new Date().toISOString() })
        .eq('id', tenantId);
}

function webhookPayload(params: {
    phone: string;
    text: string;
    pushName?: string;
    messageId?: string;
    fromAdmin?: boolean;
    replyToMessageId?: string | null;
}) {
    const phone = String(params.fromAdmin ? adminPhone : params.phone).replace(/^\+/, '');
    const textMessage = params.replyToMessageId
        ? {
            extendedTextMessage: {
                text: params.text,
                contextInfo: { stanzaId: params.replyToMessageId },
            },
        }
        : { conversation: params.text };

    return {
        event: 'messages.upsert',
        instance: 'e2e-mock',
        data: {
            key: {
                id: params.messageId || `in-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                fromMe: false,
                remoteJid: `${phone}@s.whatsapp.net`,
            },
            pushName: params.pushName ?? 'Psicóloga',
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: textMessage,
            messageType: params.replyToMessageId ? 'extendedTextMessage' : 'conversation',
        },
    };
}

async function postWebhook(payload: any) {
    const res = await fetch(`${functionsUrl}/webhook-receiver`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-evolution-token': webhookToken,
        },
        body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    expect(res.ok, JSON.stringify(body)).toBe(true);
    return body;
}

async function getLeadByPhone(phone: string) {
    const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('telefone', phone)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function getEvents(leadId: string, limit = 120) {
    const { data, error } = await supabase
        .from('lead_events')
        .select('event_type, payload, created_at')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

async function drainQueue(queueName: string) {
    for (let i = 0; i < 200; i += 1) {
        const { data, error } = await supabase.rpc('pgmq_read', { queue_name: queueName, vt: 1, qty: 10 });
        if (error) throw error;
        const rows = data || [];
        if (rows.length === 0) return;
        for (const row of rows) {
            const { error: deleteError } = await supabase.rpc('pgmq_delete', {
                queue_name: queueName,
                msg_id: row.msg_id,
            });
            if (deleteError) throw deleteError;
        }
    }
    throw new Error(`Nao foi possivel limpar fila ${queueName}`);
}

async function getAssistantMessages(leadId: string) {
    const { data, error } = await supabase
        .from('mensagens')
        .select('conteudo, created_at')
        .eq('lead_id', leadId)
        .eq('role', 'assistant')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function waitFor<T>(producer: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 90_000) {
    const start = Date.now();
    let last: T;
    while (Date.now() - start < timeoutMs) {
        last = await producer();
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Timeout aguardando ${label}`);
}

async function sendLeadTurn(phone: string, text: string, options?: { expectCommercialTrace?: boolean }): Promise<TurnTrace> {
    const expectCommercialTrace = options?.expectCommercialTrace !== false;
    const beforeLead = await getLeadByPhone(phone);
    const beforeSentTraceCount = beforeLead?.id
        ? (await getEvents(beforeLead.id, 200)).filter((event: any) => event.event_type === 'test_response_sent_trace').length
        : 0;
    const beforeAssistantCount = beforeLead?.id ? (await getAssistantMessages(beforeLead.id)).length : 0;
    await postWebhook(webhookPayload({ phone, text }));
    const lead = await waitFor(() => getLeadByPhone(phone), (value) => !!value?.id, `lead ${phone}`);
    if (expectCommercialTrace) {
        await waitFor(
            () => getEvents(lead.id, 200),
            (events) => events.filter((event: any) => event.event_type === 'test_response_sent_trace').length > beforeSentTraceCount,
            `response sent trace lead=${lead.id}`,
        );
    } else {
        await waitFor(
            () => getAssistantMessages(lead.id),
            (messages) => messages.length > beforeAssistantCount,
            `assistant welcome lead=${lead.id}`,
        );
    }
    const afterLead = await getLeadByPhone(phone);
    const events = await getEvents(lead.id);
    const sentTrace = events.find((event: any) => event.event_type === 'test_response_sent_trace');
    const readyTrace = events.find((event: any) => event.event_type === 'test_response_ready');
    const senderResults = events.filter((event: any) => event.event_type === 'test_whatsapp_sender_result');
    const classification = events.find((event: any) => event.event_type === 'test_stage_state_classification');
    const sentParts = Array.isArray(sentTrace?.payload?.sent_output_parts)
        ? sentTrace.payload.sent_output_parts.map((part: unknown) => String(part || ''))
        : [];
    return {
        user: text,
        stageBefore: beforeLead?.etapa_atual || null,
        stageAfter: afterLead?.etapa_atual || null,
        pendingCriterion: readyTrace?.payload?.pending_criterion_after || afterLead?.sales_context?.pending_criterion || null,
        processAction: readyTrace?.payload?.process_action || null,
        finalOutput: String(sentTrace?.payload?.final_output || readyTrace?.payload?.final_output || ''),
        sentParts: sentParts.length > 0
            ? sentParts
            : senderResults.flatMap((event: any) => Array.isArray(event.payload?.sent_output_parts) ? event.payload.sent_output_parts : []),
        violations: [
            ...(readyTrace?.payload?.personality_violations || []),
            ...(readyTrace?.payload?.forbidden_topics_detected || []),
            classification?.payload?.classification_reason === 'no_context_match' ? 'no_context_match' : null,
        ].filter(Boolean),
    };
}

async function sendAdminReply(replyToMessageId: string, text: string) {
    await postWebhook(webhookPayload({
        phone: adminPhone,
        text,
        fromAdmin: true,
        replyToMessageId,
        messageId: `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }));
}

function expectNoGlobalViolations(trace: TurnTrace) {
    expect(trace.finalOutput).not.toMatch(/vamos seguir|para seguirmos|vamos avançar|para continuarmos|próxima etapa/i);
    expect(trace.finalOutput).not.toMatch(/CST EM RADIOLOGIA|Tecnólogo/i);
    expect(trace.violations).not.toContain('no_context_match');
}

beforeAll(async () => {
    requireLocalEnv();
    await startEvolutionMock();
    await drainQueue('messages_vendas');
    await drainQueue('ai_processing_vendas');
    await updateTenantConfig({
        evolution_api_url: `http://127.0.0.1:${mockPort}`,
        evolution_api_key: 'e2e-mock-key',
        evolution_instance_name: 'e2e-mock',
    });
});

afterAll(async () => {
    await restoreTenantConfig();
    await stopEvolutionMock();
});

describe('local real E2E flow', () => {
    it('executa fluxo principal E1 ate E7 com webhook, debounce, fila, AI, sender mockado e checkpoints', async () => {
        const phone = `+550001${String(Date.now()).slice(-8)}`;
        const traces: TurnTrace[] = [];

        traces.push(await sendLeadTurn(phone, 'Olá, quero saber sobre Radiologia'));
        expect((await getAssistantMessages((await getLeadByPhone(phone)).id)).length).toBeGreaterThanOrEqual(3);
        expect(traces.at(-1)?.finalOutput).not.toContain('No que posso te ajudar hoje?');
        expect(traces.at(-1)?.finalOutput).toMatch(/Radiologia/i);
        expect(traces.at(-1)?.pendingCriterion).toBe('city');

        traces.push(await sendLeadTurn(phone, 'Sou de Vilhena'));
        expect(traces.at(-1)?.pendingCriterion).toBe('motivation');

        traces.push(await sendLeadTurn(phone, 'Já trabalho na área'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E2', 'E2');

        traces.push(await sendLeadTurn(phone, 'Não tenho viagem nem mudança'));
        expect(traces.at(-1)?.processAction).toBe('ask_vaccine_decider');

        traces.push(await sendLeadTurn(phone, 'Converso com meu marido'));
        expect(traces.at(-1)?.processAction).toBe('ask_vaccine_agreement');

        traces.push(await sendLeadTurn(phone, 'Vai depender do valor'));
        const leadAfterPrice = await getLeadByPhone(phone);
        expect(leadAfterPrice.sales_context?.e2_commercial_agreement_status).toBe('conditional_price_pending_confirmation');

        traces.push(await sendLeadTurn(phone, 'Pode ser'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E3', 'E3');

        traces.push(await sendLeadTurn(phone, 'Gostei, quero ver os valores'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E4', 'E4');

        traces.push(await sendLeadTurn(phone, 'Meu nome completo é Maria Silva Pereira'));
        let lead = await getLeadByPhone(phone);
        await waitFor(() => getLeadByPhone(phone), (value) => value?.bloqueado === true, 'proposal checkpoint');
        let checkpoints = await supabase
            .from('lead_admin_checkpoints')
            .select('*')
            .eq('lead_id', lead.id)
            .eq('checkpoint_admin', 'proposal_send')
            .eq('status_checkpoint', 'pending')
            .limit(1);
        expect(checkpoints.error).toBeNull();
        expect(checkpoints.data?.[0]?.admin_message_id).toBeTruthy();
        await sendAdminReply(checkpoints.data![0].admin_message_id, 'Proposta enviada');
        await waitFor(() => getLeadByPhone(phone), (value) => value?.bloqueado === false && value?.etapa_atual === 'E4', 'resume proposal');

        traces.push(await sendLeadTurn(phone, 'Quero fazer a matrícula'));
        lead = await getLeadByPhone(phone);
        await waitFor(() => getLeadByPhone(phone), (value) => value?.bloqueado === true, 'enrollment checkpoint');
        checkpoints = await supabase
            .from('lead_admin_checkpoints')
            .select('*')
            .eq('lead_id', lead.id)
            .eq('checkpoint_admin', 'enrollment_processing')
            .eq('status_checkpoint', 'pending')
            .limit(1);
        expect(checkpoints.error).toBeNull();
        await sendAdminReply(checkpoints.data![0].admin_message_id, 'Matrícula concluída');
        await waitFor(() => getLeadByPhone(phone), (value) => value?.matriculado === true && value?.etapa_atual === 'E5', 'E5 matriculado');

        traces.push(await sendLeadTurn(phone, 'Hoje'));
        await waitFor(() => getLeadByPhone(phone), (value) => value?.etapa_atual === 'E6', 'E6');

        traces.push(await sendLeadTurn(phone, 'Sim, recomendo'));
        traces.push(await sendLeadTurn(phone, 'Maria'));
        traces.push(await sendLeadTurn(phone, '69999999999'));
        await waitFor(() => getLeadByPhone(phone), (value) => value?.etapa_atual === 'E7', 'E7');

        traces.push(await sendLeadTurn(phone, 'Tudo certo'));

        for (const trace of traces) expectNoGlobalViolations(trace);

        const finalLead = await getLeadByPhone(phone);
        const events = await getEvents(finalLead.id);
        expect(events.some((event: any) => event.event_type === 'unhandled_inbound_terminal_state')).toBe(false);
        expect(events.some((event: any) => event.event_type === 'test_response_sent_trace')).toBe(true);
        expect(events.some((event: any) => event.event_type === 'test_read_receipt_success')).toBe(true);
    }, 300_000);

    it('cobre catalogo, indisponiveis, ambiguo, viagem/mudanca e infra debounce', async () => {
        const catalogPhone = `+550002${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(catalogPhone, 'Oi', { expectCommercialTrace: false });
        await sendLeadTurn(catalogPhone, 'Quero conhecer os cursos');
        await sendLeadTurn(catalogPhone, 'Tecnologia me chama atenção');
        const catalogChoice = await sendLeadTurn(catalogPhone, 'Análise e Desenvolvimento de Sistemas parece interessante');
        expect(catalogChoice.pendingCriterion).toBe('city');
        expect(catalogChoice.finalOutput).not.toMatch(/Ciência da Computação|Banco de Dados/);

        const segmentPhone = `+550003${String(Date.now()).slice(-8)}`;
        const segment = await sendLeadTurn(segmentPhone, 'Quero saber sobre Psicoterapia');
        expect(segment.processAction).toBe('present_segment_options_and_wait_selection');
        expect(segment.finalOutput).toMatch(/Saúde|Saude|Biomedicina|Psicopedagogia|Radiologia/i);
        const segmentLead = await getLeadByPhone(segmentPhone);
        const alternatives = segmentLead.sales_context?.related_area_courses || [];
        expect(alternatives.length).toBeGreaterThan(0);
        const alternativeChoice = await sendLeadTurn(segmentPhone, String(alternatives[0]));
        expect(alternativeChoice.pendingCriterion).toBe('city');

        const unavailablePhone = `+550004${String(Date.now()).slice(-8)}`;
        const unavailable = await sendLeadTurn(unavailablePhone, 'Quero saber sobre Astrofísica Quântica');
        expect(unavailable.processAction).toBe('ask_for_new_direction');
        expect(unavailable.finalOutput).not.toMatch(/Física|Ciências Exatas|cursos relacionados/i);

        const ambiguousPhone = `+550005${String(Date.now()).slice(-8)}`;
        const ambiguous = await sendLeadTurn(ambiguousPhone, 'Quero Ciências Biológicas');
        expect(ambiguous.pendingCriterion).toBe('course_line');
        expect(ambiguous.finalOutput).toMatch(/Bacharelado/i);
        expect(ambiguous.finalOutput).toMatch(/Licenciatura/i);
        const lineChoice = await sendLeadTurn(ambiguousPhone, 'Licenciatura');
        expect(lineChoice.pendingCriterion).toBe('city');

        const eadPhone = `+550006${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(eadPhone, 'Quero Administração Pública');
        await sendLeadTurn(eadPhone, 'Sou de Vilhena');
        await sendLeadTurn(eadPhone, 'É objetivo pessoal');
        await waitFor(() => getLeadByPhone(eadPhone), (lead) => lead?.etapa_atual === 'E2', 'EAD E2');
        const eadTravel = await sendLeadTurn(eadPhone, 'Vou me mudar no próximo mês');
        expect(eadTravel.processAction).toBe('ask_vaccine_decider');
        expect(eadTravel.finalOutput).toMatch(/EAD|dia|horário|horario|datas/i);

        const semiPhone = `+550007${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(semiPhone, 'Quero Radiologia');
        await sendLeadTurn(semiPhone, 'Sou de Vilhena');
        await sendLeadTurn(semiPhone, 'Já trabalho na área');
        await waitFor(() => getLeadByPhone(semiPhone), (lead) => lead?.etapa_atual === 'E2', 'Semipresencial E2');
        const semiTravel = await sendLeadTurn(semiPhone, 'Vou viajar no próximo mês');
        expect(semiTravel.processAction).toBe('ask_vaccine_decider');
        expect(semiTravel.finalOutput).toMatch(/semipresencial|plataforma|aulas ao vivo/i);

        const debouncePhone = `+550008${String(Date.now()).slice(-8)}`;
        await Promise.all([
            postWebhook(webhookPayload({ phone: debouncePhone, text: 'Estou procurando uma graduação' })),
            postWebhook(webhookPayload({ phone: debouncePhone, text: 'Quais opções tem?' })),
        ]);
        const debounceLead = await waitFor(() => getLeadByPhone(debouncePhone), (lead) => !!lead?.id, 'lead debounce');
        await waitFor(
            () => getEvents(debounceLead.id, 200),
            (events) => events.filter((event: any) => event.event_type === 'test_response_sent_trace').length === 1,
            `debounce response sent trace lead=${debounceLead.id}`,
        );
        const events = await getEvents(debounceLead.id);
        const consolidated = events.find((event: any) => event.event_type === 'test_debounce_consolidated');
        expect(consolidated?.payload?.message_count).toBe(2);
        expect(events.filter((event: any) => event.event_type === 'test_response_sent_trace')).toHaveLength(1);
    }, 360_000);
});
