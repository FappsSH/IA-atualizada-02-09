// PGMQ wrapper — Agente de Vendas Fapps
// deno-lint-ignore-file
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const QUEUES = {
    MESSAGES: 'messages_vendas',
    AI_PROCESSING: 'ai_processing_vendas',
} as const;

export async function sendMessage(supabase: any, queue: string, payload: unknown, delaySec = 0) {
    return supabase.rpc('pgmq_send', { queue_name: queue, msg: payload, delay: delaySec });
}

export async function readMessage(supabase: any, queue: string, vtSec = 30, qty = 1) {
    return supabase.rpc('pgmq_read', { queue_name: queue, vt: vtSec, qty });
}

export async function deleteMessage(supabase: any, queue: string, msgId: number) {
    return supabase.rpc('pgmq_delete', { queue_name: queue, msg_id: msgId });
}

export async function archiveMessage(supabase: any, queue: string, msgId: number) {
    return supabase.rpc('pgmq_archive', { queue_name: queue, msg_id: msgId });
}
