'use client';

import { useEffect, useState } from 'react';
import { Save, RotateCcw, AlertTriangle } from 'lucide-react';
import { AgentDefinition, AGENT_NAMES, AGENT_OBJECTIVES } from '@/lib/types';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { serverUpdate } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { getAgentPromptOverride, getAgentPromptUpdatedAt, mergeAgentConfig } from '@/lib/agent-definitions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface PromptEditorProps {
  agent: AgentDefinition | null;
  onUpdate: () => void;
}

const USAGE_DESCRIPTIONS: Record<string, { title: string; text: string }> = {
  PERSONALITY: {
    title: 'Aplicacao pratica',
    text: 'Este prompt controla a identidade global do agente. Ele e aplicado em todas as etapas do atendimento e tambem influencia os follow-ups automáticos.',
  },
  E1: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E1. Ele define como o agente deve conduzir a abertura, qualificacao inicial e coleta dos primeiros dados.',
  },
  E2: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E2. Ele governa a continuidade imediata apos a E1, o aprofundamento do contexto do lead, o alinhamento comercial e a preparacao para a progressao da conversa.',
  },
  E3: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E3. Ele controla a apresentacao do produto, a conexao com a dor do lead e o ganho de interesse.',
  },
  E4: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E4. Ele define ancoragem, proposta, coleta de dados e conducao para pagamento.',
  },
  E5: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E5. Ele controla confirmacao de pagamento, matricula e transicao para indicacoes.',
  },
  E6: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E6. Ele define a abordagem para capturar indicacoes apos a matricula.',
  },
  E7: {
    title: 'Aplicacao pratica',
    text: 'Este prompt e usado quando o lead esta na etapa E7. Ele controla o fechamento da conversa e a preparacao dos indicados.',
  },
};

export function PromptEditor({ agent, onUpdate }: PromptEditorProps) {
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (agent) {
      setPrompt(getAgentPromptOverride(agent) || agent.config?.default_prompt || '');
    }
  }, [agent]);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Selecione um subagente na lista ao lado</p>
      </div>
    );
  }

  const currentAgent = agent;
  const stage = currentAgent.subagent_key;
  const isPersonality = stage === 'PERSONALITY';
  const promptOverride = getAgentPromptOverride(currentAgent);
  const promptUpdatedAt = getAgentPromptUpdatedAt(currentAgent);
  const usage = USAGE_DESCRIPTIONS[stage] || USAGE_DESCRIPTIONS.PERSONALITY;

  async function handleSave() {
    setSaving(true);

    const isDefault = prompt === (currentAgent.config?.default_prompt || '');
    const { error } = await serverUpdate(
      'agent_definitions',
      {
        config: mergeAgentConfig(currentAgent, {
          prompt_override: isDefault ? null : prompt || null,
          prompt_updated_at: isDefault ? null : new Date().toISOString(),
        }),
        updated_at: new Date().toISOString(),
      },
      { id: currentAgent.id },
    );

    if (error) {
      toast({ title: 'Erro ao salvar', description: error, variant: 'destructive' });
    } else {
      toast({ title: 'Prompt salvo com sucesso', variant: 'success' });
      onUpdate();
    }

    setSaving(false);
  }

  async function handleReset() {
    setSaving(true);
    const defaultPrompt = currentAgent.config?.default_prompt || '';

    const { error } = await serverUpdate(
      'agent_definitions',
      {
        config: mergeAgentConfig(currentAgent, {
          prompt_override: null,
          prompt_updated_at: null,
        }),
        updated_at: new Date().toISOString(),
      },
      { id: currentAgent.id },
    );

    if (error) {
      toast({ title: 'Erro ao resetar', description: error, variant: 'destructive' });
    } else {
      toast({ title: 'Prompt restaurado para o padrao', variant: 'success' });
      setPrompt(defaultPrompt);
      setResetDialogOpen(false);
      onUpdate();
    }

    setSaving(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Prompt - {AGENT_NAMES[stage]}</h3>
          <p className="text-sm text-muted-foreground">{currentAgent.subagent_key}</p>
        </div>
        <div className="flex items-center gap-2">
          {currentAgent.enabled ? <Badge variant="success">ATIVO</Badge> : <Badge variant="destructive">DESATIVADO</Badge>}
          {promptOverride ? <Badge variant="warning">PROMPT CUSTOMIZADO</Badge> : null}
        </div>
      </div>

      {isPersonality ? (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 p-3 text-sm text-violet-600">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          Este prompt define a identidade e a personalidade do agente em todas as etapas.
          Use {'{TIPO_CONTATO}'} e {'{NOME_DO_LEAD}'} como placeholders dinamicos.
        </div>
      ) : (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          O prompt salvo aqui substitui o padrao da etapa no codigo.
        </div>
      )}

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-700">
        <p className="font-semibold">{usage.title}</p>
        <p className="mt-1">{usage.text}</p>
        <p className="mt-2 text-xs">
          O runtime usa este texto vindo da dashboard como fonte editorial real. Alterou aqui, o agente passa a usar esse conteúdo no fluxo correspondente.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={promptOverride ? 'warning' : 'secondary'}>
          {promptOverride ? 'CUSTOMIZADO' : 'PADRAO DO CODIGO'}
        </Badge>
      </div>

      <Textarea
        placeholder="Digite o prompt personalizado para este subagente..."
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="min-h-[400px] font-mono text-sm"
      />

      <p className="text-sm text-muted-foreground">
        Objetivo: {agent.config?.objetivo || AGENT_OBJECTIVES[stage]}
      </p>

      {promptUpdatedAt ? (
        <p className="text-xs text-muted-foreground">Ultima edicao: {formatDate(promptUpdatedAt)}</p>
      ) : null}

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving}>
          <Save className="mr-1 h-4 w-4" />
          {saving ? 'Salvando...' : 'Salvar Prompt'}
        </Button>

        <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="border-destructive/50 text-destructive">
              <RotateCcw className="mr-1 h-4 w-4" />
              {isPersonality ? 'Restaurar padrao' : 'Restaurar prompt do codigo'}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {isPersonality ? 'Restaurar personalidade padrao?' : 'Restaurar prompt do codigo?'}
              </DialogTitle>
              <DialogDescription>
                {isPersonality
                  ? 'Isso remove a personalidade customizada e volta para o padrao do codigo.'
                  : 'Isso remove o prompt customizado e volta para o padrao do codigo.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={handleReset} disabled={saving}>
                {saving ? 'Restaurando...' : 'Sim, restaurar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
