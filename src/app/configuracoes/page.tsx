'use client';

import { useEffect, useState } from 'react';
import {
  Brain,
  CheckCircle2,
  Clock,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Server,
  Variable,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import { useRealtime } from '@/hooks/useRealtime';
import { DEFAULT_TENANT_ID, serverUpdate } from '@/lib/supabase';
import type { Tenant, WhatsAppInstance } from '@/lib/types';

function normalizeEvolutionBaseUrl(url: string) {
  return url.trim().replace(/\/manager\/?$/i, '').replace(/\/+$/, '');
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, '');
}

interface SettingsSnapshot {
  tenant: Tenant | null;
  whatsapp: WhatsAppInstance | null;
  whatsappInstances: WhatsAppInstance[];
}

export default function ConfiguracoesPage() {
  const [whatsapp, setWhatsapp] = useState<WhatsAppInstance | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingEvolution, setSavingEvolution] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resettingTests, setResettingTests] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [modelo, setModelo] = useState('gpt-4.1');
  const [temperatura, setTemperatura] = useState(0.7);
  const [horaInicio, setHoraInicio] = useState('08:00');
  const [horaFim, setHoraFim] = useState('18:00');
  const [fuso, setFuso] = useState('America/Porto_Velho');
  const [evolutionUrl, setEvolutionUrl] = useState('');
  const [evolutionKey, setEvolutionKey] = useState('');
  const [evolutionInstanceName, setEvolutionInstanceName] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [adminPhone, setAdminPhone] = useState('');
  const [whatsNumero, setWhatsNumero] = useState('');
  const [whatsName, setWhatsName] = useState('');
  const { toast } = useToast();

  const savedConfig = tenant?.config || {};
  const savedEvolutionUrl = normalizeEvolutionBaseUrl(savedConfig.evolution_api_url || '');
  const savedEvolutionKey = (savedConfig.evolution_api_key || '').trim();
  const savedEvolutionInstanceName = (savedConfig.evolution_instance_name || '').trim();
  const savedOpenAiKey = (savedConfig.openai_api_key || '').trim();
  const savedAdminPhone = (savedConfig.telefone_admin || '').trim();
  const savedWhatsappInstanceName = whatsapp?.instance_name?.trim() || '';

  function applySnapshot(snapshot: SettingsSnapshot) {
    setTenant(snapshot.tenant);
    setWhatsapp(snapshot.whatsapp);

    if (snapshot.whatsapp) {
      setWhatsNumero(snapshot.whatsapp.numero || '');
      setWhatsName(snapshot.whatsapp.instance_name || '');
    } else {
      setWhatsNumero('');
      setWhatsName('');
    }

    if (snapshot.tenant) {
      const cfg = snapshot.tenant.config || {};
      setModelo(cfg.modelo_ia || 'gpt-4.1');
      setTemperatura(cfg.temperatura ?? 0.7);
      setHoraInicio(cfg.business_hours?.start || '08:00');
      setHoraFim(cfg.business_hours?.end || '18:00');
      setFuso(cfg.business_hours?.tz || 'America/Porto_Velho');
      setEvolutionUrl(cfg.evolution_api_url || '');
      setEvolutionKey(cfg.evolution_api_key || '');
      setEvolutionInstanceName(cfg.evolution_instance_name || '');
      setOpenaiKey(cfg.openai_api_key || '');
      setAdminPhone(cfg.telefone_admin || '');
    }
  }

  async function loadSettings() {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast({
        title: 'Erro ao carregar configuracoes',
        description: json.error || `HTTP ${res.status}`,
        variant: 'destructive',
      });
      return;
    }

    applySnapshot(json as SettingsSnapshot);
  }

  useEffect(() => {
    (async () => {
      await loadSettings();
      setLoading(false);
    })();
  }, []);

  useRealtime<Tenant>(
    'tenants',
    (payload) => {
      if (payload.new && (payload.new as Tenant).id === DEFAULT_TENANT_ID) {
        const updated = payload.new as Tenant;
        const cfg = updated.config || {};
        setTenant(updated);
        setModelo(cfg.modelo_ia || 'gpt-4.1');
        setTemperatura(cfg.temperatura ?? 0.7);
        setHoraInicio(cfg.business_hours?.start || '08:00');
        setHoraFim(cfg.business_hours?.end || '18:00');
        setFuso(cfg.business_hours?.tz || 'America/Porto_Velho');
        setEvolutionUrl(cfg.evolution_api_url || '');
        setEvolutionKey(cfg.evolution_api_key || '');
        setEvolutionInstanceName(cfg.evolution_instance_name || '');
        setOpenaiKey(cfg.openai_api_key || '');
        setAdminPhone(cfg.telefone_admin || '');
      }
    },
    `id=eq.${DEFAULT_TENANT_ID}`,
  );

  useRealtime<WhatsAppInstance>('whatsapp_instances', (payload) => {
    if (payload.new && (payload.new as WhatsAppInstance).tenant_id === DEFAULT_TENANT_ID) {
      loadSettings();
    }
  });

  async function saveConfig(updates: Partial<Tenant['config']>) {
    if (!tenant) return false;

    const newConfig = { ...(tenant.config || {}), ...updates };
    const { error } = await serverUpdate('tenants', { config: newConfig }, { id: DEFAULT_TENANT_ID });

    if (error) {
      toast({ title: 'Erro ao salvar', description: error, variant: 'destructive' });
      return false;
    }

    setTenant({ ...tenant, config: newConfig });
    toast({ title: 'Configuracao salva', variant: 'success' });
    return true;
  }

  async function saveWhatsApp() {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: 'whatsapp',
        payload: {
          instance_name: whatsName,
          numero: whatsNumero,
          current_whatsapp_id: whatsapp?.id || null,
        },
      }),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast({
        title: 'Erro ao salvar WhatsApp',
        description: json.error || `HTTP ${res.status}`,
        variant: 'destructive',
      });
      return;
    }

    applySnapshot(json as SettingsSnapshot);
    toast({ title: 'WhatsApp atualizado', variant: 'success' });
  }

  async function createWhatsApp() {
    await saveWhatsApp();
  }

  async function updateWhatsStatus(status: string) {
    if (!whatsapp) return;

    const { error } = await serverUpdate('whatsapp_instances', { status }, { id: whatsapp.id });
    if (error) {
      toast({ title: 'Erro ao atualizar status', description: error, variant: 'destructive' });
      return;
    }

    setWhatsapp({ ...whatsapp, status: status as WhatsAppInstance['status'] });
    toast({ title: `Status alterado para: ${status}`, variant: 'success' });
  }

  async function saveEvolutionSettings() {
    const normalizedUrl = normalizeEvolutionBaseUrl(evolutionUrl);
    const normalizedInstanceName = evolutionInstanceName.trim();
    const normalizedNumber = normalizePhone(whatsNumero);

    if (!normalizedUrl || !evolutionKey.trim() || !normalizedInstanceName) {
      toast({
        title: 'Campos obrigatorios',
        description: 'Preencha URL, API Key e nome da instancia da Evolution.',
        variant: 'destructive',
      });
      return;
    }

    setSavingEvolution(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'evolution',
          payload: {
            evolution_api_url: normalizedUrl,
            evolution_api_key: evolutionKey.trim(),
            evolution_instance_name: normalizedInstanceName,
            numero: normalizedNumber,
            current_whatsapp_id: whatsapp?.id || null,
          },
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast({
          title: 'Erro ao salvar Evolution',
          description: json.error || `HTTP ${res.status}`,
          variant: 'destructive',
        });
        return;
      }

      applySnapshot(json as SettingsSnapshot);
      toast({ title: 'Evolution configurada com sucesso', variant: 'success' });
    } finally {
      setSavingEvolution(false);
    }
  }

  async function checkWhatsConnection() {
    const targetInstanceName = (evolutionInstanceName || whatsName || whatsapp?.instance_name || '').trim();
    const normalizedUrl = normalizeEvolutionBaseUrl(evolutionUrl);

    if (!targetInstanceName) {
      toast({
        title: 'Instancia ausente',
        description: 'Informe o nome da instancia antes de verificar a conexao.',
        variant: 'destructive',
      });
      return;
    }

    setVerifying(true);
    try {
      const res = await fetch('/api/evolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'connectionState',
          instanceName: targetInstanceName,
          evolutionUrl: normalizedUrl,
          evolutionKey: evolutionKey.trim(),
          evolutionInstanceName: targetInstanceName,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const state =
        body?.instance?.state ||
        body?.state ||
        body?.instance?.status ||
        body?.status ||
        '';
      const connected = String(state).toLowerCase() === 'open';
      const newStatus: WhatsAppInstance['status'] = connected ? 'conectado' : 'desconectado';

      if (whatsapp) {
        await serverUpdate('whatsapp_instances', { status: newStatus }, { id: whatsapp.id });
        setWhatsapp({ ...whatsapp, status: newStatus });
      }

      toast({
        title: connected ? 'WhatsApp conectado' : 'WhatsApp desconectado',
        description: state ? `Estado retornado pela Evolution: ${state}` : undefined,
        variant: connected ? 'success' : 'destructive',
      });
    } catch (err: any) {
      toast({ title: 'Erro ao verificar', description: err.message, variant: 'destructive' });
    } finally {
      setVerifying(false);
    }
  }

  async function resetTestData() {
    const confirmed = window.confirm(
      'Isso vai apagar todos os leads, mensagens, indicacoes, follow-ups e logs de teste do Supabase local. Deseja continuar?',
    );

    if (!confirmed) {
      return;
    }

    setResettingTests(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: 'reset_test_data',
          payload: {},
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: 'Erro ao resetar testes',
          description: json.error || `HTTP ${res.status}`,
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: 'Dados de teste removidos',
        description: 'Leads, mensagens, follow-ups e logs foram zerados com sucesso.',
        variant: 'success',
      });
    } finally {
      setResettingTests(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Configuracoes</h2>
        <p className="text-sm text-muted-foreground">
          Gerencie instancia de WhatsApp, Evolution API, modelo da OpenAI e configuracoes operacionais.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="h-4 w-4" />
              Instancia WhatsApp
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {whatsapp ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <Badge
                    variant={
                      whatsapp.status === 'conectado'
                        ? 'success'
                        : whatsapp.status === 'conectando'
                          ? 'warning'
                          : 'destructive'
                    }
                    className="flex items-center gap-1"
                  >
                    {whatsapp.status === 'conectado' ? (
                      <Wifi className="h-3 w-3" />
                    ) : (
                      <WifiOff className="h-3 w-3" />
                    )}
                    {whatsapp.status}
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={checkWhatsConnection} disabled={verifying}>
                      {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      {verifying ? 'Verificando...' : 'Verificar'}
                    </Button>
                    <Select value={whatsapp.status} onValueChange={updateWhatsStatus}>
                      <SelectTrigger className="h-8 w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="conectado">Conectado</SelectItem>
                        <SelectItem value="desconectado">Desconectado</SelectItem>
                        <SelectItem value="conectando">Conectando</SelectItem>
                        <SelectItem value="banido">Banido</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium">Nome da instancia</label>
                  <Input value={whatsName} onChange={(e) => setWhatsName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium">Numero (5511999999999)</label>
                  <Input
                    value={whatsNumero}
                    onChange={(e) => setWhatsNumero(normalizePhone(e.target.value))}
                    placeholder="5511999999999"
                  />
                </div>
                <Button onClick={saveWhatsApp} className="w-full">
                  <Save className="mr-1 h-4 w-4" /> Salvar WhatsApp
                </Button>
              </>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Nenhuma instancia cadastrada.</p>
                <div className="space-y-2">
                  <label className="text-xs font-medium">Nome da instancia</label>
                  <Input
                    value={whatsName}
                    onChange={(e) => setWhatsName(e.target.value)}
                    placeholder="cruzeiro-vendas"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium">Numero</label>
                  <Input
                    value={whatsNumero}
                    onChange={(e) => setWhatsNumero(normalizePhone(e.target.value))}
                    placeholder="5511999999999"
                  />
                </div>
                <Button onClick={createWhatsApp} className="w-full">
                  <Plus className="mr-1 h-4 w-4" /> Cadastrar instancia
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="h-4 w-4" />
              Modelo de IA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Modelo</label>
              <Select
                value={modelo}
                onValueChange={(value) => {
                  setModelo(value);
                  saveConfig({ modelo_ia: value });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-4.1">gpt-4.1</SelectItem>
                  <SelectItem value="gpt-4.1-mini">gpt-4.1-mini</SelectItem>
                  <SelectItem value="gpt-4o">gpt-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">gpt-4o-mini</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Temperatura: {temperatura.toFixed(1)}</label>
              <Slider
                value={[temperatura]}
                onValueChange={([value]) => setTemperatura(value)}
                onValueCommit={([value]) => saveConfig({ temperatura: value })}
                max={1}
                step={0.1}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              Evolution API
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">URL da Evolution API</label>
              <Input
                value={evolutionUrl}
                onChange={(e) => setEvolutionUrl(e.target.value)}
                placeholder="http://localhost:8081"
              />
              <p className="text-xs text-muted-foreground">
                Pode colar a URL do painel. O sistema remove automaticamente o trecho <code>/manager</code>.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">API Key da Evolution</label>
              <div className="flex gap-2">
                <Input
                  type={showKeys.evolution_key ? 'text' : 'password'}
                  value={evolutionKey}
                  onChange={(e) => setEvolutionKey(e.target.value)}
                  placeholder="chave-da-evolution-api"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setShowKeys((current) => ({
                      ...current,
                      evolution_key: !current.evolution_key,
                    }))
                  }
                >
                  {showKeys.evolution_key ? 'Ocultar' : 'Mostrar'}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Nome da instancia Evolution</label>
              <Input
                value={evolutionInstanceName}
                onChange={(e) => {
                  setEvolutionInstanceName(e.target.value);
                  if (!whatsapp) {
                    setWhatsName(e.target.value);
                  }
                }}
                placeholder="cruzeiro-vendas"
              />
            </div>
            <Button onClick={saveEvolutionSettings} className="w-full" disabled={savingEvolution}>
              {savingEvolution ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {savingEvolution ? 'Salvando...' : 'Salvar Evolution API'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4" />
              OpenAI
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">OpenAI API Key</label>
              <div className="flex gap-2">
                <Input
                  type={showKeys.openai_key ? 'text' : 'password'}
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setShowKeys((current) => ({
                      ...current,
                      openai_key: !current.openai_key,
                    }))
                  }
                >
                  {showKeys.openai_key ? 'Ocultar' : 'Mostrar'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Chave usada pelos agentes e funcoes server-side.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">WhatsApp pessoal para alertas</label>
              <Input
                value={adminPhone}
                onChange={(e) => setAdminPhone(normalizePhone(e.target.value))}
                onBlur={() => saveConfig({ telefone_admin: normalizePhone(adminPhone) })}
                placeholder="5511999999999"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" />
              Horario de operacao
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Inicio</label>
                <Input
                  type="time"
                  value={horaInicio}
                  onChange={(e) => {
                    setHoraInicio(e.target.value);
                    saveConfig({ business_hours: { start: e.target.value, end: horaFim, tz: fuso } });
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Fim</label>
                <Input
                  type="time"
                  value={horaFim}
                  onChange={(e) => {
                    setHoraFim(e.target.value);
                    saveConfig({ business_hours: { start: horaInicio, end: e.target.value, tz: fuso } });
                  }}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Fuso horario</label>
              <Select
                value={fuso}
                onValueChange={(value) => {
                  setFuso(value);
                  saveConfig({ business_hours: { start: horaInicio, end: horaFim, tz: value } });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="America/Porto_Velho">America/Porto_Velho (UTC-4)</SelectItem>
                  <SelectItem value="America/Sao_Paulo">America/Sao_Paulo (UTC-3)</SelectItem>
                  <SelectItem value="America/Manaus">America/Manaus (UTC-4)</SelectItem>
                  <SelectItem value="America/Fortaleza">America/Fortaleza (UTC-3)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Variable className="h-4 w-4" />
              Status das chaves
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { key: 'Evolution API URL', value: savedEvolutionUrl },
              { key: 'Evolution API Key', value: savedEvolutionKey },
              { key: 'Evolution Instance', value: savedEvolutionInstanceName },
              { key: 'OpenAI API Key', value: savedOpenAiKey },
              { key: 'WhatsApp Admin', value: savedAdminPhone },
              { key: 'WhatsApp Instancia', value: savedWhatsappInstanceName },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-sm">{item.key}</span>
                {item.value ? (
                  <Badge variant="success" className="flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Configurada
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> Ausente
                  </Badge>
                )}
              </div>
            ))}
            <p className="mt-2 text-xs text-muted-foreground">
              Estes indicadores mostram o que esta salvo de verdade no banco, nao apenas o que foi digitado no formulario.
            </p>
          </CardContent>
        </Card>

        <Card className="border-red-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-red-600">
              <XCircle className="h-4 w-4" />
              Resetar testes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Remove todos os leads, mensagens, indicacoes, follow-ups e logs de teste do ambiente local, sem mexer em configuracoes, prompts ou conhecimento.
            </p>
            <Button
              variant="destructive"
              className="w-full"
              onClick={resetTestData}
              disabled={resettingTests}
            >
              {resettingTests ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <XCircle className="mr-1 h-4 w-4" />}
              {resettingTests ? 'Resetando...' : 'Resetar dados de teste'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
