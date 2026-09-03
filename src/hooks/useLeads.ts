'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { serverQuery, serverCount, serverUpdate } from '@/lib/supabase';
import { Lead, Stage } from '@/lib/types';
import { useRealtime } from './useRealtime';

const POLL_INTERVAL = 60000;

interface UseLeadsOptions {
  search?: string;
  etapa?: string;
  status?: string;
  limit?: number;
}

export function useLeads(options: UseLeadsOptions = {}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const fetchLeads = useCallback(async () => {
    const opts = optionsRef.current;
    setLoading(true);
    const match: Record<string, any> = {};

    if (opts.etapa && opts.etapa !== 'todas') {
      match.etapa_atual = opts.etapa;
    }
    if (opts.status === 'matriculado') {
      match.matriculado = true;
    }

    const { data, error } = await serverQuery<Lead>('leads', {
      columns: '*',
      match: Object.keys(match).length > 0 ? match : undefined,
      order: { column: 'updated_at', ascending: false },
      limit: opts.limit || 100,
    });
    if (!error && data) {
      let filtered = data;
      if (opts.search) {
        const q = opts.search.toLowerCase();
        filtered = data.filter((l) =>
          l.nome?.toLowerCase().includes(q) || l.telefone?.toLowerCase().includes(q)
        );
      }
      if (opts.status === 'handoff') {
        filtered = filtered.filter((l) => l.etapa_atual === 'handoff' || l.bloqueado === true);
      }
      if (opts.status === 'ativo') {
        filtered = filtered.filter((l) => l.etapa_atual !== 'encerrado' && l.etapa_atual !== 'inativo');
      }
      setLeads(filtered);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLeads();
    const interval = setInterval(fetchLeads, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchLeads]);

  useRealtime<Lead>('leads', () => fetchLeads());

  const refresh = () => fetchLeads();

  return { leads, loading, refresh };
}

export function useLead(id: string | undefined) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      const { data, error } = await serverQuery<Lead>('leads', {
        columns: '*',
        match: { id },
        limit: 1,
      });
      if (!error && data && data.length > 0) {
        setLead(data[0]);
      } else if (error) {
        console.error('Erro ao carregar lead:', error);
      }
      setLoading(false);
    })();
  }, [id]);

  useRealtime<Lead>(
    'leads',
    (payload) => {
      if (payload.new && (payload.new as Lead).id === id) {
        setLead(payload.new as Lead);
      }
    },
    id ? `id=eq.${id}` : undefined,
  );

  const updateLead = async (updates: Partial<Lead>) => {
    if (!id) return;
    const { error } = await serverUpdate(
      'leads',
      updates,
      { id },
    );

    if (!error) {
      setLead((prev) => (prev ? { ...prev, ...updates } : null));
    }
    return { error };
  };

  return { lead, loading, updateLead };
}

export function useLeadsByStage() {
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const stages: Stage[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'handoff', 'encerrado'];

  const fetchCounts = useCallback(async () => {
    const queries = stages.map((stage) => serverCount('leads', { etapa_atual: stage }));
    const responses = await Promise.all(queries);
    const results: Record<string, number> = {};
    stages.forEach((stage, i) => {
      results[stage] = responses[i].count || 0;
    });
    setStageCounts(results);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchCounts]);

  return { stageCounts, loading, stages };
}
