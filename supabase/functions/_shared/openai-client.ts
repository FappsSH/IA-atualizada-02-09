// OpenAI Chat Completions wrapper (ADR-0009).
// Multi-provider portável; logs em log_openai_requests (idêntico ao AgentHub root).
// deno-lint-ignore-file
// @ts-nocheck

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    name?: string;
}

export interface ToolSpec {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    tool_choice?: 'auto' | 'none' | 'required';
    parallel_tool_calls?: boolean;
    temperature?: number;
    max_tokens?: number;
}

export interface ChatResponse {
    id: string;
    choices: Array<{
        index: number;
        message: ChatMessage;
        finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryDelayMs(errorBody: string) {
    const secondsMatch = String(errorBody || '').match(/try again in\s+([0-9.]+)s/i);
    if (secondsMatch?.[1]) {
        return Math.ceil(Number(secondsMatch[1]) * 1000);
    }

    const msMatch = String(errorBody || '').match(/try again in\s+([0-9.]+)ms/i);
    if (msMatch?.[1]) {
        return Math.ceil(Number(msMatch[1]));
    }

    return 1500;
}

export async function transcribeAudio(apiKey: string, audioBlob: Blob, mimeType?: string): Promise<string> {
    const ext =
        mimeType?.includes('ogg') ? 'ogg' :
        mimeType?.includes('mp4') ? 'mp4' :
        mimeType?.includes('mp3') ? 'mp3' :
        mimeType?.includes('wav') ? 'wav' :
        mimeType?.includes('webm') ? 'webm' :
        mimeType?.includes('flac') ? 'flac' :
        mimeType?.includes('mpeg') ? 'mpeg' :
        'ogg'; // WhatsApp voice notes são sempre OGG Opus
    const form = new FormData();
    form.append('file', audioBlob, `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Whisper ${res.status}: ${body}`);
    }
    const data = await res.json();
    return (data.text ?? '').trim();
}

export async function chatCompletions(apiKey: string, req: ChatRequest): Promise<ChatResponse> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req),
        });

        if (res.ok) {
            return res.json();
        }

        const body = await res.text();
        if (res.status === 429 && attempt < 2) {
            await sleep(Math.max(600, extractRetryDelayMs(body)));
            continue;
        }

        throw new Error(`OpenAI ${res.status}: ${body}`);
    }

    throw new Error('OpenAI chat completion failed after retries.');
}
