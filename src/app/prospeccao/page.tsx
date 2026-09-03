'use client';

import { useState, useEffect, useCallback } from 'react';
import { serverQuery } from '@/lib/supabase';
import { Lead } from '@/lib/types';
import { useRealtime } from '@/hooks/useRealtime';
import { SingleForm } from '@/components/prospeccao/SingleForm';
import { CsvUpload } from '@/components/prospeccao/CsvUpload';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { getStageBadgeColor, getStageLabel, formatDate } from '@/lib/utils';
import { History } from 'lucide-react';

export default function ProspeccaoPage() {
  const [history, setHistory] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    const { data } = await serverQuery<Lead>('leads', {
      columns: '*',
      order: { column: 'created_at', ascending: false },
      limit: 50,
    });

    if (data) {
      setHistory(data as Lead[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useRealtime<Lead>('leads', fetchHistory);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Prospecção Ativa</h2>
        <p className="text-sm text-muted-foreground">Dispare contatos ativos e importe leads em lote</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SingleForm onSuccess={fetchHistory} />
        <CsvUpload onSuccess={fetchHistory} />
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center gap-2 border-b p-4">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">Histórico de Prospecção Ativa</h3>
          <span className="ml-auto text-xs text-muted-foreground">Últimos 50 leads</span>
        </div>
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Curso</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Etapa</TableHead>
                  <TableHead>Matriculado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">{lead.nome || '-'}</TableCell>
                    <TableCell className="font-mono text-xs">{lead.telefone}</TableCell>
                    <TableCell>{lead.curso_interesse}</TableCell>
                    <TableCell className="text-xs">{formatDate(lead.created_at)}</TableCell>
                    <TableCell>
                      <Badge className={`${getStageBadgeColor(lead.etapa_atual)} text-white`}>
                        {getStageLabel(lead.etapa_atual)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {lead.matriculado ? (
                        <Badge variant="success">Sim</Badge>
                      ) : (
                        <Badge variant="outline">Não</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
