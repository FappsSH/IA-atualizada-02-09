// AI Processor — AgenteHub Fapps
// v2: passa `trigger` e `nome_lead` para o runSubagent.
// deno-lint-ignore-file
// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { routeByEtapa } from './router.ts';
import { runSubagent } from './subagent.ts';
import { runJudgeWithPreFilter } from './judge.ts';
import { readMessage, deleteMessage, archiveMessage } from '../_shared/pgmq.ts';
import { startTrace } from '../_shared/tracing.ts';
import { loadTenantRuntimeConfig } from '../_shared/runtime-config.ts';
import { classifyLeadMessage, persistLeadIntelligence, registerLeadEvent, logLeadRuntimeEvent } from './intelligence.ts';
import { markMessageAsRead } from '../_shared/evolution-api.ts';
import { claimOutboundGeneration, claimReadReceipt, completeReadReceipt } from '../_shared/processing-claims.ts';
import { classifyQueueJobState, isQueueTimestampStale } from '../_shared/queue-job-classifier.ts';
import { validateOutboundText } from '../_shared/output-validator.ts';
import { tool_avancar_etapa, tool_consultar_conhecimento, tool_registrar_indicacao, tool_registrar_matricula } from './tools.ts';
import { detectCatalogIntentWithHistory, detectContextualReplyKind } from './catalog-resolver.ts';
import { createAdminCheckpoint, getPendingAdminCheckpoint } from '../_shared/admin-checkpoints.ts';
import { resolveTrustedLeadName } from '../_shared/lead-name.ts';
import { classifyInboundAgainstStageState, derivePendingCriterion, detectLastAgentQuestionType, getE2StateSnapshot, getNextCatalogAction, getNextE2Criterion, isE1CityResolved, matchOfferedCourseSelection } from './stage-state.ts';
import { buildInitialE1WelcomeMessages, resolveInitialE1WelcomeMessageCount, shouldRunInitialE1Welcome } from './initial-opening.ts';
import { getCourseDisplayName } from '../_shared/course-display.ts';
import {
    mentionsEarlyStageCourseDetails as mentionsEarlyStageCourseDetailsGuard,
    detectForbiddenEarlyStageTopics,
    detectAmbiguousCourseLineViolations,
    detectSegmentUnavailableViolations,
    detectUnnecessarySingleLineMention,
} from './early-stage-guard.ts';
import { detectPersonalityOutputViolations } from './output-guard.ts';

const Q_AI = 'ai_processing_vendas';
const AUTO_STAGE_HANDOFF_LIMIT = 3;
const RESPONSE_SEND_DELAY_MS = 3_000;
const MAX_QUEUE_SCAN = Number(Deno.env.get('AI_PROCESSOR_MAX_QUEUE_SCAN') || 8);
const PROCESSING_STALE_MS = Number(Deno.env.get('AI_PROCESSOR_PROCESSING_STALE_MS') || 90_000);

const PHONE_LIKE = /^\+?\d{10,15}$/;

function pendingCriterionFromProcessAction(processAction: string | null | undefined) {
    switch (String(processAction || '').trim()) {
        case 'ask_city':
            return 'city';
        case 'ask_motivation':
            return 'motivation';
        case 'ask_course_line':
            return 'course_line';
        case 'present_real_areas_and_wait_selection':
            return 'catalog_area_selection';
        case 'present_area_courses_and_wait_selection':
            return 'course_selection';
        case 'present_segment_options_and_wait_selection':
            return 'alternative_course_selection';
        case 'ask_for_new_direction':
            return 'new_direction';
        case 'ask_vaccine_availability':
            return 'vaccine_availability';
        case 'ask_vaccine_decider':
            return 'vaccine_decider';
        case 'ask_vaccine_agreement':
            return 'vaccine_agreement';
        case 'complete_stage':
            return null;
        default:
            return undefined;
    }
}

function syncLatestAssistantArtifacts(params: {
    collectedTexts: Array<{ stage: string; text: string }>;
    workingHistory: Array<{ role?: string; content?: string }>;
    currentSubagent: string;
    text: string | undefined;
}) {
    if (!params.text) return;

    const lastCollected = params.collectedTexts[params.collectedTexts.length - 1];
    if (lastCollected && lastCollected.stage === params.currentSubagent) {
        lastCollected.text = params.text;
    }

    for (let i = params.workingHistory.length - 1; i >= 0; i -= 1) {
        if (params.workingHistory[i]?.role === 'assistant') {
            params.workingHistory[i].content = params.text;
            break;
        }
    }
}

function isE2AdvanceStructurallyValid(params: {
    history: Array<{ role?: string; content?: string }>;
    recentUserMessages: string[];
    salesContext?: Record<string, unknown> | null;
}) {
    return getNextE2Criterion({
        leadSnapshot: { sales_context: { ...(params.salesContext || {}) } },
    }) === null;
}

function buildE2AgreementFallback() {
    return 'Entao deixa eu combinar uma coisa com voce.\n\nVou te apresentar tudo direitinho e, se fizer sentido pra voce e a bolsa de estudos ficar boa tambem, seguimos para a inscricao e garantimos essa oportunidade. Combinado?';
}

function userAskedFinancialQuestion(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'qual o valor',
        'qual valor',
        'quanto custa',
        'quanto fica',
        'mensalidade',
        'preco',
        'parcela',
        'bolsa',
        'desconto',
    ]);
}

function userExpressedCommercialInterest(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'gostei',
        'faz sentido',
        'quero fazer',
        'e isso que procuro',
        '� isso que procuro',
        'parece bom',
        'quero seguir',
        'quero sim',
        'tenho interesse',
        'curti',
        'nao tenho duvidas',
        'n�o tenho d�vidas',
        'sem duvidas',
        'sem d�vidas',
        'nenhuma duvida',
        'nenhuma d�vida',
    ]);
}

function userAskedToKnowValues(message: string) {
    return userAskedFinancialQuestion(message);
}

function isE3AdvanceStructurallyValid(params: {
    trigger: string;
    recentUserMessages: string[];
}) {
    const latestReply = params.recentUserMessages.slice(-1)[0] || '';
    if (params.trigger !== 'stage_handoff') return true;
    return userAskedToKnowValues(latestReply) || userExpressedCommercialInterest(latestReply);
}
function isLocalDebugLlmTraceEnabled(env: Record<string, string | undefined>) {
    const flag = String(env.DEBUG_LLM_TRACE || Deno.env.get('DEBUG_LLM_TRACE') || '').trim().toLowerCase() === 'true';
    if (!flag) return false;
    const url = String(
        env.NEXT_PUBLIC_SUPABASE_URL
        || env.SUPABASE_URL
        || Deno.env.get('NEXT_PUBLIC_SUPABASE_URL')
        || Deno.env.get('SUPABASE_URL')
        || '',
    ).trim();
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost|kong)(?::|\/|$)/i.test(url) || url.includes('supabase_edge_runtime');
}

function isLocalRuntimeUrl(env: Record<string, string | undefined>) {
    const url = String(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || '').trim();
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost|kong)(?::|\/|$)/i.test(url);
}

function sanitizeDebugLlmTraceValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeDebugLlmTraceValue(item));
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
            if (/(api[_-]?key|token|authorization|password|secret|service[_-]?role|bearer|cookie)/i.test(key)) {
                result[key] = '[REDACTED]';
            } else {
                result[key] = sanitizeDebugLlmTraceValue(rawValue);
            }
        }
        return result;
    }
    return value;
}

function emitDebugLlmTrace(env: Record<string, string | undefined>, payload: Record<string, unknown>) {
    if (!isLocalDebugLlmTraceEnabled(env)) return;
    console.log('[DEBUG_LLM_TRACE:START]');
    console.log(JSON.stringify(sanitizeDebugLlmTraceValue(payload), null, 2));
    console.log('[DEBUG_LLM_TRACE:END]');
}

function joinAssistantTexts(parts: Array<string | undefined>) {
    return uniqueNormalizedParts(parts
        .map((part) => (part || '').trim())
        .filter(Boolean)
    )
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function uniqueNormalizedParts(parts: string[]) {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const part of parts) {
        const normalized = normalizeText(part);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(part.trim());
    }

    return unique;
}

function normalizeText(text: string) {
    return (text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function textMisframesAreaSelectionAsUnavailable(text: string | undefined) {
    const normalized = normalizeText(String(text || ''));
    return /(nao temos|nao oferecemos|nao esta disponivel|curso indisponivel).{0,40}(curso|graduacao)/.test(normalized)
        || /(curso|graduacao).{0,40}(nao temos|nao oferecemos|nao esta disponivel|indisponivel)/.test(normalized);
}

function textIncludesAny(text: string, patterns: string[]) {
    return patterns.some((pattern) => text.includes(pattern));
}

function extractLatestCourseLookupDiagnostics(toolCalls: any[] | undefined) {
    const lookupCall = [...(toolCalls || [])]
        .reverse()
        .find((call: any) => String(call?.name || '').includes('consultar_conhecimento'));

    const result = lookupCall?.result || {};
    return {
        raw_inbound: result.raw_inbound || null,
        normalized_inbound: result.normalized_inbound || null,
        catalog_intent: result.catalog_intent === true,
        resolver_branch: result.resolver_branch || null,
        catalog_query_type: result.catalog_query_type || result.lookup_mode || null,
        available_areas: Array.isArray(result.available_areas) ? result.available_areas : [],
        available_area_courses: Array.isArray(result.related_area_courses) ? result.related_area_courses : [],
        requested_area: result.requested_area || null,
        requested_course: result.requested_course || null,
        available_catalog_areas: Array.isArray(result.available_catalog_areas) ? result.available_catalog_areas : [],
        requested_area_candidate: result.requested_area_candidate || null,
        requested_area_confidence: result.requested_area_confidence || null,
        requested_area_source: result.requested_area_source || null,
        related_area_courses_count: Number(result.related_area_courses_count || 0),
        course_status_final: result.course_status_final || null,
    };
}

async function markDebounceGroupStatus(params: {
    supabase: any;
    debounceGroupId?: string | null;
    status: 'processed' | 'skipped';
}) {
    if (!params.debounceGroupId) return;
    const patch: Record<string, unknown> = {
        status: params.status,
        updated_at: new Date().toISOString(),
    };
    if (params.status === 'processed') patch.processed_at = new Date().toISOString();
    await params.supabase
        .from('debounce_groups')
        .update(patch)
        .eq('id', params.debounceGroupId);
}

async function classifyQueueJob(params: {
    supabase: any;
    payload: any;
}) {
    const payload = params.payload || {};
    const generationKey = String(payload.outbound_generation_key || '').trim();
    const leadId = String(payload.lead_id || '').trim();
    const debounceGroupId = String(payload.debounce_group_id || '').trim();

    const { data: currentGroup } = debounceGroupId
        ? await params.supabase
            .from('debounce_groups')
            .select('id, lead_id, status, processed_at, updated_at, created_at, outbound_generation_key')
            .eq('id', debounceGroupId)
            .maybeSingle()
        : { data: null };

    const { data: existingClaim } = generationKey
        ? await params.supabase
            .from('outbound_generation_claims')
            .select('generation_key, lead_id, debounce_group_id, processing_job_id, created_at')
            .eq('generation_key', generationKey)
            .maybeSingle()
        : { data: null };

    const { data: earlierActiveGroups } = leadId
        ? await params.supabase
            .from('debounce_groups')
            .select('id, updated_at')
            .eq('lead_id', leadId)
            .eq('status', 'processing')
            .is('processed_at', null)
            .neq('id', debounceGroupId || '00000000-0000-0000-0000-000000000000')
            .lt('created_at', currentGroup?.created_at || new Date().toISOString())
            .limit(1)
        : { data: [] };

    const hasFreshEarlierSameLead = (earlierActiveGroups || [])
        .some((group: any) => !isQueueTimestampStale(group.updated_at, PROCESSING_STALE_MS));
    const { data: currentLead } = leadId
        ? await params.supabase
            .from('leads')
            .select('etapa_atual')
            .eq('id', leadId)
            .maybeSingle()
        : { data: null };
    const payloadStage = String(payload.etapa_atual || '').trim();
    const liveStage = String(currentLead?.etapa_atual || '').trim();
    if (payloadStage && liveStage && payloadStage !== liveStage) {
        return {
            classification: 'stale_stage_payload',
            skipReason: 'payload_stage_mismatch',
            claimStatus: existingClaim ? 'claimed' : 'unclaimed',
            processingStatus: String(currentGroup?.status || '') || null,
            processable: false,
            acknowledge: true,
            currentGroup,
            existingClaim,
        };
    }
    return {
        ...classifyQueueJobState({
            currentGroup,
            existingClaim,
            hasFreshEarlierSameLead,
            staleMs: PROCESSING_STALE_MS,
        }),
        currentGroup,
        existingClaim,
    };
}

function extractLikelyE1CourseQuery(message: string) {
    const normalized = normalizeText(message);
    if (!normalized) return '';
    if (textIncludesAny(normalized, [
        'quais cursos',
        'que cursos',
        'cursos voces tem',
        'cursos voce tem',
        'opcoes de curso',
        'opções de curso',
    ])) return '';

    const cleaned = String(message || '')
        .replace(/[!?.,;:]+$/g, '')
        .replace(/^\s*(oi|ola|olá|bom dia|boa tarde|boa noite)[,\s]+/i, '')
        .replace(/^\s*(quero saber mais sobre|quero saber sobre|queria saber sobre|tenho interesse em|quero fazer|quero cursar|quero)\s+/i, '')
        .trim();
    const cleanedNormalized = normalizeText(cleaned);
    const words = cleanedNormalized.split(' ').filter(Boolean);
    const blocked = new Set([
        'sim',
        'nao',
        'não',
        'talvez',
        'valor',
        'valores',
        'bolsa',
        'desconto',
        'cidade',
        'curso',
        'cursos',
    ]);
    if (!cleaned || words.length < 1 || words.length > 6) return '';
    if (blocked.has(cleanedNormalized)) return '';
    return cleaned;
}

function looksLikeE1ClosingValidation(text: string) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.includes('?')) return false;

    return textIncludesAny(normalized, [
        'parabens',
        'que bom saber disso',
        'que bom saber que voce ja trabalha',
        'que bom saber que voce ja atua',
        'que legal',
        'e otimo saber que voce ja atua',
        'e ótimo saber que você já atua',
        'experiencia valiosa para sua formacao',
        'experiência valiosa para sua formação',
        'que incrivel',
        'que bacana',
        'escolher seguir um sonho',
        'faz toda diferenca',
        'faz muita diferenca',
        'prazer enorme',
        'fico feliz',
        'muito bom saber',
        'perfeito',
        'excelente',
    ]);
}

function sanitizeE1InternalAdvanceNarration(text: string | undefined) {
    const source = String(text || '').trim();
    if (!source) return source;

    const blockedPatterns = [
        'vamos seguir para a proxima etapa',
        'vamos seguir para a próxima etapa',
        'vamos para a proxima etapa',
        'vamos para a próxima etapa',
        'seguir para a proxima etapa',
        'seguir para a próxima etapa',
        'agora que temos todas as informacoes vamos seguir',
        'agora que temos todas as informações vamos seguir',
        'agora que temos todas as informacoes, vamos seguir',
        'agora que temos todas as informações, vamos seguir',
        'agora que temos todas as informacoes vamos para',
        'agora que temos todas as informações vamos para',
        'proxima etapa',
        'próxima etapa',
        'vamos seguir',
        'vamos seguir adiante',
        'seguir adiante',
        'vamos continuar',
        'agora vamos continuar',
        'vamos para frente',
    ];

    const paragraphs = source
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => {
            const normalized = normalizeText(part);
            return !blockedPatterns.some((pattern) => normalized.includes(normalizeText(pattern)));
        });

    return paragraphs.join('\n\n').trim();
}

function asksE1LineSelectionQuestion(text: string | undefined) {
    const normalized = normalizeText(text || '');
    if (!normalized) return false;

    return textIncludesAny(normalized, [
        'linha de bacharelado',
        'linha de licenciatura',
        'interessado na linha de bacharelado',
        'interessada na linha de bacharelado',
        'qual linha voce prefere',
        'qual linha você prefere',
        'qual linha voce quer seguir',
        'qual linha',
        'bacharelado, certo',
        'licenciatura, certo',
        'bacharelado ou licenciatura',
    ]);
}

function sanitizeE1InvalidLineQuestion(text: string | undefined) {
    const source = String(text || '').trim();
    if (!source) return source;

    const paragraphs = source
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !asksE1LineSelectionQuestion(part));

    return paragraphs.join('\n\n').trim() || source;
}

function asksE1CityQuestion(text: string | undefined) {
    const normalized = normalizeText(String(text || ''));
    if (!normalized) return false;
    return textIncludesAny(normalized, [
        'qual cidade',
        'de qual cidade',
        'que cidade voce e',
        'que cidade você e',
        'em que cidade',
        'de onde voce fala',
        'de onde você fala',
    ]);
}

function asksE1MotivationQuestion(text: string | undefined) {
    const normalized = normalizeText(String(text || ''));
    if (!normalized) return false;
    return textIncludesAny(normalized, [
        'ja trabalha na area',
        'já trabalha na área',
        'sonho ou objetivo pessoal',
        'representa um sonho',
    ]);
}

async function applyPersonalityOutputGuard(params: {
    supabase: any;
    tenantId: string;
    leadId: string;
    payload: any;
    runtimeConfig: any;
    currentSubagent: string;
    currentStage: string;
    activeRecentUserMessages: string[];
    activeLastUserMessage: string;
    workingHistory: Array<{ role?: string; content?: string }>;
    leadSnapshot: Record<string, unknown> | null | undefined;
    intelligence: Record<string, unknown> | null | undefined;
    stageOutput: any;
}) {
    if (!params.stageOutput?.text) {
        return {
            guardTriggered: false,
            finalPersonalityValid: true,
            violations: [],
        };
    }

    const processActionByPending: Record<string, string> = {
        city: 'ask_city',
        motivation: 'ask_motivation',
        course_line: 'ask_course_line',
        catalog_area_selection: 'present_real_areas_and_wait_selection',
        course_selection: 'present_area_courses_and_wait_selection',
        alternative_course_selection: 'present_segment_options_and_wait_selection',
        new_direction: 'ask_for_new_direction',
        vaccine_availability: 'ask_vaccine_availability',
        vaccine_decider: 'ask_vaccine_decider',
        vaccine_agreement: 'ask_vaccine_agreement',
    };

    const maxRegenerations = 4;
    let attempts = 0;
    let lastResult = {
        guardTriggered: false,
        finalPersonalityValid: true,
        violations: [],
    };

    while (attempts < maxRegenerations) {
        const liveLead = await params.supabase
            .from('leads')
            .select('nome, cidade, curso_interesse, sales_context, etapa_atual')
            .eq('id', params.leadId)
            .maybeSingle();
        const liveLeadSnapshot = liveLead.data || params.leadSnapshot || {};
        const liveSalesContext = { ...(liveLeadSnapshot?.sales_context || {}) } as Record<string, unknown>;
        const contextualReplyKind = detectContextualReplyKind(params.activeLastUserMessage, params.workingHistory);
        const configuredPendingCriterion = String(params.currentSubagent === 'E1' && params.stageOutput.pendingCriterionAfter !== undefined
            ? (params.stageOutput.pendingCriterionAfter ?? '') : (params.stageOutput.pendingCriterionAfter || liveSalesContext.pending_criterion || '')).trim() || null;
        const e1CityQuestionLocked = params.currentSubagent === 'E1'
            && String(liveSalesContext.course_status || '').trim() === 'confirmed_available'
            && !isE1CityResolved(liveLeadSnapshot)
            && (
                String(params.stageOutput.processAction || '').trim() === 'ask_city'
                || asksE1CityQuestion(params.stageOutput.text)
            );
        const pendingCriterion = e1CityQuestionLocked ? 'city' : configuredPendingCriterion;
        const effectiveProcessAction = processActionByPending[pendingCriterion || '']
            || (
                String(params.stageOutput.processAction || '').trim()
                && !['follow_stage_contract', 'follow_prompt_normally'].includes(String(params.stageOutput.processAction || '').trim())
                    ? String(params.stageOutput.processAction || '').trim()
                    : null
            );

        const guard = detectPersonalityOutputViolations({
            stage: params.currentSubagent,
            text: params.stageOutput.text,
            latestUserMessage: params.activeLastUserMessage,
            savedCity: String(liveLeadSnapshot?.cidade || '').trim() || null,
            contextualReplyKind,
            processAction: effectiveProcessAction,
            courseStatus: String(liveSalesContext.course_status || '').trim() || null,
            requestedArea: String(liveSalesContext.requested_area_name || '').trim() || null,
            relatedAreaCourses: Array.isArray(liveSalesContext.related_area_courses)
                ? liveSalesContext.related_area_courses.map((item: unknown) => getCourseDisplayName(String(item))).filter(Boolean)
                : [],
            availableCourseLines: Array.isArray(liveSalesContext.available_course_lines) ? liveSalesContext.available_course_lines : [],
            pendingCriterion,
            e3AuthorizedClaimKeys: Array.isArray(params.stageOutput.speakableFacts?.e3_authorized_claim_keys)
                ? params.stageOutput.speakableFacts.e3_authorized_claim_keys.map((key: unknown) => String(key || '')).filter(Boolean)
                : Array.isArray(params.stageOutput.speakableFacts?.e3_authorized_facts)
                    ? params.stageOutput.speakableFacts.e3_authorized_facts.map((fact: any) => String(fact?.claim_key || '')).filter(Boolean)
                    : [],
            e2AvailabilityObjectionKind: String(liveSalesContext.e2_availability_objection_kind || '').trim() || null,
            leadMotivation: String(liveSalesContext.motivacao_principal || params.leadSnapshot?.dor_principal || '').trim() || null,
        });

        params.stageOutput.personalityGuardTriggered = guard.personality_guard_triggered === true;
        params.stageOutput.personalityViolations = guard.personality_violations || [];
        params.stageOutput.flowNarrationDetected = guard.flow_narration_detected === true;
        params.stageOutput.repeatedFactDetected = guard.repeated_fact_detected === true;
        params.stageOutput.ungroundedOutputDetected = guard.ungrounded_output_detected === true;
        params.stageOutput.unauthorizedStageFactDetected = guard.unauthorized_stage_fact_detected === true;
        params.stageOutput.finalPersonalityValid = guard.final_personality_valid === true;
        params.stageOutput.regenerationSuccess = false;
        params.stageOutput.guardRuns = Array.isArray(params.stageOutput.guardRuns) ? params.stageOutput.guardRuns : [];
        params.stageOutput.guardRuns.push({
            attempt: attempts,
            source: attempts === 0 ? 'raw_model' : `regenerated_${attempts}`,
            process_action: effectiveProcessAction,
            pending_criterion: pendingCriterion,
            violations: guard.personality_violations || [],
            output: params.stageOutput.text || null,
        });
        params.stageOutput.finalOutputSource = attempts === 0 ? 'raw_model' : `regenerated_${attempts}`;

        lastResult = {
            guardTriggered: guard.personality_guard_triggered === true,
            finalPersonalityValid: guard.final_personality_valid === true,
            violations: guard.personality_violations || [],
        };

        if (!guard.personality_guard_triggered) {
            if (attempts > 0 && params.stageOutput.regeneratedOutput && params.stageOutput.text === params.stageOutput.regeneratedOutput) {
                params.stageOutput.regenerationSuccess = true;
                params.stageOutput.finalOutputSource = `regenerated_${attempts}`;
            } else {
                params.stageOutput.finalOutputSource = 'raw_model';
            }
            return lastResult;
        }

        if (attempts >= maxRegenerations) {
            break;
        }

        attempts += 1;
        params.stageOutput.regenerationAttempt = attempts;

        const speakableFacts = {
            ...(params.stageOutput.speakableFacts || {}),
            course_name: String(liveLeadSnapshot?.curso_interesse || '').trim() || String(liveSalesContext.curso_base_nome || '').trim() || null,
            course_line: String(liveSalesContext.linha_formacao || '').trim() || null,
            course_status: String(liveSalesContext.course_status || '').trim() || null,
            requested_area: String(liveSalesContext.requested_area_name || '').trim() || null,
            related_area_courses: Array.isArray(liveSalesContext.related_area_courses)
                ? liveSalesContext.related_area_courses.map((item: unknown) => getCourseDisplayName(String(item))).filter(Boolean)
                : [],
            available_course_lines: Array.isArray(liveSalesContext.available_course_lines) ? liveSalesContext.available_course_lines : [],
            pending_criterion: pendingCriterion,
            pending_criterion_before: params.stageOutput.pendingCriterionBefore || pendingCriterion,
            pending_criterion_after: pendingCriterion,
            e2_availability_answer: String(liveSalesContext.e2_vaccine_availability_answer || '').trim() || null,
            e2_availability_objection_kind: String(liveSalesContext.e2_availability_objection_kind || '').trim() || null,
            lead_motivation: String(liveSalesContext.motivacao_principal || params.leadSnapshot?.dor_principal || '').trim() || null,
            ...(params.currentSubagent === 'E1' || params.currentSubagent === 'E3' ? params.stageOutput.speakableFacts : {}),
        };
        if (
            params.currentSubagent === 'E1'
            && String(liveSalesContext.course_status || '').trim() === 'confirmed_available'
            && effectiveProcessAction === 'ask_city'
        ) {
            delete speakableFacts.course_status;
            delete speakableFacts.available_course_lines;
            delete speakableFacts.availability;
            delete speakableFacts.offered;
            speakableFacts.e1_behavior = 'selected_course_to_city';
        }

        const regeneratedOutput = await runSubagent({
            subagent: params.currentSubagent as any,
            leadId: params.leadId,
            telefone: params.payload.telefone,
            etapaAtual: params.currentStage,
            recentUserMessages: params.activeRecentUserMessages,
            history: params.workingHistory,
            messages: [],
            trigger: 'personality_guard_regeneration',
            nomeDoLead: params.payload.nome_lead ?? null,
            supabase: params.supabase,
            tenantId: params.tenantId,
            env: params.runtimeConfig.env,
            messagePolicy: params.runtimeConfig.messagePolicy,
            intelligence: params.intelligence,
            leadSnapshot: liveLeadSnapshot,
            regenerationContext: {
                allowedIntent: params.stageOutput.allowedIntent || effectiveProcessAction || 'follow_stage_prompt_normally',
                speakableFacts,
                forbiddenTopics: guard.personality_violations || [],
                originalOutput: params.stageOutput.text,
            },
        });

        const originalTextBeforeRegeneration = params.stageOutput.text || '';
        params.stageOutput.originalOutput = params.stageOutput.originalOutput || originalTextBeforeRegeneration || null;
        let regeneratedText = regeneratedOutput.text || null;
        const preserveConfirmedE3Presentation =
            params.currentSubagent === 'E3'
            && effectiveProcessAction === 'present_e3_structured_blocks'
            && String(liveSalesContext.course_status || '').trim() === 'confirmed_available'
            && [3, 4].includes(splitValidatedE3Blocks(originalTextBeforeRegeneration).length)
            && /(curso nao esta disponivel|nao temos esse curso|nao oferecemos esse curso|curso indisponivel)/.test(normalizeText(regeneratedText || ''));
        if (preserveConfirmedE3Presentation) {
            regeneratedText = originalTextBeforeRegeneration;
        }
        if (
            params.currentSubagent === 'E2'
            && effectiveProcessAction === 'ask_vaccine_agreement'
            && textIncludesAny(normalizeText(params.activeLastUserMessage || ''), ['marido', 'esposa', 'mae', 'mãe', 'pai', 'familia', 'família', 'converso com'])
            && textIncludesAny(normalizeText(originalTextBeforeRegeneration), ['marido', 'esposa', 'mae', 'mãe', 'pai', 'familia', 'família'])
            && !textIncludesAny(normalizeText(regeneratedText || ''), ['marido', 'esposa', 'mae', 'mãe', 'pai', 'familia', 'família'])
            && normalizeText(originalTextBeforeRegeneration).includes('bolsa')
            && normalizeText(originalTextBeforeRegeneration).includes('combinado')
        ) {
            regeneratedText = originalTextBeforeRegeneration;
        }
        params.stageOutput.text = regeneratedText || params.stageOutput.text;
        params.stageOutput.outputBeforeGovernance = regeneratedOutput.outputBeforeGovernance || regeneratedText || params.stageOutput.text || null;
        params.stageOutput.responseOrigin = regeneratedOutput.responseOrigin || 'llm_regeneration';
        params.stageOutput.regenerationTriggered = true;
        params.stageOutput.regenerationSuccess = false;
        params.stageOutput.regeneratedOutput = regeneratedText;
        params.stageOutput.allowedIntent = regeneratedOutput.allowedIntent || params.stageOutput.allowedIntent || null;
        params.stageOutput.processAction = effectiveProcessAction || regeneratedOutput.processAction || params.stageOutput.processAction || null;
        params.stageOutput.conversationalBehavior = regeneratedOutput.conversationalBehavior || params.stageOutput.conversationalBehavior || null;
        params.stageOutput.speakableFacts = regeneratedOutput.speakableFacts || params.stageOutput.speakableFacts || null;
        params.stageOutput.pendingCriterionBefore = regeneratedOutput.pendingCriterionBefore || params.stageOutput.pendingCriterionBefore || null;
        params.stageOutput.pendingCriterionAfter = regeneratedOutput.pendingCriterionAfter || params.stageOutput.pendingCriterionAfter || null;
        params.stageOutput.personalityPromptId = regeneratedOutput.personalityPromptId || params.stageOutput.personalityPromptId || null;
        params.stageOutput.stagePromptId = regeneratedOutput.stagePromptId || params.stageOutput.stagePromptId || null;
        params.stageOutput.regenerationLlmTrace = regeneratedOutput.llmTrace || null;
        params.stageOutput.personalityViolations = guard.personality_violations || [];
        params.stageOutput.stageContractViolation = params.stageOutput.stageContractViolation === true || guard.personality_violations.length > 0;
        params.stageOutput.finalOutputSource = regeneratedText ? `regenerated_${attempts}` : 'safe_failure';
        if (regeneratedText) {
            params.stageOutput.rawModelOutput = params.stageOutput.rawModelOutput || params.stageOutput.originalOutput || null;
        }

        await logLeadRuntimeEvent({
            supabase: params.supabase,
            tenantId: params.tenantId,
            leadId: params.leadId,
            eventType: 'test_personality_guard',
            payload: {
                stage: params.currentSubagent,
                etapa_atual: params.currentStage,
                personality_guard_triggered: true,
                personality_violations: guard.personality_violations || [],
                flow_narration_detected: guard.flow_narration_detected === true,
                repeated_fact_detected: guard.repeated_fact_detected === true,
                ungrounded_output_detected: guard.ungrounded_output_detected === true,
                unauthorized_stage_fact_detected: guard.unauthorized_stage_fact_detected === true,
                regeneration_attempt: attempts,
                regeneration_success: false,
                original_output: params.stageOutput.originalOutput || null,
                regenerated_output: regeneratedText,
                raw_model_output: params.stageOutput.rawModelOutput || params.stageOutput.originalOutput || null,
                final_personality_valid: false,
                logged_at: new Date().toISOString(),
            },
        }).catch(() => {});
    }

    await logLeadRuntimeEvent({
        supabase: params.supabase,
        tenantId: params.tenantId,
        leadId: params.leadId,
        eventType: 'test_personality_guard_limit',
        payload: {
            stage: params.currentSubagent,
            etapa_atual: params.currentStage,
            personality_guard_triggered: true,
            personality_violations: lastResult.violations || [],
            regeneration_attempt: maxRegenerations,
            regeneration_success: false,
            final_personality_valid: lastResult.finalPersonalityValid === true,
            logged_at: new Date().toISOString(),
        },
    }).catch(() => {});

    params.stageOutput.finalOutputSource = 'safe_failure';
    return lastResult;
}

function extractCourseStateSnapshot(leadSnapshot: Record<string, unknown> | null | undefined) {
    const salesContext = { ...((leadSnapshot?.sales_context || {}) as Record<string, unknown>) };
    return {
        current_course: String(leadSnapshot?.curso_interesse || '').trim() || null,
        course_status: String(salesContext.course_status || '').trim() || null,
        selected_line: String(salesContext.linha_formacao || '').trim() || null,
        requested_area: String(salesContext.requested_area_name || '').trim() || null,
        related_area_courses: Array.isArray(salesContext.related_area_courses) ? salesContext.related_area_courses : [],
    };
}

function preserveCourseStateForContextualPatch(params: {
    previousLeadSnapshot: Record<string, unknown> | null | undefined;
    patch: Record<string, unknown>;
    explicitNewCourseIntent: boolean;
    authorizedCourseChange?: boolean;
}) {
    const nextPatch = { ...(params.patch || {}) };
    const previous = extractCourseStateSnapshot(params.previousLeadSnapshot);
    const candidateCourseStatus = String(nextPatch.course_status || '').trim() || null;
    const mutationAllowed = params.explicitNewCourseIntent
        || params.authorizedCourseChange === true
        || (previous.course_status === 'ambiguous_available' && candidateCourseStatus === 'confirmed_available');

    if (!mutationAllowed) {
        if (previous.course_status) nextPatch.course_status = previous.course_status;
        if (previous.selected_line) nextPatch.linha_formacao = previous.selected_line;
        if (previous.requested_area) nextPatch.requested_area_name = previous.requested_area;
        if (Array.isArray(previous.related_area_courses)) nextPatch.related_area_courses = previous.related_area_courses;
        if (previous.current_course && !nextPatch.curso_interesse) nextPatch.curso_interesse = previous.current_course;
        if (previous.course_status === 'confirmed_available') {
            nextPatch.course_validated = true;
            nextPatch.line_selection_required = false;
        }
    }

    return {
        patch: nextPatch,
        courseStatusBefore: previous.course_status,
        courseStatusCandidate: candidateCourseStatus,
        stateMutationAllowed: mutationAllowed,
        stateInvariantViolation: Boolean(
            previous.course_status === 'confirmed_available'
            && !params.explicitNewCourseIntent
            && candidateCourseStatus
            && candidateCourseStatus !== 'confirmed_available'
        ),
        selectedLineBefore: previous.selected_line,
        requestedAreaBefore: previous.requested_area,
    };
}

export function mentionsEarlyStageCourseDetails(text: string | undefined) {
    const normalized = normalizeText(text || '');
    if (!normalized) return false;

    return textIncludesAny(normalized, [
        'modalidade',
        'ead',
        'semipresencial',
        'presencial',
        'duracao',
        'duraçao',
        'duração',
        'semestres',
        'anos',
        'grade',
        'disciplinas',
        'areas de atuacao',
        'áreas de atuação',
        'mercado',
        'metodologia',
        'encontros presenciais',
        'funcionamento das aulas',
        'instituicao',
        'instituição',
        'suporte academico',
        'suporte acadêmico',
        'estrutura',
        'preco',
        'preço',
        'bolsa',
        'desconto',
        'condicao comercial',
        'condição comercial',
    ]);
}

export function buildE1AskCityFallback(course: string) {
    const courseLabel = String(course || 'esse curso').trim();
    return `${courseLabel} faz bastante sentido para muita gente que busca esse caminho.\n\nMe diz só de qual cidade você fala?`;
}

function buildAreaCourseSelectionFallback(params: { requestedArea: string; courses: unknown[] }) {
    const area = String(params.requestedArea || '').trim();
    const courses = Array.from(new Set((params.courses || [])
        .map((course) => getCourseDisplayName(String(course || '').trim()) || String(course || '').trim())
        .filter(Boolean)));
    if (!area || courses.length === 0) return '';
    return [
        `Encontrei algumas opcoes dentro de ${area} que podem combinar com o que voce procura.`,
        `*${area}*`,
        courses.map((course) => `- ${course}`).join('\n'),
        'Qual delas mais faz sentido para voce?',
    ].join('\n\n');
}

function buildE1CourseLineFallback(course: string, availableLines: unknown[]) {
    const courseLabel = getCourseDisplayName(String(course || '').trim()) || String(course || 'esse curso').trim();
    const lines = (availableLines || [])
        .map((line) => String(line || '').trim())
        .filter(Boolean);
    const renderedLines = lines.map((line) => `- ${line}`).join('\n');
    return [
        `${courseLabel} está disponível por aqui em mais de uma linha.`,
        `*${courseLabel}*`,
        renderedLines,
        'Qual linha você pretende seguir?',
    ].filter(Boolean).join('\n\n');
}

export function buildE1AskMotivationFallback(course: string) {
    const courseLabel = String(course || 'esse curso').trim();
    return `Faz sentido você olhar para ${courseLabel}.\n\nAgora me conta: você já trabalha na área ou isso representa um sonho ou objetivo pessoal para você?`;
}

function buildE2AvailabilityFallback() {
    return 'Antes de eu seguir, preciso alinhar uma coisa com você.\n\nTem alguma viagem mais longa ou mudança planejada que possa atrapalhar seu início?';
}

function buildE2DecisionFallback() {
    return 'Perfeito.\n\nNuma decisão como essa, você costuma decidir sozinho ou conversa com alguém antes?';
}


function detectLineFormationReply(history: Array<{ role?: string; content?: string }>, latestUserMessage: string) {
    const lastAssistant = [...(history || [])]
        .reverse()
        .find((item) => item?.role === 'assistant')?.content || '';
    const lastAssistantNormalized = normalizeText(lastAssistant);
    if (!lastAssistantNormalized.includes('qual linha')) return '';

    const normalized = normalizeText(latestUserMessage);
    if (!normalized) return '';
    if (normalized.includes('licenciatura')) return 'Licenciatura';
    if (normalized.includes('bacharelado')) return 'Bacharelado';
    if (textIncludesAny(normalized, [
        'quero dar aula',
        'quero ser professor',
        'quero ensinar',
        'quero trabalhar em escola',
        'seguir na docencia',
        'seguir na docência',
    ])) {
        return 'Licenciatura';
    }
    return '';
}

async function persistE1ContextualLeadData(params: {
    supabase: any;
    leadId: string;
    history: Array<{ role?: string; content?: string }>;
    latestUserMessage: string;
}) {
    const replyKind = detectContextualReplyKind(params.latestUserMessage, params.history);
    const currentLead = await params.supabase
        .from('leads')
        .select('cidade, sales_context, curso_interesse')
        .eq('id', params.leadId)
        .maybeSingle();

    const salesContext = { ...(currentLead.data?.sales_context || {}) } as Record<string, unknown>;
    const currentCity = String(currentLead.data?.cidade || '').trim();
    const lineFormation = detectLineFormationReply(params.history, params.latestUserMessage);
    const patch: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };

    let changed = false;

    if (replyKind === 'city' && !currentCity) {
        patch.cidade = params.latestUserMessage.trim();
        salesContext.e1_city_confirmed = true;
        changed = true;
    }

    if (replyKind === 'motivation' && !String(salesContext.motivacao_principal || '').trim()) {
        salesContext.motivacao_principal = params.latestUserMessage.trim();
        changed = true;
    }

    if (lineFormation && String(salesContext.linha_formacao || '').trim() !== lineFormation) {
        salesContext.linha_formacao = lineFormation;
        salesContext.line_selection_required = false;
        if (String(currentLead.data?.curso_interesse || '').trim()) {
            salesContext.course_validated = true;
        }
        changed = true;
    }

    if (changed) {
        patch.sales_context = salesContext;
        await params.supabase
            .from('leads')
            .update(patch)
            .eq('id', params.leadId);
    }
}

function shouldForceAdvanceFromE1(params: {
    leadSnapshot: Record<string, unknown> | null | undefined;
}) {
    return derivePendingCriterion({
        stage: 'E1',
        leadSnapshot: params.leadSnapshot,
        history: [],
    }) === null;
}

function latestAssistantMessage(history: Array<{ role?: string; content?: string }>) {
    return [...(history || [])].reverse().find((item) => item?.role === 'assistant')?.content || '';
}

function latestUserMessage(history: Array<{ role?: string; content?: string }>) {
    return [...(history || [])].reverse().find((item) => item?.role === 'user')?.content || '';
}

function buildE1CompletionFallback(params: {
    latestUserMessage: string;
    courseName?: string | null;
}) {
    const normalized = normalizeText(params.latestUserMessage || '');
    const courseChunk = String(params.courseName || '').trim() ? ` de ${String(params.courseName || '').trim()}` : '';

    if (textIncludesAny(normalized, ['ja trabalho', 'trabalho na area', 'atuo na area'])) {
        return `Que legal saber que voce ja trabalha na area${courseChunk}!`;
    }

    if (textIncludesAny(normalized, ['sonho', 'objetivo'])) {
        return `Que bom saber que essa graduacao${courseChunk} faz sentido para voce!`;
    }

    return 'Perfeito!';
}

function buildE2CompletionFallback() {
    return 'Perfeito, combinado!';
}

function extractModelCompletionAcknowledgement(text: string | undefined) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const firstBlock = raw.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) || '';
    const normalized = normalizeText(firstBlock);
    if (!firstBlock || firstBlock.includes('?')) return '';
    if (textIncludesAny(normalized, [
        'qual ',
        'quais ',
        'cursos',
        'opcoes',
        'opcoes',
        'cidade',
        'combinado',
        'inscricao',
        'lista',
    ])) return '';
    if (/^\s*[-*•·]/.test(firstBlock)) return '';
    return firstBlock;
}

function splitValidatedE3Blocks(text: string | undefined) {
    const blocks = String(text || '')
        .split(/\n\s*---\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
    return [3, 4].includes(blocks.length) ? blocks : [String(text || '').trim()].filter(Boolean);
}

function sanitizeBlockedE3AdvanceText(text: string | undefined) {
    const raw = String(text || '').trim();
    if (!raw) return raw;

    const normalized = normalizeText(raw);
    if (!textIncludesAny(normalized, ['agora posso te mostrar', 'condicoes de matricula', 'condicoes de matricula e valores', 'valores para voce planejar'])) {
        return raw;
    }

    const parts = raw
        .split(/\n---\n/)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => {
            const normalizedPart = normalizeText(part);
            return !textIncludesAny(normalizedPart, [
                'agora posso te mostrar',
                'condicoes de matricula',
                'condicoes de matricula e valores',
                'valores para voce planejar',
            ]);
        });

    return parts.join('\n---\n').trim() || raw;
}

function textMentionsPricesOrDiscounts(text: string | undefined) {
    const normalized = normalizeText(text || '');
    return textIncludesAny(normalized, [
        'r$',
        'reais',
        'mensalidade',
        'valor',
        'valores',
        'preco',
        'preços',
        'precos',
        'desconto',
        'parcela',
    ]) || /\b\d{2,4}(?:[.,]\d{2})?\b/.test(String(text || ''));
}

function buildE3AdvanceToE4Fallback() {
    return 'Perfeito.\n\nPara eu preparar sua proposta com as informacoes e condicoes da bolsa de estudos, me passa seu nome completo, por gentileza?';
}

function looksLikePhoneReply(message: string) {
    const normalized = String(message || '').replace(/\s+/g, '');
    return PHONE_LIKE.test(normalized.replace(/[^\d+]/g, ''));
}

function looksLikePersonNameReply(message: string) {
    const normalized = normalizeText(message);
    if (!normalized || normalized.length < 5) return false;
    if (looksLikePhoneReply(message)) return false;

    if (textIncludesAny(normalized, ['sim', 'nao', 'claro', 'com certeza', 'recomendo', 'recomendaria', 'ninguem', 'hoje', 'segunda'])) return false;
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;

    return words.every((word) => /^[a-z]+$/i.test(word));
}

function extractFullNameCandidate(message: string) {
    const raw = String(message || '').trim();
    const cleaned = raw
        .replace(/^(meu\s+nome\s+completo\s+(?:e|é)\s+)/i, '')
        .replace(/^(meu\s+nome\s+(?:e|é)\s+)/i, '')
        .replace(/^(sou\s+)/i, '')
        .trim();
    return cleaned || raw;
}

function buildE6PhoneFallback() {
    return 'Perfeito.\n\nAgora me passa o telefone dessa pessoa, por favor.';
}

function buildE6SatisfactionFallback() {
    return 'Antes de encerrarmos, me conta uma coisa: você gostou do atendimento?';
}

function buildE6RecommendationFallback() {
    return 'Fico muito feliz em saber disso!!\n\nVocê recomendaria esse atendimento para outra pessoa?';
}

function userRecommendedService(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'sim',
        'gostei',
        'gostei bastante',
        'foi bom',
        'foi otimo',
        'foi ótimo',
        'recomendo',
        'recomendaria',
        'com certeza',
        'demais',
    ]);
}

function userDidNotRecommendService(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'nao',
        'não',
        'mais ou menos',
        'nem tanto',
        'prefiro nao',
        'prefiro não',
    ]);
}

function buildE6AskIndicationNameFallback() {
    return 'Que bom saber disso!!\n\nTem alguém próximo de você que também esteja pensando em começar uma graduação e que você gostaria de indicar?\n\nSe sim, me passa primeiro o nome dessa pessoa.';
}

function shouldRedirectE6NameToPhone(params: {
    recentUserMessages: string[];
    text: string | undefined;
}) {
    const latestUser = params.recentUserMessages.slice(-1)[0] || '';
    if (!looksLikePersonNameReply(latestUser)) return false;

    const normalizedText = normalizeText(params.text || '');
    return textIncludesAny(normalizedText, [
        'qual area',
        'qual curso',
        'tem interesse em fazer',
        'melhor opcao para ele',
    ]);
}

function buildE7ClosingFallback(indicatedName: string) {
    const safeName = indicatedName || 'a pessoa que você indicou';
    return `Perfeito!! Se puder, avise ${safeName} que alguém aqui da instituição poderá entrar em contato para apresentar melhor as possibilidades de graduação. Assim, essa pessoa já sabe de onde veio o contato.\n\nFoi um prazer enorme acompanhar você até aqui!! Te desejo muito sucesso nessa nova fase e que essa graduação seja o começo de muita coisa boa para você.`;
}

function textAsksIndicatedCourseDetails(text: string | undefined) {
    const normalized = normalizeText(text || '');
    return textIncludesAny(normalized, [
        'qual area',
        'qual curso',
        'tem interesse em fazer',
        'melhor opcao para ele',
        'melhor opcao para ela',
        'se quiser posso sugerir',
    ]);
}

function latestIndicatedName(history: Array<{ role?: string; content?: string }>, recentUserMessages: string[]) {
    const recent = recentUserMessages
        .slice()
        .reverse()
        .find((message) => looksLikePersonNameReply(message));
    if (recent) return recent.trim();

    const fromHistory = [...(history || [])]
        .reverse()
        .find((item) => item?.role === 'user' && looksLikePersonNameReply(item?.content || ''))?.content || '';

    return String(fromHistory || '').trim();
}

function filterAdvanceToolCalls(toolCalls: any[] | undefined) {
    return (toolCalls || []).filter((call: any) => call?.name !== 'avancar_etapa');
}

function filterKnowledgeToolCalls(toolCalls: any[] | undefined) {
    return (toolCalls || []).filter((call: any) => call?.name !== 'consultar_conhecimento');
}

function filterHandoffToolCalls(toolCalls: any[] | undefined) {
    return (toolCalls || []).filter((call: any) => call?.name !== 'acionar_handoff');
}

function countQuestions(text: string | undefined) {
    return (String(text || '').match(/\?/g) || []).length;
}

function hasRepeatedExplicitSegments(text: string | undefined) {
    const parts = String(text || '')
        .split(/\n---\n/)
        .map((part) => part.trim())
        .filter(Boolean);

    return uniqueNormalizedParts(parts).length < parts.length;
}

function shouldSanitizeE2HandoffOutput(text: string | undefined) {
    return countQuestions(text) > 1 || String(text || '').includes('\n---\n') || hasRepeatedExplicitSegments(text);
}

function buildE2StageHandoffFallback() {
    return 'Antes de eu te apresentar os proximos passos, deixa eu alinhar uma coisa com voce.\n\nSe eu te mostrar uma condicao que faca sentido para a sua realidade, voce topa seguir comigo ate a inscricao?';
}

function shouldSanitizeE4FinancialOutput(text: string | undefined) {
    const normalized = normalizeText(text || '');
    return countQuestions(text) > 1
        || String(text || '').includes('\n---\n')
        || hasRepeatedExplicitSegments(text)
        || (normalized.includes('especialista financeiro') && normalized.split('especialista financeiro').length > 2)
        || (normalized.includes('condicoes financeiras') && normalized.split('condicoes financeiras').length > 2);
}

function buildE4FinancialFallback(course: string, city: string) {
    const courseLabel = course || 'essa graduacao';
    const cityLabel = city ? ` em ${city}` : '';
    return `Perfeito.\n\nAgora vamos falar somente das condicoes para ${courseLabel}${cityLabel}, sem voltar para perguntas de etapas anteriores.\n\nSe voce quiser seguir, eu continuo daqui com a parte financeira e de matricula.`;
}

function looksLikeFullName(message: string) {
    const normalized = normalizeText(message);
    if (!normalized || looksLikePhoneReply(message)) return false;
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 5) return false;
    return words.every((word) => /^[a-z]+$/i.test(word) && word.length >= 2);
}

function assistantAskedProposalNameQuestion(history: Array<{ role?: string; content?: string }>) {
    const normalized = normalizeText(latestAssistantMessage(history));
    return textIncludesAny(normalized, [
        'nome completo',
        'apenas um documento',
        'nao gera compromisso',
        'informacoes e condicoes da bolsa',
    ]);
}

function buildE4ProposalRequestFallback() {
    return 'Antes de eu te mostrar essa proposta, preciso do seu nome completo.\n\nE fica tranquilo: isso nao gera nenhum compromisso. E so para eu te enviar um documento com as informacoes e as condicoes da bolsa de estudos.';
}

function buildE4ProposalPauseFallback() {
    return 'Perfeito.\n\nVou organizar esse documento para voce agora e, assim que ele estiver pronto, continuo daqui com voce.';
}

function buildE4EnrollmentPauseFallback() {
    return 'Perfeito.\n\nVou encaminhar a sua matricula para conclusao agora e, assim que estiver liberado por aqui, eu continuo com voce.';
}

function extractRecentUserMessages(
    history: Array<{ role?: string; content?: string }>,
    fallback: string[] = [],
) {
    const fromHistory = (history || [])
        .filter((item) => item?.role === 'user')
        .map((item) => String(item?.content || '')
            .replace(/^\s*\[\u00c1udio transcrito\]\s*/i, '')
            .replace(/^\s*\[Audio transcrito\]\s*/i, '')
            .trim())
        .filter(Boolean)
        .slice(-4);

    return (fromHistory.length > 0 ? fromHistory : fallback).slice(-4);
}

function userConfirmedHighSchool(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'ja conclui o ensino medio',
        'conclui o ensino medio',
        'terminei o ensino medio',
        'estou concluindo o ensino medio',
    ]);
}

function userRequestedEnrollment(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'quero seguir para a matricula',
        'quero seguir pra matricula',
        'quero me matricular',
        'quero fazer a matricula',
        'quero fazer minha matricula',
        'pode me mandar o link de pagamento',
        'quero garantir minha vaga',
        'vamos fechar',
        'seguir para a inscricao',
    ]);
}

function isE4PostProposalObjection(message: string, intelligence: Record<string, unknown> | null | undefined) {
    const intent = String(intelligence?.intent || '').trim();
    const objection = String(intelligence?.primary_objection || 'none').trim();
    if (['objection', 'price', 'question', 'human_help'].includes(intent) || objection !== 'none') return true;

    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'nao consigo', 'nao posso', 'nao vou conseguir', 'nao tenho certeza',
        'preciso pensar', 'quero pensar', 'tenho uma duvida', 'tenho uma d�vida',
        'quanto custa', 'qual o valor', 'mensalidade', 'esta caro',
    ]);
}

function getE4EndOfDayDeadline(businessHours: Record<string, unknown> | null | undefined) {
    const tz = String(businessHours?.tz || 'America/Sao_Paulo');
    const end = String(businessHours?.end || '22:00');
    const [endHour, endMinute] = end.split(':').map(Number);
    const now = new Date();
    const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const timeParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const readPart = (parts: Intl.DateTimeFormatPart[], type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    let localDate = new Date(Date.UTC(readPart(dateParts, 'year'), readPart(dateParts, 'month') - 1, readPart(dateParts, 'day')));
    const currentMinutes = readPart(timeParts, 'hour') * 60 + readPart(timeParts, 'minute');
    if (currentMinutes >= endHour * 60 + endMinute) localDate.setUTCDate(localDate.getUTCDate() + 1);

    const targetYear = localDate.getUTCFullYear();
    const targetMonth = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const targetDay = String(localDate.getUTCDate()).padStart(2, '0');
    const guess = new Date(Date.UTC(targetYear, localDate.getUTCMonth(), localDate.getUTCDate(), endHour, endMinute));
    const offsetPart = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(guess).find((part) => part.type === 'timeZoneName')?.value || 'GMT-03:00';
    const offset = offsetPart.replace('GMT', '') || '-03:00';
    return new Date(`${targetYear}-${targetMonth}-${targetDay}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00${offset}`).toISOString();
}

async function scheduleE4ProposalCommitmentFollowup(params: {
    supabase: any;
    tenantId: string;
    leadId: string;
    context: Record<string, unknown>;
}) {
    const { data: priorSchedules, error: schedulesError } = await params.supabase
        .from('followup_schedule').select('attempt').eq('lead_id', params.leadId)
        .order('attempt', { ascending: false }).limit(1);
    if (schedulesError) throw new Error(`Erro ao ler tentativas de follow-up: ${schedulesError.message}`);

    const attempt = Math.max(1, Number(priorSchedules?.[0]?.attempt || 0) + 1);
    const { error } = await params.supabase.from('followup_schedule').insert({
        lead_id: params.leadId,
        tenant_id: params.tenantId,
        attempt,
        max_attempts: attempt,
        schedule_at: params.context.response_deadline,
        trigger_reason: 'e4_proposal_commitment',
        last_context: params.context,
        status: 'pending',
    });
    if (error) throw new Error(`Erro ao agendar retorno da proposta: ${error.message}`);
}

function userConfirmedPayment(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'ja paguei',
        'paguei a matricula',
        'pix realizado',
        'pagamento feito',
        'ja fiz o pagamento',
    ]);
}

function userMentionedIndicationIntent(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'posso indicar',
        'quero indicar',
        'tenho uma indicacao',
        'tenho uma pessoa para indicar',
    ]);
}

function userDeclinedIndication(message: string) {
    const normalized = normalizeText(message);
    return textIncludesAny(normalized, [
        'nao tenho ninguem',
        'nao tenho ninguém',
        'nao tenho indicacao',
        'nao tenho indicação',
        'nao lembro de ninguem',
        'sem indicacao',
        'sem indicação',
        'ninguem para indicar',
        'ninguém para indicar',
        'nao no momento',
    ]);
}

function textRequestsHighSchool(text: string | undefined) {
    return textIncludesAny(normalizeText(text || ''), [
        'ensino medio',
        'concluiu o ensino medio',
        'concluindo o ensino medio',
    ]);
}

function textRequestsModality(text: string | undefined) {
    return textIncludesAny(normalizeText(text || ''), [
        'modalidade',
        'interesse em ead',
        'prefere a modalidade',
        'semipresencial ou',
        'ead tambem',
    ]);
}

function textRequestsPaymentDetails(text: string | undefined) {
    return textIncludesAny(normalizeText(text || ''), [
        'qual foi o valor pago',
        'forma de pagamento',
        'cartao boleto ou pix',
        'valor que foi pago',
    ]);
}

function buildE4PriceGuardFallback(course: string, city: string) {
    const courseLabel = course || 'essa graduacao';
    const cityLabel = city ? ` em ${city}` : '';
    return `Perfeito.\n\nEstou seguindo com as condicoes de matricula para ${courseLabel}${cityLabel} e vou manter a conversa focada nisso, sem voltar para perguntas de qualificacao que ja ficaram para tras.`;
}

function buildE5PaymentGuardFallback() {
    return 'Perfeito.\n\nPara eu validar sua matricula sem te prender em perguntas paralelas, me confirme apenas duas coisas: qual foi o valor pago e qual foi a forma de pagamento.';
}

function findLatestPaymentConfirmation(history: Array<{ role?: string; content?: string }>, fallback: string[]) {
    const recent = extractRecentUserMessages(history, fallback).slice().reverse();
    return recent.find((message) => userConfirmedPayment(message)) || '';
}

function hasVerifiedPaymentState(leadSnapshot: Record<string, unknown> | null | undefined) {
    const salesContext = { ...(leadSnapshot?.sales_context || {}) } as Record<string, unknown>;
    return salesContext.payment_confirmed === true || leadSnapshot?.matriculado === true;
}

function buildE5PaymentDeclaredFallback() {
    return 'Perfeito.\n\nAssim que essa confirmacao aparecer por aqui, eu sigo com voce sem te fazer voltar no processo.';
}

function buildE5BoletoQuestionFallback() {
    return 'Parabens por concluir a matricula.\n\nPara o boleto de matricula, voce prefere que ele seja gerado para hoje ou para a proxima segunda-feira?';
}

function buildE5BoletoTodayFallback() {
    return 'Perfeito.\n\nEntao vamos gerar o boleto para hoje.';
}

function buildE5BoletoNextMondayFallback() {
    return 'Perfeito.\n\nEntao vamos gerar o boleto para a proxima segunda-feira.';
}

function buildE5BoletoCustomDateFallback(label: string) {
    return `Perfeito.\n\nEntao no dia ${label} vamos enviar o boleto para voce.`;
}

function textAsksBoletoDate(text: string | undefined) {
    return textIncludesAny(normalizeText(text || ''), [
        'boleto',
        'hoje',
        'proxima segunda',
        'próxima segunda',
    ]);
}

function buildE6NoIndicationFallback() {
    return 'Tranquilo!!';
}

function buildE7NoIndicationClosingFallback() {
    return 'Foi um prazer enorme acompanhar você até aqui!!\n\nTe desejo muito sucesso nessa nova fase e que essa graduação seja o começo de muita coisa boa para você.';
}

function detectBoletoDateChoice(message: string) {
    const normalized = normalizeText(message);
    if (!normalized) return null;
    if (textIncludesAny(normalized, ['hoje', 'ainda hoje'])) {
        return { kind: 'today', label: 'hoje' };
    }
    if (textIncludesAny(normalized, ['segunda'])) {
        return { kind: 'next_monday', label: 'proxima segunda-feira' };
    }
    if (textIncludesAny(normalized, ['proxima segunda', 'próxima segunda', 'segunda-feira'])) {
        return { kind: 'next_monday', label: 'proxima segunda-feira' };
    }

    const dayMonth = message.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (dayMonth) {
        return { kind: 'custom', label: dayMonth[0] };
    }

    const textual = message.match(/\b(\d{1,2})\s+de\s+([a-zç]+)\b/i);
    if (textual) {
        return { kind: 'custom', label: textual[0] };
    }

    return null;
}

async function readLeadSalesContext(supabase: any, leadId: string) {
    const { data } = await supabase
        .from('leads')
        .select('sales_context')
        .eq('id', leadId)
        .maybeSingle();

    return { ...(data?.sales_context || {}) } as Record<string, unknown>;
}

function normalizeLeadCityValue(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    return raw
        .replace(/^sou de\s+/i, '')
        .replace(/^moro em\s+/i, '')
        .replace(/^resido em\s+/i, '')
        .replace(/^sou do\s+/i, '')
        .replace(/^sou da\s+/i, '')
        .trim() || null;
}

async function mergeLeadSalesContext(supabase: any, leadId: string, patch: Record<string, unknown>) {
    const current = await readLeadSalesContext(supabase, leadId);
    const next = { ...current, ...patch };

    if (Object.prototype.hasOwnProperty.call(next, 'cidade')) {
        next.cidade = normalizeLeadCityValue(next.cidade);
    }

    Object.keys(next).forEach((key) => {
        if (next[key] === undefined) delete next[key];
    });

    const leadPatch: Record<string, unknown> = {
        sales_context: next,
        updated_at: new Date().toISOString(),
    };

    if (Object.prototype.hasOwnProperty.call(patch, 'cidade')) {
        leadPatch.cidade = normalizeLeadCityValue(patch.cidade);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'curso_interesse')) {
        leadPatch.curso_interesse = patch.curso_interesse || null;
    }

    await supabase
        .from('leads')
        .update(leadPatch)
        .eq('id', leadId);

    return next;
}

async function sendInitialE1WelcomeSequence(params: {
    supabase: any;
    env: Record<string, string>;
    tenantId: string;
    leadId: string;
    telefone: string;
    leadSnapshot: Record<string, unknown> | null | undefined;
    runtimeConfig: Record<string, unknown>;
    firstInboundHasCommercialIntent: boolean;
}) {
    const currentContext = await readLeadSalesContext(params.supabase, params.leadId);
    const expectedCount = resolveInitialE1WelcomeMessageCount({
        salesContext: currentContext,
        firstInboundHasCommercialIntent: params.firstInboundHasCommercialIntent,
    });
    const messages = buildInitialE1WelcomeMessages({
        leadSnapshot: params.leadSnapshot,
        messagePolicy: params.runtimeConfig?.messagePolicy || {},
        timeZone: params.runtimeConfig?.businessHours?.tz || 'America/Porto_Velho',
    }).slice(0, expectedCount);
    const sentIndexes = new Set(
        (Array.isArray(currentContext.initial_welcome_sent_indexes)
            ? currentContext.initial_welcome_sent_indexes
            : [])
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0),
    );
    const senderUrl = `${params.env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
    const sentNow: number[] = [];

    await mergeLeadSalesContext(params.supabase, params.leadId, {
        initial_welcome_status: 'in_progress',
        initial_welcome_expected_count: expectedCount,
        initial_welcome_first_inbound_had_commercial_intent: params.firstInboundHasCommercialIntent,
        initial_welcome_started_at: currentContext.initial_welcome_started_at || new Date().toISOString(),
    });

    for (let i = 0; i < messages.length; i += 1) {
        if (sentIndexes.has(i)) continue;

        const sendRes = await fetch(senderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({
                lead_id: params.leadId,
                telefone: params.telefone,
                text: messages[i],
                subagente_usado: 'E1',
                iteracoes: 0,
                tool_calls: [],
                skip_governance: true,
                skip_takeover: true,
            }),
        });

        const sendData = await sendRes.json().catch(() => ({}));
        if (!sendRes.ok || sendData?.ok === false) {
            await logLeadRuntimeEvent({
                supabase: params.supabase,
                tenantId: params.tenantId,
                leadId: params.leadId,
                eventType: 'test_initial_welcome_failed',
                payload: {
                    message_index: i,
                    status: sendRes.status,
                    sender_error: sendData?.first_error || sendData?.error || null,
                    sent_indexes: [...sentIndexes],
                    failed_at: new Date().toISOString(),
                },
            }).catch(() => {});

            throw new Error(`Falha ao enviar abertura E1 mensagem ${i + 1}`);
        }

        sentIndexes.add(i);
        sentNow.push(i);
        await mergeLeadSalesContext(params.supabase, params.leadId, {
            initial_welcome_status: 'in_progress',
            initial_welcome_sent_indexes: [...sentIndexes].sort(),
        });
    }

    const completed = messages.every((_, index) => sentIndexes.has(index));
    if (completed) {
        await mergeLeadSalesContext(params.supabase, params.leadId, {
            initial_welcome_status: 'completed',
            initial_welcome_expected_count: expectedCount,
            initial_welcome_sent_indexes: [...sentIndexes].sort(),
            initial_greeting_completed_at: new Date().toISOString(),
            pending_criterion: params.firstInboundHasCommercialIntent ? currentContext.pending_criterion : null,
            last_agent_question_type: params.firstInboundHasCommercialIntent ? currentContext.last_agent_question_type : null,
        });
    }

    await logLeadRuntimeEvent({
        supabase: params.supabase,
        tenantId: params.tenantId,
        leadId: params.leadId,
        eventType: 'test_initial_welcome_sequence',
        payload: {
            messages,
            sent_now: sentNow,
            sent_indexes: [...sentIndexes].sort(),
            completed,
            skip_governance: true,
            subagent_bypassed: true,
            stage_state_bypassed: true,
            logged_at: new Date().toISOString(),
        },
    }).catch(() => {});

    return { messages, sentNow, completed };
}

async function clearInvalidHandoff(supabase: any, leadId: string, etapaDestino: string) {
    await supabase
        .from('leads')
        .update({
            bloqueado: false,
            handoff_em: null,
            etapa_atual: etapaDestino,
            updated_at: new Date().toISOString(),
        })
        .eq('id', leadId);
}

serve(async (req) => {
    const env = Object.fromEntries(Object.entries(Deno.env.toObject()));
    const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

    let msg = null;
    let payload = null;
    let generationClaimAlreadyAcquired = false;

    try {
        if (req.method === 'POST') {
            const body = await req.json().catch(() => null);
            if (body?.lead_id) {
                payload = body;
            }
        }
    } catch (_) {}

    if (!payload) {
        let lastScanPayload: any = null;
        const { data: msgs } = await readMessage(supabase, Q_AI, 30, MAX_QUEUE_SCAN);
        if (!msgs?.length) {
            console.log('[ai-processor] fila vazia');
            return new Response(JSON.stringify({ status: 'empty', queue_scan_attempts: 0 }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        for (let attempt = 1; attempt <= msgs.length; attempt += 1) {
            const candidateMsg = msgs[attempt - 1];
            const candidatePayload = candidateMsg.message || {};
            lastScanPayload = candidatePayload;
            const jobState = await classifyQueueJob({ supabase, payload: candidatePayload });

            await logLeadRuntimeEvent({
                supabase,
                tenantId: candidatePayload.tenant_id,
                leadId: candidatePayload.lead_id,
                eventType: attempt === 1 ? 'test_queue_scan_started' : 'test_queue_scan_attempt',
                payload: {
                    queue_scan_attempt: attempt,
                    queue_msg_id: candidateMsg.msg_id,
                    queue_job_classification: jobState.classification,
                    skip_reason: jobState.skipReason,
                    job_lead_id: candidatePayload.lead_id || null,
                    job_debounce_group_id: candidatePayload.debounce_group_id || null,
                    job_generation_key: candidatePayload.outbound_generation_key || null,
                    claim_status: jobState.claimStatus,
                    processing_status: jobState.processingStatus,
                    job_acknowledged: false,
                    job_deleted: false,
                    job_requeued: false,
                    next_job_attempted: false,
                    scanned_at: new Date().toISOString(),
                },
            }).catch(() => {});

            if (!jobState.processable) {
                if (jobState.acknowledge) {
                    await markDebounceGroupStatus({
                        supabase,
                        debounceGroupId: candidatePayload.debounce_group_id || null,
                        status: 'skipped',
                    }).catch(() => null);
                    await deleteMessage(supabase, Q_AI, candidateMsg.msg_id).catch(() => null);
                }
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: candidatePayload.tenant_id,
                    leadId: candidatePayload.lead_id,
                    eventType: 'test_queue_job_skipped',
                    payload: {
                        queue_scan_attempt: attempt,
                        queue_msg_id: candidateMsg.msg_id,
                        queue_job_classification: jobState.classification,
                        skip_reason: jobState.skipReason,
                        job_lead_id: candidatePayload.lead_id || null,
                        job_debounce_group_id: candidatePayload.debounce_group_id || null,
                        job_generation_key: candidatePayload.outbound_generation_key || null,
                        claim_status: jobState.claimStatus,
                        processing_status: jobState.processingStatus,
                        job_acknowledged: jobState.acknowledge === true,
                        job_deleted: jobState.acknowledge === true,
                        job_requeued: jobState.acknowledge !== true,
                        next_job_attempted: attempt < msgs.length,
                        skipped_at: new Date().toISOString(),
                    },
                }).catch(() => {});
                continue;
            }

            const generationKey = String(candidatePayload.outbound_generation_key || '').trim();
            if (generationKey) {
                generationClaimAlreadyAcquired = await claimOutboundGeneration({
                    supabase,
                    generationKey,
                    tenantId: candidatePayload.tenant_id,
                    leadId: candidatePayload.lead_id,
                    debounceGroupId: candidatePayload.debounce_group_id || null,
                    processingJobId: candidatePayload.processing_job_id || null,
                }).catch(() => false);

                if (!generationClaimAlreadyAcquired) {
                    await logLeadRuntimeEvent({
                        supabase,
                        tenantId: candidatePayload.tenant_id,
                        leadId: candidatePayload.lead_id,
                        eventType: 'test_queue_job_skipped',
                        payload: {
                            queue_scan_attempt: attempt,
                            queue_msg_id: candidateMsg.msg_id,
                            queue_job_classification: 'duplicate_after_claim_race',
                            skip_reason: 'claim_failed_after_scan',
                            job_lead_id: candidatePayload.lead_id || null,
                            job_debounce_group_id: candidatePayload.debounce_group_id || null,
                            job_generation_key: generationKey,
                            claim_status: 'claim_failed',
                            processing_status: jobState.processingStatus,
                            job_acknowledged: false,
                            job_deleted: false,
                            job_requeued: true,
                            next_job_attempted: attempt < msgs.length,
                            skipped_at: new Date().toISOString(),
                        },
                    }).catch(() => {});
                    continue;
                }
            }

            msg = candidateMsg;
            payload = candidatePayload;
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_queue_scan_finished',
                payload: {
                    queue_scan_attempts: attempt,
                    processable_job_found: true,
                    queue_msg_id: msg.msg_id,
                    job_lead_id: payload.lead_id || null,
                    job_debounce_group_id: payload.debounce_group_id || null,
                    job_generation_key: payload.outbound_generation_key || null,
                    claim_status: generationClaimAlreadyAcquired ? 'claimed_by_this_invocation' : 'not_required',
                    processing_status: jobState.processingStatus,
                    finished_at: new Date().toISOString(),
                },
            }).catch(() => {});
            break;
        }

        if (!payload) {
            if (lastScanPayload?.tenant_id && lastScanPayload?.lead_id) {
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: lastScanPayload.tenant_id,
                    leadId: lastScanPayload.lead_id,
                    eventType: 'test_queue_scan_finished',
                    payload: {
                        queue_scan_attempts: msgs.length,
                        processable_job_found: false,
                        finished_reason: 'no_processable_job',
                        finished_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }
            return new Response(JSON.stringify({ status: 'empty', skipped: 'no_processable_job', queue_scan_attempts: msgs.length }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    console.log(`[ai-processor] processando lead ${payload.lead_id} etapa ${payload.etapa_atual}`);

    const trace = startTrace({
        service: 'ai-processor',
        spanName: 'process_message',
        tenantId: payload.tenant_id,
        conversationId: payload.lead_id,
        input: { etapa: payload.etapa_atual, trigger: payload.trigger },
    });

    try {
        const initialSubagent = routeByEtapa(payload.etapa_atual);
        console.log(`[ai-processor] subagente selecionado: ${initialSubagent}`);

        if (String(payload.outbound_generation_key || '').trim() && !generationClaimAlreadyAcquired) {
            const claimedGeneration = await claimOutboundGeneration({
                supabase,
                generationKey: String(payload.outbound_generation_key),
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                debounceGroupId: payload.debounce_group_id || null,
                processingJobId: payload.processing_job_id || null,
            }).catch(() => false);

            if (!claimedGeneration) {
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_outbound_generation_skipped',
                    payload: {
                        debounce_group_id: payload.debounce_group_id || null,
                        processing_job_id: payload.processing_job_id || null,
                        outbound_generation_key: payload.outbound_generation_key || null,
                        already_claimed: true,
                        skipped_at: new Date().toISOString(),
                    },
                }).catch(() => {});

                if (msg?.msg_id) {
                    await deleteMessage(supabase, Q_AI, msg.msg_id).catch(() => null);
                }

                return new Response(JSON.stringify({ ok: true, skipped: 'already_claimed' }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        try {
            await supabase.rpc('set_config', { setting: 'app.tenant_id', value: payload.tenant_id, is_local: true });
        } catch (_) {}

        const runtimeConfig = await loadTenantRuntimeConfig(supabase, payload.tenant_id, env);
        if (payload.debug_llm_trace === true && isLocalRuntimeUrl(env)) {
            runtimeConfig.env.DEBUG_LLM_TRACE = 'true';
        }
        const inboundMessageIds = Array.from(new Set((payload.inbound_message_ids ?? []).filter(Boolean)));
        if (inboundMessageIds.length > 0) {
            for (const messageId of inboundMessageIds) {
                const remoteJid = `${String(payload.telefone || '').replace(/^\+/, '')}@s.whatsapp.net`;
                const claimedReadReceipt = await claimReadReceipt({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    inboundMessageId: String(messageId),
                    remoteJid,
                }).catch(() => false);

                if (!claimedReadReceipt) {
                    await logLeadRuntimeEvent({
                        supabase,
                        tenantId: payload.tenant_id,
                        leadId: payload.lead_id,
                        eventType: 'test_read_receipt_skipped',
                        payload: {
                            inbound_message_id: String(messageId),
                            remote_jid: remoteJid,
                            already_claimed: true,
                            skipped_at: new Date().toISOString(),
                        },
                    }).catch(() => {});
                    continue;
                }

                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_read_receipt_attempted',
                    payload: {
                        inbound_message_id: String(messageId),
                        remote_jid: remoteJid,
                        attempted_at: new Date().toISOString(),
                    },
                }).catch(() => {});

                const readResult = await markMessageAsRead(runtimeConfig.evolution, payload.telefone, String(messageId)).catch((error) => ({
                    success: false,
                    routeUsed: null,
                    errorMessage: String(error),
                    routeAttempts: [],
                }));

                await completeReadReceipt({
                    supabase,
                    inboundMessageId: String(messageId),
                    success: readResult.success === true,
                    routeUsed: readResult.routeUsed || null,
                    errorMessage: readResult.errorMessage || null,
                }).catch(() => null);

                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: readResult.success === true ? 'test_read_receipt_success' : 'test_read_receipt_error',
                    payload: {
                        inbound_message_id: String(messageId),
                        remote_jid: remoteJid,
                        route_used: readResult.routeUsed || null,
                        route_attempts: Array.isArray(readResult.routeAttempts) ? readResult.routeAttempts : [],
                        read_receipt_success: readResult.success === true,
                        read_receipt_error: readResult.errorMessage || null,
                        finished_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }
        }
        const normalizeInboundUserText = (value: unknown) => String(value ?? '')
            .replace(/^\s*\[\u00c1udio transcrito\]\s*/i, '')
            .replace(/^\s*\[Audio transcrito\]\s*/i, '')
            .trim();
        let lastUserMessage = normalizeInboundUserText((payload.recent_user_messages ?? []).slice(-1)[0] ?? payload.text ?? '');
        await logLeadRuntimeEvent({
            supabase,
            tenantId: payload.tenant_id,
            leadId: payload.lead_id,
            eventType: 'test_ai_processor_started',
            payload: {
                etapa_atual: payload.etapa_atual,
                subagente_inicial: initialSubagent,
                trigger: payload.trigger,
                texto: payload.text ?? '',
                last_user_message: lastUserMessage,
                inbound_message_ids: payload.inbound_message_ids ?? [],
                debounce_group_id: payload.debounce_group_id ?? null,
                processing_job_id: payload.processing_job_id ?? null,
                outbound_generation_key: payload.outbound_generation_key ?? null,
                started_at: new Date().toISOString(),
            },
        }).catch(() => {});
        let historyText = (payload.history ?? [])
            .map((h: any) => `${h.role === 'user' ? 'Lead' : 'Helton'}: ${h.content ?? ''}`)
            .join('\n');
        const { data: leadSnapshot } = await supabase
            .from('leads')
            .select('nome, lead_person_name, lead_first_name, lead_name_confidence, lead_name_source, cidade, curso_interesse, dor_principal, valor_parcela, etapa_atual, matriculado, bloqueado, sales_context, proposta_enviada_em, pronto_matricula_em')
            .eq('id', payload.lead_id)
            .maybeSingle();
        const salesContextBeforeInbound = { ...(leadSnapshot?.sales_context || {}) };

        const pendingCheckpoint = await getPendingAdminCheckpoint(supabase, payload.lead_id).catch(() => null);
        if (pendingCheckpoint?.id) {
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_ai_skipped_pending_admin_checkpoint',
                payload: {
                    checkpoint_admin: pendingCheckpoint.checkpoint_admin,
                    etapa_pausada: pendingCheckpoint.etapa_pausada,
                    trigger: payload.trigger,
                    skipped_at: new Date().toISOString(),
                },
            }).catch(() => {});

            return new Response(JSON.stringify({
                ok: true,
                skipped: 'pending_admin_checkpoint',
                checkpoint_admin: pendingCheckpoint.checkpoint_admin,
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (shouldRunInitialE1Welcome({
            stage: payload.etapa_atual,
            history: payload.history ?? [],
            salesContext: leadSnapshot?.sales_context || {},
        })) {
            const firstInboundCatalogIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []);
            const firstInboundHasCommercialIntent = firstInboundCatalogIntent.matched === true
                && ['specific', 'specific_or_related'].includes(String(firstInboundCatalogIntent.mode || ''));
            const welcome = await sendInitialE1WelcomeSequence({
                supabase,
                env,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                telefone: payload.telefone,
                leadSnapshot,
                runtimeConfig,
                firstInboundHasCommercialIntent,
            });

            if (!firstInboundHasCommercialIntent) {
                if (msg?.msg_id) {
                    await markDebounceGroupStatus({
                        supabase,
                        debounceGroupId: payload.debounce_group_id || null,
                        status: 'processed',
                    }).catch(() => null);
                    await deleteMessage(supabase, Q_AI, msg.msg_id).catch(() => null);
                }
                return new Response(JSON.stringify({
                    status: 'ok',
                    skipped: 'initial_e1_welcome_sequence',
                    messages_sent: welcome.sentNow.length,
                    completed: welcome.completed,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        const latestSalesContextForNameGate = await readLeadSalesContext(supabase, payload.lead_id);
        Object.assign(salesContextBeforeInbound, latestSalesContextForNameGate);
        if (leadSnapshot) leadSnapshot.sales_context = latestSalesContextForNameGate;

        const persistedTrustedName = resolveTrustedLeadName({
            existingTrustedName: String(leadSnapshot?.lead_person_name || leadSnapshot?.nome || '').trim(),
        });
        const pendingPreNameInput = normalizeInboundUserText(salesContextBeforeInbound.pending_pre_name_input);
        const previousNameGateResolved = Boolean(String(salesContextBeforeInbound.pending_pre_name_resolved_at || '').trim());
        let trustedNameAlreadyPresent = Boolean(
            (
                String(leadSnapshot?.lead_name_confidence || '').trim().toLowerCase() === 'trusted'
                || previousNameGateResolved
            )
            && persistedTrustedName.leadNameUsed
            && String(persistedTrustedName.leadFirstName || '').trim()
        );
        if (
            trustedNameAlreadyPresent
            && previousNameGateResolved
            && String(leadSnapshot?.lead_name_confidence || '').trim().toLowerCase() !== 'trusted'
        ) {
            const trustRepair = await supabase
                .from('leads')
                .update({
                    nome: persistedTrustedName.leadPersonName,
                    lead_person_name: persistedTrustedName.leadPersonName,
                    lead_first_name: persistedTrustedName.leadFirstName,
                    lead_name_source: leadSnapshot?.lead_name_source || 'explicit_name_gate',
                    lead_name_confidence: 'trusted',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', payload.lead_id)
                .select('nome, lead_person_name, lead_first_name, lead_name_source, lead_name_confidence')
                .maybeSingle();
            if (trustRepair.error) throw trustRepair.error;
            if (leadSnapshot && trustRepair.data) {
                leadSnapshot.nome = trustRepair.data.nome;
                leadSnapshot.lead_person_name = trustRepair.data.lead_person_name;
                leadSnapshot.lead_first_name = trustRepair.data.lead_first_name;
                leadSnapshot.lead_name_source = trustRepair.data.lead_name_source;
                leadSnapshot.lead_name_confidence = trustRepair.data.lead_name_confidence;
            }
        }

        if (payload.etapa_atual === 'E1' && !trustedNameAlreadyPresent && pendingPreNameInput) {
            const resolvedName = resolveTrustedLeadName({ explicitName: lastUserMessage });
            if (resolvedName.leadNameUsed) {
                const nameUpdate = await supabase
                    .from('leads')
                    .update({
                        nome: resolvedName.leadPersonName,
                        lead_person_name: resolvedName.leadPersonName,
                        lead_first_name: resolvedName.leadFirstName,
                        lead_name_source: 'explicit_name_gate',
                        lead_name_confidence: 'trusted',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', payload.lead_id)
                    .select('nome, lead_person_name, lead_first_name, lead_name_source, lead_name_confidence')
                    .maybeSingle();
                if (nameUpdate.error) throw nameUpdate.error;
                const persistedName = nameUpdate.data || {};
                const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                    pending_pre_name_input: null,
                    pending_pre_name_started_at: null,
                    pending_pre_name_resolved_at: new Date().toISOString(),
                });
                if (leadSnapshot) {
                    leadSnapshot.nome = persistedName.nome || resolvedName.leadPersonName;
                    leadSnapshot.lead_person_name = persistedName.lead_person_name || resolvedName.leadPersonName;
                    leadSnapshot.lead_first_name = persistedName.lead_first_name || resolvedName.leadFirstName;
                    leadSnapshot.lead_name_source = persistedName.lead_name_source || 'explicit_name_gate';
                    leadSnapshot.lead_name_confidence = persistedName.lead_name_confidence || 'trusted';
                    leadSnapshot.sales_context = nextSalesContext;
                }
                payload.history = [
                    ...(payload.history ?? []),
                    { role: 'user', content: pendingPreNameInput },
                ];
                payload.recent_user_messages = [pendingPreNameInput];
                payload.text = pendingPreNameInput;
                lastUserMessage = pendingPreNameInput;
                trustedNameAlreadyPresent = true;
                historyText = (payload.history ?? [])
                    .map((h: any) => `${h.role === 'user' ? 'Lead' : 'Helton'}: ${h.content ?? ''}`)
                    .join('\n');
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_name_gate_resolved',
                    payload: {
                        trusted_first_name: resolvedName.leadFirstName,
                        pending_pre_name_input_recovered: pendingPreNameInput,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            } else {
                const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
                const text = 'Claro! Antes de te passar certinho, como posso te chamar?';
                await fetch(senderUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    },
                    body: JSON.stringify({
                        lead_id: payload.lead_id,
                        telefone: payload.telefone,
                        text,
                        subagente_usado: 'E1',
                        iteracoes: 0,
                        tool_calls: [],
                        skip_takeover: true,
                    }),
                });
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_name_gate_waiting',
                    payload: {
                        pending_pre_name_input: pendingPreNameInput,
                        rejected_name_candidate: lastUserMessage,
                        asked_name: true,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
                if (msg?.msg_id) {
                    await markDebounceGroupStatus({
                        supabase,
                        debounceGroupId: payload.debounce_group_id || null,
                        status: 'processed',
                    }).catch(() => null);
                    await deleteMessage(supabase, Q_AI, msg.msg_id).catch(() => null);
                }
                return new Response(JSON.stringify({
                    status: 'ok',
                    skipped: 'name_gate_waiting',
                    ask_name: true,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        const nameGateCourseIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []);
        const nameGateFallbackCourseQuery = payload.etapa_atual === 'E1'
            ? extractLikelyE1CourseQuery(lastUserMessage)
            : '';
        const nameGateCommercialIntent = payload.etapa_atual === 'E1'
            && (
                (
                    nameGateCourseIntent.matched === true
                    && ['specific', 'specific_or_related'].includes(String(nameGateCourseIntent.mode || ''))
                )
                || Boolean(nameGateFallbackCourseQuery)
            );

        if (nameGateCommercialIntent && !trustedNameAlreadyPresent) {
            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                pending_pre_name_input: lastUserMessage,
                pending_pre_name_started_at: new Date().toISOString(),
            });
            if (leadSnapshot) leadSnapshot.sales_context = nextSalesContext;
            const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
            const text = 'Claro! Antes de te passar certinho, como posso te chamar?';
            await fetch(senderUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    lead_id: payload.lead_id,
                    telefone: payload.telefone,
                    text,
                    subagente_usado: 'E1',
                    iteracoes: 0,
                    tool_calls: [],
                    skip_takeover: true,
                }),
            });
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_name_gate_blocked_commercial_start',
                payload: {
                    pending_pre_name_input: lastUserMessage,
                    course_consultation_blocked: true,
                    city_question_blocked: true,
                    asked_name: true,
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
            if (msg?.msg_id) {
                await markDebounceGroupStatus({
                    supabase,
                    debounceGroupId: payload.debounce_group_id || null,
                    status: 'processed',
                }).catch(() => null);
                await deleteMessage(supabase, Q_AI, msg.msg_id).catch(() => null);
            }
            return new Response(JSON.stringify({
                status: 'ok',
                skipped: 'name_gate',
                ask_name: true,
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const intelligence = await classifyLeadMessage({
            apiKey: runtimeConfig.openaiApiKey,
            model: runtimeConfig.model.subagent,
            etapaAtual: payload.etapa_atual,
            lastUserMessage,
            historyText,
            leadSnapshot,
        });

        const stageState = classifyInboundAgainstStageState({
            stage: payload.etapa_atual,
            leadSnapshot,
            history: payload.history ?? [],
            latestUserMessage: lastUserMessage,
        });
        const resolvedPendingCityThisTurn =
            payload.etapa_atual === 'E1'
            && stageState.matched === true
            && stageState.classification === 'contextual_response'
            && stageState.classificationReason === 'resolved_pending_city';
        const explicitCourseIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []).matched === true;
        const pendingCriterion = derivePendingCriterion({
            stage: payload.etapa_atual,
            leadSnapshot,
            history: payload.history ?? [],
        });
        const e1PendingCriterionResponse =
            payload.etapa_atual === 'E1'
            && stageState.matched === true
            && stageState.classification === 'contextual_response'
            && [
                'resolved_pending_city',
                'partial_pending_motivation_work_status',
                'resolved_pending_motivation',
                'motivation_already_answered_complaint',
            ].includes(String(stageState.classificationReason || ''));
        const effectiveExplicitCourseIntent = e1PendingCriterionResponse
            ? false
            : (explicitCourseIntent || stageState.explicitNewIntent === true);
        const e1SpecificCourseIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []);
        const fallbackE1CourseQuery = payload.etapa_atual === 'E1' && pendingCriterion === 'course'
            ? extractLikelyE1CourseQuery(lastUserMessage)
            : '';
        const e1ExplicitCourseChangeIntent =
            payload.etapa_atual === 'E1'
            && pendingCriterion !== 'course'
            && !e1PendingCriterionResponse
            && !resolvedPendingCityThisTurn
            && e1SpecificCourseIntent.matched === true
            && ['specific', 'specific_or_related'].includes(String(e1SpecificCourseIntent.mode || ''));
        const shouldRunE1CoursePreflight =
            payload.etapa_atual === 'E1'
            && !e1PendingCriterionResponse
            && !resolvedPendingCityThisTurn
            && (pendingCriterion === 'course' || e1ExplicitCourseChangeIntent)
            && (
                (
                    e1SpecificCourseIntent.matched === true
                    && ['specific', 'specific_or_related'].includes(String(e1SpecificCourseIntent.mode || ''))
                )
                || Boolean(fallbackE1CourseQuery)
            );

        if (shouldRunE1CoursePreflight) {
            const preflightQuery = String(e1SpecificCourseIntent.query || fallbackE1CourseQuery || lastUserMessage);
            const lookup = await tool_consultar_conhecimento({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                telefone: payload.telefone,
                env: {
                    ...env,
                    CURRENT_SUBAGENT: 'E1',
                },
            }, {
                tipo: 'course',
                query: preflightQuery,
                lookup_mode_hint: 'specific',
            }).catch((error) => ({ ok: false, error: String(error) }));

            const { data: refreshedAfterCourseLookup } = await supabase
                .from('leads')
                .select('nome, lead_first_name, lead_name_confidence, cidade, curso_interesse, dor_principal, valor_parcela, etapa_atual, matriculado, bloqueado, sales_context, proposta_enviada_em, pronto_matricula_em')
                .eq('id', payload.lead_id)
                .maybeSingle();
            if (leadSnapshot && refreshedAfterCourseLookup) {
                Object.assign(leadSnapshot, refreshedAfterCourseLookup);
            }

            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_e1_course_preflight_lookup',
                payload: {
                    query: preflightQuery,
                    fallback_query: fallbackE1CourseQuery || null,
                    lookup_ok: lookup?.ok !== false,
                    match_status: lookup?.match_status || null,
                    pending_criterion_before: pendingCriterion,
                    course_status_after: refreshedAfterCourseLookup?.sales_context?.course_status || null,
                    available_course_lines: refreshedAfterCourseLookup?.sales_context?.available_course_lines || [],
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
        }

        if (
            payload.etapa_atual === 'E1'
            && !stageState.matched
            && ['course_selection', 'alternative_course_selection'].includes(String(pendingCriterion || ''))
        ) {
            const salesContext = { ...(leadSnapshot?.sales_context || {}) } as Record<string, unknown>;
            const selectedCourse = matchOfferedCourseSelection(
                lastUserMessage,
                salesContext.related_area_courses || salesContext.area_courses || [],
            );
            if (selectedCourse) {
                stageState.classification = 'contextual_course_selection';
                stageState.classificationReason = pendingCriterion === 'alternative_course_selection'
                    ? 'valid_alternative_course_selection'
                    : 'selected_catalog_course';
                stageState.matched = true;
                stageState.authorizedCourseChange = true;
                stageState.statePatch = {
                    curso_interesse: selectedCourse,
                    course_display_name: selectedCourse,
                    course_validated: true,
                    course_status: 'confirmed_available',
                    catalog_mode: 'inactive',
                    catalog_exploration_intent: false,
                    course_was_selected_from_offered_list: true,
                    selected_area: salesContext.requested_area_name || salesContext.selected_area || null,
                    pending_criterion: 'city',
                };
            }
        }

        if (stageState.matched) {
            intelligence.intent = 'qualification';
            intelligence.next_best_action = 'qualify';
            intelligence.needs_handoff = false;
            intelligence.asked_discount = false;
            intelligence.asked_price_early = false;
            intelligence.suggested_stage = payload.etapa_atual;
        }

        if (Object.keys(stageState.statePatch || {}).length > 0) {
            const stateBeforeInbound = {
                course_status: String(leadSnapshot?.sales_context?.course_status || '').trim() || null,
                selected_line: String(leadSnapshot?.sales_context?.linha_formacao || '').trim() || null,
                city: String(leadSnapshot?.cidade || '').trim() || null,
                motivation: String(leadSnapshot?.sales_context?.motivacao_principal || '').trim() || null,
            };
            const e2StateBefore = getE2StateSnapshot(leadSnapshot);
            const preservedCourseState = preserveCourseStateForContextualPatch({
                previousLeadSnapshot: leadSnapshot,
                patch: stageState.statePatch,
                explicitNewCourseIntent: effectiveExplicitCourseIntent,
                authorizedCourseChange: stageState.authorizedCourseChange === true
                    || ['selected_catalog_course', 'valid_alternative_course_selection'].includes(String(stageState.classificationReason || '')),
            });
            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                ...preservedCourseState.patch,
                pending_criterion: payload.etapa_atual === 'E1' && Object.prototype.hasOwnProperty.call(preservedCourseState.patch, 'pending_criterion')
                    ? preservedCourseState.patch.pending_criterion : (preservedCourseState.patch.pending_criterion ?? pendingCriterion),
                last_inbound_classification: stageState.classification,
                last_inbound_classification_reason: stageState.classificationReason,
            });
            if (leadSnapshot) {
                leadSnapshot.sales_context = nextSalesContext;
                if (preservedCourseState.patch.cidade) leadSnapshot.cidade = preservedCourseState.patch.cidade;
                if (preservedCourseState.patch.curso_interesse) leadSnapshot.curso_interesse = preservedCourseState.patch.curso_interesse;
            }
            const e2StateAfter = getE2StateSnapshot({ sales_context: nextSalesContext });

            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_e1_transition_snapshot',
                payload: {
                    stage: payload.etapa_atual,
                    pending_criterion_before: pendingCriterion,
                    inbound_resolution: stageState.classificationReason,
                    state_before_inbound: stateBeforeInbound,
                    state_after_inbound: {
                        course_status: String(nextSalesContext.course_status || '').trim() || null,
                        selected_line: String(nextSalesContext.linha_formacao || '').trim() || null,
                        city: String(preservedCourseState.patch.cidade || leadSnapshot?.cidade || '').trim() || null,
                        motivation: String(nextSalesContext.motivacao_principal || '').trim() || null,
                    },
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});

            if (payload.etapa_atual === 'E2') {
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_e2_state_transition',
                    payload: {
                        stage: payload.etapa_atual,
                        pending_criterion_before: pendingCriterion,
                        e2_state_before: e2StateBefore,
                        inbound_resolution: stageState.classificationReason,
                        availability_status_candidate: String(preservedCourseState.patch.e2_availability_status || '').trim() || null,
                        availability_status_after: e2StateAfter.availability_status,
                        getNextE2Criterion_result: e2StateAfter.next_criterion,
                        process_action: e2StateAfter.next_criterion === 'vaccine_availability'
                            ? 'ask_vaccine_availability'
                            : e2StateAfter.next_criterion === 'vaccine_decider'
                                ? 'ask_vaccine_decider'
                                : e2StateAfter.next_criterion === 'vaccine_agreement'
                                    ? 'ask_vaccine_agreement'
                                    : 'advance_or_hold',
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }

            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_course_state_invariant',
                payload: {
                    stage: payload.etapa_atual,
                    explicit_new_course_intent: effectiveExplicitCourseIntent,
                    authorized_course_change: stageState.authorizedCourseChange === true
                        || ['selected_catalog_course', 'valid_alternative_course_selection'].includes(String(stageState.classificationReason || '')),
                    course_status_before: preservedCourseState.courseStatusBefore,
                    course_status_candidate: preservedCourseState.courseStatusCandidate,
                    course_status_after: String(nextSalesContext.course_status || '').trim() || null,
                    course_status_change_reason: stageState.classificationReason,
                    state_mutation_allowed: preservedCourseState.stateMutationAllowed,
                    state_invariant_violation: preservedCourseState.stateInvariantViolation,
                    selected_line_before: preservedCourseState.selectedLineBefore,
                    selected_line_after: String(nextSalesContext.linha_formacao || '').trim() || null,
                    requested_area_before: preservedCourseState.requestedAreaBefore,
                    requested_area_after: String(nextSalesContext.requested_area_name || '').trim() || null,
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
        }

        await logLeadRuntimeEvent({
            supabase,
            tenantId: payload.tenant_id,
            leadId: payload.lead_id,
            eventType: 'test_stage_state_classification',
            payload: {
                stage: payload.etapa_atual,
                pending_criterion: pendingCriterion,
                last_question_type: stageState.lastAgentQuestionType,
                classification: stageState.classification,
                classification_reason: stageState.classificationReason,
                state_before: {
                    etapa_atual: payload.etapa_atual,
                    curso_interesse: leadSnapshot?.curso_interesse || null,
                    cidade: leadSnapshot?.cidade || null,
                    sales_context: leadSnapshot?.sales_context || {},
                },
                state_patch: stageState.statePatch || {},
                explicit_new_course_intent: effectiveExplicitCourseIntent,
                checkpoint_status: {
                    proposal: leadSnapshot?.sales_context?.proposal_checkpoint_pending === true,
                    enrollment: leadSnapshot?.sales_context?.enrollment_checkpoint_pending === true,
                },
                logged_at: new Date().toISOString(),
            },
        }).catch(() => {});

        await persistLeadIntelligence({
            supabase,
            leadId: payload.lead_id,
            intelligence,
            currentLead: leadSnapshot,
        });
        const adminPhone = runtimeConfig.adminPhone || '';

        async function notifyAdminIfNeeded(eventType: string, eventKey: string, detalhes: string) {
            if (!adminPhone) return;

            const inserted = await registerLeadEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType,
                eventKey,
                payload: { detalhes, intelligence },
            });
            if (!inserted) return;

            const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
            await fetch(senderUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    telefone: adminPhone,
                    text: detalhes,
                    skip_governance: true,
                    persist_message: false,
                }),
            }).catch(() => {});
        }

        async function createCheckpointAndPause(params: {
            checkpointAdmin: 'proposal_send' | 'enrollment_processing';
            motivoPausa: string;
            adminText: string;
            salesContextPatch: Record<string, unknown>;
            resumeFrom?: string;
        }) {
            if (!adminPhone) {
                throw new Error('ADMIN_PHONE nao configurado para checkpoint administrativo');
            }

            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, params.salesContextPatch);
            if (leadSnapshot) {
                leadSnapshot.sales_context = nextSalesContext;
            }

            const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
            const sendRes = await fetch(senderUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    telefone: adminPhone,
                    text: params.adminText,
                    skip_governance: true,
                    persist_message: false,
                }),
            });

            if (!sendRes.ok) {
                const errBody = await sendRes.text().catch(() => '');
                throw new Error(`Falha ao enviar notificacao admin: ${sendRes.status} ${errBody}`);
            }

            const sendData = await sendRes.json().catch(() => ({}));
            const checkpoint = await createAdminCheckpoint({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                etapaPausada: currentStage,
                motivoPausa: params.motivoPausa,
                checkpointAdmin: params.checkpointAdmin,
                adminMessageId: sendData?.messageId || null,
                adminPhoneOrId: adminPhone,
                resumeFrom: params.resumeFrom || currentStage,
                metadata: {
                    etapa_atual: currentStage,
                    lead_nome: leadSnapshot?.nome || payload.nome_lead || null,
                    telefone_lead: payload.telefone,
                    curso_interesse: leadSnapshot?.curso_interesse || null,
                },
            });

            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_admin_checkpoint_created',
                payload: {
                    checkpoint_admin: params.checkpointAdmin,
                    admin_message_id: sendData?.messageId || null,
                    motivo_pausa: params.motivoPausa,
                    checkpoint_id: checkpoint?.id || null,
                    created_at: new Date().toISOString(),
                },
            }).catch(() => {});
        }

        const preProposalPriceAsk = intelligence.asked_price_early === true && !leadSnapshot?.proposta_enviada_em;
        if (preProposalPriceAsk) {
            const currentPriceAskContext = await readLeadSalesContext(supabase, payload.lead_id);
            const previousPriceAskCount = Number(currentPriceAskContext.pre_proposal_price_ask_count || 0);
            const nextPriceAskCount = previousPriceAskCount + 1;
            const alreadyNotifiedPriceAsk = currentPriceAskContext.pre_proposal_price_admin_notified === true;
            const shouldNotifyPriceAsk = nextPriceAskCount >= 2 && !alreadyNotifiedPriceAsk;
            const nextPriceAskContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                pre_proposal_price_ask_count: nextPriceAskCount,
                pre_proposal_price_last_asked_at: new Date().toISOString(),
                pre_proposal_price_admin_notified: alreadyNotifiedPriceAsk || shouldNotifyPriceAsk,
            });
            if (leadSnapshot) leadSnapshot.sales_context = nextPriceAskContext;

            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_pre_proposal_price_ask',
                payload: {
                    count: nextPriceAskCount,
                    admin_notified: shouldNotifyPriceAsk,
                    already_notified: alreadyNotifiedPriceAsk,
                    etapa_atual: payload.etapa_atual,
                    mensagem: lastUserMessage,
                    created_at: new Date().toISOString(),
                },
            }).catch(() => {});

            if (shouldNotifyPriceAsk) {
                await notifyAdminIfNeeded(
                    'price_early',
                    `price_early_repeat_${payload.lead_id}`,
                    `Lead perguntou valor antes da etapa financeira mais de uma vez.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nEtapa atual: ${payload.etapa_atual}\nMensagem: ${lastUserMessage}`,
                );
            }
        }

        if (intelligence.proposal_ready && !preProposalPriceAsk) {
            await notifyAdminIfNeeded(
                'proposal_ready',
                `proposal_ready_${payload.etapa_atual}`,
                `Lead em momento de proposta de valor.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nEtapa atual: ${payload.etapa_atual}\nPróxima ação sugerida: ${intelligence.next_best_action}\nResumo: ${intelligence.summary}`,
            );
        }

        if (intelligence.enrollment_ready || intelligence.payment_confirmed) {
            await notifyAdminIfNeeded(
                'enrollment_ready',
                `enrollment_ready_${payload.etapa_atual}`,
                `Lead pronto para inscrição/matrícula.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nEtapa atual: ${payload.etapa_atual}\nMensagem: ${lastUserMessage}`,
            );
        }

        const shouldForceHandoff =
            intelligence.needs_handoff &&
            (intelligence.intent === 'human_help' || intelligence.asked_discount === true);

        let out;
        let e4ProposalFollowupContext: Record<string, unknown> | null = null;
        let finalSubagent = initialSubagent;
        let currentStage = payload.etapa_atual;
        let workingHistory = (payload.history ?? []).map((item: any) => item?.role === 'user'
            ? {
                ...item,
                content: normalizeInboundUserText(item?.content),
            }
            : item);
        if (shouldForceHandoff) {
            await supabase
                .from('leads')
                .update({
                    bloqueado: true,
                    handoff_em: new Date().toISOString(),
                    etapa_atual: 'handoff',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', payload.lead_id);

            await notifyAdminIfNeeded(
                'forced_handoff',
                `forced_handoff_${intelligence.intent}_${payload.etapa_atual}`,
                `Handoff automático acionado.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nMotivo: ${intelligence.intent === 'human_help' ? 'Lead pediu humano' : 'Lead pediu condição especial/desconto'}\nMensagem: ${lastUserMessage}`,
            );

            out = {
                text: intelligence.intent === 'human_help'
                    ? 'Perfeito. Ja acionei alguem da equipe para continuar com voce por aqui, tudo bem?'
                    : 'Entendi. Vou chamar alguem da equipe para olhar essa condicao com voce e seguir daqui, combinado?',
                toolCalls: [],
                handoff: true,
                avancou: false,
                iterations: 0,
            };
        } else {
            const collectedTexts: Array<{ stage: string; text: string }> = [];
            let collectedToolCalls: any[] = [];
            let currentSubagent = initialSubagent;
            let lastOutput = null;

            for (let hop = 0; hop < AUTO_STAGE_HANDOFF_LIMIT; hop += 1) {
                const activeRecentUserMessages = extractRecentUserMessages(
                    workingHistory,
                    payload.recent_user_messages ?? [],
                );
                const activeLastUserMessage = activeRecentUserMessages.slice(-1)[0] || payload.text || '';
                const stageOutput = await runSubagent({
                    subagent:           currentSubagent,
                    leadId:             payload.lead_id,
                    telefone:           payload.telefone,
                    etapaAtual:         currentStage,
                    recentUserMessages: activeRecentUserMessages,
                    history:            workingHistory,
                    messages:           hop === 0 ? (payload.messages ?? []) : [],
                    trigger:            hop === 0 ? (payload.trigger ?? 'whatsapp_inbound') : 'stage_handoff',
                    nomeDoLead:         payload.nome_lead ?? null,
                    supabase,
                    tenantId:           payload.tenant_id,
                    env:                runtimeConfig.env,
                    messagePolicy:      runtimeConfig.messagePolicy,
                    intelligence,
                    leadSnapshot,
                    ...(currentSubagent === 'E1' && hop === 0 ? {
                        inboundResolution: stageState,
                        pendingCriterionBefore: pendingCriterion,
                    } : {}),
                });

                if (
                    currentSubagent === 'E1'
                    && stageState.classificationReason === 'resolved_pending_motivation'
                ) {
                    stageOutput.processAction = 'complete_stage';
                    stageOutput.allowedIntent = 'complete_e1_and_handoff_to_e2';
                    stageOutput.conversationalBehavior = 'complete_stage';
                    stageOutput.pendingCriterionAfter = null;
                    stageOutput.avancou = stageOutput.avancou === true;
                    stageOutput.handoff = false;
                }

                if (
                    currentSubagent === 'E2'
                    && hop > 0
                    && shouldSanitizeE2HandoffOutput(stageOutput.text)
                ) {
                    console.warn('[ai-processor] saneando saida estrutural torta em E2 stage_handoff');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(filterKnowledgeToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE2StageHandoffFallback();
                    stageOutput.responseOrigin = 'technical_failure';
                    stageOutput.fallbackUsed = true;
                    stageOutput.fallbackReason = 'invalid_e2_stage_handoff_output';
                }

                if (
                    currentSubagent === 'E2'
                    && stageOutput.avancou
                ) {
                    const { data: e2AdvanceGuardLead } = await supabase
                        .from('leads')
                        .select('sales_context')
                        .eq('id', payload.lead_id)
                        .maybeSingle();
                    const e2AdvanceGuardContext = { ...(e2AdvanceGuardLead?.sales_context || {}) } as Record<string, unknown>;

                    if (!isE2AdvanceStructurallyValid({
                        history: workingHistory,
                        recentUserMessages: activeRecentUserMessages,
                        salesContext: e2AdvanceGuardContext,
                    })) {
                    console.warn('[ai-processor] bloqueando avance estrutural invalido em E2');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(stageOutput.toolCalls);
                    stageOutput.text = buildE2AgreementFallback();
                    stageOutput.responseOrigin = 'technical_failure';
                    stageOutput.fallbackUsed = true;
                    stageOutput.fallbackReason = 'invalid_e2_advance';
                    }
                }

                const liveSalesContextForViolationCheck = ['E1', 'E2'].includes(currentSubagent)
                    ? await readLeadSalesContext(supabase, payload.lead_id)
                    : null;
                const earlyStageForbiddenTopicsRaw = ['E1', 'E2'].includes(currentSubagent)
                    ? detectForbiddenEarlyStageTopics(stageOutput.text)
                    : [];
                const allowE2TravelMoveModality = currentSubagent === 'E2'
                    && String(liveSalesContextForViolationCheck?.e2_availability_objection_kind || '').trim() === 'travel_or_move';
                const allowE2ConditionalMethodology = currentSubagent === 'E2'
                    && String(liveSalesContextForViolationCheck?.e2_commercial_agreement_status || '').trim() === 'conditional_price_pending_confirmation';
                const allowE2AgreementBolsa = currentSubagent === 'E2'
                    && String(stageOutput.processAction || '').trim() === 'ask_vaccine_agreement';
                const earlyStageForbiddenTopics = earlyStageForbiddenTopicsRaw.filter((topic) => {
                    const currentTopic = String(topic);
                    if (
                        allowE2TravelMoveModality
                        && ['modalidade', 'ead', 'semipresencial', 'presencial', 'metodologia', 'funcionamento das aulas'].includes(currentTopic)
                    ) return false;
                    if (allowE2ConditionalMethodology && currentTopic === 'metodologia') return false;
                    if (allowE2AgreementBolsa && currentTopic === 'bolsa') return false;
                    return true;
                });
                const ambiguousLineViolations = currentSubagent === 'E1'
                    && liveSalesContextForViolationCheck?.course_status === 'ambiguous_available'
                    ? detectAmbiguousCourseLineViolations(
                        stageOutput.text,
                        Array.isArray(liveSalesContextForViolationCheck?.available_course_lines)
                            ? liveSalesContextForViolationCheck.available_course_lines
                            : [],
                    )
                    : [];
                const segmentUnavailableViolations = currentSubagent === 'E1'
                    ? detectSegmentUnavailableViolations(
                        stageOutput.text,
                        String(liveSalesContextForViolationCheck?.requested_area_name || '').trim() || null,
                        Array.isArray(liveSalesContextForViolationCheck?.related_area_courses)
                            ? liveSalesContextForViolationCheck.related_area_courses
                            : [],
                    )
                    : [];
                const unnecessarySingleLineMentionViolations = currentSubagent === 'E1'
                    ? detectUnnecessarySingleLineMention(
                        stageOutput.text,
                        Array.isArray(liveSalesContextForViolationCheck?.available_course_lines)
                            ? liveSalesContextForViolationCheck.available_course_lines
                            : [],
                        String(liveSalesContextForViolationCheck?.pending_criterion || '').trim() || null,
                    )
                    : [];
                const catalogSelectionLoopViolations = currentSubagent === 'E1'
                    && String(stageState.classificationReason || '') === 'selected_catalog_course'
                    && ['present_area_courses_and_wait_selection', 'present_segment_options_and_wait_selection'].includes(String(stageOutput.processAction || ''))
                    ? ['catalog_selection_loop']
                    : [];
                const stageContractViolations = [
                    ...earlyStageForbiddenTopics,
                    ...ambiguousLineViolations,
                    ...segmentUnavailableViolations,
                    ...unnecessarySingleLineMentionViolations,
                    ...catalogSelectionLoopViolations,
                ];

                if (['E1', 'E2'].includes(currentSubagent) && stageContractViolations.length > 0) {
                    console.warn(`[ai-processor] regenerando saida com violacao contratual em ${currentSubagent}`);
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(filterKnowledgeToolCalls(stageOutput.toolCalls));

                    const { data: liveLeadForRecovery } = await supabase
                        .from('leads')
                        .select('nome, cidade, curso_interesse, modalidade, sales_context, etapa_atual')
                        .eq('id', payload.lead_id)
                        .maybeSingle();
                    const liveSalesContext = { ...((liveLeadForRecovery?.sales_context || liveSalesContextForViolationCheck || {}) as Record<string, unknown>) };
                    const pendingCriterion = derivePendingCriterion({
                        stage: currentStage,
                        leadSnapshot: liveLeadForRecovery || { ...(leadSnapshot || {}), sales_context: liveSalesContext },
                        history: workingHistory,
                    });
                    const originalOutput = stageOutput.text || '';
                    const responseOriginBefore = stageOutput.responseOrigin || 'llm_free_generation';
                    const availableCourseLinesForRecovery = Array.isArray(liveSalesContext.available_course_lines)
                        ? liveSalesContext.available_course_lines
                        : [];
                    const deterministicRecovery = currentSubagent === 'E1' && pendingCriterion === 'course_line'
                        ? {
                            text: buildE1CourseLineFallback(
                                String(liveSalesContext.course_display_name || liveLeadForRecovery?.curso_interesse || leadSnapshot?.curso_interesse || '').trim(),
                                availableCourseLinesForRecovery,
                            ),
                            pendingBefore: stageOutput.pendingCriterionBefore || 'course_line',
                            pendingAfter: 'course_line',
                            processAction: 'ask_course_line',
                            allowedIntent: 'ask_course_line_only',
                            conversationalBehavior: 'list_only_real_available_course_lines_and_wait_choice',
                        }
                        : null;

                    const allowedIntent = currentSubagent === 'E1'
                        ? pendingCriterion === 'motivation'
                            ? 'acknowledge_course_and_ask_motivation'
                            : pendingCriterion === 'course_line'
                                ? 'ask_course_line_only'
                                : pendingCriterion === 'catalog_area_selection'
                                    ? 'present_real_catalog_areas_and_ask_which_area_matches_best'
                                    : pendingCriterion === 'course_selection'
                                        ? 'present_real_courses_from_selected_area_and_wait_for_course_choice'
                                : pendingCriterion === 'alternative_course_selection'
                                    ? 'present_same_segment_alternatives_and_wait_for_specific_course_choice'
                                    : pendingCriterion === 'new_direction'
                                        ? 'explain_unavailable_course_without_known_segment_and_ask_for_new_direction'
                                : 'acknowledge_course_and_ask_city'
                        : pendingCriterion === 'vaccine_decider'
                            ? 'ask_vaccine_decider'
                            : pendingCriterion === 'vaccine_agreement'
                                ? 'ask_vaccine_agreement'
                                : 'ask_vaccine_availability';

                    const regenerationLeadSnapshot = {
                        ...(leadSnapshot || {}),
                        sales_context: liveSalesContext,
                    };
                    const speakableFacts: Record<string, unknown> = {
                        course_name: String(regenerationLeadSnapshot?.curso_interesse || '').trim() || null,
                        course_line: String(regenerationLeadSnapshot?.sales_context?.linha_formacao || '').trim() || null,
                        course_status: String(regenerationLeadSnapshot?.sales_context?.course_status || '').trim() || null,
                        pending_criterion: pendingCriterion || null,
                        ...(currentSubagent === 'E1' ? stageOutput.speakableFacts : {}),
                    };
                    if (String(regenerationLeadSnapshot?.sales_context?.requested_area_name || '').trim()) {
                        speakableFacts.requested_area = String(regenerationLeadSnapshot.sales_context.requested_area_name || '').trim();
                    }
                    if (Array.isArray(regenerationLeadSnapshot?.sales_context?.related_area_courses)
                        && regenerationLeadSnapshot.sales_context.related_area_courses.length > 0) {
                        speakableFacts.related_area_courses = regenerationLeadSnapshot.sales_context.related_area_courses
                            .map((item: unknown) => getCourseDisplayName(String(item)))
                            .filter(Boolean);
                    }
                    if (Array.isArray(regenerationLeadSnapshot?.sales_context?.available_course_lines)
                        && regenerationLeadSnapshot.sales_context.available_course_lines.length > 0) {
                        speakableFacts.available_course_lines = regenerationLeadSnapshot.sales_context.available_course_lines;
                    }
                    if (
                        currentSubagent === 'E1'
                        && String(liveSalesContext.course_status || '').trim() === 'confirmed_available'
                        && pendingCriterion === 'city'
                    ) {
                        delete speakableFacts.course_status;
                        delete speakableFacts.available_course_lines;
                        delete speakableFacts.availability;
                        delete speakableFacts.offered;
                        speakableFacts.e1_behavior = 'selected_course_to_city';
                    }

                    const regeneratedOutput = deterministicRecovery
                        ? {
                            text: deterministicRecovery.text,
                            responseOrigin: 'structural_fallback',
                            outputBeforeGovernance: deterministicRecovery.text,
                            deterministicReplyUsed: true,
                            pendingCriterionBefore: deterministicRecovery.pendingBefore,
                            pendingCriterionAfter: deterministicRecovery.pendingAfter,
                            processAction: deterministicRecovery.processAction,
                            allowedIntent: deterministicRecovery.allowedIntent,
                            conversationalBehavior: deterministicRecovery.conversationalBehavior,
                            iterations: 0,
                        }
                        : await runSubagent({
                            subagent: currentSubagent,
                            leadId: payload.lead_id,
                            telefone: payload.telefone,
                            etapaAtual: currentStage,
                            recentUserMessages: activeRecentUserMessages,
                            history: workingHistory,
                            messages: [],
                            trigger: hop === 0 ? (payload.trigger ?? 'whatsapp_inbound') : 'stage_handoff',
                            nomeDoLead: payload.nome_lead ?? null,
                            supabase,
                            tenantId: payload.tenant_id,
                            env: runtimeConfig.env,
                            messagePolicy: runtimeConfig.messagePolicy,
                            intelligence,
                            leadSnapshot: regenerationLeadSnapshot,
                            regenerationContext: {
                                allowedIntent,
                                speakableFacts,
                                forbiddenTopics: stageContractViolations,
                                originalOutput,
                            },
                        });

                    stageOutput.text = regeneratedOutput.text || '';
                    stageOutput.responseOrigin = regeneratedOutput.responseOrigin || 'llm_regeneration';
                    stageOutput.outputBeforeGovernance = regeneratedOutput.outputBeforeGovernance || regeneratedOutput.text || null;
                    stageOutput.stageContractViolation = true;
                    stageOutput.forbiddenTopicsDetected = stageContractViolations;
                    stageOutput.regenerationTriggered = true;
                    stageOutput.originalOutput = originalOutput;
                    stageOutput.regeneratedOutput = regeneratedOutput.text || null;
                    stageOutput.fallbackUsed = regeneratedOutput.fallbackUsed === true;
                    stageOutput.fallbackReason = regeneratedOutput.fallbackReason || null;
                    stageOutput.deterministicReplyUsed = regeneratedOutput.deterministicReplyUsed === true;
                    stageOutput.iterations = Math.max(stageOutput.iterations || 0, regeneratedOutput.iterations || 0);
                    stageOutput.handoff = false;
                    stageOutput.avancou = false;
                    stageOutput.processAction = regeneratedOutput.processAction || stageOutput.processAction;
                    stageOutput.allowedIntent = regeneratedOutput.allowedIntent || allowedIntent;
                    stageOutput.conversationalBehavior = regeneratedOutput.conversationalBehavior || stageOutput.conversationalBehavior;
                    stageOutput.pendingCriterionBefore = regeneratedOutput.pendingCriterionBefore ?? stageOutput.pendingCriterionBefore;
                    stageOutput.pendingCriterionAfter = regeneratedOutput.pendingCriterionAfter ?? stageOutput.pendingCriterionAfter;

                    await logLeadRuntimeEvent({
                        supabase,
                        tenantId: payload.tenant_id,
                        leadId: payload.lead_id,
                        eventType: 'test_stage_contract_violation',
                        payload: {
                            stage: currentSubagent,
                            etapa_atual: currentStage,
                            pending_criterion: pendingCriterion || null,
                            allowed_intent: regeneratedOutput.allowedIntent || allowedIntent,
                            process_action: regeneratedOutput.processAction || (
                                pendingCriterion === 'alternative_course_selection'
                                    ? 'present_segment_options_and_wait_selection'
                                    : pendingCriterion === 'new_direction'
                                        ? 'ask_for_new_direction'
                                        : null
                            ),
                            conversational_behavior: regeneratedOutput.conversationalBehavior || null,
                            speakable_facts: regeneratedOutput.speakableFacts || speakableFacts,
                            pending_criterion_before: regeneratedOutput.pendingCriterionBefore || pendingCriterion || null,
                            pending_criterion_after: regeneratedOutput.pendingCriterionAfter || pendingCriterion || null,
                            personality_prompt_id: regeneratedOutput.personalityPromptId || null,
                            stage_prompt_id: regeneratedOutput.stagePromptId || null,
                            stage_contract_violation: true,
                            forbidden_topics_detected: stageContractViolations,
                            regeneration_triggered: true,
                            response_origin_before: responseOriginBefore,
                            response_origin_after: stageOutput.responseOrigin,
                            original_output: originalOutput,
                            raw_model_output: regeneratedOutput.rawModelOutput || regeneratedOutput.outputBeforeGovernance || regeneratedOutput.text || null,
                            regenerated_output: stageOutput.text || null,
                            logged_at: new Date().toISOString(),
                        },
                    }).catch(() => {});
                }

                if (
                    currentSubagent === 'E3'
                    && stageOutput.avancou
                    && !isE3AdvanceStructurallyValid({
                        trigger: hop === 0 ? (payload.trigger ?? 'whatsapp_inbound') : 'stage_handoff',
                        recentUserMessages: activeRecentUserMessages,
                    })
                ) {
                    console.warn('[ai-processor] bloqueando avance estrutural invalido em E3');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(stageOutput.toolCalls);
                    stageOutput.text = sanitizeBlockedE3AdvanceText(stageOutput.text);
                }

                if (
                    currentSubagent === 'E3'
                    && textMentionsPricesOrDiscounts(stageOutput.text)
                ) {
                    console.warn('[ai-processor] removendo preco/desconto indevido em E3');
                    stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                    if (userAskedToKnowValues(activeLastUserMessage) || stageOutput.avancou) {
                        stageOutput.text = buildE3AdvanceToE4Fallback();
                        try {
                            const forcedAdvance = await tool_avancar_etapa({
                                supabase,
                                tenantId: payload.tenant_id,
                                leadId: payload.lead_id,
                                telefone: payload.telefone,
                                env: runtimeConfig.env,
                            }, { etapa_destino: 'E4' });

                            stageOutput.avancou = true;
                            stageOutput.toolCalls.push({
                                name: 'avancar_etapa',
                                args: { etapa_destino: 'E4' },
                                result: forcedAdvance,
                            });
                        } catch (forceAdvanceError) {
                            console.error(`[ai-processor] falha ao avancar E3->E4 apos interesse em valores: ${String(forceAdvanceError)}`);
                            stageOutput.avancou = false;
                        }
                    } else {
                        stageOutput.avancou = false;
                        stageOutput.text = sanitizeBlockedE3AdvanceText(stageOutput.text);
                    }
                }

                if (
                    currentSubagent === 'E3'
                    && !stageOutput.avancou
                    && (userAskedToKnowValues(activeLastUserMessage) || userExpressedCommercialInterest(activeLastUserMessage))
                ) {
                    stageOutput.processAction = 'complete_stage';
                    stageOutput.pendingCriterionAfter = null;
                    stageOutput.allowedIntent = 'complete_e3_and_handoff_to_e4';
                    stageOutput.conversationalBehavior = 'optional_short_contextual_acknowledgement';
                    try {
                        const forcedAdvance = await tool_avancar_etapa({
                            supabase,
                            tenantId: payload.tenant_id,
                            leadId: payload.lead_id,
                            telefone: payload.telefone,
                            env: runtimeConfig.env,
                        }, { etapa_destino: 'E4' });

                        stageOutput.avancou = true;
                        stageOutput.toolCalls = [
                            ...(stageOutput.toolCalls || []),
                            {
                                name: 'avancar_etapa',
                                args: { etapa_destino: 'E4' },
                                result: forcedAdvance,
                            },
                        ];
                    } catch (forceAdvanceError) {
                        console.error(`[ai-processor] falha ao aplicar avance estrutural E3->E4: ${String(forceAdvanceError)}`);
                    }
                }

                if (
                    currentSubagent === 'E6'
                    && shouldRedirectE6NameToPhone({
                        recentUserMessages: activeRecentUserMessages,
                        text: stageOutput.text,
                    })
                ) {
                    console.warn('[ai-processor] bloqueando consulta indevida em E6 e redirecionando para telefone');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE6PhoneFallback();
                }

                if (
                    currentSubagent === 'E1'
                    && ['present_area_courses_and_wait_selection', 'present_segment_options_and_wait_selection'].includes(String(stageOutput.processAction || ''))
                    && String(stageState.classificationReason || '') !== 'selected_catalog_course'
                    && textMisframesAreaSelectionAsUnavailable(stageOutput.text)
                ) {
                    const liveSalesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    const requestedArea = String(liveSalesContext.requested_area_name || leadSnapshot?.sales_context?.requested_area_name || '').trim() || null;
                    const relatedAreaCourses = Array.isArray(liveSalesContext.related_area_courses)
                        ? liveSalesContext.related_area_courses.filter(Boolean).map((item: unknown) => String(item))
                        : [];

                    if (requestedArea && relatedAreaCourses.length > 0) {
                        stageOutput.text = buildAreaCourseSelectionFallback({
                            requestedArea,
                            courses: relatedAreaCourses,
                        });
                        stageOutput.deterministicReplyUsed = true;
                        stageOutput.responseOrigin = 'structural_fallback';
                    }
                }

                if (
                    currentSubagent === 'E7'
                    && looksLikePhoneReply(activeLastUserMessage)
                    && textAsksIndicatedCourseDetails(stageOutput.text)
                ) {
                    console.warn('[ai-processor] corrigindo fechamento de E7 para encerramento estrutural');
                    stageOutput.text = buildE7ClosingFallback(
                        latestIndicatedName(workingHistory, activeRecentUserMessages),
                    );
                    stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                    try {
                        const forcedAdvance = await tool_avancar_etapa({
                            supabase,
                            tenantId: payload.tenant_id,
                            leadId: payload.lead_id,
                            telefone: payload.telefone,
                            env: runtimeConfig.env,
                        }, {});

                        stageOutput.avancou = true;
                        stageOutput.toolCalls = [
                            ...(stageOutput.toolCalls ?? []),
                            {
                                name: 'avancar_etapa',
                                args: {},
                                result: forcedAdvance,
                            },
                        ];
                    } catch (forceAdvanceError) {
                        console.error(`[ai-processor] falha ao aplicar encerramento estrutural E7: ${String(forceAdvanceError)}`);
                    }
                }

                if (
                    currentSubagent === 'E4'
                    && userAskedFinancialQuestion(activeLastUserMessage)
                    && (textRequestsHighSchool(stageOutput.text) || textRequestsModality(stageOutput.text))
                ) {
                    console.warn('[ai-processor] saneando desvio estrutural de E4 apos pergunta financeira');
                    stageOutput.text = buildE4PriceGuardFallback(
                        String(leadSnapshot?.curso_interesse || ''),
                        String(leadSnapshot?.cidade || ''),
                    );
                }

                if (
                    currentSubagent === 'E4'
                    && userAskedFinancialQuestion(activeLastUserMessage)
                    && stageOutput.handoff
                ) {
                    console.warn('[ai-processor] bloqueando handoff indevido em E4 para pergunta financeira valida');
                    await clearInvalidHandoff(supabase, payload.lead_id, 'E4');
                    stageOutput.handoff = false;
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(
                        filterKnowledgeToolCalls(
                            filterHandoffToolCalls(stageOutput.toolCalls),
                        ),
                    );
                    stageOutput.text = buildE4FinancialFallback(
                        String(leadSnapshot?.curso_interesse || ''),
                        String(leadSnapshot?.cidade || ''),
                    );
                }

                if (
                    currentSubagent === 'E4'
                    && userAskedFinancialQuestion(activeLastUserMessage)
                    && shouldSanitizeE4FinancialOutput(stageOutput.text)
                ) {
                    console.warn('[ai-processor] simplificando resposta redundante de E4');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(filterKnowledgeToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE4FinancialFallback(
                        String(leadSnapshot?.curso_interesse || ''),
                        String(leadSnapshot?.cidade || ''),
                    );
                }

                if (
                    currentSubagent === 'E4'
                    && textMentionsPricesOrDiscounts(stageOutput.text)
                ) {
                    console.warn('[ai-processor] removendo valor/desconto indevido em E4');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE4FinancialFallback(
                        String(leadSnapshot?.curso_interesse || ''),
                        String(leadSnapshot?.cidade || ''),
                    );
                }

                if (currentSubagent === 'E4') {
                    const liveSalesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    if (leadSnapshot) {
                        leadSnapshot.sales_context = liveSalesContext;
                    }

                    const proposalCompleted = liveSalesContext.proposal_checkpoint_completed === true;
                    const enrollmentCompleted = liveSalesContext.enrollment_checkpoint_completed === true;
                    const postProposalOpeningPending = proposalCompleted
                        && liveSalesContext.e4_post_proposal_opening_pending === true
                        && liveSalesContext.e4_post_proposal_opening_sent !== true;

                    if (postProposalOpeningPending) {
                        stageOutput.avancou = false;
                        stageOutput.handoff = false;
                        stageOutput.toolCalls = filterHandoffToolCalls(filterAdvanceToolCalls(filterKnowledgeToolCalls(stageOutput.toolCalls)));
                        const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                            e4_post_proposal_opening_pending: false,
                            e4_post_proposal_opening_sent: true,
                            e4_post_proposal_opening_sent_at: new Date().toISOString(),
                        });
                        if (leadSnapshot) leadSnapshot.sales_context = nextSalesContext;
                    } else if (
                        proposalCompleted
                        && !enrollmentCompleted
                        && payload.trigger !== 'stage_handoff'
                        && Boolean(String(activeLastUserMessage || '').trim())
                        && !userRequestedEnrollment(activeLastUserMessage)
                        && !isE4PostProposalObjection(activeLastUserMessage, intelligence)
                    ) {
                        stageOutput.avancou = false;
                        stageOutput.handoff = false;
                        stageOutput.toolCalls = filterHandoffToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        const responseDeadline = getE4EndOfDayDeadline(runtimeConfig.businessHours);
                        e4ProposalFollowupContext = {
                            stage: 'E4',
                            proposal_sent: true,
                            response_deadline: responseDeadline,
                            course: String(liveSalesContext.course_display_name || leadSnapshot?.curso_interesse || '').trim() || null,
                            motivation: String(liveSalesContext.motivacao_principal || leadSnapshot?.dor_principal || '').trim() || null,
                            decision_participant: String(liveSalesContext.e2_decision_participant || '').trim() || null,
                            decision_answer: String(liveSalesContext.e2_vaccine_decider_answer || '').trim() || null,
                            candidate_response: activeLastUserMessage,
                        };
                        const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                            e4_proposal_commitment_answer: activeLastUserMessage,
                            e4_proposal_response_due_at: responseDeadline,
                            e4_proposal_followup_scheduled: false,
                        });
                        if (leadSnapshot) leadSnapshot.sales_context = nextSalesContext;
                    }

                    if (!proposalCompleted) {
                        const fullNameCandidate = extractFullNameCandidate(activeLastUserMessage);
                        const lastKnownName = String(liveSalesContext.proposal_full_name || leadSnapshot?.nome || '').trim();
                        const proposalName = looksLikeFullName(fullNameCandidate)
                            ? fullNameCandidate
                            : looksLikeFullName(lastKnownName)
                                ? lastKnownName
                                : '';

                        if (proposalName) {
                            const proposalCourse = String(
                                liveSalesContext.course_display_name
                                || leadSnapshot?.curso_interesse
                                || 'nao informado',
                            ).trim();
                            const proposalCity = String(leadSnapshot?.cidade || 'nao informada').trim();
                            const proposalMotivation = String(
                                liveSalesContext.motivacao_principal
                                || leadSnapshot?.dor_principal
                                || 'nao informado',
                            ).trim();

                            await supabase
                                .from('leads')
                                .update({
                                    nome: proposalName,
                                    updated_at: new Date().toISOString(),
                                })
                                .eq('id', payload.lead_id);

                            await createCheckpointAndPause({
                                checkpointAdmin: 'proposal_send',
                                motivoPausa: 'aguardando_geracao_envio_proposta',
                                adminText:
                                    `Alerta interno: lead solicitou proposta para o curso de ${proposalCourse}\n\n` +
                                    `Nome Completo do Lead: ${proposalName}\n` +
                                    `Tel: ${payload.telefone}\n` +
                                    `Etapa atual: E4\n` +
                                    `Curso: ${proposalCourse}\n\n` +
                                    `Detalhes\n` +
                                    `Cidade: ${proposalCity}\n` +
                                    `Motivo: ${proposalMotivation}`,
                                salesContextPatch: {
                                    proposal_full_name: proposalName,
                                    proposal_checkpoint_pending: true,
                                    proposal_checkpoint_completed: false,
                                },
                                resumeFrom: 'E4',
                            });

                            stageOutput.handoff = false;
                            stageOutput.avancou = false;
                            stageOutput.skipTakeoverSend = true;
                            stageOutput.toolCalls = filterHandoffToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE4ProposalPauseFallback();
                        } else {
                            stageOutput.handoff = false;
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterHandoffToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE4ProposalRequestFallback();
                        }
                    } else if (!enrollmentCompleted && userRequestedEnrollment(activeLastUserMessage)) {
                        await createCheckpointAndPause({
                            checkpointAdmin: 'enrollment_processing',
                            motivoPausa: 'aguardando_conclusao_matricula_admin',
                            adminText:
                                `Concluir matricula deste lead.\n` +
                                `Lead: ${String(leadSnapshot?.nome || payload.nome_lead || payload.telefone)}\n` +
                                `Telefone: ${payload.telefone}\n` +
                                `Etapa pausada: E4\n` +
                                `Curso: ${String(leadSnapshot?.curso_interesse || '') || 'nao informado'}`,
                            salesContextPatch: {
                                enrollment_checkpoint_pending: true,
                                enrollment_checkpoint_completed: false,
                            },
                            resumeFrom: 'E5',
                        });

                        stageOutput.handoff = false;
                        stageOutput.avancou = false;
                        stageOutput.skipTakeoverSend = true;
                        stageOutput.toolCalls = filterHandoffToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        stageOutput.text = buildE4EnrollmentPauseFallback();
                    } else if (!enrollmentCompleted && stageOutput.avancou) {
                        stageOutput.avancou = false;
                        stageOutput.toolCalls = filterAdvanceToolCalls(stageOutput.toolCalls);
                    }
                }

                if (
                    currentSubagent === 'E4'
                    && userRequestedEnrollment(activeLastUserMessage)
                    && !stageOutput.avancou
                ) {
                    stageOutput.toolCalls = filterAdvanceToolCalls(stageOutput.toolCalls);
                }

                if (
                    currentSubagent === 'E5'
                    && (textRequestsModality(stageOutput.text) || textRequestsHighSchool(stageOutput.text) || textRequestsPaymentDetails(stageOutput.text))
                ) {
                    console.warn('[ai-processor] removendo pergunta legada em E5');
                    stageOutput.text = buildE5BoletoQuestionFallback();
                }

                if (currentSubagent === 'E5') {
                    const boletoChoice = detectBoletoDateChoice(activeLastUserMessage);
                    if (boletoChoice) {
                        const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                            boleto_date_choice: boletoChoice.kind,
                            boleto_date_label: boletoChoice.label,
                        });
                        leadSnapshot.sales_context = nextSalesContext;

                        if (boletoChoice.kind === 'custom') {
                            await notifyAdminIfNeeded(
                                'custom_boleto_date',
                                `custom_boleto_date_${payload.lead_id}_${boletoChoice.label}`,
                                `Lead pediu boleto em data especifica.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nData pedida: ${boletoChoice.label}`,
                            );
                            stageOutput.text = buildE5BoletoCustomDateFallback(boletoChoice.label);
                        } else if (boletoChoice.kind === 'today') {
                            stageOutput.text = buildE5BoletoTodayFallback();
                        } else {
                            stageOutput.text = buildE5BoletoNextMondayFallback();
                        }

                        stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        try {
                            const forcedAdvance = await tool_avancar_etapa({
                                supabase,
                                tenantId: payload.tenant_id,
                                leadId: payload.lead_id,
                                telefone: payload.telefone,
                                env: runtimeConfig.env,
                            }, { etapa_destino: 'E6' });

                            stageOutput.avancou = true;
                            stageOutput.toolCalls.push({
                                name: 'avancar_etapa',
                                args: { etapa_destino: 'E6' },
                                result: forcedAdvance,
                            });
                        } catch (forceAdvanceError) {
                            console.error(`[ai-processor] falha ao avancar E5->E6: ${String(forceAdvanceError)}`);
                            stageOutput.avancou = false;
                        }
                    } else if (stageOutput.avancou || !textAsksBoletoDate(stageOutput.text)) {
                        stageOutput.avancou = false;
                        stageOutput.toolCalls = filterAdvanceToolCalls(stageOutput.toolCalls);
                        stageOutput.text = buildE5BoletoQuestionFallback();
                    }
                }

                if (currentSubagent === 'E6') {
                    const e6Context = await readLeadSalesContext(supabase, payload.lead_id);
                    const normalizedE6Message = normalizeText(activeLastUserMessage);
                    const negativeFeedback = userDidNotRecommendService(activeLastUserMessage);
                    const explicitRecommendation = textIncludesAny(normalizedE6Message, ['recomendo', 'recomendaria']);
                    const positiveFeedback = !negativeFeedback && userRecommendedService(activeLastUserMessage);
                    const stopE6 = async (reason: string) => {
                        stageOutput.avancou = false;
                        stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        try {
                            const forcedAdvance = await tool_avancar_etapa({
                                supabase,
                                tenantId: payload.tenant_id,
                                leadId: payload.lead_id,
                                telefone: payload.telefone,
                                env: runtimeConfig.env,
                            }, { etapa_destino: 'E7' });
                            stageOutput.avancou = true;
                            stageOutput.toolCalls.push({
                                name: 'avancar_etapa',
                                args: { etapa_destino: 'E7' },
                                result: forcedAdvance,
                            });
                        } catch (forceAdvanceError) {
                            console.error(`[ai-processor] falha ao avancar E6->E7 ${reason}: ${String(forceAdvanceError)}`);
                            stageOutput.avancou = false;
                        }
                    };

                    const satisfactionResolvedThisTurn = String(stageState.classificationReason || '') === 'resolved_pending_service_satisfaction';
                    const satisfactionCollected = !satisfactionResolvedThisTurn
                        && (e6Context.e6_satisfaction_collected === true || e6Context.e6_feedback_collected === true);
                    if (!satisfactionCollected) {
                        if (negativeFeedback) {
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                e6_satisfaction_collected: true,
                                e6_satisfaction_positive: false,
                                e6_feedback_collected: true,
                                e6_recommended_service: false,
                                no_indication: true,
                                pending_criterion: null,
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.text = 'Entendo. Obrigado pela sinceridade.';
                            await stopE6('apos feedback negativo');
                        } else if (positiveFeedback) {
                            const recommendationAlreadyAnswered = explicitRecommendation;
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                e6_satisfaction_collected: true,
                                e6_satisfaction_positive: true,
                                e6_feedback_collected: recommendationAlreadyAnswered,
                                e6_recommended_service: recommendationAlreadyAnswered ? true : null,
                                no_indication: false,
                                pending_criterion: recommendationAlreadyAnswered ? 'referral_name' : 'service_recommendation',
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = recommendationAlreadyAnswered
                                ? buildE6AskIndicationNameFallback()
                                : buildE6RecommendationFallback();
                        } else {
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE6SatisfactionFallback();
                        }
                    } else if (e6Context.e6_feedback_collected !== true) {
                        if (negativeFeedback) {
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                e6_feedback_collected: true,
                                e6_recommended_service: false,
                                no_indication: true,
                                pending_criterion: null,
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.text = 'Tranquilo!!';
                            await stopE6('apos recomendacao negativa');
                        } else if (positiveFeedback) {
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                e6_feedback_collected: true,
                                e6_recommended_service: true,
                                no_indication: false,
                                pending_criterion: 'referral_name',
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE6AskIndicationNameFallback();
                        } else {
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE6RecommendationFallback();
                        }
                    } else if (e6Context.e6_recommended_service === true) {
                        if (userDeclinedIndication(activeLastUserMessage)) {
                            console.warn('[ai-processor] lead sem indicacao; avancando E6->E7');
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                no_indication: true,
                                pending_indication_name: null,
                                pending_criterion: null,
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.text = buildE6NoIndicationFallback();
                            await stopE6('sem indicacao');
                        } else if (!String(e6Context.pending_indication_name || '').trim() && looksLikePersonNameReply(activeLastUserMessage)) {
                            console.warn('[ai-processor] capturando nome do indicado em E6');
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                pending_indication_name: activeLastUserMessage.trim(),
                                pending_criterion: 'referral_phone',
                            });
                            leadSnapshot.sales_context = nextSalesContext;
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = buildE6PhoneFallback();
                        } else if (String(e6Context.pending_indication_name || '').trim() && looksLikePhoneReply(activeLastUserMessage)) {
                            console.warn('[ai-processor] registrando indicacao em E6 a partir do telefone informado');
                            const indicatedName = String(e6Context.pending_indication_name || '').trim();
                            stageOutput.text = '';
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            try {
                                const indicationResult = await tool_registrar_indicacao({
                                    supabase,
                                    tenantId: payload.tenant_id,
                                    leadId: payload.lead_id,
                                    telefone: payload.telefone,
                                    env: runtimeConfig.env,
                                }, {
                                    telefone_indicado: activeLastUserMessage.trim(),
                                    nome_indicado: indicatedName,
                                });
                                stageOutput.toolCalls.push({
                                    name: 'registrar_indicacao',
                                    args: { telefone_indicado: activeLastUserMessage.trim(), nome_indicado: indicatedName },
                                    result: indicationResult,
                                });
                                await mergeLeadSalesContext(supabase, payload.lead_id, {
                                    pending_indication_name: null,
                                    pending_indication_phone: activeLastUserMessage.trim(),
                                    referral_registered: true,
                                    last_indicated_name: indicatedName,
                                    pending_criterion: null,
                                });
                                await stopE6('apos registrar indicacao');
                            } catch (indicationError) {
                                console.error(`[ai-processor] falha ao registrar indicacao em E6: ${String(indicationError)}`);
                                stageOutput.avancou = false;
                                stageOutput.text = buildE6PhoneFallback();
                            }
                        } else {
                            stageOutput.avancou = false;
                            stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                            stageOutput.text = String(e6Context.pending_indication_name || '').trim()
                                ? buildE6PhoneFallback()
                                : buildE6AskIndicationNameFallback();
                        }
                    } else {
                        stageOutput.text = buildE6NoIndicationFallback();
                        await stopE6('sem recomendacao');
                    }
                }

                if (currentSubagent === 'E7') {
                    const liveSalesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    if (liveSalesContext.referral_registered === true) {
                        stageOutput.text = buildE7ClosingFallback(String(liveSalesContext.last_indicated_name || '').trim());
                    } else if (liveSalesContext.no_indication === true && hop > 0) {
                        stageOutput.text = buildE7NoIndicationClosingFallback();
                    }
                }

                if (
                    stageOutput.deterministicReplyUsed === true
                    && stageOutput.text
                    && stageOutput.fallbackUsed !== true
                    && stageOutput.responseOrigin !== 'structural_contract_recovery'
                    && !(currentSubagent === 'E1' && ['ask_motivation', 'complete_stage'].includes(String(stageOutput.processAction || '').trim()))
                ) {
                    const originalOutput = stageOutput.text;
                    const regeneratedOutput = await runSubagent({
                        subagent: currentSubagent,
                        leadId: payload.lead_id,
                        telefone: payload.telefone,
                        etapaAtual: currentStage,
                        recentUserMessages: activeRecentUserMessages,
                        history: workingHistory,
                        messages: [],
                        trigger: hop === 0 ? (payload.trigger ?? 'whatsapp_inbound') : 'stage_handoff',
                        nomeDoLead: payload.nome_lead ?? null,
                        supabase,
                        tenantId: payload.tenant_id,
                        env: runtimeConfig.env,
                        messagePolicy: runtimeConfig.messagePolicy,
                        intelligence,
                        leadSnapshot,
                        regenerationContext: {
                            allowedIntent: stageOutput.allowedIntent || stageOutput.processAction || 'follow_stage_contract',
                            speakableFacts: stageOutput.speakableFacts || {},
                            forbiddenTopics: ['deterministic_normal_reply'],
                            originalOutput,
                        },
                    });

                    if (regeneratedOutput.text) {
                        stageOutput.text = regeneratedOutput.text;
                        stageOutput.rawModelOutput = regeneratedOutput.rawModelOutput || regeneratedOutput.outputBeforeGovernance || regeneratedOutput.text || null;
                        stageOutput.outputBeforeGovernance = regeneratedOutput.outputBeforeGovernance || regeneratedOutput.text || null;
                        stageOutput.responseOrigin = 'llm_regeneration';
                        stageOutput.deterministicReplyUsed = false;
                        stageOutput.stageContractViolation = true;
                        stageOutput.forbiddenTopicsDetected = [
                            ...(stageOutput.forbiddenTopicsDetected || []),
                            'deterministic_normal_reply',
                        ];
                        stageOutput.regenerationTriggered = true;
                        stageOutput.originalOutput = originalOutput;
                        stageOutput.regeneratedOutput = regeneratedOutput.text;
                        stageOutput.regenerationAttempt = Math.max(stageOutput.regenerationAttempt || 0, regeneratedOutput.regenerationAttempt || 1);
                    }
                }

                await applyPersonalityOutputGuard({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    payload,
                    runtimeConfig,
                    currentSubagent,
                    currentStage,
                    activeRecentUserMessages,
                    activeLastUserMessage,
                    workingHistory,
                    leadSnapshot,
                    intelligence,
                    stageOutput,
                });

                if (stageOutput.text) {
                    const { data: refreshedLeadSnapshot } = await supabase
                        .from('leads')
                        .select('nome, cidade, curso_interesse, modalidade, sales_context, etapa_atual')
                        .eq('id', payload.lead_id)
                        .maybeSingle();

                    const liveLeadBeforeAssistant = refreshedLeadSnapshot || leadSnapshot;
                    const derivedNextPendingCriterion = derivePendingCriterion({
                        stage: currentStage,
                        leadSnapshot: refreshedLeadSnapshot || leadSnapshot,
                        history: [
                            ...workingHistory,
                            { role: 'assistant', content: stageOutput.text },
                        ],
                    });
                    const lockedPendingCriterion = pendingCriterionFromProcessAction(stageOutput.processAction || null);
                    let nextPendingCriterion = lockedPendingCriterion !== undefined
                        ? lockedPendingCriterion
                        : derivedNextPendingCriterion;
                    if (
                        currentSubagent === 'E1'
                        && nextPendingCriterion === 'motivation'
                        && !isE1CityResolved(liveLeadBeforeAssistant)
                    ) {
                        const salesContext = { ...(liveLeadBeforeAssistant?.sales_context || {}) } as Record<string, unknown>;
                        const courseName = String(
                            salesContext.course_display_name
                            || liveLeadBeforeAssistant?.curso_interesse
                            || 'esse curso',
                        ).trim();
                        nextPendingCriterion = 'city';
                        stageOutput.processAction = 'ask_city';
                        stageOutput.allowedIntent = 'ask_city';
                        stageOutput.conversationalBehavior = 'ask_city';
                        stageOutput.pendingCriterionAfter = 'city';
                        stageOutput.responseOrigin = stageOutput.responseOrigin || 'llm_free_generation';
                        stageOutput.deterministicReplyUsed = false;
                        stageOutput.personalityViolations = [];
                        stageOutput.finalPersonalityValid = true;
                        await logLeadRuntimeEvent({
                            supabase,
                            tenantId: payload.tenant_id,
                            leadId: payload.lead_id,
                            eventType: 'test_e1_missing_city_guard',
                            payload: {
                                original_process_action: lockedPendingCriterion !== undefined
                                    ? stageOutput.processAction
                                    : null,
                                original_pending_criterion: derivedNextPendingCriterion,
                                enforced_pending_criterion: nextPendingCriterion,
                                city_resolved: false,
                                logged_at: new Date().toISOString(),
                            },
                        }).catch(() => {});
                    }
                    const lastAgentQuestionType = detectLastAgentQuestionType({
                        stage: currentStage,
                        text: stageOutput.text,
                        pendingCriterion: nextPendingCriterion,
                    });
                    if (currentSubagent === 'E1') {
                        const snapshotForNextCriterion = refreshedLeadSnapshot || leadSnapshot || {};
                        const snapshotSalesContext = { ...(snapshotForNextCriterion?.sales_context || {}) } as Record<string, unknown>;
                        const cityResolved = isE1CityResolved(snapshotForNextCriterion);
                        await logLeadRuntimeEvent({
                            supabase,
                            tenantId: payload.tenant_id,
                            leadId: payload.lead_id,
                            eventType: 'test_e1_next_criterion',
                            payload: {
                                pending_criterion_before: stageOutput.pendingCriterionBefore || null,
                                e1_state_snapshot_before_next_criterion: {
                                    course_status: String(snapshotSalesContext.course_status || '').trim() || null,
                                    selected_line: String(snapshotSalesContext.linha_formacao || '').trim() || null,
                                    city: String(snapshotForNextCriterion?.cidade || '').trim() || null,
                                    motivation: String(snapshotSalesContext.motivacao_principal || '').trim() || null,
                                },
                                e1_city_resolution: {
                                    city_value: String(snapshotForNextCriterion?.cidade || '').trim() || null,
                                    e1_city_confirmed: snapshotSalesContext.e1_city_confirmed === true,
                                    city_source: snapshotSalesContext.e1_city_confirmed === true ? 'current_flow' : 'unconfirmed_or_absent',
                                    city_resolved_boolean: cityResolved,
                                },
                                next_e1_criterion: nextPendingCriterion,
                                process_action_after: stageOutput.processAction || null,
                                logged_at: new Date().toISOString(),
                            },
                        }).catch(() => {});
                    }
                    const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                        pending_criterion: nextPendingCriterion,
                        last_agent_question_type: lastAgentQuestionType,
                    });
                    if (leadSnapshot) {
                        if (refreshedLeadSnapshot) {
                            Object.assign(leadSnapshot, refreshedLeadSnapshot);
                        }
                        leadSnapshot.sales_context = nextSalesContext;
                    }
                    collectedTexts.push({
                        stage: currentSubagent,
                        text: stageOutput.text,
                    });
                    workingHistory = [
                        ...workingHistory,
                        { role: 'assistant', content: stageOutput.text },
                    ];
                }
                collectedToolCalls = [...collectedToolCalls, ...(stageOutput.toolCalls ?? [])];

                if (!stageOutput.handoff && !stageOutput.avancou && currentSubagent === 'E1') {
                    const { data: e1LeadSnapshot } = await supabase
                        .from('leads')
                        .select('nome, cidade, curso_interesse, modalidade, sales_context, etapa_atual')
                        .eq('id', payload.lead_id)
                        .maybeSingle();

                    const shouldForceAdvance = shouldForceAdvanceFromE1({
                        leadSnapshot: e1LeadSnapshot,
                    });

                    if (shouldForceAdvance) {
                        console.log('[ai-processor] E1 concluida sem avancar_etapa explicito; aplicando avance estrutural para E2');
                        stageOutput.processAction = 'complete_stage';
                        stageOutput.pendingCriterionAfter = null;
                        stageOutput.allowedIntent = 'complete_e1_and_handoff_to_e2';
                        stageOutput.conversationalBehavior = 'optional_short_contextual_acknowledgement';
                        const modelCompletionText = extractModelCompletionAcknowledgement(stageOutput.text || stageOutput.rawModelOutput || stageOutput.outputBeforeGovernance);
                        stageOutput.text = modelCompletionText || '';
                        await logLeadRuntimeEvent({
                            supabase,
                            tenantId: payload.tenant_id,
                            leadId: payload.lead_id,
                            eventType: 'test_forced_stage_advance',
                            payload: {
                                from_stage: currentStage,
                                to_stage: 'E2',
                                reason: 'e1_completed_without_explicit_tool',
                                stage_before_handoff: currentStage,
                                contract_before_handoff: {
                                    pending_criterion_before: stageOutput.pendingCriterionBefore || null,
                                    pending_criterion_after: stageOutput.pendingCriterionAfter || null,
                                    process_action: stageOutput.processAction || null,
                                    allowed_intent: stageOutput.allowedIntent || null,
                                    conversational_behavior: stageOutput.conversationalBehavior || null,
                                },
                                texto_gerado: stageOutput.text ?? null,
                                logged_at: new Date().toISOString(),
                            },
                        }).catch(() => {});
                        try {
                            const forcedAdvance = await tool_avancar_etapa({
                                supabase,
                                tenantId: payload.tenant_id,
                                leadId: payload.lead_id,
                                telefone: payload.telefone,
                                env: runtimeConfig.env,
                            }, { etapa_destino: 'E2' });

                            stageOutput.avancou = true;
                            collectedToolCalls.push({
                                name: 'avancar_etapa',
                                args: { etapa_destino: 'E2' },
                                result: forcedAdvance,
                            });
                        } catch (forceAdvanceError) {
                            console.error(`[ai-processor] falha ao aplicar avance estrutural E1->E2: ${String(forceAdvanceError)}`);
                        }
                        const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                            pending_criterion: null,
                            last_agent_question_type: null,
                        });
                        if (leadSnapshot) {
                            leadSnapshot.sales_context = nextSalesContext;
                        }
                    }
                }

                if (currentSubagent === 'E2') {
                    const e2SalesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    const e2Completed = isE2AdvanceStructurallyValid({
                        history: workingHistory,
                        recentUserMessages: activeRecentUserMessages,
                        salesContext: e2SalesContext,
                    });

                    if (e2Completed) {
                        stageOutput.processAction = 'complete_stage';
                        stageOutput.allowedIntent = 'complete_e2_and_handoff_to_e3';
                        stageOutput.conversationalBehavior = 'optional_short_contextual_acknowledgement';
                        stageOutput.pendingCriterionAfter = null;
                        const modelCompletionText = extractModelCompletionAcknowledgement(stageOutput.text || stageOutput.rawModelOutput || stageOutput.outputBeforeGovernance);
                        stageOutput.text = modelCompletionText || buildE2CompletionFallback();
                        stageOutput.deterministicReplyUsed = !modelCompletionText;
                        stageOutput.responseOrigin = modelCompletionText ? (stageOutput.responseOrigin || 'llm_free_generation') : 'structural_fallback';

                        if (!stageOutput.avancou) {
                            try {
                                const forcedAdvance = await tool_avancar_etapa({
                                    supabase,
                                    tenantId: payload.tenant_id,
                                    leadId: payload.lead_id,
                                    telefone: payload.telefone,
                                    env: runtimeConfig.env,
                                }, { etapa_destino: 'E3' });

                                stageOutput.avancou = true;
                                collectedToolCalls.push({
                                    name: 'avancar_etapa',
                                    args: { etapa_destino: 'E3' },
                                    result: forcedAdvance,
                                });
                            } catch (forceAdvanceError) {
                                console.error(`[ai-processor] falha ao aplicar avance estrutural E2->E3: ${String(forceAdvanceError)}`);
                            }
                            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                                pending_criterion: null,
                                last_agent_question_type: null,
                            });
                            if (leadSnapshot) {
                                leadSnapshot.sales_context = nextSalesContext;
                            }
                        }
                    }
                }

                syncLatestAssistantArtifacts({
                    collectedTexts,
                    workingHistory,
                    currentSubagent,
                    text: stageOutput.text,
                });

                lastOutput = stageOutput;
                finalSubagent = currentSubagent;
                const advanceCallForTrace = [...(stageOutput.toolCalls || []), ...collectedToolCalls]
                    .reverse()
                    .find((call: any) => call?.name === 'avancar_etapa');
                const stageAfterForTrace = stageOutput.avancou === true
                    ? String((advanceCallForTrace?.args as any)?.etapa_destino || (advanceCallForTrace?.result as any)?.etapa_destino || '').trim() || null
                    : currentStage;
                emitDebugLlmTrace(runtimeConfig.env, {
                    trace_type: 'agenthub_llm_forensic_trace',
                    hop,
                    stage: currentSubagent,
                    stage_before: currentStage,
                    stage_after: stageAfterForTrace,
                    trigger: hop === 0 ? (payload.trigger ?? 'whatsapp_inbound') : 'stage_handoff',
                    lead_id: payload.lead_id,
                    tenant_id: payload.tenant_id,
                    subagent_trace: stageOutput.llmTrace || null,
                    regeneration_llm_trace: stageOutput.regenerationLlmTrace || null,
                    processAction: stageOutput.processAction || null,
                    pendingCriterion: stageOutput.pendingCriterionAfter || null,
                    pendingCriterionBefore: stageOutput.pendingCriterionBefore || null,
                    pendingCriterionAfter: stageOutput.pendingCriterionAfter || null,
                    responseContract: {
                        processAction: stageOutput.processAction || null,
                        conversationalBehavior: stageOutput.conversationalBehavior || null,
                        allowedIntent: stageOutput.allowedIntent || null,
                        speakableFacts: stageOutput.speakableFacts || null,
                        pendingCriterionBefore: stageOutput.pendingCriterionBefore || null,
                        pendingCriterionAfter: stageOutput.pendingCriterionAfter || null,
                    },
                    conversationalBehavior: stageOutput.conversationalBehavior || null,
                    allowedIntent: stageOutput.allowedIntent || null,
                    speakableFacts: stageOutput.speakableFacts || null,
                    model: stageOutput.llmTrace?.model || stageOutput.regenerationLlmTrace?.model || null,
                    effective_temperature: stageOutput.llmTrace?.effective_temperature || stageOutput.regenerationLlmTrace?.effective_temperature || null,
                    first_raw_output: stageOutput.rawModelOutput || stageOutput.llmTrace?.first_raw_output || null,
                    guard_result: {
                        personality_guard_triggered: stageOutput.personalityGuardTriggered === true,
                        final_personality_valid: stageOutput.finalPersonalityValid !== false,
                        flow_narration_detected: stageOutput.flowNarrationDetected === true,
                        repeated_fact_detected: stageOutput.repeatedFactDetected === true,
                        ungrounded_output_detected: stageOutput.ungroundedOutputDetected === true,
                        unauthorized_stage_fact_detected: stageOutput.unauthorizedStageFactDetected === true,
                    },
                    violations: stageOutput.personalityViolations || stageOutput.forbiddenTopicsDetected || [],
                    guard_runs: stageOutput.guardRuns || [],
                    regeneration_context: stageOutput.regenerationLlmTrace?.regeneration_context || null,
                    regeneration_output: stageOutput.regeneratedOutput || stageOutput.regenerationLlmTrace?.regeneration_output || null,
                    final_output: stageOutput.text || null,
                    tool_results: stageOutput.toolCalls || [],
                    deterministic_reply_used: stageOutput.deterministicReplyUsed === true,
                    fallback_used: stageOutput.fallbackUsed === true,
                    fallback_reason: stageOutput.fallbackReason || null,
                });
                console.log(`[ai-processor] stage ${currentSubagent} tool_calls=${(stageOutput.toolCalls ?? []).map((call: any) => call.name).join(',') || 'none'} avancou=${stageOutput.avancou} handoff=${stageOutput.handoff}`);
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_stage_result',
                    payload: {
                        ...extractLatestCourseLookupDiagnostics(stageOutput.toolCalls ?? []),
                        stage: currentSubagent,
                        etapa_atual: currentStage,
                        texto_gerado: stageOutput.text ?? null,
                        final_output: stageOutput.text ?? null,
                        tool_calls: stageOutput.toolCalls ?? [],
                        avancou: stageOutput.avancou,
                        handoff: stageOutput.handoff,
                        iterations: stageOutput.iterations,
                        response_origin: stageOutput.responseOrigin || 'llm_free_generation',
                        deterministic_reply_used: stageOutput.deterministicReplyUsed === true,
                        fallback_used: stageOutput.fallbackUsed === true,
                        fallback_reason: stageOutput.fallbackReason || null,
                        output_before_governance: stageOutput.outputBeforeGovernance || stageOutput.text || null,
                        raw_model_output: stageOutput.rawModelOutput || stageOutput.outputBeforeGovernance || stageOutput.text || null,
                        pending_criterion_before: stageOutput.pendingCriterionBefore || null,
                        pending_criterion_after: stageOutput.pendingCriterionAfter || null,
                        allowed_intent: stageOutput.allowedIntent || null,
                        process_action: stageOutput.processAction || null,
                        conversational_behavior: stageOutput.conversationalBehavior || null,
                        speakable_facts: stageOutput.speakableFacts || null,
                        personality_prompt_id: stageOutput.personalityPromptId || null,
                        stage_prompt_id: stageOutput.stagePromptId || null,
                        stage_contract_violation: stageOutput.stageContractViolation === true,
                        forbidden_topics_detected: stageOutput.forbiddenTopicsDetected || [],
                        regeneration_triggered: stageOutput.regenerationTriggered === true,
                        original_output: stageOutput.originalOutput || null,
                        regenerated_output: stageOutput.regeneratedOutput || null,
                        sanitizer_applied: stageOutput.sanitizerApplied === true,
                        sanitizer_reason: stageOutput.sanitizerReason || null,
                        sanitizer_before: stageOutput.sanitizerBefore || null,
                        sanitizer_after: stageOutput.sanitizerAfter || null,
                        personality_guard_triggered: stageOutput.personalityGuardTriggered === true,
                        personality_violations: stageOutput.personalityViolations || [],
                        flow_narration_detected: stageOutput.flowNarrationDetected === true,
                        repeated_fact_detected: stageOutput.repeatedFactDetected === true,
                        ungrounded_output_detected: stageOutput.ungroundedOutputDetected === true,
                        unauthorized_stage_fact_detected: stageOutput.unauthorizedStageFactDetected === true,
                        regeneration_attempt: stageOutput.regenerationAttempt || 0,
                        regeneration_success: stageOutput.regenerationSuccess === true,
                        guard_runs: stageOutput.guardRuns || [],
                        final_output_source: stageOutput.regenerationTriggered === true
                            ? `regenerated_${stageOutput.regenerationAttempt || 1}`
                            : stageOutput.fallbackUsed === true
                                ? 'technical_failure'
                                : 'raw_model',
                        final_personality_valid: stageOutput.finalPersonalityValid !== false,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});

                if (stageOutput.handoff || !stageOutput.avancou) {
                    break;
                }

                const { data: updatedLead } = await supabase
                    .from('leads')
                    .select('etapa_atual')
                    .eq('id', payload.lead_id)
                    .maybeSingle();

                const nextStage = updatedLead?.etapa_atual || currentStage;
                if (!nextStage || nextStage === currentStage) {
                    break;
                }

                if (['handoff', 'encerrado', 'inativo'].includes(nextStage)) {
                    currentStage = nextStage;
                    break;
                }

                console.log(`[ai-processor] troca automatica de etapa: ${currentStage} -> ${nextStage}`);
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_stage_transition',
                    payload: {
                        from_stage: currentStage,
                        to_stage: nextStage,
                        contract_after_handoff: nextStage === 'E2'
                            ? {
                                pending_criterion: 'vaccine_availability',
                              }
                            : null,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
                currentStage = nextStage;
                currentSubagent = routeByEtapa(nextStage);
                if (nextStage === 'E2') {
                    const { data: handoffLeadSnapshot, error: handoffReadError } = await supabase
                        .from('leads').select('*').eq('id', payload.lead_id).single();
                    if (handoffReadError) throw handoffReadError;
                    Object.assign(leadSnapshot, handoffLeadSnapshot);
                    continue;
                }
                if (nextStage === 'E3' || nextStage === 'E4') {
                    continue;
                }
                break;
            }

            out = {
                text: (() => {
                    const uniqueStages = Array.from(new Set(collectedTexts.map((item) => item.stage)));
                    if (uniqueStages.length === 2 && uniqueStages[0] === 'E1' && uniqueStages[1] === 'E2') {
                        return collectedTexts.map((item) => item.text).filter(Boolean).join('\n\n');
                    }
                    if (uniqueStages.length > 1) {
                        return collectedTexts.slice(-1)[0]?.text || '';
                    }
                    return joinAssistantTexts(collectedTexts.map((item) => item.text));
                })(),
                toolCalls: collectedToolCalls,
                handoff: lastOutput?.handoff ?? false,
                avancou: lastOutput?.avancou ?? false,
                iterations: lastOutput?.iterations ?? 0,
                skipTakeoverSend: lastOutput?.skipTakeoverSend === true,
                responseOrigin: lastOutput?.responseOrigin || 'llm_free_generation',
                deterministicReplyUsed: lastOutput?.deterministicReplyUsed === true,
                fallbackUsed: lastOutput?.fallbackUsed === true,
                fallbackReason: lastOutput?.fallbackReason || null,
                outputBeforeGovernance: lastOutput?.outputBeforeGovernance || null,
                rawModelOutput: lastOutput?.rawModelOutput || null,
                pendingCriterionBefore: lastOutput?.pendingCriterionBefore || null,
                pendingCriterionAfter: lastOutput?.pendingCriterionAfter || null,
                allowedIntent: lastOutput?.allowedIntent || null,
                processAction: lastOutput?.processAction || null,
                conversationalBehavior: lastOutput?.conversationalBehavior || null,
                speakableFacts: lastOutput?.speakableFacts || null,
                personalityPromptId: lastOutput?.personalityPromptId || null,
                stagePromptId: lastOutput?.stagePromptId || null,
                stageContractViolation: lastOutput?.stageContractViolation === true,
                forbiddenTopicsDetected: lastOutput?.forbiddenTopicsDetected || [],
                regenerationTriggered: lastOutput?.regenerationTriggered === true,
                originalOutput: lastOutput?.originalOutput || null,
                regeneratedOutput: lastOutput?.regeneratedOutput || null,
                personalityGuardTriggered: lastOutput?.personalityGuardTriggered === true,
                personalityViolations: lastOutput?.personalityViolations || [],
                flowNarrationDetected: lastOutput?.flowNarrationDetected === true,
                repeatedFactDetected: lastOutput?.repeatedFactDetected === true,
                ungroundedOutputDetected: lastOutput?.ungroundedOutputDetected === true,
                unauthorizedStageFactDetected: lastOutput?.unauthorizedStageFactDetected === true,
                regenerationAttempt: lastOutput?.regenerationAttempt || 0,
                regenerationSuccess: lastOutput?.regenerationSuccess === true,
                guardRuns: lastOutput?.guardRuns || [],
                finalOutputSource: lastOutput?.finalOutputSource || 'raw_model',
                finalPersonalityValid: lastOutput?.finalPersonalityValid !== false,
                atomicMessages: collectedTexts.length === 2 && collectedTexts[0].stage === 'E1' && collectedTexts[1].stage === 'E2'
                    ? collectedTexts.map((item) => item.text).filter(Boolean)
                    : Array.isArray(lastOutput?.atomicMessages) ? lastOutput.atomicMessages : null,
                institutionalClaimsPending: Array.isArray(lastOutput?.institutionalClaimsPending) ? lastOutput.institutionalClaimsPending : [],
            };
        }

        console.log(`[ai-processor] subagente concluiu — text: ${!!out.text}, iterations: ${out.iterations}, handoff: ${out.handoff}`);

        if (out.text) {
            const isE3Presentation = finalSubagent === 'E3'
                && String(out.processAction || '').trim() === 'present_e3_structured_blocks';
            const validatedOutbound = isE3Presentation
                ? { text: out.text, changed: false, reasons: [] as string[] }
                : validateOutboundText(out.text);
            if (validatedOutbound.changed) {
                console.warn('[ai-processor] validador final de saida ajustou a mensagem antes do envio');
                out.text = validatedOutbound.text;
                if (Array.isArray(out.atomicMessages) && out.atomicMessages.length > 0) {
                    out.atomicMessages = finalSubagent === 'E3'
                        ? splitValidatedE3Blocks(validatedOutbound.text)
                        : [validatedOutbound.text];
                }
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_output_validated',
                    payload: {
                        final_subagent: finalSubagent,
                        final_stage: currentStage,
                        reasons: validatedOutbound.reasons,
                        texto_final: out.text,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }

            const lastReceivedAt = payload.last_received_at || payload.consolidated_at || null;
            if (lastReceivedAt) {
                const elapsedBeforeSend = Date.now() - new Date(lastReceivedAt).getTime();
                const waitBeforeSendMs = Math.max(0, RESPONSE_SEND_DELAY_MS - elapsedBeforeSend);
                if (waitBeforeSendMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, waitBeforeSendMs));
                }
            }

            const senderUrl = `${env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
            console.log(`[ai-processor] enviando resposta para ${payload.telefone} via whatsapp-sender`);
            const courseLookupDiagnostics = extractLatestCourseLookupDiagnostics(out.toolCalls ?? []);
            const isCatalogAreaTurn = payload.etapa_atual === 'E1'
                && (
                    String(stageState?.classificationReason || '') === 'selected_catalog_area'
                    || String(out.processAction || '') === 'present_area_courses_and_wait_selection'
                    || String(out.allowedIntent || '') === 'present_real_courses_from_selected_area_and_wait_for_course_choice'
                );
            if (isCatalogAreaTurn) {
                const catalogModeBefore = String(salesContextBeforeInbound.catalog_mode || '').trim() || null;
                const selectedAreaCandidate = String(stageState?.statePatch?.selected_area || stageState?.statePatch?.requested_area_name || courseLookupDiagnostics.requested_area || '').trim() || null;
                const availableAreaCourses = Array.isArray(courseLookupDiagnostics.available_area_courses)
                    ? courseLookupDiagnostics.available_area_courses
                    : [];
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_catalog_area_selection_trace',
                    payload: {
                        raw_inbound: lastUserMessage,
                        normalized_inbound: normalizeText(lastUserMessage),
                        catalog_mode_before: catalogModeBefore,
                        pending_criterion_before: pendingCriterion || out.pendingCriterionBefore || null,
                        catalog_area_match_candidate: selectedAreaCandidate,
                        selected_area_candidate: selectedAreaCandidate,
                        selected_area_after: String(leadSnapshot?.sales_context?.selected_area || leadSnapshot?.sales_context?.requested_area_name || selectedAreaCandidate || '').trim() || null,
                        catalog_mode_after: String(leadSnapshot?.sales_context?.catalog_mode || '').trim() || null,
                        pending_criterion_after: out.pendingCriterionAfter || leadSnapshot?.sales_context?.pending_criterion || null,
                        next_catalog_action: getNextCatalogAction({ leadSnapshot }),
                        process_action: out.processAction || null,
                        available_area_courses_count: availableAreaCourses.length,
                        available_area_courses: availableAreaCourses,
                        subagent_called: finalSubagent,
                        raw_model_output: out.rawModelOutput || out.outputBeforeGovernance || out.text || null,
                        guard_violations: out.personalityViolations || out.forbiddenTopicsDetected || [],
                        final_output: out.text || null,
                        outbound_created: Boolean(out.text),
                        outbound_sent: false,
                        error: null,
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_response_ready',
                payload: {
                    ...courseLookupDiagnostics,
                    final_subagent: finalSubagent,
                    final_stage: currentStage,
                    texto_final: out.text,
                    final_output: out.text,
                    response_origin: out.responseOrigin || 'llm_free_generation',
                    deterministic_reply_used: out.deterministicReplyUsed === true,
                    fallback_used: out.fallbackUsed === true,
                    fallback_reason: out.fallbackReason || null,
                    output_before_governance: out.outputBeforeGovernance || out.text,
                    raw_model_output: out.rawModelOutput || out.outputBeforeGovernance || out.text,
                    pending_criterion_before: out.pendingCriterionBefore || null,
                    pending_criterion_after: out.pendingCriterionAfter || null,
                    allowed_intent: out.allowedIntent || null,
                    process_action: out.processAction || null,
                    conversational_behavior: out.conversationalBehavior || null,
                    speakable_facts: out.speakableFacts || null,
                    personality_prompt_id: out.personalityPromptId || null,
                    stage_prompt_id: out.stagePromptId || null,
                    stage_contract_violation: out.stageContractViolation === true,
                    forbidden_topics_detected: out.forbiddenTopicsDetected || [],
                    regeneration_triggered: out.regenerationTriggered === true,
                    original_output: out.originalOutput || null,
                    regenerated_output: out.regeneratedOutput || null,
                    sanitizer_applied: out.sanitizerApplied === true,
                    sanitizer_reason: out.sanitizerReason || null,
                    sanitizer_before: out.sanitizerBefore || null,
                    sanitizer_after: out.sanitizerAfter || null,
                    atomic_messages: Array.isArray(out.atomicMessages) ? out.atomicMessages : null,
                    institutional_claims_pending: Array.isArray(out.institutionalClaimsPending) ? out.institutionalClaimsPending : [],
                    personality_guard_triggered: out.personalityGuardTriggered === true,
                    personality_violations: out.personalityViolations || [],
                    flow_narration_detected: out.flowNarrationDetected === true,
                    repeated_fact_detected: out.repeatedFactDetected === true,
                    ungrounded_output_detected: out.ungroundedOutputDetected === true,
                    unauthorized_stage_fact_detected: out.unauthorizedStageFactDetected === true,
                    regeneration_attempt: out.regenerationAttempt || 0,
                    regeneration_success: out.regenerationSuccess === true,
                    guard_runs: out.guardRuns || [],
                    final_output_source: out.regenerationTriggered === true
                        ? `regenerated_${out.regenerationAttempt || 1}`
                        : out.fallbackUsed === true
                            ? 'technical_failure'
                            : 'raw_model',
                    final_personality_valid: out.finalPersonalityValid !== false,
                    tool_calls: out.toolCalls ?? [],
                    iterations: out.iterations,
                    handoff: out.handoff,
                    ready_at: new Date().toISOString(),
                },
            }).catch(() => {});

            if (Array.isArray(out.atomicMessages) && out.atomicMessages.length > 0) {
                const atomicText = out.atomicMessages.map((part: unknown) => String(part || '').trim()).filter(Boolean).join('\n\n');
                if (normalizeText(atomicText) !== normalizeText(out.text)) {
                    const preserveValidatedE3Presentation = finalSubagent === 'E3'
                        && String(out.processAction || '').trim() === 'present_e3_structured_blocks'
                        && out.atomicMessages.length === 4;
                    if (!preserveValidatedE3Presentation) {
                        out.atomicMessages = finalSubagent === 'E3'
                            ? splitValidatedE3Blocks(out.text)
                            : [out.text];
                    }
                }
            }
            if (
                finalSubagent === 'E3'
                && String(out.processAction || '').trim() !== 'answer_e3_specific_question'
            ) {
                const e3Blocks = splitValidatedE3Blocks(out.text);
                if ([3, 4].includes(e3Blocks.length)) {
                    out.atomicMessages = e3Blocks;
                }
            }

            const outboundParts = Array.isArray(out.atomicMessages) && out.atomicMessages.length > 0
                ? out.atomicMessages.map((part: unknown) => String(part || '').trim()).filter(Boolean)
                : [out.text];
            let totalSent = 0;
            const governedOutputParts: string[] = [];
            const senderPayloadParts: string[] = [];
            const sentOutputParts: string[] = [];
            const senderErrors: string[] = [];

            for (const outboundText of outboundParts) {
                const sendRes = await fetch(senderUrl, {
                method: 'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                    lead_id:  payload.lead_id,
                    telefone: payload.telefone,
                    text:     outboundText,
                    subagente_usado: finalSubagent,
                    iteracoes: out.iterations,
                    tool_calls: out.toolCalls ?? [],
                    skip_takeover: out.skipTakeoverSend === true,
                    skip_governance: outboundParts.length > 1 || (finalSubagent === 'E3' && String(out.processAction || '').trim() === 'present_e3_structured_blocks'),
                    final_output_source: out.finalOutputSource || out.responseOrigin || 'raw_model',
                }),
                });

            if (!sendRes.ok) {
                const errBody = await sendRes.text().catch(() => '');
                console.error(`[ai-processor] whatsapp-sender erro ${sendRes.status}: ${errBody}`);
                senderErrors.push(errBody || `http_${sendRes.status}`);
                break;
            } else {
                const sendData = await sendRes.json().catch(() => ({}));
                totalSent += Number(sendData.mensagens_enviadas ?? 1);
                governedOutputParts.push(...(Array.isArray(sendData.governed_output_parts) ? sendData.governed_output_parts.map((part: unknown) => String(part || '')) : []));
                senderPayloadParts.push(...(Array.isArray(sendData.sender_payload_parts) ? sendData.sender_payload_parts.map((part: unknown) => String(part || '')) : [outboundText]));
                sentOutputParts.push(...(Array.isArray(sendData.sent_output_parts) ? sendData.sent_output_parts.map((part: unknown) => String(part || '')) : []));
                console.log(`[ai-processor] mensagem(ns) enviada(s) — total: ${sendData.mensagens_enviadas ?? 1}`);
                if (sendData?.ok === false || sendData?.first_error) {
                    console.error(`[ai-processor] detalhe do sender: ${sendData?.first_error ?? 'envio sem sucesso'}`);
                    senderErrors.push(String(sendData?.first_error ?? 'envio_sem_sucesso'));
                    break;
                }
            }
            console.log(`[ai-processor] mensagens enviadas total=${totalSent}`);
            }
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_response_sent_trace',
                payload: {
                    ...courseLookupDiagnostics,
                    final_subagent: finalSubagent,
                    final_stage: currentStage,
                    raw_model_output: out.rawModelOutput || null,
                    regenerated_outputs: out.regeneratedOutput ? [out.regeneratedOutput] : [],
                    validated_output: out.text,
                    governed_output_parts: governedOutputParts.length > 0 ? governedOutputParts : outboundParts,
                    sender_payload_parts: senderPayloadParts.length > 0 ? senderPayloadParts : outboundParts,
                    sent_output_parts: sentOutputParts,
                    final_output: sentOutputParts.length > 0 ? sentOutputParts.join('\n---\n') : null,
                    final_output_source: out.regenerationTriggered === true
                        ? `regenerated_${out.regenerationAttempt || 1}`
                        : out.fallbackUsed === true
                            ? 'technical_failure'
                            : 'raw_model',
                    deterministic_reply_used: out.deterministicReplyUsed === true,
                    fallback_used: out.fallbackUsed === true,
                    sender_errors: senderErrors,
                    total_sent: totalSent,
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
            if (isCatalogAreaTurn) {
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'test_catalog_area_selection_trace_sent',
                    payload: {
                        raw_inbound: lastUserMessage,
                        normalized_inbound: normalizeText(lastUserMessage),
                        process_action: out.processAction || null,
                        final_output: out.text || null,
                        outbound_created: Boolean(out.text),
                        outbound_sent: totalSent > 0,
                        outbound_sent_count: totalSent,
                        error: totalSent > 0 ? null : 'sender_returned_zero_messages',
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }
        } else {
            console.warn('[ai-processor] subagente não gerou texto (só tool calls ou vazio)');
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_no_text_output',
                payload: {
                    final_subagent: finalSubagent,
                    final_stage: currentStage,
                    tool_calls: out.toolCalls ?? [],
                    iterations: out.iterations,
                    handoff: out.handoff,
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
            if (!out.handoff && !out.avancou) {
                await logLeadRuntimeEvent({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    eventType: 'unhandled_inbound_terminal_state',
                    payload: {
                        final_subagent: finalSubagent,
                        final_stage: currentStage,
                        lead_active: true,
                        checkpoint_pending: false,
                        debounce_group_id: payload.debounce_group_id ?? null,
                        processing_job_id: payload.processing_job_id ?? null,
                        reason: 'pipeline_finished_without_text_or_handoff',
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
            }
        }

        if (out.text) {
            const userMsg = (payload.recent_user_messages ?? []).slice(-1)[0] ?? '';
            runJudgeWithPreFilter({
                tenantId:    payload.tenant_id,
                leadId:      payload.lead_id,
                telefone:    payload.telefone,
                userMessage: userMsg,
                aiResponse:  out.text,
                agentKey:    finalSubagent,
                trace,
            }).catch(() => {});
        }

        // ── Agendar follow-up proativo para leads ativos ──────────────────────
        const etapasAtivas = ['E1','E2','E3','E4','E5','E6'];
        const { data: finalLeadStageData } = await supabase
            .from('leads')
            .select('nome, curso_interesse, dor_principal, etapa_atual, sales_context')
            .eq('id', payload.lead_id)
            .single();
        const finalLeadStage = finalLeadStageData?.etapa_atual ?? currentStage ?? payload.etapa_atual;
        if (finalLeadStage && etapasAtivas.includes(finalLeadStage) && !out.handoff) {
            await supabase
                .from('followup_schedule')
                .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                .eq('lead_id', payload.lead_id)
                .eq('status', 'pending');

            const finalSalesContext = { ...(finalLeadStageData?.sales_context || {}) } as Record<string, unknown>;
            const e4ProposalNegotiationOpen = finalLeadStage === 'E4'
                && finalSalesContext.proposal_checkpoint_completed === true
                && finalSalesContext.enrollment_checkpoint_completed !== true;

            if (e4ProposalFollowupContext) {
                await scheduleE4ProposalCommitmentFollowup({
                    supabase,
                    tenantId: payload.tenant_id,
                    leadId: payload.lead_id,
                    context: e4ProposalFollowupContext,
                });
                await mergeLeadSalesContext(supabase, payload.lead_id, {
                    e4_proposal_followup_scheduled: true,
                    e4_proposal_followup_scheduled_at: new Date().toISOString(),
                });
                console.log(`[ai-processor] follow-up de compromisso E4 agendado p/ ${String(e4ProposalFollowupContext.response_deadline)}`);
            } else if (!e4ProposalNegotiationOpen) {
                let scheduleAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

            // Ajusta para horário comercial se configurado
            const bh = runtimeConfig.businessHours;
            if (bh?.start && bh?.end) {
                const tz = bh.tz || 'America/Porto_Velho';
                const proposed = new Date(scheduleAt);
                const options: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false };
                const timeStr = proposed.toLocaleTimeString('pt-BR', options);
                const [h, m] = timeStr.split(':').map(Number);
                const currentMinutes = h * 60 + m;
                const [startH, startM] = bh.start.split(':').map(Number);
                const [endH, endM] = bh.end.split(':').map(Number);
                const startMinutes = startH * 60 + startM;
                const endMinutes = endH * 60 + endM;
                if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
                    // Ajusta para o próximo horário de início (amanhã se já passou)
                    const tomorrow = new Date(proposed);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(startH, startM, 0, 0);
                    scheduleAt = tomorrow.toISOString();
                }
            }

            await supabase
                .from('followup_schedule')
                .upsert({
                    lead_id: payload.lead_id,
                    tenant_id: payload.tenant_id,
                    attempt: 1,
                    max_attempts: 6,
                    schedule_at: scheduleAt,
                    trigger_reason: 'lead_parou',
                    last_context: finalLeadStageData ?? {},
                    status: 'pending',
                }, { onConflict: 'lead_id,attempt', ignoreDuplicates: false });

                console.log(`[ai-processor] follow-up #1 agendado p/ lead ${payload.lead_id} em ${scheduleAt}`);
            }
        }

        if (msg?.msg_id) {
            await markDebounceGroupStatus({
                supabase,
                debounceGroupId: payload.debounce_group_id || null,
                status: 'processed',
            }).catch(() => null);
            await deleteMessage(supabase, Q_AI, msg.msg_id);
        }
        trace.end({ subagent: finalSubagent, iterations: out.iterations, handoff: out.handoff, finalStage: currentStage }, 'ok');

        return new Response(JSON.stringify({ status: 'ok', subagent: finalSubagent, out, final_stage: currentStage }), {
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (e) {
        console.error(`[ai-processor] erro: ${String(e)}`);
        if (payload?.tenant_id && payload?.lead_id) {
            await logLeadRuntimeEvent({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                eventType: 'test_ai_processor_error',
                payload: {
                    etapa_atual: payload.etapa_atual ?? null,
                    trigger: payload.trigger ?? null,
                    texto: payload.text ?? null,
                    error: String(e),
                    logged_at: new Date().toISOString(),
                },
            }).catch(() => {});
        }
        trace.end({ error: String(e) }, 'error');
        if (msg?.msg_id) {
            await archiveMessage(supabase, Q_AI, msg.msg_id);
        }
        return new Response(JSON.stringify({ status: 'error', error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
});
