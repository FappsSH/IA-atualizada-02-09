'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { serverInsert, serverQuery } from '@/lib/supabase';
import { AgentDefinition } from '@/lib/types';
import { AgentList } from '@/components/subagentes/AgentList';
import { PromptEditor } from '@/components/subagentes/PromptEditor';
import { useRealtime } from '@/hooks/useRealtime';
import { buildDefaultPersonalityAgent } from '@/lib/default-agent-definition';

export function SubagentesClient({ initialAgents }: { initialAgents: AgentDefinition[] }) {
  const [agents, setAgents] = useState<AgentDefinition[]>(initialAgents);
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(null);
  const [loading, setLoading] = useState(initialAgents.length === 0);
  const initialSelectDone = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedAgent?.id || null;
  }, [selectedAgent]);

  useEffect(() => {
    if (agents.length > 0 && !initialSelectDone.current) {
      initialSelectDone.current = true;
      const personality = agents.find((agent) => agent.subagent_key === 'PERSONALITY');
      setSelectedAgent(personality || agents[0]);
    }
  }, [agents]);

  const ensurePersonalityAgent = useCallback(async (items: AgentDefinition[]) => {
    const hasPersonality = items.some((agent) => agent.subagent_key === 'PERSONALITY');
    if (hasPersonality) {
      return items;
    }

    const { error } = await serverInsert('agent_definitions', buildDefaultPersonalityAgent());
    if (error && !error.toLowerCase().includes('duplicate')) {
      return items;
    }

    const retry = await serverQuery<AgentDefinition>('agent_definitions', {
      columns: '*',
      order: { column: 'subagent_key', ascending: true },
    });

    return (retry.data as AgentDefinition[] | null) || items;
  }, []);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const { data, error } = await serverQuery<AgentDefinition>('agent_definitions', {
      columns: '*',
      order: { column: 'subagent_key', ascending: true },
    });

    if (!error && data) {
      const nextAgents = await ensurePersonalityAgent(data as AgentDefinition[]);
      setAgents(nextAgents);

      if (selectedIdRef.current) {
        const match = nextAgents.find((agent) => agent.id === selectedIdRef.current);
        if (match) {
          setSelectedAgent(match);
        }
      }
    }

    setLoading(false);
  }, [ensurePersonalityAgent]);

  useEffect(() => {
    if (!initialAgents.length) {
      void fetchAgents();
    }
  }, [fetchAgents, initialAgents.length]);

  useEffect(() => {
    if (initialAgents.length > 0) {
      void ensurePersonalityAgent(initialAgents).then((nextAgents) => {
        setAgents(nextAgents);
      });
    }
  }, [ensurePersonalityAgent, initialAgents]);

  useRealtime<any>('agent_definitions', fetchAgents);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Subagentes</h2>
        <p className="text-sm text-muted-foreground">
          Esta tela e a fonte editorial de verdade do agente. O runtime usa os prompts salvos aqui para montar a identidade global e o fluxo de cada etapa.
        </p>
      </div>

      <div className="grid gap-6 lg:min-h-[calc(100dvh-12rem)] lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="max-h-[420px] overflow-y-auto rounded-lg border p-4 lg:max-h-none">
          <AgentList
            agents={agents}
            selectedKey={selectedAgent?.subagent_key || null}
            onSelect={setSelectedAgent}
            loading={loading}
            onToggle={fetchAgents}
          />
        </div>
        <div className="min-w-0 overflow-y-auto rounded-lg border p-4 sm:p-6">
          <PromptEditor key={selectedAgent?.id || 'none'} agent={selectedAgent} onUpdate={fetchAgents} />
        </div>
      </div>
    </div>
  );
}
