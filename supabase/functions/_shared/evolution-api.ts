// Evolution API helpers — download de mídia, descriptografia, envio de texto
// deno-lint-ignore-file
// @ts-nocheck

export interface EvolutionConfig {
    baseUrl: string;
    apiKey: string;
    instanceName: string;
}

function evolutionHeaders(apiKey: string, withJson = false) {
    const headers: Record<string, string> = {
        apikey: apiKey,
    };
    if (withJson) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

function looksLikeUrl(value: string) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizeBase64Payload(value: string): { base64: string; mimeType: string | null } | null {
    const input = String(value || '').trim();
    if (!input) return null;

    const dataUrlMatch = input.match(/^data:([^;]+);base64,(.+)$/i);
    if (dataUrlMatch) {
        return {
            mimeType: dataUrlMatch[1] || null,
            base64: dataUrlMatch[2] || '',
        };
    }

    if (/^[A-Za-z0-9+/_=-]{80,}$/.test(input)) {
        return { base64: input, mimeType: null };
    }

    return null;
}

function blobFromBase64Payload(value: string, mimeType?: string | null): Blob | null {
    const normalized = normalizeBase64Payload(value);
    if (!normalized) return null;
    const bytes = base64ToBytes(normalized.base64);
    return new Blob([bytes], { type: mimeType || normalized.mimeType || 'application/octet-stream' });
}

function findNestedStringValue(input: unknown, keys: string[]): string | null {
    if (!input || typeof input !== 'object') return null;

    for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    for (const value of Object.values(input as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
            const nested = findNestedStringValue(value, keys);
            if (nested) return nested;
        }
    }

    return null;
}

function findNestedArrayValue(input: unknown, keys: string[]): number[] | null {
    if (!input || typeof input !== 'object') return null;

    for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
            return value as number[];
        }
    }

    for (const value of Object.values(input as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
            const nested = findNestedArrayValue(value, keys);
            if (nested) return nested;
        }
    }

    return null;
}

async function parseMediaResponse(
    res: Response,
    fallbackMimeType?: string | null,
): Promise<{ blob: Blob; mimeType: string } | null> {
    const contentType = res.headers.get('content-type') ?? '';

    if (contentType.includes('application/json') || contentType.startsWith('text/')) {
        const rawText = await res.text();
        const parsed = (() => {
            try {
                return JSON.parse(rawText);
            } catch {
                return null;
            }
        })();

        const base64Value =
            findNestedStringValue(parsed, ['base64', 'data', 'media', 'buffer', 'file', 'audio', 'content']) ??
            normalizeBase64Payload(rawText)?.base64 ??
            null;
        const urlValue = findNestedStringValue(parsed, ['url', 'downloadUrl', 'download_url', 'mediaUrl', 'media_url']);
        const arrayValue = findNestedArrayValue(parsed, ['bytes', 'data', 'buffer']);
        const envelopeMimeType =
            findNestedStringValue(parsed, ['mimetype', 'mimeType', 'contentType', 'content_type']) ??
            fallbackMimeType ??
            null;

        if (base64Value) {
            const blob = blobFromBase64Payload(base64Value, envelopeMimeType);
            if (blob) {
                return { blob, mimeType: envelopeMimeType || blob.type || 'application/octet-stream' };
            }
        }

        if (arrayValue) {
            const blob = new Blob([new Uint8Array(arrayValue)], {
                type: envelopeMimeType || 'application/octet-stream',
            });
            return { blob, mimeType: envelopeMimeType || blob.type || 'application/octet-stream' };
        }

        if (urlValue && looksLikeUrl(urlValue)) {
            return await downloadFromUrl(urlValue, envelopeMimeType || fallbackMimeType || undefined);
        }

        return null;
    }

    const blob = await res.blob();
    const mimeType = contentType || fallbackMimeType || 'audio/ogg';
    return { blob, mimeType };
}

export async function markMessageAsRead(
    config: EvolutionConfig,
    number: string,
    messageId: string,
): Promise<{
    success: boolean;
    routeUsed: string | null;
    errorMessage: string | null;
    routeAttempts: Array<{
        route: string;
        httpStatus: number | null;
        responseBody: string | null;
        authMode: string;
        instanceName: string | null;
    }>;
}> {
    const normalizedNumber = String(number || '').replace(/^\+/, '').replace(/@.*/, '');
    if (!normalizedNumber || !messageId) {
        return { success: false, routeUsed: null, errorMessage: 'missing_number_or_message_id', routeAttempts: [] };
    }

    const headers = evolutionHeaders(config.apiKey, true);
    const routeAttempts: Array<{
        route: string;
        httpStatus: number | null;
        responseBody: string | null;
        authMode: string;
        instanceName: string | null;
    }> = [];

    try {
        const directRoute = 'message/markread';
        const directRes = await fetch(`${config.baseUrl}/${directRoute}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                number: normalizedNumber,
                id: [messageId],
            }),
        });
        routeAttempts.push({
            route: directRoute,
            httpStatus: directRes.status,
            responseBody: (await directRes.text().catch(() => '')).slice(0, 280) || null,
            authMode: 'apikey_json',
            instanceName: config.instanceName || null,
        });

        if (directRes.ok) {
            return { success: true, routeUsed: directRoute, errorMessage: null, routeAttempts };
        }

        const fallbackRoute = `chat/markMessageAsRead/${config.instanceName}`;
        const fallbackRes = await fetch(`${config.baseUrl}/${fallbackRoute}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                readMessages: [
                    {
                        id: messageId,
                        fromMe: false,
                        remoteJid: `${normalizedNumber}@s.whatsapp.net`,
                    },
                ],
            }),
        });
        routeAttempts.push({
            route: fallbackRoute,
            httpStatus: fallbackRes.status,
            responseBody: (await fallbackRes.text().catch(() => '')).slice(0, 280) || null,
            authMode: 'apikey_json',
            instanceName: config.instanceName || null,
        });

        if (fallbackRes.ok) {
            return { success: true, routeUsed: fallbackRoute, errorMessage: null, routeAttempts };
        }

        const errorMessage = `markMessageAsRead failed: ${routeAttempts.map((attempt) => attempt.httpStatus ?? 'ERR').join('/')}`;
        console.warn(`[evolution-api] ${errorMessage}`);
        return { success: false, routeUsed: null, errorMessage, routeAttempts };
    } catch (error) {
        const errorMessage = String(error);
        console.warn(`[evolution-api] markMessageAsRead exception: ${errorMessage}`);
        return {
            success: false,
            routeUsed: null,
            errorMessage,
            routeAttempts,
        };
    }
}

export async function downloadMedia(
    config: EvolutionConfig,
    messageKey: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
    const url = `${config.baseUrl}/message/getMedia/${config.instanceName}?messageKey=${encodeURIComponent(messageKey)}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: evolutionHeaders(config.apiKey),
    });
    if (!res.ok) {
        console.warn(`[evolution-api] downloadMedia (messageKey) falhou: ${res.status} ${await res.text().catch(() => '')}`);
        return null;
    }
    return await parseMediaResponse(res, 'audio/ogg');
}

// Tenta download com diferentes nomes de parâmetro (messageKey vs mediaKey)
export async function downloadMediaFlexible(
    config: EvolutionConfig,
    key: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
    // Tenta com messageKey (Evolution API v2+)
    let result = await downloadMedia(config, key);
    if (result) return result;

    // Tenta com mediaKey (Evolution API v1)
    const url2 = `${config.baseUrl}/message/getMedia/${config.instanceName}?mediaKey=${encodeURIComponent(key)}`;
    const res2 = await fetch(url2, {
        method: 'GET',
        headers: evolutionHeaders(config.apiKey),
    });
    if (!res2.ok) {
        console.warn(`[evolution-api] downloadMedia (mediaKey) falhou: ${res2.status}`);
        return null;
    }
    return await parseMediaResponse(res2, 'audio/ogg');
}

export async function downloadMediaFromMessageObject(
    config: EvolutionConfig,
    messageEnvelope: Record<string, unknown>,
): Promise<{ blob: Blob; mimeType: string } | null> {
    const candidateMessages = [
        messageEnvelope,
        (messageEnvelope?.message && typeof messageEnvelope.message === 'object')
            ? messageEnvelope.message as Record<string, unknown>
            : null,
        {
            key: messageEnvelope?.key,
            message: messageEnvelope?.message,
            messageType: messageEnvelope?.messageType,
            messageTimestamp: messageEnvelope?.messageTimestamp,
            pushName: messageEnvelope?.pushName,
            contextInfo: messageEnvelope?.contextInfo,
        },
    ].filter(Boolean);

    const routes = [
        '/message/downloadimage',
        `/message/downloadimage/${config.instanceName}`,
        '/message/downloadMedia',
        `/message/downloadMedia/${config.instanceName}`,
        '/chat/getBase64FromMediaMessage',
        `/chat/getBase64FromMediaMessage/${config.instanceName}`,
    ];

    for (const route of routes) {
        for (const candidateMessage of candidateMessages) {
            for (const body of [{ message: candidateMessage }, candidateMessage]) {
                try {
                    const res = await fetch(`${config.baseUrl}${route}`, {
                        method: 'POST',
                        headers: evolutionHeaders(config.apiKey, true),
                        body: JSON.stringify(body),
                    });

                    if (!res.ok) {
                        console.warn(`[evolution-api] downloadMediaFromMessageObject falhou em ${route}: ${res.status} ${await res.text().catch(() => '')}`);
                        continue;
                    }

                    const media = await parseMediaResponse(res, 'audio/ogg');
                    if (media?.blob?.size) {
                        return media;
                    }
                } catch (error) {
                    console.warn(`[evolution-api] downloadMediaFromMessageObject exception em ${route}: ${String(error)}`);
                }
            }
        }
    }

    return null;
}

// ── Descriptografia de mídia WhatsApp ─────────────────────────────────────────
// Mídia do WhatsApp é armazenada criptografada no CDN com AES-256-CBC.
// A mediaKey do webhook (base64) é expandida via HKDF-SHA256 para derivar a chave.
// O blob baixado tem estrutura: IV(16 bytes) + ciphertext.

export function base64ToBytes(b64: string): Uint8Array {
    const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = norm.padEnd(norm.length + (4 - (norm.length % 4)) % 4, '=');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function unpadPKCS7(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    const padLen = data[data.length - 1];
    if (padLen < 1 || padLen > 16) return data;
    for (let i = data.length - padLen; i < data.length; i++) {
        if (data[i] !== padLen) return data;
    }
    return data.slice(0, data.length - padLen);
}

export async function decryptWhatsAppMedia(
    encryptedBlob: Blob,
    mediaKey: string | Uint8Array | number[],
    mediaType: 'Audio' | 'Image' | 'Video' | 'Document' = 'Audio',
): Promise<Blob> {
    let ikm: Uint8Array;
    if (typeof mediaKey === 'string') {
        ikm = base64ToBytes(mediaKey);
    } else if (mediaKey instanceof Uint8Array) {
        ikm = mediaKey;
    } else if (Array.isArray(mediaKey)) {
        ikm = new Uint8Array(mediaKey);
    } else if (mediaKey instanceof ArrayBuffer) {
        ikm = new Uint8Array(mediaKey);
    } else {
        throw new Error(`Unsupported mediaKey type: ${typeof mediaKey}`);
    }
    if (ikm.length !== 32) {
        throw new Error(`mediaKey length ${ikm.length} !== 32`);
    }

    const mediaInfoMap: Record<string, string> = {
        Audio: 'WhatsApp Audio Keys',
        Image: 'WhatsApp Image Keys',
        Video: 'WhatsApp Video Keys',
        Document: 'WhatsApp Document Keys',
    };
    const salt = new Uint8Array(0);
    const info = new TextEncoder().encode(mediaInfoMap[mediaType] || 'WhatsApp Audio Keys');

    const baseKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const expandedBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        baseKey,
        112 * 8, // 112 bytes em bits
    );

    const expanded = new Uint8Array(expandedBits);
    const cipherKey = expanded.slice(16, 48); // AES-256-CBC key
    const derivedIv = expanded.slice(0, 16);

    const encBytes = new Uint8Array(await encryptedBlob.arrayBuffer());

    // Formato oficial WhatsApp CDN: ciphertext + MAC(10 bytes)
    if (encBytes.length > 10 && (encBytes.length - 10) % 16 === 0) {
        try {
            const ciphertext = encBytes.slice(0, encBytes.length - 10);
            const aesKey = await crypto.subtle.importKey('raw', cipherKey, { name: 'AES-CBC' }, false, ['decrypt']);
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-CBC', iv: derivedIv },
                aesKey,
                ciphertext,
            );
            const unpadded = unpadPKCS7(new Uint8Array(pt));
            console.log('[decryptWhatsAppMedia] OK com formato oficial WhatsApp, tamanho:', unpadded.length);
            return new Blob([unpadded], { type: 'audio/ogg' });
        } catch (_officialErr) {
            console.log('[decryptWhatsAppMedia] formato oficial falhou, tentando fallbacks');
        }
    }

    // Tenta 2 layouts:
    // 1) IV(16) + ciphertext (mais comum)
    // 2) ciphertext inteiro com IV derivado do HKDF (alternativo)

    // Primeira tentativa: IV do próprio arquivo
    if (encBytes.length > 16) {
        const fileIv = encBytes.slice(0, 16);
        const ciphertext = encBytes.slice(16);

        if (ciphertext.length > 0 && ciphertext.length % 16 === 0) {
            try {
                const aesKey = await crypto.subtle.importKey('raw', cipherKey, { name: 'AES-CBC' }, false, ['decrypt']);
                const pt = await crypto.subtle.decrypt(
                    { name: 'AES-CBC', iv: fileIv },
                    aesKey,
                    ciphertext,
                );
                console.log('[decryptWhatsAppMedia] OK com fileIv, tamanho:', new Uint8Array(pt).length);
                return new Blob([pt], { type: 'audio/ogg' });
            } catch (_e) {
                console.log('[decryptWhatsAppMedia] fileIv falhou, tentando derivedIv');
            }
        }
    }

    // Segunda tentativa: IV derivado, blob inteiro é ciphertext
    if (encBytes.length > 0 && encBytes.length % 16 === 0) {
        try {
            const aesKey = await crypto.subtle.importKey('raw', cipherKey, { name: 'AES-CBC' }, false, ['decrypt']);
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-CBC', iv: derivedIv },
                aesKey,
                encBytes,
            );
            console.log('[decryptWhatsAppMedia] OK com derivedIv, tamanho:', new Uint8Array(pt).length);
            return new Blob([pt], { type: 'audio/ogg' });
        } catch (_e2) {
            console.log('[decryptWhatsAppMedia] derivedIv também falhou');
        }
    }

    // Terceira tentativa: manual com stripping de padding
    if (encBytes.length > 16) {
        const fileIv = encBytes.slice(0, 16);
        const ciphertext = encBytes.slice(16);
        if (ciphertext.length > 0) {
            try {
                const aesKey = await crypto.subtle.importKey('raw', cipherKey, { name: 'AES-CBC' }, false, ['decrypt']);
                const raw = await crypto.subtle.decrypt(
                    { name: 'AES-CBC', iv: fileIv },
                    aesKey,
                    ciphertext,
                );
                const unpadded = unpadPKCS7(new Uint8Array(raw));
                console.log('[decryptWhatsAppMedia] OK (padding manual), tamanho:', unpadded.length);
                return new Blob([unpadded], { type: 'audio/ogg' });
            } catch (_e3) {
                throw new Error('WhatsApp media decryption failed after all attempts');
            }
        }
    }

    throw new Error(`WhatsApp media decryption failed: blob too small (${encBytes.length} bytes)`);
}

// Download direto pela URL do CDN do WhatsApp (fornecida no webhook)
// knownMimeType: mimeType real conhecido (ex: audio/ogg) — usado se o CDN devolver application/octet-stream
export async function downloadFromUrl(
    url: string,
    knownMimeType?: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[evolution-api] downloadFromUrl falhou: ${res.status}`);
            return null;
        }
        const blob = await res.blob();
        let mimeType = res.headers.get('content-type') ?? knownMimeType ?? 'audio/ogg';
        // CDN do WhatsApp frequentemente devolve application/octet-stream — usar o knownMimeType
        if ((mimeType === 'application/octet-stream' || !mimeType) && knownMimeType) {
            mimeType = knownMimeType;
        }
        return { blob, mimeType };
    } catch (e) {
        console.warn(`[evolution-api] downloadFromUrl exception: ${String(e)}`);
        return null;
    }
}

// Tenta download da Evolution API com diferentes métodos e rotas
// Evolution API tem variações de versão — experimentamos vários patterns
export async function downloadMediaMultiRoute(
    config: EvolutionConfig,
    messageKey: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
    const routes = [
        // Estratégia A: GET /message/getMedia/:instance?messageKey= (Evolution API v2+)
        { method: 'GET', path: `/message/getMedia/${config.instanceName}?messageKey=${encodeURIComponent(messageKey)}`, body: false },
        // Estratégia B: GET /message/getMedia/:instance?mediaKey= (Evolution API v1)
        { method: 'GET', path: `/message/getMedia/${config.instanceName}?mediaKey=${encodeURIComponent(messageKey)}`, body: false },
        // Estratégia C: POST /message/getMedia/:instance (body JSON)
        { method: 'POST', path: `/message/getMedia/${config.instanceName}`, body: { messageKey } },
        // Estratégia D: GET /chat/getMedia/:instance?messageKey=
        { method: 'GET', path: `/chat/getMedia/${config.instanceName}?messageKey=${encodeURIComponent(messageKey)}`, body: false },
        // Estratégia E: GET /media/getMedia/:instance?messageKey=
        { method: 'GET', path: `/media/getMedia/${config.instanceName}?messageKey=${encodeURIComponent(messageKey)}`, body: false },
        // Estratégia F: GET /message/downloadMedia/:instance?messageKey=
        { method: 'GET', path: `/message/downloadMedia/${config.instanceName}?messageKey=${encodeURIComponent(messageKey)}`, body: false },
    ];

    for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        try {
            const url = `${config.baseUrl}${route.path}`;
            const opts: RequestInit = {
                method: route.method,
                headers: evolutionHeaders(config.apiKey) as Record<string, string>,
            };
            if (route.body) {
                (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(route.body);
            }
            const res = await fetch(url, opts);
            if (!res.ok) {
                console.log(`[downloadMediaMultiRoute] rota ${i + 1} (${route.method} ${route.path}) falhou: ${res.status}`);
                continue;
            }
            const media = await parseMediaResponse(res, 'audio/ogg');
            if (media?.blob?.size) {
                console.log(`[downloadMediaMultiRoute] rota ${i + 1} OK, ${media.blob.size} bytes`);
                return media;
            }
            console.log(`[downloadMediaMultiRoute] rota ${i + 1} blob vazio`);
        } catch (e) {
            console.log(`[downloadMediaMultiRoute] rota ${i + 1} exception: ${String(e)}`);
        }
    }

    return null;
}
