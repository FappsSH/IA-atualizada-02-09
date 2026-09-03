'use client';

import { useEffect, useState } from 'react';
import { ListChecks, MessageSquareText, ScrollText, SmilePlus, Type, Variable } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useRealtime } from '@/hooks/useRealtime';
import { DEFAULT_TENANT_ID, serverUpdate } from '@/lib/supabase';
import { DEFAULT_MESSAGE_POLICY, normalizeMessagePolicy } from '@/lib/message-policy';
import type { Tenant } from '@/lib/types';

interface SettingsSnapshot {
  tenant: Tenant | null;
}

export default function RegrasPage() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [messagePolicy, setMessagePolicy] = useState(normalizeMessagePolicy(undefined));
  const { toast } = useToast();
  const greetingRules = messagePolicy.greeting_rules || DEFAULT_MESSAGE_POLICY.greeting_rules!;
  const formatting = messagePolicy.formatting || DEFAULT_MESSAGE_POLICY.formatting!;

  function applySnapshot(snapshot: SettingsSnapshot) {
    setTenant(snapshot.tenant);
    setMessagePolicy(normalizeMessagePolicy(snapshot.tenant?.config?.message_policy));
  }

  async function loadRules() {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast({
        title: 'Erro ao carregar regras',
        description: json.error || `HTTP ${res.status}`,
        variant: 'destructive',
      });
      return;
    }

    applySnapshot(json as SettingsSnapshot);
  }

  useEffect(() => {
    (async () => {
      await loadRules();
      setLoading(false);
    })();
  }, []);

  useRealtime<Tenant>(
    'tenants',
    (payload) => {
      if (payload.new && (payload.new as Tenant).id === DEFAULT_TENANT_ID) {
        const updated = payload.new as Tenant;
        setTenant(updated);
        setMessagePolicy(normalizeMessagePolicy(updated.config?.message_policy));
      }
    },
    `id=eq.${DEFAULT_TENANT_ID}`,
  );

  async function saveConfig(nextPolicy: typeof messagePolicy) {
    if (!tenant) return false;

    const newConfig = { ...(tenant.config || {}), message_policy: nextPolicy };
    const { error } = await serverUpdate('tenants', { config: newConfig }, { id: DEFAULT_TENANT_ID });

    if (error) {
      toast({ title: 'Erro ao salvar regras', description: error, variant: 'destructive' });
      return false;
    }

    setTenant({ ...tenant, config: newConfig });
    setMessagePolicy(nextPolicy);
    toast({ title: 'Regras atualizadas', variant: 'success' });
    return true;
  }

  function updatePolicy(path: string[], value: string | number | boolean) {
    setMessagePolicy((current) => {
      const next = structuredClone(current);
      let target: Record<string, unknown> = next as unknown as Record<string, unknown>;

      for (let index = 0; index < path.length - 1; index += 1) {
        target = target[path[index]] as Record<string, unknown>;
      }

      target[path[path.length - 1]] = value;
      return next;
    });
  }

  async function saveWithPatch(path: string[], value: string | number | boolean) {
    const next = structuredClone(messagePolicy);
    let target: Record<string, unknown> = next as unknown as Record<string, unknown>;

    for (let index = 0; index < path.length - 1; index += 1) {
      target = target[path[index]] as Record<string, unknown>;
    }

    target[path[path.length - 1]] = value;
    await saveConfig(normalizeMessagePolicy(next));
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28" />
        <div className="grid gap-6 xl:grid-cols-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ListChecks className="h-6 w-6 text-primary" />
          Regras
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Esta tela controla as regras operacionais que o sistema aplica de verdade antes de enviar cada resposta.
          Quando voce ajustar aqui, o runtime passa a usar estas configuracoes no WhatsApp e nos prompts.
        </p>
      </div>

      <Card className="border-sky-500/30 bg-sky-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Variable className="h-4 w-4" />
            Tags disponiveis para os prompts
          </CardTitle>
          <CardDescription>
            Use estas tags dentro dos prompts da dashboard para deixar o comportamento mais claro.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><code>regras_gerais</code>: conjunto de comandos obrigatorios com prioridade maxima sobre estilo e variacoes.</p>
          <p><code>saudacao_por_horario</code>: aplica a saudacao correta conforme as faixas definidas abaixo.</p>
          <p><code>estrutura_mensagem</code>: aplica o padrao de separacao e quebra visual das mensagens.</p>
          <p><code>caracteres_nao_permitidos</code>: remove os caracteres proibidos da resposta final.</p>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4" />
              Regras gerais
            </CardTitle>
            <CardDescription>
              Use este bloco para comandos obrigatorios que o agente nunca pode descumprir. Se a linha comecar com "Nao", o sistema trata como proibicao absoluta no runtime.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={messagePolicy.general_rules || ''}
              onChange={(e) => updatePolicy(['general_rules'], e.target.value)}
              onBlur={(e) => saveWithPatch(['general_rules'], e.target.value)}
              className="min-h-[220px]"
              placeholder={'Ex:\nNao use emojis.\nNao fale de preco antes da etapa correta.\nUse sempre o nome Universidade Cruzeiro do Sul.\nResponda sempre seguindo regras_gerais, saudacao_por_horario e estrutura_mensagem.'}
            />
            <p className="text-xs text-muted-foreground">
              Escreva uma regra por linha. Quando voce quiser proibir algo, comece a linha com <code>Nao</code>.
            </p>
          </CardContent>
        </Card>

        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SmilePlus className="h-4 w-4" />
              Horarios e forma de saudacao
            </CardTitle>
            <CardDescription>
              O sistema ajusta automaticamente a saudacao inicial com base no horario de Sao Paulo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { key: 'morning', label: 'Manha' },
              { key: 'afternoon', label: 'Tarde' },
              { key: 'night', label: 'Noite' },
            ].map((item) => (
              <div key={item.key} className="space-y-2 rounded-xl border p-4">
                <p className="text-sm font-semibold">{item.label}</p>
                <div className="grid gap-3 sm:grid-cols-[7rem_7rem_minmax(0,1fr)]">
                  <Input
                    type="time"
                    value={greetingRules[item.key as keyof typeof greetingRules]?.start || ''}
                    onChange={(e) => updatePolicy(['greeting_rules', item.key, 'start'], e.target.value)}
                    onBlur={(e) => saveWithPatch(['greeting_rules', item.key, 'start'], e.target.value)}
                  />
                  <Input
                    type="time"
                    value={greetingRules[item.key as keyof typeof greetingRules]?.end || ''}
                    onChange={(e) => updatePolicy(['greeting_rules', item.key, 'end'], e.target.value)}
                    onBlur={(e) => saveWithPatch(['greeting_rules', item.key, 'end'], e.target.value)}
                  />
                  <Input
                    value={greetingRules[item.key as keyof typeof greetingRules]?.text || ''}
                    onChange={(e) => updatePolicy(['greeting_rules', item.key, 'text'], e.target.value)}
                    onBlur={(e) => saveWithPatch(['greeting_rules', item.key, 'text'], e.target.value)}
                    placeholder={`Saudacao da ${item.label.toLowerCase()}`}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareText className="h-4 w-4" />
              Estrutura e padrao de mensagem
            </CardTitle>
            <CardDescription>
              Aqui voce define como o texto sera quebrado e apresentado antes do envio.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border p-4">
              <div className="pr-4">
                <p className="text-sm font-medium">Enviar nova mensagem so quando passar do limite</p>
                <p className="text-xs text-muted-foreground">
                  Dentro do limite, o sistema mantem blocos com linha em branco na mesma mensagem.
                </p>
              </div>
              <Switch
                checked={formatting.force_separate_messages}
                onCheckedChange={(checked) => {
                  updatePolicy(['formatting', 'force_separate_messages'], checked);
                  saveWithPatch(['formatting', 'force_separate_messages'], checked);
                }}
              />
            </div>

            <div className="flex items-center justify-between rounded-xl border p-4">
              <div className="pr-4">
                <p className="text-sm font-medium">Inserir linha em branco em mensagem longa</p>
                <p className="text-xs text-muted-foreground">
                  Cria blocos mais legiveis quando a resposta passar do limite configurado.
                </p>
              </div>
              <Switch
                checked={formatting.insert_blank_line_in_long_messages}
                onCheckedChange={(checked) => {
                  updatePolicy(['formatting', 'insert_blank_line_in_long_messages'], checked);
                  saveWithPatch(['formatting', 'insert_blank_line_in_long_messages'], checked);
                }}
              />
            </div>

            <div className="grid gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium">Limite de caracteres para considerar mensagem longa</label>
                <Input
                  type="number"
                  value={formatting.long_message_char_threshold}
                  onChange={(e) => updatePolicy(['formatting', 'long_message_char_threshold'], Number(e.target.value || 0))}
                  onBlur={(e) => saveWithPatch(['formatting', 'long_message_char_threshold'], Number(e.target.value || 0))}
                />
                <p className="text-xs text-muted-foreground">
                  Exemplo: `240` para manter ate 2 frases de ~120 caracteres na mesma mensagem antes de abrir outra.
                </p>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Numero maximo de frases por bloco</label>
                <Input
                  type="number"
                  value={formatting.sentences_per_block}
                  onChange={(e) => updatePolicy(['formatting', 'sentences_per_block'], Number(e.target.value || 1))}
                  onBlur={(e) => saveWithPatch(['formatting', 'sentences_per_block'], Number(e.target.value || 1))}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Exemplo de mensagem 1</label>
                <Textarea
                  value={formatting.example_message_1 || ''}
                  onChange={(e) => updatePolicy(['formatting', 'example_message_1'], e.target.value)}
                  onBlur={(e) => saveWithPatch(['formatting', 'example_message_1'], e.target.value)}
                  className="min-h-[120px]"
                  placeholder={'Ex: Muito bom dia, Maria\n\nQuero entender seu objetivo profissional para te orientar melhor.'}
                />
                <p className="text-xs text-muted-foreground">
                  Use este campo para mostrar ao agente um exemplo curto do formato ideal.
                </p>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Exemplo de mensagem 2</label>
                <Textarea
                  value={formatting.example_message_2 || ''}
                  onChange={(e) => updatePolicy(['formatting', 'example_message_2'], e.target.value)}
                  onBlur={(e) => saveWithPatch(['formatting', 'example_message_2'], e.target.value)}
                  className="min-h-[140px]"
                  placeholder={'Ex: Muito boa tarde, Joao\n\nQuero te explicar como funciona a formacao.\n\nSe passar do limite configurado, a proxima parte segue em outra mensagem.'}
                />
                <p className="text-xs text-muted-foreground">
                  Use este campo para um exemplo mais completo, com quebra visual e organizacao do texto.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Type className="h-4 w-4" />
              Caracteres nao permitidos
            </CardTitle>
            <CardDescription>
              Informe apenas os caracteres que o agente nunca deve enviar na resposta final.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 rounded-xl border p-4">
              <label className="block text-sm font-medium">Lista de caracteres bloqueados</label>
              <Input
                value={messagePolicy.forbidden_chars || ''}
                onChange={(e) => updatePolicy(['forbidden_chars'], e.target.value)}
                onBlur={(e) => saveWithPatch(['forbidden_chars'], e.target.value)}
                placeholder="Ex: *_#[]{}"
              />
              <p className="text-xs text-muted-foreground">
                Exemplo: se voce colocar <code>*_#</code>, qualquer um desses caracteres sera removido antes do envio.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
