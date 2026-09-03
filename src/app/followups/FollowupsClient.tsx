'use client';

import { useEffect, useState } from 'react';
import { serverQuery, serverUpdate, DEFAULT_TENANT_ID } from '@/lib/supabase';
import { FollowupConfig, FollowupSchedule } from '@/lib/types';
import { useRealtime } from '@/hooks/useRealtime';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Timer,
  Clock,
  Play,
  XCircle,
  RefreshCw,
  Save,
  Send,
} from 'lucide-react';

interface Props {
  initialConfigs: FollowupConfig[];
  initialPendentes: any[];
  initialHistorico: any[];
}

export function FollowupsClient({ initialConfigs, initialPendentes, initialHistorico }: Props) {
  const [configs, setConfigs] = useState<FollowupConfig[]>(initialConfigs);
  const [pendentes, setPendentes] = useState<any[]>(initialPendentes);
  const [historico, setHistorico] = useState<any[]>(initialHistorico);
  const [loading, setLoading] = useState(false);
  const [savingAttempt, setSavingAttempt] = useState<number | null>(null);
  const { toast } = useToast();

  const fetchAll = async () => {
    setLoading(true);

    const [configRes, pendingRes, historyRes] = await Promise.all([
      serverQuery<FollowupConfig>('followup_config', {
        columns: '*',
        match: { tenant_id: DEFAULT_TENANT_ID },
        order: { column: 'attempt', ascending: true },
      }),
      serverQuery<any>('followup_schedule', {
        columns: '*, leads!inner(id, nome, telefone, etapa_atual, curso_interesse)',
        match: { tenant_id: DEFAULT_TENANT_ID, status: 'pending' },
        order: { column: 'schedule_at', ascending: true },
        limit: 50,
      }),
      serverQuery<any>('followup_schedule', {
        columns: '*, leads!inner(id, nome, telefone, etapa_atual, curso_interesse)',
        match: {
          tenant_id: DEFAULT_TENANT_ID,
          status: { in: ['sent', 'cancelled', 'expired'] },
        },
        order: { column: 'updated_at', ascending: false },
        limit: 30,
      }),
    ]);

    if (configRes.data) setConfigs(configRes.data as FollowupConfig[]);
    if (pendingRes.data) setPendentes(pendingRes.data);
    if (historyRes.data) setHistorico(historyRes.data);
    setLoading(false);
  };

  useEffect(() => {
    if (!initialConfigs.length && !initialPendentes.length && !initialHistorico.length) {
      void fetchAll();
    }
  }, [initialConfigs.length, initialPendentes.length, initialHistorico.length]);

  useRealtime<FollowupConfig>('followup_config', fetchAll);
  useRealtime<FollowupSchedule>('followup_schedule', fetchAll);

  const saveInterval = async (attempt: number, minutes: number) => {
    setSavingAttempt(attempt);
    const { error } = await serverUpdate(
      'followup_config',
      { interval_minutes: minutes, tenant_id: DEFAULT_TENANT_ID },
      { tenant_id: DEFAULT_TENANT_ID, attempt },
    );

    if (error) {
      toast({ title: 'Erro ao salvar', description: error, variant: 'destructive' });
    } else {
      toast({ title: `Tentativa #${attempt} salva (${minutes} min)`, variant: 'success' });
      void fetchAll();
    }

    setSavingAttempt(null);
  };

  const cancelSchedule = async (id: string) => {
    const { error } = await serverUpdate(
      'followup_schedule',
      { status: 'cancelled', updated_at: new Date().toISOString() },
      { id },
    );

    if (error) {
      toast({ title: 'Erro ao cancelar', description: error, variant: 'destructive' });
    } else {
      toast({ title: 'Follow-up cancelado', variant: 'success' });
      void fetchAll();
    }
  };

  const triggerNow = async (id: string) => {
    const { error } = await serverUpdate(
      'followup_schedule',
      { schedule_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id },
    );

    if (error) {
      toast({ title: 'Erro ao disparar', description: error, variant: 'destructive' });
    } else {
      toast({ title: 'Follow-up reagendado para agora', variant: 'success' });
      void fetchAll();
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; variant: 'warning' | 'success' | 'destructive' | 'secondary' }> = {
      pending: { label: 'Pendente', variant: 'warning' },
      sent: { label: 'Enviado', variant: 'success' },
      cancelled: { label: 'Cancelado', variant: 'destructive' },
      expired: { label: 'Expirado', variant: 'secondary' },
    };
    const current = map[status] || { label: status, variant: 'secondary' as const };
    return <Badge variant={current.variant}>{current.label}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Follow-ups</h2>
        <p className="text-sm text-muted-foreground">
          Gerencie os intervalos e acompanhe os follow-ups programados
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Intervalos por Tentativa
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void fetchAll()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
        </CardHeader>
        <CardContent>
          {configs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma configuração encontrada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Tentativa</TableHead>
                  <TableHead>Rótulo</TableHead>
                  <TableHead className="w-40">Intervalo (minutos)</TableHead>
                  <TableHead className="w-32">Em horas</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-24 text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {configs.map((cfg) => {
                  const hours = (cfg.interval_minutes / 60).toFixed(1);

                  return (
                    <TableRow key={cfg.id}>
                      <TableCell>
                        <Badge variant="outline">#{cfg.attempt}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{cfg.label ?? '-'}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          defaultValue={cfg.interval_minutes}
                          min={1}
                          max={43200}
                          className="h-8 w-28"
                          id={`interval-${cfg.attempt}`}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {cfg.interval_minutes < 60
                          ? `${cfg.interval_minutes}min`
                          : `${hours}h${cfg.interval_minutes % 60 > 0 ? ` ${cfg.interval_minutes % 60}min` : ''}`}
                      </TableCell>
                      <TableCell>
                        {cfg.enabled ? <Badge variant="success">Ativo</Badge> : <Badge variant="secondary">Inativo</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          onClick={() => {
                            const el = document.getElementById(`interval-${cfg.attempt}`) as HTMLInputElement | null;
                            const val = Number.parseInt(el?.value || '', 10);
                            if (val > 0) {
                              void saveInterval(cfg.attempt, val);
                            }
                          }}
                          disabled={savingAttempt === cfg.attempt}
                        >
                          <Save className="mr-1 h-3.5 w-3.5" />
                          {savingAttempt === cfg.attempt ? '...' : 'Salvar'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4" />
            Pendentes ({pendentes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pendentes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum follow-up pendente.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Tentativa</TableHead>
                  <TableHead>Agendado para</TableHead>
                  <TableHead>Etapa</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-36 text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendentes.map((schedule: any) => (
                  <TableRow key={schedule.id}>
                    <TableCell className="font-medium">{schedule.leads?.nome ?? '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{schedule.leads?.telefone ?? '-'}</TableCell>
                    <TableCell><Badge variant="outline">#{schedule.attempt}</Badge></TableCell>
                    <TableCell>{new Date(schedule.schedule_at).toLocaleString('pt-BR')}</TableCell>
                    <TableCell>{schedule.leads?.etapa_atual ?? '-'}</TableCell>
                    <TableCell>{statusBadge(schedule.status)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={() => void triggerNow(schedule.id)} title="Disparar agora">
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void cancelSchedule(schedule.id)} title="Cancelar">
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4" />
            Histórico
          </CardTitle>
        </CardHeader>
        <CardContent>
          {historico.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum histórico.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Tentativa</TableHead>
                  <TableHead>Agendado</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Enviado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historico.map((schedule: any) => (
                  <TableRow key={schedule.id}>
                    <TableCell className="font-medium">{schedule.leads?.nome ?? '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{schedule.leads?.telefone ?? '-'}</TableCell>
                    <TableCell><Badge variant="outline">#{schedule.attempt}</Badge></TableCell>
                    <TableCell>{new Date(schedule.schedule_at).toLocaleString('pt-BR')}</TableCell>
                    <TableCell>{statusBadge(schedule.status)}</TableCell>
                    <TableCell>{schedule.sent_at ? new Date(schedule.sent_at).toLocaleString('pt-BR') : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
