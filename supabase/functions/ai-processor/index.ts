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

function hasE1MotivationSignal(history: Array<{ role?: string; content?: string }>, recentUserMessages: string[]) {
    const corpus = normalizeText(
        [
            ...history
                .filter((item) => item?.role === 'user')
                .map((item) => item?.content || ''),
            ...recentUserMessages,
        ].join(' \n '),
    );

    return textIncludesAny(corpus, [
        'ja trabalho',
        'trabalho na area',
        'trabalho nessa area',
        'atuo na area',
        'sempre quis',
        'sempre quiz',
        'quero fazer',
        'quero cursar',
        'tenho esse sonho',
        'tenho esse objetivo',
        'e meu objetivo',
        'me identifico com a area',
        'gosto da area',
        'sonho meu',
        'sou enfermeiro',
        'sou tecnico',
        'recebi uma oportunidade',
        'quero migrar',
        'quero mudar de area',
        'sempre foi um sonho',
        'e um sonho',
        'meu sonho',
        'objetivo pessoal',
        'objetivo profissional',
        'quero realizar',
        'quero crescer',
        'quero evoluir',
        'busco uma oportunidade',
    ]);
}

function assistantAskedE1MotivationQuestion(history: Array<{ role?: string; content?: string }>) {
    const lastAssistant = [...history]
        .reverse()
        .find((item) => item?.role === 'assistant')?.content || '';
    const normalized = normalizeText(lastAssistant);

    return textIncludesAny(normalized, [
        'ja trabalha na area',
        'trabalha na area',
        'esse curso representa um sonho',
        'esse curso e mais um sonho',
        'objetivo pessoal',
        'objetivo profissional',
        'sempre foi um sonho',
    ]);
}

function lastLeadReplyCanCloseE1(recentUserMessages: string[]) {
    const lastReply = normalizeText(recentUserMessages.slice(-1)[0] || '');
    if (!lastReply) return false;

    return lastReply.length >= 6 || textIncludesAny(lastReply, [
        'sim',
        'sempre quis',
        'sempre quiz',
        'e um sonho',
        'meu sonho',
        'objetivo',
    ]);
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

    const maxRegenerations = 2;
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
        const pendingCriterion = String(params.stageOutput.pendingCriterionAfter || liveSalesContext.pending_criterion || '').trim() || null;
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
        };

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
                allowedIntent: (
                    effectiveProcessAction === 'ask_city' ? 'confirm_course_available_and_ask_city'
                        : effectiveProcessAction === 'ask_motivation' ? 'confirm_course_available_and_ask_motivation'
                            : effectiveProcessAction === 'ask_course_line' ? 'confirm_course_exists_and_ask_only_for_real_available_line_choice'
                                : effectiveProcessAction === 'present_segment_options_and_wait_selection' ? 'present_same_segment_alternatives_and_wait_for_specific_course_choice'
                                    : effectiveProcessAction === 'ask_for_new_direction' ? 'explain_unavailable_course_without_known_segment_and_ask_for_new_direction'
                                        : effectiveProcessAction === 'ask_vaccine_availability' ? 'natural_transition_and_ask_vaccine_availability'
                                            : effectiveProcessAction === 'ask_vaccine_decider' ? 'natural_transition_and_ask_vaccine_decider'
                                                : effectiveProcessAction === 'ask_vaccine_agreement' ? 'natural_transition_and_ask_vaccine_agreement'
                                                    : params.stageOutput.allowedIntent || 'follow_stage_prompt_normally'
                ),
                speakableFacts,
                forbiddenTopics: guard.personality_violations || [],
                originalOutput: params.stageOutput.text,
            },
        });

        params.stageOutput.originalOutput = params.stageOutput.originalOutput || params.stageOutput.text || null;
        const regeneratedText = regeneratedOutput.text || null;
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

function buildAreaCourseSelectionFallback(params: {
    requestedArea: string | null;
    courses: string[];
}) {
    const requestedArea = String(params.requestedArea || '').trim() || 'essa area';
    const lines = params.courses
        .filter(Boolean)
        .map((course) => getCourseDisplayName(String(course)))
        .filter(Boolean)
        .map((course) => `- ${course}`);
    return [
        `Na area de ${requestedArea}, temos algumas opcoes bem interessantes:`,
        lines.join('\n'),
        'Qual desses cursos mais te interessa?',
    ].filter(Boolean).join('\n\n');
}

function textMisframesAreaSelectionAsUnavailable(text: string | undefined) {
    const normalized = normalizeText(text || '');
    if (!normalized) return false;
    const preservesOpportunity = textIncludesAny(normalized, [
        'outras alternativas',
        'outras opcoes',
        'outras opÃ§Ãµes',
        'podem ser interessantes',
        'podem te interessar',
    ]);
    if (preservesOpportunity) return false;
    return textIncludesAny(normalized, [
        'infelizmente',
        'nao temos',
        'não temos',
        'nao esta entre as opcoes',
        'não está entre as opções',
        'graduacao que voce mencionou nao esta',
        'graduação que você mencionou não está',
    ]);
}

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

function assistantAskedE2AgreementQuestion(history: Array<{ role?: string; content?: string }>) {
    const normalized = normalizeText(latestAssistantMessage(history));
    return textIncludesAny(normalized, [
        'vou te apresentar tudo direitinho',
        'bolsa de estudos ficar boa',
        'seguimos para a inscricao',
        'garantimos essa oportunidade',
        'combinado',
    ]);
}

function assistantAskedE2AvailabilityQuestion(history: Array<{ role?: string; content?: string }>) {
    const normalized = normalizeText(latestAssistantMessage(history));
    return textIncludesAny(normalized, [
        'alguma viagem mais longa',
        'alguma viagem',
        'mudanca ja planejada',
        'mudança já planejada',
        'possa interferir no inicio da graduacao',
        'possa interferir no início da graduação',
    ]);
}

function assistantAskedE2DecisionQuestion(history: Array<{ role?: string; content?: string }>) {
    const normalized = normalizeText(latestAssistantMessage(history));
    return textIncludesAny(normalized, [
        'normalmente decide por voce mesmo',
        'normalmente decide por você mesmo',
        'costuma conversar com alguem antes',
        'costuma conversar com alguém antes',
        'decisao importante assim sobre seus estudos',
        'decisão importante assim sobre seus estudos',
    ]);
}

function hasReplyAfterLastAssistantQuestion(history: Array<{ role?: string; content?: string }>, patterns: string[]) {
    const lastIndex = [...(history || [])]
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item?.role === 'assistant' && textIncludesAny(normalizeText(entry.item?.content || ''), patterns))
        .slice(-1)[0]?.index;

    if (lastIndex === undefined) return false;
    return (history || []).slice(lastIndex + 1).some((item) => item?.role === 'user' && String(item?.content || '').trim());
}

function leadAcceptedE2Agreement(recentUserMessages: string[]) {
    const normalized = normalizeText(recentUserMessages.slice(-1)[0] || '');
    if (!normalized) return false;

    return textIncludesAny(normalized, [
        'combinado',
        'sim',
        'se a bolsa ficar boa',
        'dependendo do valor',
        'se couber no meu bolso',
        'seguimos sim',
        'fechado',
        'pode ser',
    ]);
}

function isE2AdvanceStructurallyValid(params: {
    history: Array<{ role?: string; content?: string }>;
    recentUserMessages: string[];
    salesContext?: Record<string, unknown> | null;
}) {
    return getNextE2Criterion({
        leadSnapshot: { sales_context: { ...(params.salesContext || {}) } },
    }) === null;

    const salesContext = { ...(params.salesContext || {}) } as Record<string, unknown>;
    const persistedVaccinesDone =
        salesContext.e2_vaccine_availability_done === true
        && salesContext.e2_vaccine_decider_done === true
        && salesContext.e2_vaccine_agreement_done === true;
    if (persistedVaccinesDone) return true;

    const availabilityDone = hasReplyAfterLastAssistantQuestion(params.history, [
        'alguma viagem mais longa',
        'alguma viagem',
        'mudanca ja planejada',
        'mudança já planejada',
        'possa interferir no inicio da graduacao',
        'possa interferir no início da graduação',
    ]);

    const decisionDone = hasReplyAfterLastAssistantQuestion(params.history, [
        'normalmente decide por voce mesmo',
        'normalmente decide por você mesmo',
        'costuma conversar com alguem antes',
        'costuma conversar com alguém antes',
        'decisao importante assim sobre seus estudos',
        'decisão importante assim sobre seus estudos',
    ]);

    const agreementDone = assistantAskedE2AgreementQuestion(params.history)
        && leadAcceptedE2Agreement(params.recentUserMessages);

    return availabilityDone && decisionDone && agreementDone;
}

function buildE2AgreementFallback() {
    return 'Entao deixa eu combinar uma coisa com voce.\n\nVou te apresentar tudo direitinho e, se fizer sentido pra voce e a bolsa de estudos ficar boa tambem, seguimos para a inscricao e garantimos essa oportunidade. Combinado?';
}

function buildDeterministicStageContractRecovery(params: {
    stage: string;
    pendingCriterion: string | null;
    latestUserMessage: string;
    leadSnapshot: Record<string, unknown> | null | undefined;
}) {
    const stage = String(params.stage || '').toUpperCase();
    const leadSnapshot = params.leadSnapshot || {};
    const salesContext = { ...(leadSnapshot.sales_context || {}) } as Record<string, unknown>;
    const courseName = String(salesContext.course_display_name || leadSnapshot.curso_interesse || 'esse curso').trim();

    if (stage === 'E1') {
        if (params.pendingCriterion === 'city') {
            return {
                text: buildE1AskCityFallback(courseName),
                processAction: 'ask_city',
                allowedIntent: 'acknowledge_course_and_ask_city',
                conversationalBehavior: 'acknowledge_course_or_line_choice_and_ask_city',
                pendingBefore: 'course',
                pendingAfter: 'city',
            };
        }
        if (params.pendingCriterion === 'motivation') {
            return {
                text: buildE1AskMotivationFallback(courseName),
                processAction: 'ask_motivation',
                allowedIntent: 'acknowledge_course_and_ask_motivation',
                conversationalBehavior: 'confirm_course_is_offered_if_relevant_and_make_a_natural_transition_without_sounding_like_checklist',
                pendingBefore: 'city',
                pendingAfter: 'motivation',
            };
        }
        if (params.pendingCriterion === null) {
            return {
                text: buildE1CompletionFallback({
                    latestUserMessage: params.latestUserMessage,
                    courseName,
                }),
                processAction: 'complete_stage',
                allowedIntent: 'complete_e1_and_handoff_to_e2',
                conversationalBehavior: 'optional_short_contextual_acknowledgement',
                pendingBefore: 'motivation',
                pendingAfter: null,
            };
        }
    }

    if (stage === 'E2') {
        if (params.pendingCriterion === 'vaccine_availability') {
            return {
                text: buildE2AvailabilityFallback(),
                processAction: 'ask_vaccine_availability',
                allowedIntent: 'ask_vaccine_availability',
                conversationalBehavior: 'introduce_the_question_naturally',
                pendingBefore: null,
                pendingAfter: 'vaccine_availability',
            };
        }
        if (params.pendingCriterion === 'vaccine_decider') {
            return {
                text: buildE2DecisionFallback(),
                processAction: 'ask_vaccine_decider',
                allowedIntent: 'ask_vaccine_decider',
                conversationalBehavior: 'transition_naturally_without_sounding_mechanical',
                pendingBefore: 'vaccine_availability',
                pendingAfter: 'vaccine_decider',
            };
        }
        if (params.pendingCriterion === 'vaccine_agreement') {
            return {
                text: buildE2AgreementFallback(),
                processAction: 'ask_vaccine_agreement',
                allowedIntent: 'ask_vaccine_agreement',
                conversationalBehavior: 'transition_naturally_without_sounding_mechanical',
                pendingBefore: 'vaccine_decider',
                pendingAfter: 'vaccine_agreement',
            };
        }
        if (params.pendingCriterion === null) {
            return {
                text: buildE2CompletionFallback(),
                processAction: 'complete_stage',
                allowedIntent: 'complete_e2_and_handoff_to_e3',
                conversationalBehavior: 'optional_short_contextual_acknowledgement',
                pendingBefore: 'vaccine_agreement',
                pendingAfter: null,
            };
        }
    }

    return null;
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
        'é isso que procuro',
        'parece bom',
        'quero seguir',
        'quero sim',
        'tenho interesse',
        'curti',
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
    return 'Perfeito.\n\nFaz sentido te mostrar as condicoes da bolsa de estudos com mais calma.\n\nMe diz so o que mais pesou para voce nessa escolha.';
}

function looksLikePhoneReply(message: string) {
    const normalized = String(message || '').replace(/\s+/g, '');
    return PHONE_LIKE.test(normalized.replace(/[^\d+]/g, ''));
}

function looksLikePersonNameReply(message: string) {
    const normalized = normalizeText(message);
    if (!normalized || normalized.length < 5) return false;
    if (looksLikePhoneReply(message)) return false;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 4) return false;

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
    return 'Antes de eu te pedir uma indicacao, me conta uma coisa: voce gostou do atendimento? E recomendaria esse atendimento para outra pessoa?';
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
    return 'Fico feliz em saber disso.\n\nTem alguem que voce gostaria de me indicar? Se sim, me passa primeiro o nome dessa pessoa.';
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
    const safeName = indicatedName || 'essa pessoa';
    return `Se puder, avisa o ${safeName} que alguem aqui da instituicao pode falar com ele sobre a graduacao. Assim ele ja sabe de onde veio o contato.\n\nFico feliz por acompanhar esse seu momento, Helton.`;
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
        .map((item) => String(item?.content || '').trim())
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
    return 'Tudo certo.\n\nSe surgir alguem depois, me fala por aqui.';
}

function buildE7NoIndicationClosingFallback() {
    return 'Perfeito.\n\nFico feliz por acompanhar esse seu momento. Se surgir qualquer duvida mais para frente, estou por aqui.';
}

function detectBoletoDateChoice(message: string) {
    const normalized = normalizeText(message);
    if (!normalized) return null;
    if (textIncludesAny(normalized, ['hoje', 'ainda hoje'])) {
        return { kind: 'today', label: 'hoje' };
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
        for (let attempt = 1; attempt <= MAX_QUEUE_SCAN; attempt += 1) {
            const { data: msgs } = await readMessage(supabase, Q_AI, 30);
            if (!msgs?.length) {
                if (lastScanPayload?.tenant_id && lastScanPayload?.lead_id) {
                    await logLeadRuntimeEvent({
                        supabase,
                        tenantId: lastScanPayload.tenant_id,
                        leadId: lastScanPayload.lead_id,
                        eventType: 'test_queue_scan_finished',
                        payload: {
                            queue_scan_attempts: attempt - 1,
                            processable_job_found: false,
                            finished_reason: 'queue_empty',
                            finished_at: new Date().toISOString(),
                        },
                    }).catch(() => {});
                }
                console.log('[ai-processor] fila vazia');
                return new Response(JSON.stringify({ status: 'empty', queue_scan_attempts: attempt - 1 }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            const candidateMsg = msgs[0];
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
                        next_job_attempted: attempt < MAX_QUEUE_SCAN,
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
                            next_job_attempted: attempt < MAX_QUEUE_SCAN,
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
            return new Response(JSON.stringify({ status: 'empty', skipped: 'no_processable_job', queue_scan_attempts: MAX_QUEUE_SCAN }), {
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
        const lastUserMessage = (payload.recent_user_messages ?? []).slice(-1)[0] ?? payload.text ?? '';
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
        const historyText = (payload.history ?? [])
            .map((h: any) => `${h.role === 'user' ? 'Lead' : 'Helton'}: ${h.content ?? ''}`)
            .join('\n');
        const { data: leadSnapshot } = await supabase
            .from('leads')
            .select('nome, lead_first_name, lead_name_confidence, cidade, curso_interesse, dor_principal, valor_parcela, etapa_atual, matriculado, bloqueado, sales_context, proposta_enviada_em, pronto_matricula_em')
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
        const explicitCourseIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []).matched === true;
        const pendingCriterion = derivePendingCriterion({
            stage: payload.etapa_atual,
            leadSnapshot,
            history: payload.history ?? [],
        });
        const e1SpecificCourseIntent = detectCatalogIntentWithHistory(lastUserMessage, payload.history ?? []);

        if (
            payload.etapa_atual === 'E1'
            && pendingCriterion === 'course'
            && e1SpecificCourseIntent.matched === true
            && ['specific', 'specific_or_related'].includes(String(e1SpecificCourseIntent.mode || ''))
        ) {
            const lookup = await tool_consultar_conhecimento({
                supabase,
                tenantId: payload.tenant_id,
                leadId: payload.lead_id,
                telefone: payload.telefone,
                env,
            }, {
                tipo: 'course',
                query: String(e1SpecificCourseIntent.query || lastUserMessage),
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
                    query: e1SpecificCourseIntent.query || lastUserMessage,
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
                explicitNewCourseIntent: explicitCourseIntent || stageState.explicitNewIntent === true,
                authorizedCourseChange: stageState.authorizedCourseChange === true
                    || ['selected_catalog_course', 'valid_alternative_course_selection'].includes(String(stageState.classificationReason || '')),
            });
            const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                ...preservedCourseState.patch,
                pending_criterion: preservedCourseState.patch.pending_criterion ?? pendingCriterion,
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
                    explicit_new_course_intent: explicitCourseIntent || stageState.explicitNewIntent === true,
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
                explicit_new_course_intent: explicitCourseIntent || stageState.explicitNewIntent === true,
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

        if (intelligence.asked_price_early) {
            await notifyAdminIfNeeded(
                'price_early',
                `price_early_${payload.etapa_atual}`,
                `Lead perguntou valor antes da etapa financeira.\nLead: ${leadSnapshot?.nome || payload.telefone}\nTelefone: ${payload.telefone}\nEtapa atual: ${payload.etapa_atual}\nMensagem: ${lastUserMessage}`,
            );
        }

        if (intelligence.proposal_ready) {
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
        let finalSubagent = initialSubagent;
        let currentStage = payload.etapa_atual;
        let workingHistory = payload.history ?? [];
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
                });

                if (
                    currentSubagent === 'E2'
                    && hop > 0
                    && shouldSanitizeE2HandoffOutput(stageOutput.text)
                ) {
                    console.warn('[ai-processor] saneando saida estrutural torta em E2 stage_handoff');
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterAdvanceToolCalls(filterKnowledgeToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE2StageHandoffFallback();
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
                const earlyStageForbiddenTopics = allowE2TravelMoveModality
                    ? earlyStageForbiddenTopicsRaw.filter((topic) => ![
                        'modalidade',
                        'ead',
                        'semipresencial',
                        'presencial',
                        'metodologia',
                        'funcionamento das aulas',
                    ].includes(String(topic)))
                    : allowE2ConditionalMethodology
                        ? earlyStageForbiddenTopicsRaw.filter((topic) => !['metodologia'].includes(String(topic)))
                    : earlyStageForbiddenTopicsRaw;
                const ambiguousLineViolations = currentSubagent === 'E1'
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
                    const deterministicRecovery = null;

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

                    if (!proposalCompleted) {
                        const fullNameCandidate = extractFullNameCandidate(activeLastUserMessage);
                        const lastKnownName = String(liveSalesContext.proposal_full_name || leadSnapshot?.nome || '').trim();
                        const proposalName = lastKnownName || (looksLikeFullName(fullNameCandidate) ? fullNameCandidate : '');

                        if (proposalName) {
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
                                    `Gerar e enviar proposta para este lead.\n` +
                                    `Lead: ${proposalName}\n` +
                                    `Telefone: ${payload.telefone}\n` +
                                    `Etapa pausada: E4\n` +
                                    `Curso: ${String(leadSnapshot?.curso_interesse || '') || 'nao informado'}\n` +
                                    `Cidade: ${String(leadSnapshot?.cidade || '') || 'nao informada'}`,
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
                        } else if (!lastKnownName) {
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

                    if (
                        e6Context.e6_feedback_collected !== true
                        && !looksLikePersonNameReply(activeLastUserMessage)
                        && !looksLikePhoneReply(activeLastUserMessage)
                        && !userDeclinedIndication(activeLastUserMessage)
                        && !userRecommendedService(activeLastUserMessage)
                        && !userDidNotRecommendService(activeLastUserMessage)
                    ) {
                        stageOutput.avancou = false;
                        stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        stageOutput.text = buildE6SatisfactionFallback();
                    }

                    if (userRecommendedService(activeLastUserMessage) || userDidNotRecommendService(activeLastUserMessage)) {
                        const recommended = userRecommendedService(activeLastUserMessage);
                        const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                            e6_feedback_collected: true,
                            e6_recommended_service: recommended,
                        });
                        leadSnapshot.sales_context = nextSalesContext;

                        stageOutput.avancou = false;
                        stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                        stageOutput.text = recommended
                            ? buildE6AskIndicationNameFallback()
                            : buildE6NoIndicationFallback();

                        if (!recommended) {
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
                                console.error(`[ai-processor] falha ao avancar E6->E7 apos feedback negativo: ${String(forceAdvanceError)}`);
                                stageOutput.avancou = false;
                            }
                        }
                    }
                }

                if (
                    currentSubagent === 'E6'
                    && userDeclinedIndication(activeLastUserMessage)
                ) {
                    console.warn('[ai-processor] lead sem indicacao; avancando E6->E7');
                    const nextSalesContext = await mergeLeadSalesContext(supabase, payload.lead_id, {
                        no_indication: true,
                        pending_indication_name: null,
                        e6_feedback_collected: true,
                    });
                    leadSnapshot.sales_context = nextSalesContext;
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
                        stageOutput.text = buildE6NoIndicationFallback();
                    } catch (forceAdvanceError) {
                        console.error(`[ai-processor] falha ao avancar E6->E7 sem indicacao: ${String(forceAdvanceError)}`);
                    }
                }

                if (
                    currentSubagent === 'E6'
                    && looksLikePersonNameReply(activeLastUserMessage)
                ) {
                    console.warn('[ai-processor] capturando nome do indicado em E6');
                    await mergeLeadSalesContext(supabase, payload.lead_id, {
                        pending_indication_name: activeLastUserMessage.trim(),
                        e6_feedback_collected: true,
                        e6_recommended_service: true,
                    });
                    stageOutput.avancou = false;
                    stageOutput.toolCalls = filterKnowledgeToolCalls(filterAdvanceToolCalls(stageOutput.toolCalls));
                    stageOutput.text = buildE6PhoneFallback();
                }

                if (
                    currentSubagent === 'E6'
                    && looksLikePhoneReply(activeLastUserMessage)
                ) {
                    console.warn('[ai-processor] registrando indicacao em E6 a partir do telefone informado');
                    const salesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    const indicatedName = String(
                        salesContext.pending_indication_name
                        || latestIndicatedName(workingHistory, activeRecentUserMessages)
                        || '',
                    ).trim();

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
                            nome_indicado: indicatedName || undefined,
                        });

                        stageOutput.toolCalls.push({
                            name: 'registrar_indicacao',
                            args: {
                                telefone_indicado: activeLastUserMessage.trim(),
                                nome_indicado: indicatedName || undefined,
                            },
                            result: indicationResult,
                        });

                        await mergeLeadSalesContext(supabase, payload.lead_id, {
                            pending_indication_name: null,
                            last_indicated_name: indicatedName || null,
                        });

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
                        console.error(`[ai-processor] falha ao registrar indicacao em E6: ${String(forceAdvanceError)}`);
                        stageOutput.avancou = false;
                        stageOutput.text = buildE6PhoneFallback();
                    }
                }

                if (currentSubagent === 'E7') {
                    const liveSalesContext = await readLeadSalesContext(supabase, payload.lead_id);
                    if (liveSalesContext.no_indication === true && hop > 0) {
                        stageOutput.text = buildE7NoIndicationClosingFallback();
                    }
                }

                if (
                    stageOutput.deterministicReplyUsed === true
                    && stageOutput.text
                    && stageOutput.fallbackUsed !== true
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
                    const nextPendingCriterion = lockedPendingCriterion !== undefined
                        ? lockedPendingCriterion
                        : derivedNextPendingCriterion;
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
                        stageOutput.text = buildE1CompletionFallback({
                            latestUserMessage: activeLastUserMessage,
                            courseName: String(e1LeadSnapshot?.sales_context?.course_display_name || e1LeadSnapshot?.curso_interesse || '').trim() || null,
                        });
                        stageOutput.deterministicReplyUsed = true;
                        stageOutput.responseOrigin = 'structural_fallback';
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
                        stageOutput.text = buildE2CompletionFallback();
                        stageOutput.deterministicReplyUsed = true;
                        stageOutput.responseOrigin = 'structural_fallback';

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
                if (nextStage === 'E3') {
                    continue;
                }
                break;
            }

            out = {
                text: (() => {
                    const uniqueStages = Array.from(new Set(collectedTexts.map((item) => item.stage)));
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
                atomicMessages: Array.isArray(lastOutput?.atomicMessages) ? lastOutput.atomicMessages : null,
                institutionalClaimsPending: Array.isArray(lastOutput?.institutionalClaimsPending) ? lastOutput.institutionalClaimsPending : [],
            };
        }

        console.log(`[ai-processor] subagente concluiu — text: ${!!out.text}, iterations: ${out.iterations}, handoff: ${out.handoff}`);

        if (out.text) {
            const validatedOutbound = validateOutboundText(out.text);
            if (validatedOutbound.changed) {
                console.warn('[ai-processor] validador final de saida ajustou a mensagem antes do envio');
                out.text = validatedOutbound.text;
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
                    skip_governance: outboundParts.length > 1,
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
            if (!out.handoff) {
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
            .select('nome, curso_interesse, dor_principal, etapa_atual')
            .eq('id', payload.lead_id)
            .single();
        const finalLeadStage = finalLeadStageData?.etapa_atual ?? currentStage ?? payload.etapa_atual;
        if (finalLeadStage && etapasAtivas.includes(finalLeadStage) && !out.handoff) {
            await supabase
                .from('followup_schedule')
                .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                .eq('lead_id', payload.lead_id)
                .eq('status', 'pending');

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
