'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { serverQuery } from '@/lib/supabase';
import { Mensagem } from '@/lib/types';
import { useRealtime } from './useRealtime';

const POLL_INTERVAL = 60000;

export function useMensagens(leadId: string | undefined) {
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [loading, setLoading] = useState(true);
  const leadIdRef = useRef(leadId);
  leadIdRef.current = leadId;

  const fetchMensagens = useCallback(async () => {
    const id = leadIdRef.current;
    if (!id) {
      setMensagens([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await serverQuery<Mensagem>('mensagens', {
      columns: '*',
      match: { lead_id: id },
      order: { column: 'created_at', ascending: true },
    });

    if (!error && data) {
      setMensagens(data as Mensagem[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchMensagens();
    const interval = setInterval(fetchMensagens, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMensagens, leadId]);

  useRealtime<Mensagem>(
    'mensagens',
    () => {
      if (leadIdRef.current) {
        fetchMensagens();
      }
    },
    leadId ? `lead_id=eq.${leadId}` : undefined,
  );

  return { mensagens, loading, refresh: fetchMensagens };
}
