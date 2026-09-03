// webhook-receiver — recebe eventos da Evolution API (WhatsApp self-hosted).
// deno-lint-ignore-file
// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { sendMessage } from '../_shared/pgmq.ts';
import { logLeadRuntimeEvent } from '../ai-processor/intelligence.ts';
import {
    downloadMedia,
    downloadMediaFlexible,
    downloadMediaFromMessageObject,
    downloadFromUrl,
    decryptWhatsAppMedia,
    downloadMediaMultiRoute,
    base64ToBytes,
} from '../_shared/evolution-api.ts';
import { transcribeAudio } from '../_shared/openai-client.ts';
import { loadTenantRuntimeConfig, resolveEdgeReachableUrl } from '../_shared/runtime-config.ts';
import { completeAdminCheckpointByReply, getPendingAdminCheckpoint, isAuthorizedAdminPhone } from '../_shared/admin-checkpoints.ts';
import { resolveTrustedLeadName } from '../_shared/lead-name.ts';

const TENANT_ID = Deno.env.get('TENANT_ID') ?? '00000000-0000-0000-0000-000000000001';
const Q_INBOUND = 'messages_vendas';

function uniqueMimeTypes(values: string[]) {
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function findNestedStringByKeys(input: unknown, keys: string[]): string | null {
    if (!input || typeof input !== 'object') return null;

    for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    for (const value of Object.values(input as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
            const nested = findNestedStringByKeys(value, keys);
            if (nested) return nested;
        }
    }

    return null;
}

function extractWebhookBase64Media(message: unknown, fallbackMimeType?: string | null) {
    const dataUrlOrBase64 = findNestedStringByKeys(message, ['base64', 'media', 'file', 'audio', 'content']);
    if (!dataUrlOrBase64) return null;

    const dataUrlMatch = dataUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/i);
    const mimeType = dataUrlMatch?.[1] || fallbackMimeType || 'audio/ogg';
    const base64Payload = dataUrlMatch?.[2] || dataUrlOrBase64;

    if (!/^[A-Za-z0-9+/_=-]{80,}$/.test(base64Payload)) {
        return null;
    }

    try {
        const bytes = base64ToBytes(base64Payload);
        return {
            blob: new Blob([bytes], { type: mimeType }),
            mimeType,
        };
    } catch {
        return null;
    }
}

function firstAvailableMediaFromWebhook(candidates: unknown[], fallbackMimeType?: string | null) {
    for (const candidate of candidates) {
        const media = extractWebhookBase64Media(candidate, fallbackMimeType);
        if (media) return media;
    }
    return null;
}

function extractMediaKeyBytes(rawMediaKey: any): { bytes: Uint8Array | null; preview: string; type: string } {
    const mkType = typeof rawMediaKey;
    let preview = 'ausente';
    let mediaKeyBytes: Uint8Array | null = null;

    if (!rawMediaKey) {
        return { bytes: null, preview, type: mkType };
    }

    if (mkType === 'string') {
        preview = rawMediaKey.substring(0, 24);
        try {
            mediaKeyBytes = base64ToBytes(rawMediaKey);
        } catch {}
    } else if (Array.isArray(rawMediaKey)) {
        preview = `[array len=${rawMediaKey.length}]`;
        mediaKeyBytes = new Uint8Array(rawMediaKey);
    } else if (rawMediaKey instanceof Uint8Array) {
        preview = `Uint8Array len=${rawMediaKey.length}`;
        mediaKeyBytes = rawMediaKey;
    } else if (rawMediaKey instanceof ArrayBuffer) {
        preview = `ArrayBuffer len=${rawMediaKey.byteLength}`;
        mediaKeyBytes = new Uint8Array(rawMediaKey);
    } else {
        try {
            const mkKeys = Object.keys(rawMediaKey);
            preview = `object keys=[${mkKeys.join(',')}]`;

            if (mkKeys.length === 32 && mkKeys.every((k, i) => k === String(i))) {
                mediaKeyBytes = new Uint8Array(mkKeys.map((k) => {
                    const v = rawMediaKey[k];
                    return typeof v === 'number' ? v : Number(v);
                }));
                preview += ' -> bytes 0-31';
            }

            if (!mediaKeyBytes) {
                mkKeys.forEach((k) => {
                    const v = rawMediaKey[k];
                    if (typeof v === 'string' && v.length > 20) {
                        try { mediaKeyBytes = base64ToBytes(v); } catch {}
                    } else if (typeof v === 'string' && v.length === 64) {
                        try { mediaKeyBytes = new Uint8Array(v.match(/.{2}/g)!.map((b) => parseInt(b, 16))); } catch {}
                    }
                });
            }

            if (!mediaKeyBytes && typeof rawMediaKey.toString === 'function') {
                const str = rawMediaKey.toString();
                if (str.length > 20) {
                    try { mediaKeyBytes = base64ToBytes(str); } catch {}
                }
            }

            if (!mediaKeyBytes && typeof rawMediaKey.data !== 'undefined') {
                const data = rawMediaKey.data;
                if (Array.isArray(data)) mediaKeyBytes = new Uint8Array(data);
                else if (typeof data === 'string' && data.length > 20) {
                    try { mediaKeyBytes = base64ToBytes(data); } catch {}
                }
            }

            if (!mediaKeyBytes && typeof rawMediaKey._serialized === 'string' && rawMediaKey._serialized.length > 20) {
                try { mediaKeyBytes = base64ToBytes(rawMediaKey._serialized); } catch {}
            }
        } catch (e) {
            preview = `object (inspect err: ${String(e)})`;
        }
    }

    if (mediaKeyBytes && mediaKeyBytes.length < 32) {
        mediaKeyBytes = null;
    }

    return { bytes: mediaKeyBytes, preview, type: mkType };
}

async function blobStartsWith(blob: Blob, signature: number[]) {
    if (blob.size < signature.length) return false;
    const bytes = new Uint8Array(await blob.slice(0, signature.length).arrayBuffer());
    return signature.every((value, index) => bytes[index] === value);
}

async function blobContainsAtOffset(blob: Blob, offset: number, signature: number[]) {
    if (blob.size < offset + signature.length) return false;
    const bytes = new Uint8Array(await blob.slice(offset, offset + signature.length).arrayBuffer());
    return signature.every((value, index) => bytes[index] === value);
}

async function isLikelyDecodedAudio(blob: Blob) {
    return (
        await blobStartsWith(blob, [0x4f, 0x67, 0x67, 0x53]) || // OggS
        await blobStartsWith(blob, [0x52, 0x49, 0x46, 0x46]) || // RIFF
        await blobStartsWith(blob, [0x49, 0x44, 0x33]) || // ID3
        await blobContainsAtOffset(blob, 4, [0x66, 0x74, 0x79, 0x70]) // ftyp
    );
}

async function prepareAudioForTranscription(
    media: { blob: Blob; mimeType?: string | null } | null,
    mediaKeyBytes: Uint8Array | null,
    sourceLabel: string,
) {
    if (!media || !media.blob || media.blob.size <= 0) {
        return { media: null, reason: `${sourceLabel}:blob_vazio` };
    }

    if (await isLikelyDecodedAudio(media.blob)) {
        return { media, reason: null };
    }

    if (!mediaKeyBytes) {
        return { media: null, reason: `${sourceLabel}:sem_media_key_para_descriptografar` };
    }

    try {
        const decrypted = await decryptWhatsAppMedia(media.blob, mediaKeyBytes, 'Audio');
        if (!(await isLikelyDecodedAudio(decrypted))) {
            return { media: null, reason: `${sourceLabel}:descriptografou_mas_formato_desconhecido` };
        }
        return {
            media: { blob: decrypted, mimeType: 'audio/ogg' },
            reason: null,
        };
    } catch (error) {
        return { media: null, reason: `${sourceLabel}:descriptografia_falhou:${String(error)}` };
    }
}

async function tryTranscribeAudioVariants(apiKey: string, media: { blob: Blob; mimeType?: string | null }, originalMimeType?: string | null) {
    const attemptedMimeTypes = uniqueMimeTypes([
        media?.mimeType || '',
        originalMimeType || '',
        'audio/oga',
        'audio/ogg',
        'audio/webm',
        'audio/mpeg',
        'audio/mp4',
        'audio/wav',
    ]);

    const errors: string[] = [];
    for (const mimeType of attemptedMimeTypes) {
        try {
            const blob = mimeType ? new Blob([media.blob], { type: mimeType }) : media.blob;
            const transcription = await transcribeAudio(apiKey, blob, mimeType || undefined);
            if (transcription) {
                return { ok: true, transcription, mimeType, errors };
            }
            errors.push(`transcricao_vazia:${mimeType || 'sem_mime'}`);
        } catch (error) {
            errors.push(`${mimeType || 'sem_mime'}:${String(error)}`);
        }
    }

    return { ok: false, transcription: '', mimeType: attemptedMimeTypes[0] || '', errors };
}

async function findLeadByPhone(supabase: any, tenantId: string, telefone: string) {
    const { data, error } = await supabase
        .from('leads')
        .select('id, etapa_atual, bloqueado, nome, lead_person_name, lead_first_name, lead_name_confidence')
        .eq('tenant_id', tenantId)
        .eq('telefone', telefone)
        .maybeSingle();

    if (error) throw error;
    return data;
}

async function upsertInboundLead(params: {
    supabase: any;
    tenantId: string;
    telefone: string;
    rawContactName: string | null;
    leadPersonName: string | null;
    leadFirstName: string | null;
    leadNameSource: string | null;
    leadNameConfidence: string | null;
}) {
    const existingLead = await findLeadByPhone(params.supabase, params.tenantId, params.telefone).catch(() => null);

    if (existingLead?.id) {
        const payload: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
            raw_contact_name: params.rawContactName,
            lead_name_source: params.leadNameSource,
            lead_name_confidence: params.leadNameConfidence,
        };

        if (params.leadPersonName && (
            !existingLead.lead_person_name
            || existingLead.lead_name_confidence !== 'trusted'
        )) {
            payload.nome = params.leadPersonName;
            payload.lead_person_name = params.leadPersonName;
            payload.lead_first_name = params.leadFirstName;
        }

        const { data, error } = await params.supabase
            .from('leads')
            .update(payload)
            .eq('id', existingLead.id)
            .select('id, etapa_atual, bloqueado, nome, lead_person_name, lead_first_name, lead_name_confidence')
            .maybeSingle();

        if (error) throw error;
        return data ?? existingLead;
    }

    const { data, error } = await params.supabase
        .from('leads')
        .insert({
            tenant_id: params.tenantId,
            telefone: params.telefone,
            nome: params.leadPersonName,
            lead_person_name: params.leadPersonName,
            lead_first_name: params.leadFirstName,
            raw_contact_name: params.rawContactName,
            lead_name_source: params.leadNameSource,
            lead_name_confidence: params.leadNameConfidence,
            etapa_atual: 'E1',
            updated_at: new Date().toISOString(),
        })
        .select('id, etapa_atual, bloqueado, nome, lead_person_name, lead_first_name, lead_name_confidence')
        .maybeSingle();

    if (error) throw error;
    return data;
}

function normalizeInboundPhone(key: any) {
    const candidates = [
        key?.remoteJidAlt,
        key?.participantAlt,
        key?.participant,
        key?.remoteJid,
    ].filter(Boolean);

    for (const candidate of candidates) {
        const raw = String(candidate);
        if (!raw) continue;

        // Lid addressing uses synthetic ids in remoteJid and exposes the real WhatsApp jid in remoteJidAlt.
        if (raw.endsWith('@lid')) {
            continue;
        }

        const digits = raw.replace(/@s\.whatsapp\.net|@c\.us|@g\.us|@broadcast/gi, '').replace(/\D/g, '');
        if (digits.length >= 10) {
            return `+${digits}`;
        }
    }

    const fallback = String(key?.remoteJid ?? '').replace('@lid', '').replace(/\D/g, '');
    return fallback ? `+${fallback}` : '';
}

function extractReplyMessageId(message: any) {
    return findNestedStringByKeys(message, [
        'stanzaId',
        'quotedMessageId',
        'quotedMessageID',
        'quotedStanzaID',
        'quotedStanzaId',
        'quotedMsgId',
    ]) || '';
}

async function buildFreshConversationSnapshot(supabase: any, leadId: string) {
    const [{ data: lead }, { data: recentMsgs }, { data: recentUserOnly }] = await Promise.all([
        supabase
            .from('leads')
            .select('etapa_atual, nome, telefone')
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
        lead,
        history,
        recentUserMessages,
    };
}

async function logAdminRuntimeEvent(supabase: any, payload: {
    tenantId: string;
    adminPhone: string;
    eventType: string;
    replyToMessageId?: string | null;
    data?: Record<string, unknown>;
}) {
    await supabase
        .from('admin_runtime_logs')
        .insert({
            tenant_id: payload.tenantId,
            admin_phone: payload.adminPhone,
            event_type: payload.eventType,
            reply_to_message_id: payload.replyToMessageId ?? null,
            payload: payload.data ?? {},
            created_at: new Date().toISOString(),
        });
}

async function triggerEdgeFunction(functionName: string) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
        console.warn(`[webhook-receiver] nao foi possivel disparar ${functionName}: SUPABASE_URL/SERVICE_ROLE_KEY ausentes`);
        return;
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ trigger: 'pipeline_kick' }),
    }).catch((error) => {
        console.error(`[webhook-receiver] erro ao disparar ${functionName}: ${String(error)}`);
        return null;
    });

    if (res && !res.ok) {
        const err = await res.text().catch(() => '');
        console.warn(`[webhook-receiver] disparo de ${functionName} retornou ${res.status}: ${err}`);
    }
}

serve(async (req) => {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
    }

    const token = req.headers.get('x-evolution-token') ?? req.headers.get('apikey');
    const expectedToken = Deno.env.get('EVOLUTION_WEBHOOK_TOKEN');
    if (expectedToken && token !== expectedToken) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    let body: any;
    try {
        const raw = await req.json();
        if (typeof raw === 'object' && typeof raw.data === 'string') {
            body = JSON.parse(atob(raw.data));
        } else if (typeof raw === 'string') {
            body = JSON.parse(atob(raw));
        } else {
            body = raw;
        }
    } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
    }

    const event = (body.event ?? '').toLowerCase().replace('.', '_');
    if (event !== 'messages_upsert') {
        return new Response(JSON.stringify({ skipped: true, event: body.event }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    let messages: any[];
    if (Array.isArray(body.data?.messages)) {
        messages = body.data.messages;
    } else if (body.data?.key) {
        messages = [{
            key: body.data.key,
            message: body.data.message,
            messageTimestamp: body.data.messageTimestamp,
            pushName: body.data.pushName ?? null,
            contextInfo: body.data.contextInfo,
            messageType: body.data.messageType,
        }];
    } else {
        messages = [];
    }

    const supabase = createServiceClient();
    const runtimeConfig = await loadTenantRuntimeConfig(supabase, TENANT_ID);
    const enqueued: string[] = [];

    for (const m of messages) {
        if (m.key?.fromMe) continue;

        // ── Extrair texto ou transcrever áudio ──────────────────────────────
        let text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null;
        let tipo = 'texto';
        let mimeType: string | null = null;
        let mediaUrl: string | null = null;
        let transcricao: string | null = null;
        let audioFailureReason: string | null = null;

        if (!text) {
            const audioMsg = m.message?.audioMessage;
            if (audioMsg) {
                tipo = 'audio';
                mimeType = audioMsg.mimetype ?? null;
                mediaUrl = audioMsg.url ?? null;
                console.log('[webhook-receiver] áudio detectado, mimeType:', mimeType, 'url:', !!mediaUrl, 'key.id:', !!m.key?.id, 'mediaKey:', !!audioMsg.mediaKey);
                const mediaKeyInfo = extractMediaKeyBytes(audioMsg.mediaKey);
                console.log('[webhook-receiver] mediaKey detectada, tipo:', mediaKeyInfo.type, 'preview:', mediaKeyInfo.preview, 'extraida:', !!mediaKeyInfo.bytes);

                const openAiKey = runtimeConfig.openaiApiKey;
                if (!openAiKey) {
                    console.warn('[webhook-receiver] OPENAI_API_KEY não configurada — pulando transcrição');
                }

                try {
                    const evoConfig = {
                        baseUrl: resolveEdgeReachableUrl(runtimeConfig.evolution.baseUrl ?? ''),
                        apiKey: runtimeConfig.evolution.apiKey ?? '',
                        instanceName: body.instance ?? runtimeConfig.evolution.instanceName ?? 'cruzeiro-vendas',
                    };

                    if (!evoConfig.baseUrl) {
                        console.warn('[webhook-receiver] EVOLUTION_API_URL não configurada');
                    }

                    let media = null;

                    // Strategy 0: base64 já veio no próprio webhook
                    const strategy0Media = firstAvailableMediaFromWebhook(
                        [m, m.message, body?.data, body],
                        mimeType,
                    );
                    if (strategy0Media) {
                        const strategy0Prepared = await prepareAudioForTranscription(strategy0Media, mediaKeyInfo.bytes, 'estrategia_0');
                        if (strategy0Prepared.media) {
                            media = strategy0Prepared.media;
                            console.log('[webhook-receiver] [estratégia 0] base64 do webhook OK');
                        } else {
                            audioFailureReason = strategy0Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 0] falhou:', strategy0Prepared.reason);
                        }
                    }

                    // Strategy 1: URL direta do CDN WhatsApp (mais confiável)
                    if (audioMsg.url) {
                        console.log('[webhook-receiver] [estratégia 1] tentando URL direta');
                        // Passa mimeType original como fallback (CDN devolve application/octet-stream)
                        const strategy1Media = await downloadFromUrl(audioMsg.url, audioMsg.mimetype);
                        const strategy1Prepared = await prepareAudioForTranscription(strategy1Media, mediaKeyInfo.bytes, 'estrategia_1');
                        if (strategy1Prepared.media) {
                            media = strategy1Prepared.media;
                            console.log('[webhook-receiver] [estratégia 1] OK, mimeType:', media.mimeType, 'tamanho:', media.blob.size);
                        } else {
                            audioFailureReason = strategy1Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 1] falhou:', strategy1Prepared.reason);
                        }
                    }

                    if (!media && audioMsg.directPath) {
                        const directPathUrl = String(audioMsg.directPath).startsWith('http')
                            ? String(audioMsg.directPath)
                            : `https://mmg.whatsapp.net${String(audioMsg.directPath)}`;
                        console.log('[webhook-receiver] [estratégia 1b] tentando directPath');
                        const strategy1bMedia = await downloadFromUrl(directPathUrl, audioMsg.mimetype);
                        const strategy1bPrepared = await prepareAudioForTranscription(strategy1bMedia, mediaKeyInfo.bytes, 'estrategia_1b');
                        if (strategy1bPrepared.media) {
                            media = strategy1bPrepared.media;
                            console.log('[webhook-receiver] [estratégia 1b] OK');
                        } else {
                            audioFailureReason = strategy1bPrepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 1b] falhou:', strategy1bPrepared.reason);
                        }
                    }

                    // Strategy 2: Evolution API getMedia com key.id (messageKey)
                    if (!media && m.key?.id) {
                        console.log('[webhook-receiver] [estratégia 2] getMedia com key.id');
                        const strategy2Media = await downloadMediaFlexible(evoConfig, m.key.id);
                        const strategy2Prepared = await prepareAudioForTranscription(strategy2Media, mediaKeyInfo.bytes, 'estrategia_2');
                        if (strategy2Prepared.media) {
                            media = strategy2Prepared.media;
                            console.log('[webhook-receiver] [estratégia 2] OK');
                        } else {
                            audioFailureReason = strategy2Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 2] falhou:', strategy2Prepared.reason);
                        }
                    }

                    // Strategy 3: Evolution API getMedia com mediaKey do audioMessage
                    if (!media && (typeof audioMsg.mediaKey === 'string' || Array.isArray(audioMsg.mediaKey))) {
                        console.log('[webhook-receiver] [estratégia 3] getMedia com mediaKey');
                        const strategy3Key = typeof audioMsg.mediaKey === 'string'
                            ? audioMsg.mediaKey
                            : Buffer.from(audioMsg.mediaKey).toString('base64');
                        const strategy3Media = await downloadMediaFlexible(evoConfig, strategy3Key);
                        const strategy3Prepared = await prepareAudioForTranscription(strategy3Media, mediaKeyInfo.bytes, 'estrategia_3');
                        if (strategy3Prepared.media) {
                            media = strategy3Prepared.media;
                            console.log('[webhook-receiver] [estratégia 3] OK');
                        } else {
                            audioFailureReason = strategy3Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 3] falhou:', strategy3Prepared.reason);
                        }
                    }

                    // Strategy 4: Multi-rota Evolution API (POST, /chat/getMedia/, etc.)
                    if (!media && m.key?.id) {
                        console.log('[webhook-receiver] [estratégia 4] multi-rota Evolution API');
                        const strategy4Media = await downloadMediaMultiRoute(evoConfig, m.key.id);
                        const strategy4Prepared = await prepareAudioForTranscription(strategy4Media, mediaKeyInfo.bytes, 'estrategia_4');
                        if (strategy4Prepared.media) {
                            media = strategy4Prepared.media;
                            console.log('[webhook-receiver] [estratégia 4] OK');
                        } else {
                            audioFailureReason = strategy4Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 4] falhou:', strategy4Prepared.reason);
                        }
                    }

                    // Strategy 5: download pelo objeto completo da mensagem do webhook
                    if (!media && m.message) {
                        console.log('[webhook-receiver] [estratégia 5] download pelo objeto message do webhook');
                        const strategy5Media = await downloadMediaFromMessageObject(evoConfig, m);
                        const strategy5Prepared = await prepareAudioForTranscription(strategy5Media, mediaKeyInfo.bytes, 'estrategia_5');
                        if (strategy5Prepared.media) {
                            media = strategy5Prepared.media;
                            console.log('[webhook-receiver] [estratégia 5] OK');
                        } else {
                            audioFailureReason = strategy5Prepared.reason || audioFailureReason;
                            console.warn('[webhook-receiver] [estratégia 5] falhou:', strategy5Prepared.reason);
                        }
                    }

                    if (media && openAiKey) {
                        console.log('[webhook-receiver] enviando para Whisper, mimeType:', media.mimeType, 'tamanho:', media.blob.size);
                        try {
                            const transcriptionResult = await tryTranscribeAudioVariants(openAiKey, media, mimeType);
                            const transcription = transcriptionResult.transcription;
                            if (transcriptionResult.ok && transcription) {
                                text = '[Áudio transcrito] ' + transcription;
                                transcricao = transcription;
                                console.log('[webhook-receiver] transcrição OK:', transcription.substring(0, 120));
                            } else {
                                audioFailureReason = transcriptionResult.errors.join(' | ') || 'transcricao_vazia';
                                console.warn('[webhook-receiver] Whisper retornou string vazia');
                            }
                        } catch (e) {
                            audioFailureReason = String(e);
                            console.error('[webhook-receiver] erro no Whisper:', String(e));
                        }
                    } else if (!media) {
                        audioFailureReason = audioFailureReason || 'download_media_falhou';
                        console.warn('[webhook-receiver] todas as estratégias de download falharam');
                    }
                } catch (e) {
                    audioFailureReason = String(e);
                    console.error('[webhook-receiver] erro no bloco de áudio:', String(e));
                }

                if (!text) {
                    text = '[Áudio]';
                    console.log('[webhook-receiver] fallback: registrando como "[Áudio]"');
                }
            }
        }

        // Outros tipos de mídia sem texto — registra com placeholder
        if (!text) {
            const mediaTypes: Record<string, string> = {
                imageMessage: '[Imagem]',
                videoMessage: '[Vídeo]',
                documentMessage: '[Documento]',
                stickerMessage: '[Figurinha]',
                ptvMessage: '[Vídeo]',
            };
            for (const [key, placeholder] of Object.entries(mediaTypes)) {
                if (m.message?.[key]) {
                    text = placeholder;
                    tipo = key.replace('Message', '');
                    break;
                }
            }
        }

        if (!text) continue;

        const telefone = normalizeInboundPhone(m.key);
        if (!telefone) {
            console.warn('[webhook-receiver] nao foi possivel resolver telefone do payload:', JSON.stringify(m.key ?? {}));
            continue;
        }

        const inboundMessageId = m.key?.id ? String(m.key.id) : '';
        const replyToMessageId = extractReplyMessageId(m);
        const isAdminMessage = isAuthorizedAdminPhone(telefone, runtimeConfig.adminPhone || '');

        if (isAdminMessage) {
            if (!replyToMessageId) {
                await logAdminRuntimeEvent(supabase, {
                    tenantId: TENANT_ID,
                    adminPhone: telefone,
                    eventType: 'admin_reply_uncorrelated',
                    data: {
                        texto: text,
                        inbound_message_id: inboundMessageId || null,
                        reason: 'missing_reply_reference',
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
                continue;
            }

            const completion = await completeAdminCheckpointByReply({
                supabase,
                tenantId: TENANT_ID,
                adminReplyToMessageId: replyToMessageId,
                adminPhoneOrId: telefone,
            }).catch((error) => {
                console.error('[webhook-receiver] falha ao concluir checkpoint administrativo', String(error));
                return { ok: false, reason: 'checkpoint_completion_error' };
            });

            if (!completion?.ok || !completion?.lead_id) {
                await logAdminRuntimeEvent(supabase, {
                    tenantId: TENANT_ID,
                    adminPhone: telefone,
                    eventType: 'admin_reply_uncorrelated',
                    replyToMessageId,
                    data: {
                        texto: text,
                        inbound_message_id: inboundMessageId || null,
                        reason: completion?.reason || 'checkpoint_not_found',
                        logged_at: new Date().toISOString(),
                    },
                }).catch(() => {});
                continue;
            }

            const snapshot = await buildFreshConversationSnapshot(supabase, completion.lead_id);
            await sendMessage(supabase, 'ai_processing_vendas', {
                lead_id: completion.lead_id,
                tenant_id: TENANT_ID,
                telefone: snapshot.lead?.telefone,
                etapa_atual: snapshot.lead?.etapa_atual || completion.next_stage || 'E4',
                text: '',
                messages: [],
                nome_lead: snapshot.lead?.nome ?? null,
                recent_user_messages: snapshot.recentUserMessages,
                history: snapshot.history,
                inbound_message_ids: [],
                last_received_at: new Date().toISOString(),
                message_count: 0,
                consolidated_at: new Date().toISOString(),
                trigger: 'stage_handoff',
                instance: body.instance,
            });

            await logLeadRuntimeEvent({
                supabase,
                tenantId: TENANT_ID,
                leadId: completion.lead_id,
                eventType: 'test_admin_checkpoint_resumed',
                payload: {
                    checkpoint_admin: completion.checkpoint?.checkpoint_admin,
                    next_stage: completion.next_stage,
                    reply_to_message_id: replyToMessageId,
                    resumed_at: new Date().toISOString(),
                },
            }).catch(() => {});
            continue;
        }

        const resolvedLeadName = resolveTrustedLeadName({
            verifiedName: m.message?.extendedTextMessage?.contextInfo?.verifiedName || null,
            pushName: m.pushName || m.message?.extendedTextMessage?.contextInfo?.pushName || null,
            notifyName: m.notifyName || null,
        });

        const lead = await upsertInboundLead({
            supabase,
            tenantId: TENANT_ID,
            telefone,
            rawContactName: resolvedLeadName.rawContactName,
            leadPersonName: resolvedLeadName.leadPersonName,
            leadFirstName: resolvedLeadName.leadFirstName,
            leadNameSource: resolvedLeadName.leadNameSource,
            leadNameConfidence: resolvedLeadName.leadNameConfidence,
        }).catch((error) => {
            console.error('[webhook-receiver] upsert lead error', JSON.stringify(error));
            return null;
        });

        if (!lead) {
            continue;
        }

        await logLeadRuntimeEvent({
            supabase,
            tenantId: TENANT_ID,
            leadId: lead.id,
            eventType: 'test_lead_name_resolution',
            payload: {
                lead_name_raw: resolvedLeadName.rawContactName,
                lead_name_source: resolvedLeadName.leadNameSource,
                lead_name_normalized: resolvedLeadName.leadNameNormalized,
                lead_name_confidence: resolvedLeadName.leadNameConfidence,
                lead_name_used: resolvedLeadName.leadNameUsed,
                lead_person_name: resolvedLeadName.leadPersonName,
                lead_first_name: resolvedLeadName.leadFirstName,
                resolved_at: new Date().toISOString(),
            },
        }).catch(() => {});

        const pendingCheckpoint = await getPendingAdminCheckpoint(supabase, lead.id).catch(() => null);
        if (pendingCheckpoint?.id) {
            lead.bloqueado = false;
            if (lead.etapa_atual === 'handoff' && pendingCheckpoint.etapa_pausada) {
                lead.etapa_atual = pendingCheckpoint.etapa_pausada;
            }
        }

        if (lead.bloqueado || lead.etapa_atual === 'handoff') {
            console.log(`[webhook-receiver] lead ${lead.id} bloqueado/handoff — ignorando`);
            continue;
        }

        // ── Cancelar follow-ups pendentes (lead voltou a falar) ─────────────
        await supabase
            .from('followup_schedule')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('lead_id', lead.id)
            .eq('status', 'pending');

        const messageId = m.key?.id ?? null;

        let shouldInsertMessage = true;

        if (messageId) {
            const { data: existingMessage, error: existingMessageError } = await supabase
                .from('mensagens')
                .select('id')
                .eq('whatsapp_message_id', messageId)
                .maybeSingle();

            if (existingMessageError) {
                console.error('[webhook-receiver] erro ao verificar duplicidade da mensagem', JSON.stringify(existingMessageError));
            }

            if (existingMessage?.id) {
                shouldInsertMessage = false;
            }
        }

        if (shouldInsertMessage) {
            const { error: insertMessageError } = await supabase
                .from('mensagens')
                .insert({
                    tenant_id: TENANT_ID,
                    lead_id: lead.id,
                    role: 'user',
                    conteudo: text,
                    tipo,
                    mime_type: mimeType,
                    media_url: mediaUrl,
                    transcricao,
                    etapa_no_momento: lead.etapa_atual,
                    whatsapp_message_id: messageId,
                    created_at: new Date((m.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString(),
                });

            if (insertMessageError) {
                console.error('[webhook-receiver] erro ao salvar mensagem', JSON.stringify(insertMessageError));
                continue;
            }
        }

        await logLeadRuntimeEvent({
            supabase,
            tenantId: TENANT_ID,
            leadId: lead.id,
            eventType: 'test_webhook_received',
            payload: {
                telefone,
                etapa_atual: lead.etapa_atual,
                texto: text,
                tipo,
                transcricao_presente: !!transcricao,
                transcricao_preview: transcricao ? transcricao.slice(0, 160) : null,
                audio_failure_reason: audioFailureReason,
                audio_metadata: tipo === 'audio' ? {
                    mime_type: mimeType,
                    media_url_presente: !!mediaUrl,
                    message_id: inboundMessageId || null,
                    message_root_keys: Object.keys(m.message ?? {}),
                    audio_keys: Object.keys(m.message?.audioMessage ?? {}),
                } : null,
                inbound_message_id: inboundMessageId || null,
                whatsapp_message_id: messageId,
                inserted_message: shouldInsertMessage,
                received_at: new Date().toISOString(),
            },
        }).catch(() => {});

        if (pendingCheckpoint?.id) {
            await logLeadRuntimeEvent({
                supabase,
                tenantId: TENANT_ID,
                leadId: lead.id,
                eventType: 'test_message_buffered_during_admin_pause',
                payload: {
                    telefone,
                    etapa_atual: lead.etapa_atual,
                    texto: text,
                    checkpoint_admin: pendingCheckpoint.checkpoint_admin,
                    buffered_at: new Date().toISOString(),
                },
            }).catch(() => {});
            continue;
        }

        const [{ data: recentMsgs }, { data: recentUserOnly }] = await Promise.all([
            supabase
                .from('mensagens')
                .select('role, conteudo, created_at')
                .eq('lead_id', lead.id)
                .order('created_at', { ascending: false })
                .limit(60),
            supabase
                .from('mensagens')
                .select('conteudo, created_at')
                .eq('lead_id', lead.id)
                .eq('role', 'user')
                .order('created_at', { ascending: false })
                .limit(6),
        ]);

        const history = (recentMsgs ?? [])
            .reverse()
            .map((h: any) => ({ role: h.role, content: h.conteudo ?? '' }))
            .filter((h: any) => h.content !== '');

        const recentUserMessages = (recentUserOnly ?? [])
            .slice()
            .reverse()
            .map((h: any) => h?.conteudo ?? '')
            .filter(Boolean)
            .slice(-3);

        await sendMessage(supabase, Q_INBOUND, {
            lead_id: lead.id,
            tenant_id: TENANT_ID,
            telefone,
            etapa_atual: lead.etapa_atual,
            text,
            nome_lead: lead.lead_person_name ?? lead.nome ?? null,
            recent_user_messages: recentUserMessages,
            history,
            received_at: new Date().toISOString(),
            inbound_message_id: inboundMessageId || null,
            trigger: 'whatsapp_inbound',
            instance: body.instance,
        });

        await logLeadRuntimeEvent({
            supabase,
            tenantId: TENANT_ID,
            leadId: lead.id,
            eventType: 'test_inbound_enqueued',
            payload: {
                telefone,
                etapa_atual: lead.etapa_atual,
                texto: text,
                recent_user_messages: recentUserMessages,
                history_size: history.length,
                queued_at: new Date().toISOString(),
            },
        }).catch(() => {});

        console.log(`[webhook-receiver] enqueued lead ${lead.id} telefone ${telefone}`);
        enqueued.push(lead.id);
    }

    if (enqueued.length > 0) {
        await triggerEdgeFunction('debounce-worker');
    }

    return new Response(
        JSON.stringify({ ok: true, enqueued: enqueued.length, lead_ids: enqueued }),
        { headers: { 'Content-Type': 'application/json' } },
    );
});
