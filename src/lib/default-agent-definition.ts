import { DEFAULT_TENANT_ID } from '@/lib/supabase';
import type { AgentDefinition } from '@/lib/types';

export function buildDefaultPersonalityAgent() {
  return {
    tenant_id: DEFAULT_TENANT_ID,
    subagent_key: 'PERSONALITY',
    enabled: true,
    config: {
      nome: 'Personalidade Compartilhada',
      objetivo: 'Definir identidade, tom, postura e regras globais que todos os subagentes devem seguir.',
      default_prompt: '',
    },
  } satisfies Partial<AgentDefinition> & Record<string, unknown>;
}
