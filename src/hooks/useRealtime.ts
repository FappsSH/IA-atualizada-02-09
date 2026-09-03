'use client';

import { useEffect, useRef } from 'react';
import { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createBrowserClient, getSupabaseConfigStatus } from '@/lib/supabase';

type TableName =
  | 'agent_definitions'
  | 'followup_config'
  | 'followup_schedule'
  | 'indicacoes'
  | 'knowledge_items'
  | 'lead_events'
  | 'leads'
  | 'mensagens'
  | 'tenants'
  | 'trace_span'
  | 'whatsapp_instances';

export function useRealtime<T extends { [key: string]: any }>(
  table: TableName,
  onPayload: (payload: RealtimePostgresChangesPayload<T>) => void,
  filter?: string
) {
  const supabase = useRef(createBrowserClient());
  const callbackRef = useRef(onPayload);
  const channelCounterRef = useRef(0);
  callbackRef.current = onPayload;

  const hasFilter = filter !== undefined;
  const stableFilter = hasFilter ? filter : null;

  useEffect(() => {
    if (!getSupabaseConfigStatus().realtimeEnabled) {
      return;
    }

    channelCounterRef.current += 1;
    const channelName = `realtime-${table}-${channelCounterRef.current}-${Date.now()}`;
    const channel = supabase.current.channel(channelName);

    channel.on(
      'postgres_changes' as any,
      {
        event: '*',
        schema: 'public',
        table,
        filter: stableFilter ?? undefined,
      },
      (payload: RealtimePostgresChangesPayload<T>) => {
        callbackRef.current(payload);
      }
    );

    channel.subscribe((status: string) => {
      if (status === 'CHANNEL_ERROR') {
        console.warn(`Realtime error on ${table}: CHANNEL_ERROR`);
      }
    });

    return () => {
      supabase.current.removeChannel(channel);
    };
  }, [table, stableFilter, hasFilter]);
}
