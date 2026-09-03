'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import {
  DEFAULT_TENANT_ID,
  serverInsert,
} from '@/lib/supabase';
import { Upload, UploadCloud, Loader2 } from 'lucide-react';

interface CsvRow {
  telefone: string;
  nome: string;
  curso: string;
}

export function CsvUpload({ onSuccess }: { onSuccess: () => void }) {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [progress, setProgress] = useState(0);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ sent: number; errors: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  const parseFile = (file: File) => {
    if (!file.name.endsWith('.csv')) {
      toast({ title: 'Formato inválido', description: 'Use arquivo .csv', variant: 'destructive' });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').filter((line) => line.trim());

      if (lines.length < 2) {
        toast({ title: 'CSV vazio', description: 'O arquivo precisa de cabeçalho e dados', variant: 'destructive' });
        return;
      }

      const header = lines[0].toLowerCase().split(',');
      const telIdx = header.findIndex((value) => value.includes('telefone'));
      const nomeIdx = header.findIndex((value) => value.includes('nome'));
      const cursoIdx = header.findIndex((value) => value.includes('curso'));

      if (telIdx === -1 || cursoIdx === -1) {
        toast({
          title: 'Colunas obrigatórias',
          description: 'O CSV precisa ter: telefone,nome,curso',
          variant: 'destructive',
        });
        return;
      }

      const parsed: CsvRow[] = lines.slice(1).map((line) => {
        const cols = line.split(',');
        return {
          telefone: cols[telIdx]?.trim() || '',
          nome: nomeIdx >= 0 ? cols[nomeIdx]?.trim() || '' : '',
          curso: cols[cursoIdx]?.trim() || '',
        };
      }).filter((row) => row.telefone && row.curso);

      setRows(parsed);
      setResult(null);
      toast({ title: `${parsed.length} linha(s) carregadas`, variant: 'success' });
    };

    reader.readAsText(file);
  };

  const handleImport = async () => {
    setImporting(true);
    setProgress(0);
    let sent = 0;
    let errors = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      try {
        const cleanedPhone = row.telefone.replace(/\D/g, '');
        const { error } = await serverInsert('leads', {
          tenant_id: DEFAULT_TENANT_ID,
          telefone: cleanedPhone,
          nome: row.nome || null,
          curso_interesse: row.curso,
          etapa_atual: 'E1',
        });

        if (error) {
          errors += 1;
        } else {
          sent += 1;
        }
      } catch {
        errors += 1;
      }

      setProgress(Math.round(((index + 1) / rows.length) * 100));
    }

    setResult({ sent, errors });
    setImporting(false);
    toast({ title: `${sent} enviados, ${errors} erros`, variant: sent > 0 ? 'success' : 'destructive' });
    onSuccess();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importação em Lote (CSV)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50"
          >
            <UploadCloud className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Arraste um CSV aqui ou clique para selecionar</p>
            <p className="mt-1 text-xs text-muted-foreground">Colunas: telefone, nome, curso</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{rows.length} linha(s) carregadas</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setRows([])}>
                  Limpar
                </Button>
                <Button size="sm" onClick={handleImport} disabled={importing}>
                  {importing ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-4 w-4" />
                  )}
                  Importar e Disparar
                </Button>
              </div>
            </div>

            {importing && <Progress value={progress} />}

            {result && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">Resultado:</p>
                <p className="text-green-500">{result.sent} enviados</p>
                {result.errors > 0 && <p className="text-red-500">{result.errors} erros</p>}
              </div>
            )}

            <div className="max-h-60 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Curso</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 10).map((row, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-mono text-xs">{row.telefone}</TableCell>
                      <TableCell className="text-sm">{row.nome}</TableCell>
                      <TableCell className="text-sm">{row.curso}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length > 10 && (
                <p className="p-2 text-center text-xs text-muted-foreground">...e mais {rows.length - 10} linha(s)</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
