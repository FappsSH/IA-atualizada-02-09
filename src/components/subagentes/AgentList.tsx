'use client';

import { Bot, User } from 'lucide-react';
import { AgentDefinition, AGENT_NAMES, AGENT_OBJECTIVES } from '@/lib/types';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { serverUpdate } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import { getAgentPromptOverride } from '@/lib/agent-definitions';

interface AgentListProps {
  agents: AgentDefinition[];
  selectedKey: string | null;
  onSelect: (agent: AgentDefinition) => void;
  loading: boolean;
  onToggle: () => void;
}

const STAGE_ORDER = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];

export function AgentList({ agents, selectedKey, onSelect, loading, onToggle }: AgentListProps) {
  const { toast } = useToast();

  async function handleToggle(agent: AgentDefinition, enabled: boolean) {
    const { error } = await serverUpdate(
      'agent_definitions',
      { enabled, updated_at: new Date().toISOString() },
      { id: agent.id },
    );

    if (error) {
      toast({ title: 'Erro', description: error, variant: 'destructive' });
      return;
    }

    toast({
      title: `${AGENT_NAMES[agent.subagent_key]} ${enabled ? 'ativado' : 'desativado'}`,
      variant: 'success',
    });
    onToggle();
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 9 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const personalityAgent = agents.find((agent) => agent.subagent_key === 'PERSONALITY');
  const sortedAgents = STAGE_ORDER.map((key) => agents.find((agent) => agent.subagent_key === key)).filter(
    Boolean,
  ) as AgentDefinition[];

  return (
    <div className="space-y-1">
      {personalityAgent ? (
        <>
          <button
            type="button"
            onClick={() => onSelect(personalityAgent)}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
              personalityAgent.subagent_key === selectedKey
                ? 'border-primary/30 bg-accent'
                : 'border-transparent hover:bg-accent/50'
            }`}
          >
            <div className="flex items-start gap-3">
              <User className="mt-0.5 h-5 w-5 text-violet-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-violet-600 dark:text-violet-400">
                  {AGENT_NAMES.PERSONALITY}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {personalityAgent.config?.objetivo || AGENT_OBJECTIVES.PERSONALITY}
                </p>
                {getAgentPromptOverride(personalityAgent) ? (
                  <p className="mt-1 text-[10px] text-amber-500">Personalizado</p>
                ) : null}
              </div>
            </div>
          </button>
          <div className="my-2 border-t" />
        </>
      ) : null}

      <p className="mb-1 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Fluxo de Vendas
      </p>

      {sortedAgents.map((agent) => {
        const isSelected = agent.subagent_key === selectedKey;
        return (
          <div
            key={agent.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(agent)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(agent);
              }
            }}
            className={`w-full cursor-pointer rounded-lg border p-3 text-left transition-colors ${
              isSelected ? 'border-primary/30 bg-accent' : 'border-transparent hover:bg-accent/50'
            }`}
          >
            <div className="flex items-start gap-3">
              <Bot className={`mt-0.5 h-5 w-5 ${agent.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {agent.subagent_key} - {AGENT_NAMES[agent.subagent_key]}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {agent.config?.objetivo || AGENT_OBJECTIVES[agent.subagent_key]}
                </p>
                {getAgentPromptOverride(agent) ? (
                  <p className="mt-1 text-[10px] text-yellow-500">Prompt customizado</p>
                ) : null}
              </div>
              <Switch
                checked={agent.enabled}
                onCheckedChange={(checked) => handleToggle(agent, checked)}
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
