'use client';

import { useState, useEffect, useRef } from 'react';
import { getSupabaseConfigStatus, serverUpdate } from '@/lib/supabase';
import { Lead, Stage } from '@/lib/types';
import { LeadInfo } from './LeadInfo';
import { LeadIntelligencePanel } from './LeadIntelligencePanel';
import { MessageBubble } from './MessageBubble';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useMensagens } from '@/hooks/useMensagens';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Send, ArrowLeftRight, PhoneOff, UserCheck, ChevronDown } from 'lucide-react';

interface ChatWindowProps {
  lead: Lead;
  onUpdate: () => void;
}

const STAGES: Stage[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];

export function ChatWindow({ lead, onUpdate }: ChatWindowProps) {
  const { mensagens, loading } = useMensagens(lead.id);
  const [forceStage, setForceStage] = useState<Stage>(lead.etapa_atual as Stage);
  const [humanMessage, setHumanMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mensagens]);

  const handleTakeover = async () => {
    const { error } = await serverUpdate(
      'leads',
      { bloqueado: true, updated_at: new Date().toISOString() },
      { id: lead.id },
    );

    if (error) {
      toast({ title: 'Erro', description: error, variant: 'destructive' });
      return;
    }

    toast({ title: 'Conversa assumida', variant: 'success' });
    onUpdate();
  };

  const handleRelease = async () => {
    const { error } = await serverUpdate(
      'leads',
      { bloqueado: false, updated_at: new Date().toISOString() },
      { id: lead.id },
    );

    if (error) {
      toast({ title: 'Erro', description: error, variant: 'destructive' });
      return;
    }

    toast({ title: 'Conversa devolvida para IA', variant: 'success' });
    onUpdate();
  };

  const handleSendMessage = async () => {
    if (!humanMessage.trim()) return;

    const config = getSupabaseConfigStatus();
    if (!config.functionsConfigured) {
      toast({
        title: 'Supabase não configurado',
        description: config.missingConfigMessage,
        variant: 'destructive',
      });
      return;
    }

    setSending(true);
    try {
      const res = await fetch(`${config.functionsUrl}/whatsapp-sender`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.anonKey}`,
        },
        body: JSON.stringify({
          lead_id: lead.id,
          telefone: lead.telefone,
          text: humanMessage.trim(),
        }),
      });

      if (!res.ok) {
        throw new Error('Erro ao enviar mensagem');
      }

      toast({ title: 'Mensagem enviada', variant: 'success' });
      setHumanMessage('');
      onUpdate();
    } catch (err: any) {
      toast({ title: 'Erro ao enviar', description: err.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const handleForceStage = async () => {
    setForcing(true);

    const { error } = await serverUpdate(
      'leads',
      { etapa_atual: forceStage, updated_at: new Date().toISOString() },
      { id: lead.id },
    );

    if (error) {
      toast({ title: 'Erro', description: error, variant: 'destructive' });
      setForcing(false);
      return;
    }

    toast({ title: `Etapa alterada para ${forceStage}`, variant: 'success' });
    setDialogOpen(false);
    setForcing(false);
    onUpdate();
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <LeadInfo lead={lead} />

        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2">
          {lead.bloqueado ? (
            <>
              <Badge variant="destructive" className="flex items-center gap-1">
                <UserCheck className="h-3 w-3" /> Você está assumindo
              </Badge>
              <Button variant="outline" size="sm" onClick={handleRelease} className="ml-auto">
                <ArrowLeftRight className="mr-1 h-4 w-4" /> Devolver para IA
              </Button>
            </>
          ) : (
            <Button variant="destructive" size="sm" onClick={handleTakeover} className="ml-auto">
              <PhoneOff className="mr-1 h-4 w-4" /> Assumir Conversa
            </Button>
          )}

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <ChevronDown className="mr-1 h-4 w-4" /> Forçar Etapa
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Forçar Avanço de Etapa</DialogTitle>
                <DialogDescription>Alterar a etapa atual do lead para:</DialogDescription>
              </DialogHeader>
              <Select value={forceStage} onValueChange={(value) => setForceStage(value as Stage)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGES.map((stage) => (
                    <SelectItem key={stage} value={stage}>
                      {stage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button onClick={handleForceStage} disabled={forcing}>
                  {forcing ? 'Alterando...' : 'Confirmar'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-4">
          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                  <Skeleton className={`h-16 w-3/4 rounded-2xl ${index % 2 === 0 ? '' : 'rounded-br-sm'}`} />
                </div>
              ))}
            </div>
          ) : mensagens.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Nenhuma mensagem ainda</p>
            </div>
          ) : (
            mensagens.map((msg) => <MessageBubble key={msg.id} mensagem={msg} />)
          )}
          <div ref={messagesEndRef} />
        </div>

        {lead.bloqueado && (
          <div className="border-t p-4">
            <div className="flex gap-2">
              <Input
                placeholder="Digite sua mensagem..."
                value={humanMessage}
                onChange={(e) => setHumanMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              />
              <Button onClick={handleSendMessage} disabled={sending || !humanMessage.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <LeadIntelligencePanel lead={lead} />
    </div>
  );
}
