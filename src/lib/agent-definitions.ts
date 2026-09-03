import { AgentDefinition } from '@/lib/types';

export function getAgentPromptOverride(agent?: Pick<AgentDefinition, 'config'> & {
  prompt_override?: string | null;
}) {
  if (!agent) return null;

  const configPrompt =
    agent.config && typeof agent.config === 'object' && 'prompt_override' in agent.config
      ? String((agent.config as Record<string, unknown>).prompt_override || '').trim()
      : '';

  const flatPrompt = typeof agent.prompt_override === 'string' ? agent.prompt_override.trim() : '';
  return flatPrompt || configPrompt || null;
}

export function getAgentPromptUpdatedAt(agent?: Pick<AgentDefinition, 'config'> & {
  prompt_updated_at?: string | null;
}) {
  if (!agent) return null;

  const configUpdatedAt =
    agent.config && typeof agent.config === 'object' && 'prompt_updated_at' in agent.config
      ? String((agent.config as Record<string, unknown>).prompt_updated_at || '').trim()
      : '';

  const flatUpdatedAt =
    typeof agent.prompt_updated_at === 'string' ? agent.prompt_updated_at.trim() : '';

  return flatUpdatedAt || configUpdatedAt || null;
}

export function mergeAgentConfig(
  agent: Pick<AgentDefinition, 'config'>,
  patch: Record<string, unknown>,
) {
  return {
    ...(agent.config || {}),
    ...patch,
  };
}
