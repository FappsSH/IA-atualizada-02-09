'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import {
  DEFAULT_TENANT_ID,
  getSupabaseConfigStatus,
  serverInsert,
} from '@/lib/supabase';
import { Send, Loader2 } from 'lucide-react';

export function SingleForm({ onSuccess }: { onSuccess: () => void }) {
  const [telefone, setTelefone] = useState('');
  const [nome, setNome] = useState('');
  const [curso, setCurso] = useState('');
  const [sending, setSending] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!telefone || !curso) {
      toast({ title: 'Preencha telefone e curso', variant: 'destructive' });
      return;
    }

    const cleanedPhone = telefone.replace(/\D/g, '');
    if (cleanedPhone.length < 12) {
      toast({
        title: 'Telefone inválido',
        description: 'Use o formato 5511999999999',
        variant: 'destructive',
      });
      return;
    }

    setSending(true);
    try {
      const { data: lead, error: insertError } = await serverInsert<any>('leads', {
        tenant_id: DEFAULT_TENANT_ID,
        telefone: cleanedPhone,
        nome: nome || null,
        curso_interesse: curso,
        etapa_atual: 'E1',
      });

      if (insertError || !lead) {
        throw new Error(insertError || 'Não foi possível criar o lead');
      }

      const config = getSupabaseConfigStatus();
      if (config.functionsConfigured) {
        await fetch(`${config.functionsUrl}/ai-processor`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.anonKey}`,
          },
          body: JSON.stringify({
            lead_id: lead.id,
            tenant_id: DEFAULT_TENANT_ID,
            telefone: cleanedPhone,
            etapa_atual: 'E1',
            trigger: 'outbound',
            nome_lead: nome || null,
            history: [],
            recent_user_messages: [],
          }),
        });
      }

      toast({ title: 'Lead criado e processamento iniciado', variant: 'success' });
      setTelefone('');
      setNome('');
      setCurso('');
      onSuccess();
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Disparo Individual</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Telefone</label>
            <Input
              placeholder="5511999999999"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value.replace(/\D/g, ''))}
              maxLength={13}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Formato: 5511999999999 (código do país + DDD + número)
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Nome completo</label>
            <Input
              placeholder="Nome do lead (opcional)"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Curso de interesse</label>
            <Input
              placeholder="Ex: Administração, Cruzeiro, Pacote Europa..."
              value={curso}
              onChange={(e) => setCurso(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={sending} className="w-full">
            {sending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            {sending ? 'Processando...' : 'Prospectar Agora'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
