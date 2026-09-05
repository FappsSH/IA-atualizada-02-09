import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAuthorizedKnowledgeFacts } from '../../../supabase/functions/ai-processor/knowledge.ts';

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
    speakableFacts?: any;
    readyPayload?: any;
    sentPayload?: any;
    senderPayloads?: any[];
};

let originalTenantConfig: Record<string, unknown> | null = null;
let server: ReturnType<typeof createServer> | null = null;
const sentMessages: SentMessage[] = [];
let failNextSendCount = 0;

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
            if (failNextSendCount > 0) {
                failNextSendCount -= 1;
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'forced sender failure' }));
                return;
            }
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

async function invokeFunction(name: string, body: any = {}) {
    const res = await fetch(`${functionsUrl}/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
}

async function invokeAiProcessor(body: any = {}) {
    return invokeFunction('ai-processor', body);
}

async function enqueueAiJob(payload: Record<string, unknown>) {
    const { data, error } = await supabase.rpc('pgmq_send', {
        queue_name: 'ai_processing_vendas',
        msg: payload,
        delay: 0,
    });
    if (error) throw error;
    return data;
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

async function getIndications(leadId: string) {
    const { data, error } = await supabase
        .from('indicacoes')
        .select('*')
        .eq('lead_origem_id', leadId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function createLeadFixture(phone: string, patch: Record<string, unknown>) {
    const row = {
        tenant_id: tenantId,
        telefone: phone,
        etapa_atual: 'E1',
        sales_context: {},
        ...patch,
        updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
        .from('leads')
        .insert(row)
        .select('*')
        .single();
    if (error) throw error;
    return data;
}

async function createProcessedDebounceGroup(leadId: string, phone: string) {
    const groupId = crypto.randomUUID();
    const processingJobId = crypto.randomUUID();
    const generationKey = `${tenantId}:${leadId}:old:${groupId}`;
    const { error } = await supabase.from('debounce_groups').insert({
        id: groupId,
        tenant_id: tenantId,
        lead_id: leadId,
        processing_job_id: processingJobId,
        outbound_generation_key: generationKey,
        inbound_message_ids: [],
        consolidated_text: 'job velho',
        status: 'processed',
        processed_at: new Date().toISOString(),
    });
    if (error) throw error;
    await enqueueAiJob({
        lead_id: leadId,
        tenant_id: tenantId,
        telefone: phone,
        etapa_atual: 'E1',
        text: 'job velho',
        debounce_group_id: groupId,
        processing_job_id: processingJobId,
        outbound_generation_key: generationKey,
        trigger: 'debounced',
    });
    return { groupId, processingJobId, generationKey };
}

async function createQueuedDebounceGroup(leadId: string, phone: string, text: string, etapaAtual = 'E1') {
    const groupId = crypto.randomUUID();
    const processingJobId = crypto.randomUUID();
    const generationKey = `${tenantId}:${leadId}:new:${groupId}`;
    const now = new Date().toISOString();
    const { error } = await supabase.from('debounce_groups').insert({
        id: groupId,
        tenant_id: tenantId,
        lead_id: leadId,
        processing_job_id: processingJobId,
        outbound_generation_key: generationKey,
        inbound_message_ids: [],
        first_message_at: now,
        last_message_at: now,
        consolidated_text: text,
        status: 'processing',
    });
    if (error) throw error;
    await enqueueAiJob({
        lead_id: leadId,
        tenant_id: tenantId,
        telefone: phone,
        etapa_atual: etapaAtual,
        text,
        messages: [{ text, received_at: now, delay_ms: 0 }],
        debounce_group_id: groupId,
        processing_job_id: processingJobId,
        outbound_generation_key: generationKey,
        trigger: 'debounced',
    });
    return { groupId, processingJobId, generationKey };
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

async function sendLeadTurn(phone: string, text: string, options?: { expectCommercialTrace?: boolean; pushName?: string }): Promise<TurnTrace> {
    const expectCommercialTrace = options?.expectCommercialTrace !== false;
    const beforeLead = await getLeadByPhone(phone);
    const turnStartedAtMs = Date.now() - 500;
    await postWebhook(webhookPayload({ phone, text, pushName: options?.pushName }));
    const lead = await waitFor(() => getLeadByPhone(phone), (value) => !!value?.id, `lead ${phone}`);
    if (expectCommercialTrace) {
        await waitFor(
            () => getEvents(lead.id, 200),
            (events) => events.some((event: any) => (
                event.event_type === 'test_response_sent_trace'
                && new Date(event.created_at).getTime() >= turnStartedAtMs
            )),
            `response sent trace lead=${lead.id}`,
        );
    } else {
        await waitFor(
            () => getAssistantMessages(lead.id),
            (messages) => messages.some((message: any) => new Date(message.created_at).getTime() >= turnStartedAtMs),
            `assistant welcome lead=${lead.id}`,
        );
    }
    const afterLead = await getLeadByPhone(phone);
    const events = await getEvents(lead.id);
    const turnEvents = events.filter((event: any) => new Date(event.created_at).getTime() >= turnStartedAtMs);
    const sentTrace = turnEvents.find((event: any) => event.event_type === 'test_response_sent_trace')
        || events.find((event: any) => event.event_type === 'test_response_sent_trace');
    const readyTrace = turnEvents.find((event: any) => event.event_type === 'test_response_ready')
        || events.find((event: any) => event.event_type === 'test_response_ready');
    const senderResults = turnEvents.filter((event: any) => event.event_type === 'test_whatsapp_sender_result');
    const classification = turnEvents.find((event: any) => event.event_type === 'test_stage_state_classification')
        || events.find((event: any) => event.event_type === 'test_stage_state_classification');
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
        speakableFacts: readyTrace?.payload?.speakable_facts || null,
        sentParts: sentParts.length > 0
            ? sentParts
            : senderResults.flatMap((event: any) => Array.isArray(event.payload?.sent_output_parts) ? event.payload.sent_output_parts : []),
        violations: [
            ...(readyTrace?.payload?.personality_violations || []),
            ...(readyTrace?.payload?.forbidden_topics_detected || []),
            classification?.payload?.classification_reason === 'no_context_match' ? 'no_context_match' : null,
        ].filter(Boolean),
        readyPayload: readyTrace?.payload || null,
        sentPayload: sentTrace?.payload || null,
        senderPayloads: senderResults.map((event: any) => event.payload),
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

function normalizeForAssert(value: string) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/---/g, ' ')
        .replace(/[,:;.!?]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function expectSemanticPartsEqual(payload: any) {
    const validated = normalizeForAssert(payload?.validated_output || '');
    const governed = normalizeForAssert((payload?.governed_output_parts || []).join(' '));
    const sender = normalizeForAssert((payload?.sender_payload_parts || []).join(' '));
    const sent = normalizeForAssert((payload?.sent_output_parts || []).join(' '));
    expect(governed).toBe(validated);
    expect(sender).toBe(governed);
    expect(sent).toBe(sender);
}

function expectE3UsesAdminAuthorizedClaims(trace: TurnTrace) {
    const text = trace.finalOutput || '';
    const keys = new Set((trace.speakableFacts?.e3_authorized_facts || trace.speakableFacts?.authorized_facts || [])
        .map((fact: any) => String(fact?.claim_key || ''))
        .filter(Boolean));
    [
        'institution_is_university',
        'institution_diploma_international_recognition',
        'institution_university_advantage_vs_college',
        'institution_60_plus_years',
        'institution_maximum_mec_rating',
        'institution_maximum_mec_since_beginning',
    ].forEach((key) => expect(keys.has(key)).toBe(true));
    expect(trace.speakableFacts?.e3_authorized_facts?.length).toBeGreaterThan(0);
    expect(text).toMatch(/Universidade Cruzeiro do Sul|Universidade/i);
    expect(text).toMatch(/fora do Brasil|exterior/i);
    expect(text).toMatch(/6[0-9] anos/i);
    expect(text).toMatch(/nota m[áa]xima/i);
    expect(text).toMatch(/tutores?/i);
    expect(text).not.toMatch(/n[úu]mero 1/i);
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

beforeEach(async () => {
    await drainQueue('messages_vendas');
    await drainQueue('ai_processing_vendas');
});

afterAll(async () => {
    await restoreTenantConfig();
    await stopEvolutionMock();
});

describe('local real E2E flow', () => {
    it('cobre welcome oficial, nome confiavel, nome nao confiavel e retry parcial', async () => {
        const simplePhone = `+550019${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(simplePhone, 'Oi', { expectCommercialTrace: false, pushName: 'Psicologa' });
        const simpleLead = await getLeadByPhone(simplePhone);
        const simpleMessages = await getAssistantMessages(simpleLead.id);
        expect(simpleMessages).toHaveLength(3);
        expect(simpleMessages.map((message: any) => message.conteudo).join('\n')).not.toMatch(/Psicologa|Psicóloga/i);
        const simpleWelcome = (await getEvents(simpleLead.id)).find((event: any) => event.event_type === 'test_initial_welcome_sequence');
        expect(simpleWelcome?.payload?.sent_now).toEqual([0, 1, 2]);
        expect(simpleWelcome?.payload?.completed).toBe(true);

        const trustedPhone = `+550020${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(trustedPhone, 'Oi', { expectCommercialTrace: false, pushName: 'Maria Eduarda' });
        const trustedLead = await getLeadByPhone(trustedPhone);
        const trustedMessages = await getAssistantMessages(trustedLead.id);
        expect(trustedMessages[0]?.conteudo).toMatch(/Maria/i);

        const retryPhone = `+550021${String(Date.now()).slice(-8)}`;
        const retryLead = await createLeadFixture(retryPhone, {
            etapa_atual: 'E1',
            sales_context: {
                initial_welcome_status: 'in_progress',
                initial_welcome_expected_count: 3,
                initial_welcome_sent_indexes: [0],
            },
        });
        await sendLeadTurn(retryPhone, 'Oi', { expectCommercialTrace: false });
        const retryEvents = await getEvents(retryLead.id);
        const retryWelcome = retryEvents.find((event: any) => event.event_type === 'test_initial_welcome_sequence');
        expect(retryWelcome?.payload?.sent_now).toEqual([1, 2]);
        expect(retryWelcome?.payload?.sent_indexes).toEqual([0, 1, 2]);
        expect(await getAssistantMessages(retryLead.id)).toHaveLength(2);
    }, 240_000);

    it('executa fluxo principal E1 ate E7 com webhook, debounce, fila, AI, sender mockado e checkpoints', async () => {
        const phone = `+550001${String(Date.now()).slice(-8)}`;
        const traces: TurnTrace[] = [];

        traces.push(await sendLeadTurn(phone, 'Olá, quero saber sobre Radiologia'));
        expect((await getAssistantMessages((await getLeadByPhone(phone)).id)).length).toBeGreaterThanOrEqual(3);
        expect(traces.at(-1)?.finalOutput).not.toContain('No que posso te ajudar hoje?');
        expect(traces.at(-1)?.finalOutput).toMatch(/Radiologia/i);
        expect(traces.at(-1)?.pendingCriterion).toBe('city');
        expect(traces.at(-1)?.finalOutput).not.toMatch(/modalidade|dura|semestre|CST|Tecn[oó]logo/i);

        traces.push(await sendLeadTurn(phone, 'Sou de Vilhena'));
        expect(traces.at(-1)?.pendingCriterion).toBe('motivation');
        expect(traces.at(-1)?.finalOutput).not.toMatch(/Vilhena/i);
        expect(traces.at(-1)?.finalOutput).not.toMatch(/obrigad[oa]|agradec/i);

        traces.push(await sendLeadTurn(phone, 'Já trabalho na área'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E2', 'E2');
        expect(traces.at(-1)?.finalOutput).not.toMatch(/cidade/i);

        traces.push(await sendLeadTurn(phone, 'Não tenho viagem nem mudança'));
        expect(traces.at(-1)?.processAction).toBe('ask_vaccine_decider');

        traces.push(await sendLeadTurn(phone, 'Converso com meu marido'));
        expect(traces.at(-1)?.processAction).toBe('ask_vaccine_agreement');
        expect(traces.at(-1)?.finalOutput).toMatch(/marido|ele|d[uú]vida|pergunta/i);
        expect(traces.at(-1)?.finalOutput).not.toMatch(/decide sozinho|conversa com algu[eé]m/i);

        traces.push(await sendLeadTurn(phone, 'Vai depender do valor'));
        const leadAfterPrice = await getLeadByPhone(phone);
        expect(leadAfterPrice.sales_context?.e2_commercial_agreement_status).toBe('conditional_price_pending_confirmation');

        traces.push(await sendLeadTurn(phone, 'Pode ser'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E3', 'E3');
        expectE3UsesAdminAuthorizedClaims(traces.at(-1)!);
        expect(traces.at(-1)?.sentParts).toHaveLength(3);
        expect(traces.at(-1)?.finalOutput).toMatch(/Radiologia/i);
        expect(traces.at(-1)?.finalOutput).toMatch(/semestres?|anos?/i);
        expect(traces.at(-1)?.finalOutput).toMatch(/semipresencial|EAD|presencial/i);
        expect(traces.at(-1)?.finalOutput).toMatch(/metodologia|plataforma|aula|tutor/i);
        expect(traces.at(-1)?.speakableFacts?.e3_authorized_facts?.some((fact: any) => fact.claim_key === 'semipresencial_live_online_classes')).toBe(true);
        ['tutoring_full_journey_support', 'tutoring_deadline_reminders', 'tutoring_awarded', 'tutoring_best_in_brazil']
            .forEach((key) => expect(traces.at(-1)?.speakableFacts?.e3_authorized_facts?.some((fact: any) => fact.claim_key === key)).toBe(true));

        traces.push(await sendLeadTurn(phone, 'Gostei, quero ver os valores'));
        await waitFor(() => getLeadByPhone(phone), (lead) => lead?.etapa_atual === 'E4', 'E4');
        expect(traces.at(-1)?.finalOutput).toMatch(/nome completo/i);
        expect(traces.at(-1)?.finalOutput).not.toMatch(/cidade|modalidade/i);

        await postWebhook(webhookPayload({ phone, text: 'Meu nome completo é Maria Silva Pereira' }));
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

        await postWebhook(webhookPayload({ phone, text: 'Quero fazer a matrícula' }));
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
        const leadWithIndication = await getLeadByPhone(phone);
        const indications = await getIndications(leadWithIndication.id);
        expect(indications.some((item: any) => String(item.nome_indicado || '').match(/Maria/i) && String(item.telefone_indicado || '').includes('69999999999'))).toBe(true);

        traces.push(await sendLeadTurn(phone, 'Tudo certo'));
        expect(traces.at(-1)?.finalOutput).toMatch(/avisar|contato|entrar em contato/i);
        expect(traces.at(-1)?.finalOutput).not.toMatch(/curso|cidade|nova indica/i);

        for (const trace of traces) expectNoGlobalViolations(trace);
        for (const trace of traces) {
            if (trace.sentPayload?.validated_output && trace.sentPayload?.sent_output_parts?.length) {
                expectSemanticPartsEqual(trace.sentPayload);
            }
            expect(trace.readyPayload?.deterministic_reply_used).toBe(false);
            expect(trace.readyPayload?.fallback_used).toBe(false);
            expect(['raw_model', 'regenerated_1', 'regenerated_2']).toContain(trace.readyPayload?.final_output_source);
        }

        const finalLead = await getLeadByPhone(phone);
        const events = await getEvents(finalLead.id);
        expect(events.some((event: any) => event.event_type === 'unhandled_inbound_terminal_state')).toBe(false);
        expect(events.some((event: any) => event.event_type === 'test_response_sent_trace')).toBe(true);
        expect(events.some((event: any) => event.event_type === 'test_read_receipt_success')).toBe(true);
    }, 300_000);

    it('cobre catalogo, indisponiveis, ambiguo, viagem/mudanca e infra debounce', async () => {
        const catalogPhone = `+550002${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(catalogPhone, 'Oi', { expectCommercialTrace: false });
        const broadCatalog = await sendLeadTurn(catalogPhone, 'Quais cursos voces tem?');
        expect(['ask_catalog_area', 'present_real_areas_and_wait_selection']).toContain(broadCatalog.processAction);
        expect(broadCatalog.pendingCriterion).toBe('catalog_area_selection');
        expect(broadCatalog.finalOutput).toMatch(/area|identifica|curso|opcao|opcoes/i);
        expect(broadCatalog.finalOutput).not.toMatch(/Radiologia.*Administra/i);
        const areaChoice = await sendLeadTurn(catalogPhone, 'Tecnologia me chama atencao');
        expect(areaChoice.processAction).toBe('present_area_courses_and_wait_selection');
        expect(['course_selection', 'alternative_course_selection']).toContain(areaChoice.pendingCriterion);
        expect(areaChoice.finalOutput).toMatch(/Analise|An[aá]lise|Sistemas|Tecnologia/i);
        const catalogChoice = await sendLeadTurn(catalogPhone, 'Análise e Desenvolvimento de Sistemas parece interessante');
        expect(catalogChoice.pendingCriterion).toBe('city');
        expect(catalogChoice.finalOutput).not.toMatch(/Ciência da Computação|Banco de Dados/);
        const reopenBrowse = await sendLeadTurn(catalogPhone, 'Quero ver outras opcoes tambem');
        expect(reopenBrowse.processAction).toMatch(/catalog|area|browse|selection/i);
        expect(normalizeForAssert(reopenBrowse.finalOutput)).toMatch(/area|opcao|opcoes|curso/i);

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
        const eadAfterTravel = await getLeadByPhone(eadPhone);
        expect(eadAfterTravel.sales_context?.e2_availability_status).toBe('resolved');
        expect(eadAfterTravel.sales_context?.pending_criterion).toBe('vaccine_decider');

        const semiPhone = `+550007${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(semiPhone, 'Quero Radiologia');
        await sendLeadTurn(semiPhone, 'Sou de Vilhena');
        await sendLeadTurn(semiPhone, 'Já trabalho na área');
        await waitFor(() => getLeadByPhone(semiPhone), (lead) => lead?.etapa_atual === 'E2', 'Semipresencial E2');
        const semiTravel = await sendLeadTurn(semiPhone, 'Vou viajar no próximo mês');
        expect(semiTravel.processAction).toBe('ask_vaccine_decider');
        expect(semiTravel.finalOutput).toMatch(/semipresencial|plataforma|aulas ao vivo/i);

        const debouncePhone = `+550008${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(debouncePhone, 'Oi', { expectCommercialTrace: false });
        const debounceLeadBefore = await getLeadByPhone(debouncePhone);
        const debounceTraceCountBefore = (await getEvents(debounceLeadBefore.id, 200))
            .filter((event: any) => event.event_type === 'test_response_sent_trace').length;
        await Promise.all([
            postWebhook(webhookPayload({ phone: debouncePhone, text: 'Estou procurando uma graduação' })),
            postWebhook(webhookPayload({ phone: debouncePhone, text: 'Quais opções tem?' })),
        ]);
        const debounceLead = await waitFor(() => getLeadByPhone(debouncePhone), (lead) => !!lead?.id, 'lead debounce');
        await waitFor(
            () => getEvents(debounceLead.id, 200),
            (events) => events.filter((event: any) => event.event_type === 'test_response_sent_trace').length > debounceTraceCountBefore,
            `debounce response sent trace lead=${debounceLead.id}`,
        );
        const events = await getEvents(debounceLead.id);
        const consolidated = events.find((event: any) =>
            event.event_type === 'test_debounce_consolidated'
            && event.payload?.message_count === 2
        );
        expect(consolidated?.payload?.message_count).toBe(2);
        expect(events.filter((event: any) => event.event_type === 'test_response_sent_trace').length).toBe(debounceTraceCountBefore + 1);
    }, 360_000);

    it('cobre variantes E1/E2/E3 sem reabrir criterios nem degradar curso', async () => {
        const dreamPhone = `+550009${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(dreamPhone, 'Quero Radiologia');
        await sendLeadTurn(dreamPhone, 'Moro em Vilhena');
        await sendLeadTurn(dreamPhone, 'Sempre foi meu sonho');
        await waitFor(() => getLeadByPhone(dreamPhone), (lead) => lead?.etapa_atual === 'E2', 'dream E2');
        let lead = await getLeadByPhone(dreamPhone);
        expect(lead.sales_context?.course_status).toBe('confirmed_available');
        expect(lead.sales_context?.motivacao_principal || lead.dor_principal).toBeTruthy();

        const contestPhone = `+550010${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(contestPhone, 'Quero Radiologia');
        await sendLeadTurn(contestPhone, 'Sou de Vilhena');
        await sendLeadTurn(contestPhone, 'Quero fazer para prestar concurso');
        await waitFor(() => getLeadByPhone(contestPhone), (value) => value?.etapa_atual === 'E2', 'contest E2');

        const soloPhone = `+550011${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(soloPhone, 'Quero Administração Pública');
        await sendLeadTurn(soloPhone, 'Sou de Vilhena');
        await sendLeadTurn(soloPhone, 'É meu objetivo pessoal');
        await waitFor(() => getLeadByPhone(soloPhone), (value) => value?.etapa_atual === 'E2', 'solo E2');
        await sendLeadTurn(soloPhone, 'Não tenho viagem nem mudança');
        const solo = await sendLeadTurn(soloPhone, 'Decido sozinho');
        expect(solo.processAction).toBe('ask_vaccine_agreement');
        const directAgreement = await sendLeadTurn(soloPhone, 'Combinado');
        await waitFor(() => getLeadByPhone(soloPhone), (value) => value?.etapa_atual === 'E3', 'direct agreement E3');
        expect(directAgreement.stageAfter).toBe('E3');

        const eadE3Phone = `+550012${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(eadE3Phone, 'Quero Administração Pública');
        await sendLeadTurn(eadE3Phone, 'Sou de Vilhena');
        await sendLeadTurn(eadE3Phone, 'Já trabalho na área');
        await waitFor(() => getLeadByPhone(eadE3Phone), (value) => value?.etapa_atual === 'E2', 'ead e3 E2');
        await sendLeadTurn(eadE3Phone, 'Não tenho viagem nem mudança');
        await sendLeadTurn(eadE3Phone, 'Decido sozinho');
        const eadE3 = await sendLeadTurn(eadE3Phone, 'Combinado');
        await waitFor(() => getLeadByPhone(eadE3Phone), (value) => value?.etapa_atual === 'E3', 'ead e3');
        expect(eadE3.finalOutput).toMatch(/EAD/i);
        expect(eadE3.speakableFacts?.e3_authorized_facts?.some((fact: any) => fact.claim_key === 'ead_flexible_study_schedule')).toBe(true);
        const e3Question = await sendLeadTurn(eadE3Phone, 'Como funcionam os tutores?');
        expect(e3Question.finalOutput).toMatch(/tutor/i);
        expect(e3Question.finalOutput.length).toBeLessThan(1200);

        const noDoubtPhone = `+550023${String(Date.now()).slice(-8)}`;
        await createLeadFixture(noDoubtPhone, {
            etapa_atual: 'E3',
            curso_interesse: 'Administracao Publica',
            cidade: 'Vilhena',
            sales_context: {
                pending_criterion: 'interest_signal',
                course_status: 'confirmed_available',
                e3_presentation_complete: true,
            },
        });
        const noDoubt = await sendLeadTurn(noDoubtPhone, 'Nao tenho duvidas');
        await waitFor(() => getLeadByPhone(noDoubtPhone), (value) => value?.etapa_atual === 'E4', 'no doubt E4');
        expect(noDoubt.finalOutput).not.toMatch(/60 anos|nota maxima|tutores|semestres/i);
    }, 420_000);

    it('cobre checkpoints negativos, dois leads e bloqueio absoluto', async () => {
        const phoneA = `+550013${String(Date.now()).slice(-8)}`;
        const phoneB = `+550014${String(Date.now()).slice(-8)}`;
        const leadA = await createLeadFixture(phoneA, {
            etapa_atual: 'E4',
            curso_interesse: 'Radiologia',
            cidade: 'Vilhena',
            sales_context: {
                pending_criterion: 'full_name',
                course_status: 'confirmed_available',
                e3_presentation_complete: true,
                e3_interest_signal_captured: true,
            },
        });
        const leadB = await createLeadFixture(phoneB, {
            etapa_atual: 'E4',
            curso_interesse: 'Administração Pública',
            cidade: 'Vilhena',
            sales_context: {
                pending_criterion: 'full_name',
                course_status: 'confirmed_available',
                e3_presentation_complete: true,
                e3_interest_signal_captured: true,
            },
        });

        await sendLeadTurn(phoneA, 'Meu nome completo é Ana Maria Silva');
        await sendLeadTurn(phoneB, 'Meu nome completo é Bruna Maria Silva');
        await waitFor(() => getLeadByPhone(phoneA), (lead) => lead?.bloqueado === true, 'lead A blocked');
        await waitFor(() => getLeadByPhone(phoneB), (lead) => lead?.bloqueado === true, 'lead B blocked');

        const checkpointsA = await supabase
            .from('lead_admin_checkpoints')
            .select('*')
            .eq('lead_id', leadA.id)
            .eq('checkpoint_admin', 'proposal_send')
            .eq('status_checkpoint', 'pending')
            .limit(1);
        const checkpointsB = await supabase
            .from('lead_admin_checkpoints')
            .select('*')
            .eq('lead_id', leadB.id)
            .eq('checkpoint_admin', 'proposal_send')
            .eq('status_checkpoint', 'pending')
            .limit(1);
        expect(checkpointsA.error).toBeNull();
        expect(checkpointsB.error).toBeNull();

        await postWebhook(webhookPayload({ phone: phoneA, text: 'Pode continuar?' }));
        expect((await getLeadByPhone(phoneA)).etapa_atual).toBe('E4');
        expect((await getLeadByPhone(phoneA)).bloqueado).toBe(true);

        await postWebhook(webhookPayload({
            phone: adminPhone,
            text: 'Mensagem sem correlação',
            fromAdmin: true,
            messageId: `admin-wrong-${Date.now()}`,
        }));
        expect((await getLeadByPhone(phoneA)).bloqueado).toBe(true);
        expect((await getLeadByPhone(phoneB)).bloqueado).toBe(true);

        await sendAdminReply(checkpointsA.data![0].admin_message_id, 'Proposta enviada A');
        await waitFor(() => getLeadByPhone(phoneA), (lead) => lead?.bloqueado === false, 'lead A resume only');
        expect((await getLeadByPhone(phoneB)).bloqueado).toBe(true);
        await sendAdminReply(checkpointsB.data![0].admin_message_id, 'Proposta enviada B');
        await waitFor(() => getLeadByPhone(phoneB), (lead) => lead?.bloqueado === false, 'lead B resume');
    }, 300_000);

    it('cobre E5, E6 e E7 variantes finais', async () => {
        const mondayPhone = `+550015${String(Date.now()).slice(-8)}`;
        await createLeadFixture(mondayPhone, {
            etapa_atual: 'E5',
            matriculado: true,
            curso_interesse: 'Radiologia',
            sales_context: { pending_criterion: 'boleto_date', enrollment_checkpoint_completed: true },
        });
        await sendLeadTurn(mondayPhone, 'Segunda');
        await waitFor(() => getLeadByPhone(mondayPhone), (lead) => lead?.etapa_atual === 'E6', 'monday E6');

        const customDatePhone = `+550016${String(Date.now()).slice(-8)}`;
        await createLeadFixture(customDatePhone, {
            etapa_atual: 'E5',
            matriculado: true,
            curso_interesse: 'Radiologia',
            sales_context: { pending_criterion: 'boleto_date', enrollment_checkpoint_completed: true },
        });
        const customDate = await sendLeadTurn(customDatePhone, 'Dia 20/09');
        const customDateEvents = await getEvents((await getLeadByPhone(customDatePhone)).id, 200);
        expect(customDateEvents.some((event: any) => event.event_type === 'custom_boleto_date')).toBe(true);
        expect(customDate.finalOutput).not.toMatch(/aprovado|confirmado pelo financeiro/i);

        const referralPhone = `+550022${String(Date.now()).slice(-8)}`;
        const referralLead = await createLeadFixture(referralPhone, {
            etapa_atual: 'E6',
            matriculado: true,
            curso_interesse: 'Radiologia',
            sales_context: { pending_criterion: 'referral_offer', boleto_date_defined: true },
        });
        await sendLeadTurn(referralPhone, 'Sim, gostei e recomendo');
        await sendLeadTurn(referralPhone, 'Carlos');
        await sendLeadTurn(referralPhone, '69988887777');
        await waitFor(() => getLeadByPhone(referralPhone), (lead) => lead?.etapa_atual === 'E7', 'referral E7');
        const referralRows = await getIndications(referralLead.id);
        expect(referralRows.some((item: any) => String(item.nome_indicado || '').match(/Carlos/i) && String(item.telefone_indicado || '').includes('69988887777'))).toBe(true);
        const e7IndicatedPhone = `+550030${String(Date.now()).slice(-8)}`;
        await createLeadFixture(e7IndicatedPhone, {
            etapa_atual: 'E7',
            matriculado: true,
            curso_interesse: 'Radiologia',
            sales_context: {
                referral_registered: true,
                last_indicated_name: 'Carlos',
            },
        });
        const referralClose = await sendLeadTurn(e7IndicatedPhone, 'Tudo certo');
        expect(referralClose.finalOutput).toMatch(/avisar|contato|entrar em contato/i);
        expect(referralClose.finalOutput).not.toMatch(/curso|cidade|nova indica/i);

        const refusalPhone = `+550017${String(Date.now()).slice(-8)}`;
        await createLeadFixture(refusalPhone, {
            etapa_atual: 'E6',
            matriculado: true,
            curso_interesse: 'Radiologia',
            sales_context: { pending_criterion: 'referral_offer', boleto_date_defined: true },
        });
        await sendLeadTurn(refusalPhone, 'Não quero indicar ninguém');
        await waitFor(() => getLeadByPhone(refusalPhone), (lead) => lead?.etapa_atual === 'E7', 'refusal E7');
        const closing = await sendLeadTurn(refusalPhone, 'Sem dúvidas');
        expect(closing.finalOutput).not.toMatch(/curso|cidade|matr[ií]cula/i);
    }, 300_000);

    it('cobre infraestrutura: job velho, stale claim, concorrencia, sender failure e silence guard', async () => {
        const oldPhone = `+550024${String(Date.now()).slice(-8)}`;
        const oldLead = await createLeadFixture(oldPhone, { etapa_atual: 'E1', sales_context: {} });
        await createProcessedDebounceGroup(oldLead.id, oldPhone);

        const newPhone = `+550025${String(Date.now()).slice(-8)}`;
        const newLead = await createLeadFixture(newPhone, { etapa_atual: 'E1', sales_context: {} });
        await createQueuedDebounceGroup(newLead.id, newPhone, 'Quero Radiologia');
        const scan = await invokeAiProcessor();
        expect(scan.res.ok).toBe(true);
        await waitFor(() => getEvents(newLead.id, 200), (events) => events.some((event: any) => event.event_type === 'test_response_sent_trace'), 'new job processed');
        const oldEvents = await getEvents(oldLead.id, 200);
        const newEvents = await getEvents(newLead.id, 200);
        expect(oldEvents.some((event: any) => event.event_type === 'test_queue_job_skipped' && ['already_completed', 'stale_duplicate'].includes(String(event.payload?.queue_job_classification || '')))).toBe(true);
        expect(newEvents.some((event: any) => event.event_type === 'test_queue_scan_finished' && event.payload?.processable_job_found === true)).toBe(true);

        const stalePhone = `+550026${String(Date.now()).slice(-8)}`;
        const staleLead = await createLeadFixture(stalePhone, { etapa_atual: 'E1', sales_context: {} });
        const stale = await createQueuedDebounceGroup(staleLead.id, stalePhone, 'Quero Radiologia');
        const oldDate = new Date(Date.now() - 10 * 60_000).toISOString();
        await supabase.from('outbound_generation_claims').insert({
            generation_key: stale.generationKey,
            tenant_id: tenantId,
            lead_id: staleLead.id,
            debounce_group_id: stale.groupId,
            processing_job_id: stale.processingJobId,
            created_at: oldDate,
        });
        await supabase.from('debounce_groups').update({ updated_at: oldDate }).eq('id', stale.groupId);
        await invokeAiProcessor();
        const staleEvents = await getEvents(staleLead.id, 200);
        expect(staleEvents.some((event: any) => event.event_type === 'test_queue_job_skipped' && event.payload?.skip_reason === 'claimed_stale')).toBe(true);
        expect(await getAssistantMessages(staleLead.id)).toHaveLength(0);

        const freshPhone = `+550027${String(Date.now()).slice(-8)}`;
        const freshLead = await createLeadFixture(freshPhone, { etapa_atual: 'E1', sales_context: {} });
        await createQueuedDebounceGroup(freshLead.id, freshPhone, 'Quero Administracao Publica');
        await invokeAiProcessor();
        await waitFor(() => getEvents(freshLead.id, 200), (events) => events.some((event: any) => event.event_type === 'test_response_sent_trace'), 'fresh after stale');

        const racePhone = `+550028${String(Date.now()).slice(-8)}`;
        const raceLead = await createLeadFixture(racePhone, { etapa_atual: 'E1', sales_context: {} });
        await createQueuedDebounceGroup(raceLead.id, racePhone, 'Quero Radiologia');
        await Promise.all([invokeAiProcessor(), invokeAiProcessor()]);
        await waitFor(() => getEvents(raceLead.id, 200), (events) => events.some((event: any) => event.event_type === 'test_response_sent_trace'), 'race processed once');
        const raceEvents = await getEvents(raceLead.id, 200);
        expect(raceEvents.filter((event: any) => event.event_type === 'test_response_sent_trace')).toHaveLength(1);

        const senderPhone = `+550029${String(Date.now()).slice(-8)}`;
        const senderLead = await createLeadFixture(senderPhone, { etapa_atual: 'E1', sales_context: {} });
        failNextSendCount = 1;
        const failed = await invokeFunction('whatsapp-sender', {
            lead_id: senderLead.id,
            telefone: senderPhone,
            text: 'Mensagem de teste de falha',
            subagente_usado: 'E1',
            skip_takeover: true,
        });
        expect(failed.json.ok).toBe(false);
        expect(await getAssistantMessages(senderLead.id)).toHaveLength(0);
        const retried = await invokeFunction('whatsapp-sender', {
            lead_id: senderLead.id,
            telefone: senderPhone,
            text: 'Mensagem de teste de falha',
            subagente_usado: 'E1',
            skip_takeover: true,
        });
        expect(retried.json.ok).toBe(true);
        expect(await getAssistantMessages(senderLead.id)).toHaveLength(1);

        const normalEvents = await getEvents(newLead.id, 200);
        expect(normalEvents.some((event: any) => event.event_type === 'unhandled_inbound_terminal_state')).toBe(false);
    }, 420_000);

    it('cobre debounce triplo e claims editaveis dinamicos', async () => {
        const triplePhone = `+550018${String(Date.now()).slice(-8)}`;
        await sendLeadTurn(triplePhone, 'Oi', { expectCommercialTrace: false });
        const leadBefore = await getLeadByPhone(triplePhone);
        const traceCountBefore = (await getEvents(leadBefore.id, 200))
            .filter((event: any) => event.event_type === 'test_response_sent_trace').length;
        await Promise.all([
            postWebhook(webhookPayload({ phone: triplePhone, text: 'Estou procurando graduação' })),
            postWebhook(webhookPayload({ phone: triplePhone, text: 'Quero opções' })),
            postWebhook(webhookPayload({ phone: triplePhone, text: 'Pode ser por área' })),
        ]);
        const lead = await waitFor(() => getLeadByPhone(triplePhone), (value) => !!value?.id, 'triple lead');
        await waitFor(
            () => getEvents(lead.id, 200),
            (events) => events.filter((event: any) => event.event_type === 'test_response_sent_trace').length > traceCountBefore,
            'triple debounce response',
        );
        const events = await getEvents(lead.id);
        expect(events.some((event: any) => event.event_type === 'test_debounce_consolidated' && event.payload?.message_count === 3)).toBe(true);

        const claimKey = 'institution_60_plus_years';
        const { data: original, error: originalError } = await supabase
            .from('knowledge_items')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('type', 'claim')
            .eq('claim_key', claimKey)
            .single();
        expect(originalError).toBeNull();

        async function claimAppears() {
            const { data, error } = await supabase
                .from('knowledge_items')
                .select('claim_key, value, metadata')
                .eq('tenant_id', tenantId)
                .eq('type', 'claim')
                .eq('active', true)
                .eq('authorized', true)
                .eq('source_type', 'admin_defined')
                .eq('status', 'published')
                .eq('claim_key', claimKey);
            if (error) throw error;
            return data || [];
        }

        async function authorizedFactsForClaim() {
            return getAuthorizedKnowledgeFacts({
                supabase,
                tenantId,
                stage: 'E3',
            }).then((facts) => facts.filter((fact: any) => fact.claim_key === claimKey));
        }

        expect((await claimAppears()).length).toBe(1);
        expect((await authorizedFactsForClaim()).length).toBe(1);
        await supabase.from('knowledge_items').update({ authorized: false }).eq('id', original.id);
        expect((await claimAppears()).length).toBe(0);
        expect((await authorizedFactsForClaim()).length).toBe(0);
        await supabase.from('knowledge_items').update({ authorized: true, active: false }).eq('id', original.id);
        expect((await claimAppears()).length).toBe(0);
        expect((await authorizedFactsForClaim()).length).toBe(0);
        await supabase.from('knowledge_items').update({ active: true, status: 'archived' }).eq('id', original.id);
        expect((await claimAppears()).length).toBe(0);
        expect((await authorizedFactsForClaim()).length).toBe(0);
        await supabase.from('knowledge_items').update({
            status: 'published',
            value: { ...original.value, content: 'A instituição possui mais de 61 anos de mercado educacional.', metadata: original.metadata },
            metadata: { ...original.metadata, forbidden_strengthening: ['nao_falar_numero_1'] },
        }).eq('id', original.id);
        const changed = await claimAppears();
        const changedFacts = await authorizedFactsForClaim();
        expect(changed[0].value.content).toContain('61 anos');
        expect(changedFacts[0].content).toContain('61 anos');
        expect(changedFacts[0].metadata).toBeUndefined();
        expect(JSON.stringify(changedFacts[0])).not.toContain('nao_falar_numero_1');
        expect(JSON.stringify(changed[0].metadata)).toContain('nao_falar_numero_1');
        expect(changed[0].value.content).not.toContain('nao_falar_numero_1');

        await supabase.from('knowledge_items').update({
            active: original.active,
            authorized: original.authorized,
            status: original.status,
            value: original.value,
            metadata: original.metadata,
            updated_at: original.updated_at,
        }).eq('id', original.id);
    }, 300_000);
});
