// =============================================================================
// Native Tracing — grava spans/scores diretamente em trace_span / llm_score.
// Fire-and-forget via EdgeRuntime.waitUntil. Fail-open total.
// =============================================================================
// deno-lint-ignore-file
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type ServiceName =
    | 'ai-processor' | 'webhook-receiver' | 'whatsapp-sender'
    | 'debounce-worker' | 'followup-worker';

export interface TraceRootOptions {
    service: ServiceName;
    spanName: string;
    conversationId?: string;
    tenantId?: string;
    userPhone?: string;
    sessionId?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
}

export interface SpanOptions {
    spanName: string;
    spanKind: 'generation' | 'operation';
    model?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
}

export interface SpanEndOptions {
    output?: unknown;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number };
    costCents?: number;
    status?: 'ok' | 'error';
    errorMessage?: string;
}

export interface ScoreOptions {
    name: string;
    type: 'NUMERIC' | 'CATEGORICAL' | 'BOOLEAN';
    value: number | string | boolean;
    comment?: string;
}

export interface SpanHandle { id: string; traceId: string; end(opts?: SpanEndOptions): void; }
export interface TraceHandle {
    traceId: string;
    rootSpanId: string;
    addSpan(opts: SpanOptions, parentSpanId?: string): SpanHandle;
    addScore(opts: ScoreOptions, spanId?: string): void;
    end(output?: unknown, status?: 'ok' | 'error'): void;
}

function getClient() {
    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!url || !key) return null;
    return createClient(url, key, { auth: { persistSession: false } });
}

function fireAndForget<T>(p: Promise<T> | T): void {
    const promise = Promise.resolve(p as Promise<T>);
    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(promise.catch(() => {}));
    else promise.catch(() => {});
}

function noopHandle(traceId: string, rootSpanId: string): TraceHandle {
    const noopSpan: SpanHandle = { id: crypto.randomUUID(), traceId, end: () => {} };
    return { traceId, rootSpanId, addSpan: () => noopSpan, addScore: () => {}, end: () => {} };
}

export function startTrace(opts: TraceRootOptions): TraceHandle {
    const traceId = crypto.randomUUID();
    const rootSpanId = crypto.randomUUID();
    const sb = getClient();
    if (!sb) return noopHandle(traceId, rootSpanId);

    const startedAt = new Date().toISOString();
    fireAndForget(sb.from('trace_span').insert({
        id: rootSpanId, trace_id: traceId, parent_span_id: null,
        service_name: opts.service, span_name: opts.spanName, span_kind: 'trace_root',
        conversation_id: opts.conversationId ?? null,
        tenant_id: opts.tenantId ?? null,
        user_phone: opts.userPhone ?? null,
        session_id: opts.sessionId ?? opts.conversationId ?? null,
        input: opts.input ?? null,
        metadata: opts.metadata ?? {},
        tags: opts.tags ?? [],
        started_at: startedAt,
    }));

    function addSpan(span: SpanOptions, parentSpanId?: string): SpanHandle {
        const spanId = crypto.randomUUID();
        const spanStarted = new Date().toISOString();
        fireAndForget(sb.from('trace_span').insert({
            id: spanId, trace_id: traceId, parent_span_id: parentSpanId ?? rootSpanId,
            service_name: opts.service, span_name: span.spanName, span_kind: span.spanKind,
            conversation_id: opts.conversationId ?? null,
            tenant_id: opts.tenantId ?? null,
            user_phone: opts.userPhone ?? null,
            session_id: opts.sessionId ?? opts.conversationId ?? null,
            model: span.model ?? null,
            input: span.input ?? null,
            metadata: span.metadata ?? {},
            started_at: spanStarted,
        }));
        return {
            id: spanId,
            traceId,
            end(endOpts?: SpanEndOptions) {
                const endedAt = new Date();
                const latencyMs = endedAt.getTime() - new Date(spanStarted).getTime();
                fireAndForget(sb.from('trace_span').update({
                    output: endOpts?.output ?? null,
                    prompt_tokens: endOpts?.usage?.promptTokens ?? null,
                    completion_tokens: endOpts?.usage?.completionTokens ?? null,
                    total_tokens: endOpts?.usage?.totalTokens ?? null,
                    cost_cents: endOpts?.costCents ?? null,
                    latency_ms: latencyMs,
                    ended_at: endedAt.toISOString(),
                    status: endOpts?.status ?? 'ok',
                    error_message: endOpts?.errorMessage ?? null,
                }).eq('id', spanId));
            },
        };
    }

    function addScore(score: ScoreOptions, spanId?: string): void {
        const row: Record<string, unknown> = {
            trace_id: traceId,
            span_id: spanId ?? rootSpanId,
            conversation_id: opts.conversationId ?? null,
            score_name: score.name,
            score_type: score.type,
            comment: score.comment ?? null,
        };
        if (score.type === 'NUMERIC') row.value_numeric = Number(score.value);
        else row.value_text = String(score.value);
        fireAndForget(sb.from('llm_score').insert(row));
    }

    function end(output?: unknown, status: 'ok' | 'error' = 'ok'): void {
        const endedAt = new Date();
        const latencyMs = endedAt.getTime() - new Date(startedAt).getTime();
        fireAndForget(sb.from('trace_span').update({
            output: output ?? null,
            latency_ms: latencyMs,
            ended_at: endedAt.toISOString(),
            status,
        }).eq('id', rootSpanId));
    }

    return { traceId, rootSpanId, addSpan, addScore, end };
}
