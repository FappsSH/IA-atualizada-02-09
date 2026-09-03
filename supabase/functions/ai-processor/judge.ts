// Judge Agent — Vendase Fapps
// Post-response quality check (sampling 15% + force when severity=high).
// Dimensions: tone (PT-BR neutro-acolhedor), CTA, message length, empathy.
// 1-5 score. Scores via tracing.
// deno-lint-ignore-file
import { type SpanHandle, type TraceHandle } from '../_shared/tracing.ts';

export interface JudgeDimensions {
    toneAdherence: number;
    ctaPresence: number;
    messageLength: number;
    empathyScore: number;
}

export interface JudgeResult {
    overallScore: number;
    dimensions: JudgeDimensions;
    flags: string[];
    needsReview: boolean;
}

function checkCTAQuick(response: string): { score: number; flags: string[] } {
    const flags: string[] = [];
    const lastSentence = response.trim().split('\n').pop() ?? '';
    const ctaPatterns = [
        /\?$/, /quer\s+que\s+eu/i, /posso\s+te\s+ajudar/i, /me\s+conta/i,
        /me\s+fala/i, /qual\s+seria/i, /qual\s+(?:o\s+)?nome/i,
        /confirma\s+pra\s+mim/i, /topa/i, /o\s+que\s+acha/i, /vamos\s+nisso/i,
    ];
    const hasCTA = ctaPatterns.some((p) => p.test(lastSentence));
    if (!hasCTA) {
        flags.push('Resposta não termina com pergunta ou CTA');
        return { score: 1, flags };
    }
    if (lastSentence.length < 10) {
        flags.push('CTA muito curto/genérico');
        return { score: 3, flags };
    }
    return { score: 5, flags };
}

function checkMessageLength(response: string): { score: number; flags: string[] } {
    const flags: string[] = [];
    const blocks = response.split(/\n\s*\n/);
    const maxBlock = Math.max(...blocks.map((b) => b.length));
    if (maxBlock > 500) {
        flags.push(`Bloco excede 500 chars (${maxBlock})`);
        return { score: 2, flags };
    }
    if (response.length > 1500) {
        flags.push(`Resposta muito longa (${response.length} chars)`);
        return { score: 3, flags };
    }
    return { score: 5, flags };
}

export async function judgeResponse(
    openai: any,
    response: string,
    context?: { userMessage?: string; conversationId?: string; tenantId?: string; trace?: TraceHandle },
): Promise<JudgeResult> {
    const allFlags: string[] = [];
    const ctaQuick = checkCTAQuick(response);
    allFlags.push(...ctaQuick.flags);
    const lengthCheck = checkMessageLength(response);
    allFlags.push(...lengthCheck.flags);

    let toneScore = 5;
    let empathyScore = 5;

    const judgeMessages = [{
        role: 'system' as const,
        content: `Avaliador de qualidade para agente de vendas educacional Fapps.

Avalie 2 dimensoes (1-5):
1. TOM (tone): PT-BR natural, acolhedor, caloroso, sem pressão? NÃO use jargões de vendedor. Deve parecer um especialista de carreiras ajudando, não um vendedor empurrando.
2. EMPATIA (empathy): reconhece o que o lead disse, usa o nome quando conhecido, mostra que está ouvindo? Reage ao que foi dito antes de prosseguir?

Retorne APENAS JSON:
{"tone": 1-5, "empathy": 1-5, "reasoning": "breve"}

Resposta a avaliar:
${response.substring(0, 2000)}`,
    }];

    let judgeSpan: SpanHandle | undefined;
    try {
        judgeSpan = context?.trace?.addSpan({
            spanName: 'judge.llm_check', spanKind: 'generation',
            model: 'gpt-4o-mini', input: judgeMessages,
        });

        const llmCheck = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: judgeMessages,
            temperature: 0.1,
            max_tokens: 150,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'fapps_judge_scores',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['tone', 'empathy', 'reasoning'],
                        properties: {
                            tone: { type: 'integer', minimum: 1, maximum: 5 },
                            empathy: { type: 'integer', minimum: 1, maximum: 5 },
                            reasoning: { type: ['string', 'null'] },
                        },
                    },
                },
            },
        });

        const content = llmCheck.choices?.[0]?.message?.content ?? '';
        judgeSpan?.end({
            output: content,
            usage: {
                promptTokens: llmCheck.usage?.prompt_tokens,
                completionTokens: llmCheck.usage?.completion_tokens,
                totalTokens: llmCheck.usage?.total_tokens,
                cachedTokens: llmCheck.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            },
        });
        try {
            const parsed = JSON.parse(content);
            toneScore = Math.max(1, Math.min(5, parsed.tone ?? 5));
            empathyScore = Math.max(1, Math.min(5, parsed.empathy ?? 5));
        } catch { /* defaults */ }
    } catch (error) {
        judgeSpan?.end({ status: 'error', errorMessage: String(error) });
    }

    const dimensions: JudgeDimensions = {
        toneAdherence: toneScore,
        ctaPresence: ctaQuick.score,
        messageLength: lengthCheck.score,
        empathyScore: empathyScore,
    };
    const scores = Object.values(dimensions);
    const overallScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    const needsReview = scores.some((s) => s < 3);
    if (needsReview) allFlags.push('Resposta flagada — alguma dimensão < 3');

    const result: JudgeResult = { overallScore, dimensions, flags: allFlags, needsReview };

    if (context?.trace) {
        try {
            const t = context.trace;
            t.addScore({ name: 'judge.overall', type: 'NUMERIC', value: overallScore }, judgeSpan?.id);
            t.addScore({ name: 'judge.tone', type: 'NUMERIC', value: dimensions.toneAdherence }, judgeSpan?.id);
            t.addScore({ name: 'judge.cta', type: 'NUMERIC', value: dimensions.ctaPresence }, judgeSpan?.id);
            t.addScore({ name: 'judge.length', type: 'NUMERIC', value: dimensions.messageLength }, judgeSpan?.id);
            t.addScore({ name: 'judge.empathy', type: 'NUMERIC', value: dimensions.empathyScore }, judgeSpan?.id);
            if (needsReview) {
                t.addScore({
                    name: 'judge.needs_review', type: 'BOOLEAN', value: true,
                    comment: allFlags.slice(0, 3).join(' | '),
                }, judgeSpan?.id);
            }
        } catch { /* fail-open */ }
    }
    return result;
}

const SAMPLING_RATE = 0.15;
export function shouldJudge(): boolean { return Math.random() < SAMPLING_RATE; }

export async function runJudge(params: {
    tenantId?: string;
    leadId: string;
    telefone?: string;
    userMessage: string;
    aiResponse: string;
    agentKey: string;
    trace?: TraceHandle;
}): Promise<JudgeResult> {
    const OpenAI = (await import('https://esm.sh/openai@4')).default;
    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });

    return judgeResponse(openai, params.aiResponse, {
        userMessage: params.userMessage,
        conversationId: params.leadId,
        tenantId: params.tenantId,
        trace: params.trace,
    });
}

export async function runJudgeWithPreFilter(params: {
    tenantId?: string;
    leadId: string;
    telefone?: string;
    userMessage: string;
    aiResponse: string;
    agentKey: string;
    trace?: TraceHandle;
}): Promise<JudgeResult | null> {
    if (shouldJudge()) return runJudge(params);
    return null;
}
