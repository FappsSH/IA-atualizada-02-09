'use client';

import { useEffect, useMemo, useState } from 'react';
import { serverInsert, serverQuery, serverUpdate, DEFAULT_TENANT_ID } from '@/lib/supabase';
import { KnowledgeItem } from '@/lib/types';
import { useRealtime } from '@/hooks/useRealtime';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  BarChart3,
  BookOpen,
  Clock3,
  Globe,
  HelpCircle,
  Link2,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

function formatDateTime(value?: string | null) {
  if (!value) return 'Nunca consultado';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getContentPreview(item: KnowledgeItem) {
  return item.value.descricao || item.value.resposta || item.value.texto || '';
}

function getConsultCount(items: KnowledgeItem[]) {
  return items.reduce((total, item) => total + Number(item.consult_count || 0), 0);
}

export default function ConhecimentoPage() {
  const [links, setLinks] = useState<KnowledgeItem[]>([]);
  const [institutionalItems, setInstitutionalItems] = useState<KnowledgeItem[]>([]);
  const [faqItems, setFaqItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkDialog, setLinkDialog] = useState(false);
  const [institutionalDialog, setInstitutionalDialog] = useState(false);
  const [faqDialog, setFaqDialog] = useState(false);
  const [editingLink, setEditingLink] = useState<KnowledgeItem | null>(null);
  const [editingInstitutional, setEditingInstitutional] = useState<KnowledgeItem | null>(null);
  const [editingFaq, setEditingFaq] = useState<KnowledgeItem | null>(null);
  const { toast } = useToast();

  const [linkNome, setLinkNome] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const [institutionalNome, setInstitutionalNome] = useState('');
  const [institutionalConteudo, setInstitutionalConteudo] = useState('');
  const [institutionalTags, setInstitutionalTags] = useState('');

  const [faqNome, setFaqNome] = useState('');
  const [faqConteudo, setFaqConteudo] = useState('');
  const [faqTags, setFaqTags] = useState('');

  const buildSearchableText = (parts: Array<string | undefined>) =>
    parts.filter(Boolean).join(' ').trim();

  const fetchAll = async () => {
    const { data, error } = await serverQuery<KnowledgeItem>('knowledge_items', {
      columns:
        'id, tenant_id, type, key, label, value, active, status, searchable_text, tags, published_at, consult_count, last_consulted_at, last_consulted_source, created_at, updated_at',
      match: { tenant_id: DEFAULT_TENANT_ID, active: true, status: 'published', type: { neq: 'course' } },
      order: { column: 'label', ascending: true },
    });

    if (error) {
      toast({ title: 'Erro ao carregar base de conhecimento', description: error, variant: 'destructive' });
      setLoading(false);
      return;
    }

    const items = data || [];
    setLinks(items.filter((item) => item.type === 'link'));
    setInstitutionalItems(items.filter((item) => ['general', 'offer', 'policy'].includes(item.type)));
    setFaqItems(items.filter((item) => ['faq', 'pricing_rule', 'script', 'objection_playbook'].includes(item.type)));
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  useRealtime<KnowledgeItem>('knowledge_items', () => {
    fetchAll();
  });

  const stats = useMemo(() => {
    const allItems = [...links, ...institutionalItems, ...faqItems];
    const lastConsulted = allItems
      .map((item) => item.last_consulted_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    return {
      links: links.length,
      institutional: institutionalItems.length,
      faq: faqItems.length,
      totalItems: allItems.length,
      totalConsults: getConsultCount(allItems),
      linksConsults: getConsultCount(links),
      institutionalConsults: getConsultCount(institutionalItems),
      faqConsults: getConsultCount(faqItems),
      lastConsulted,
    };
  }, [links, institutionalItems, faqItems]);

  const resetLinkForm = () => {
    setLinkNome('');
    setLinkUrl('');
    setEditingLink(null);
  };

  const resetInstitutionalForm = () => {
    setInstitutionalNome('');
    setInstitutionalConteudo('');
    setInstitutionalTags('');
    setEditingInstitutional(null);
  };

  const resetFaqForm = () => {
    setFaqNome('');
    setFaqConteudo('');
    setFaqTags('');
    setEditingFaq(null);
  };

  const openLinkDialog = (item?: KnowledgeItem) => {
    if (item) {
      setEditingLink(item);
      setLinkNome(item.label);
      setLinkUrl(item.value.url || '');
    } else {
      resetLinkForm();
    }
    setLinkDialog(true);
  };

  const openInstitutionalDialog = (item?: KnowledgeItem) => {
    if (item) {
      setEditingInstitutional(item);
      setInstitutionalNome(item.label);
      setInstitutionalConteudo(getContentPreview(item));
      setInstitutionalTags((item.tags || []).join(', '));
    } else {
      resetInstitutionalForm();
    }
    setInstitutionalDialog(true);
  };

  const openFaqDialog = (item?: KnowledgeItem) => {
    if (item) {
      setEditingFaq(item);
      setFaqNome(item.label);
      setFaqConteudo(getContentPreview(item));
      setFaqTags((item.tags || []).join(', '));
    } else {
      resetFaqForm();
    }
    setFaqDialog(true);
  };

  const saveLink = async () => {
    if (!linkNome.trim() || !linkUrl.trim()) {
      toast({ title: 'Nome e URL são obrigatórios', variant: 'destructive' });
      return;
    }

    const key = slugify(linkNome);
    const value = { url: linkUrl };
    const searchable_text = buildSearchableText([linkNome, linkUrl]);

    if (editingLink) {
      const { error } = await serverUpdate(
        'knowledge_items',
        {
          label: linkNome,
          key,
          value,
          searchable_text,
          status: 'published',
          published_at: editingLink.published_at || new Date().toISOString(),
        },
        { id: editingLink.id },
      );

      if (error) {
        toast({ title: 'Erro ao atualizar link', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'Link institucional atualizado', variant: 'success' });
    } else {
      const { error } = await serverInsert('knowledge_items', {
        tenant_id: DEFAULT_TENANT_ID,
        type: 'link',
        key,
        label: linkNome,
        value,
        searchable_text,
        status: 'published',
        published_at: new Date().toISOString(),
      });

      if (error) {
        toast({ title: 'Erro ao criar link', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'Link institucional criado', variant: 'success' });
    }

    setLinkDialog(false);
    resetLinkForm();
    fetchAll();
  };

  const saveInstitutional = async () => {
    if (!institutionalNome.trim() || !institutionalConteudo.trim()) {
      toast({ title: 'Título e conteúdo são obrigatórios', variant: 'destructive' });
      return;
    }

    const key = slugify(institutionalNome);
    const tags = institutionalTags.split(',').map((tag) => tag.trim()).filter(Boolean);
    const value = { descricao: institutionalConteudo };
    const searchable_text = buildSearchableText([institutionalNome, institutionalConteudo, ...tags]);

    if (editingInstitutional) {
      const { error } = await serverUpdate(
        'knowledge_items',
        {
          type: 'general',
          label: institutionalNome,
          key,
          value,
          tags,
          searchable_text,
          status: 'published',
          published_at: editingInstitutional.published_at || new Date().toISOString(),
        },
        { id: editingInstitutional.id },
      );

      if (error) {
        toast({ title: 'Erro ao atualizar informação institucional', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'Informação institucional atualizada', variant: 'success' });
    } else {
      const { error } = await serverInsert('knowledge_items', {
        tenant_id: DEFAULT_TENANT_ID,
        type: 'general',
        key,
        label: institutionalNome,
        value,
        tags,
        searchable_text,
        status: 'published',
        published_at: new Date().toISOString(),
      });

      if (error) {
        toast({ title: 'Erro ao criar informação institucional', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'Informação institucional criada', variant: 'success' });
    }

    setInstitutionalDialog(false);
    resetInstitutionalForm();
    fetchAll();
  };

  const saveFaq = async () => {
    if (!faqNome.trim() || !faqConteudo.trim()) {
      toast({ title: 'Título e conteúdo são obrigatórios', variant: 'destructive' });
      return;
    }

    const key = slugify(faqNome);
    const tags = faqTags.split(',').map((tag) => tag.trim()).filter(Boolean);
    const value = { resposta: faqConteudo };
    const searchable_text = buildSearchableText([faqNome, faqConteudo, ...tags]);

    if (editingFaq) {
      const { error } = await serverUpdate(
        'knowledge_items',
        {
          type: 'faq',
          label: faqNome,
          key,
          value,
          tags,
          searchable_text,
          status: 'published',
          published_at: editingFaq.published_at || new Date().toISOString(),
        },
        { id: editingFaq.id },
      );

      if (error) {
        toast({ title: 'Erro ao atualizar FAQ', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'FAQ atualizada', variant: 'success' });
    } else {
      const { error } = await serverInsert('knowledge_items', {
        tenant_id: DEFAULT_TENANT_ID,
        type: 'faq',
        key,
        label: faqNome,
        value,
        tags,
        searchable_text,
        status: 'published',
        published_at: new Date().toISOString(),
      });

      if (error) {
        toast({ title: 'Erro ao criar FAQ', description: error, variant: 'destructive' });
        return;
      }

      toast({ title: 'FAQ criada', variant: 'success' });
    }

    setFaqDialog(false);
    resetFaqForm();
    fetchAll();
  };

  const archiveItem = async (item: KnowledgeItem, successTitle: string) => {
    const { error } = await serverUpdate(
      'knowledge_items',
      {
        active: false,
        status: 'archived',
        updated_at: new Date().toISOString(),
      },
      { id: item.id },
    );

    if (error) {
      toast({ title: 'Erro ao excluir item', description: error, variant: 'destructive' });
      return;
    }

    toast({ title: successTitle, variant: 'success' });
    fetchAll();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-44" />
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Base de Conhecimento</h2>
        <p className="text-sm text-muted-foreground">
          Tudo que for salvo aqui entra em uso no fluxo assim que é publicado. Cursos não são mais geridos nesta tela:
          agora o catálogo oficial é consultado diretamente pelo banco de dados estruturado.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Como o AgentHub usa esta base hoje
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Informações institucionais</span> entram no prompt como
              diferenciais, vantagens e contexto real da instituição.
            </p>
            <p>
              <span className="font-medium text-foreground">FAQs</span> entram como lógica de resposta e apoio de
              decisão, funcionando como um IF e ELSE interno para dúvidas e situações recorrentes.
            </p>
            <p>
              <span className="font-medium text-foreground">Links institucionais</span> são usados apenas como base
              interna de consulta. O agente não deve enviar nem mencionar esses links ao lead.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Estatísticas em tempo real
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Itens publicados</span>
              <span className="font-medium">{stats.totalItems}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Consultas totais</span>
              <span className="font-medium">{stats.totalConsults}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Institucionais</span>
              <span className="font-medium">{stats.institutionalConsults}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">FAQs</span>
              <span className="font-medium">{stats.faqConsults}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Links</span>
              <span className="font-medium">{stats.linksConsults}</span>
            </div>
            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                Última consulta registrada
              </div>
              <p className="mt-2">{formatDateTime(stats.lastConsulted)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Informações institucionais
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Cadastre diferenciais, vantagens competitivas e informações que ajudam o agente a entender melhor a instituição.
            </p>
          </div>
          <Dialog
            open={institutionalDialog}
            onOpenChange={(open) => {
              setInstitutionalDialog(open);
              if (!open) resetInstitutionalForm();
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => openInstitutionalDialog()}>
                <Plus className="h-4 w-4 mr-1" />
                Nova informação
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingInstitutional ? 'Editar informação institucional' : 'Nova informação institucional'}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Título</label>
                  <Input
                    value={institutionalNome}
                    onChange={(e) => setInstitutionalNome(e.target.value)}
                    placeholder="Ex: Diferenciais da Universidade Cruzeiro do Sul"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Conteúdo</label>
                  <Textarea
                    value={institutionalConteudo}
                    onChange={(e) => setInstitutionalConteudo(e.target.value)}
                    placeholder="Descreva vantagens, diferenciais, estrutura, apoio ao aluno e demais pontos fortes."
                    className="min-h-40"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tags</label>
                  <Input
                    value={institutionalTags}
                    onChange={(e) => setInstitutionalTags(e.target.value)}
                    placeholder="diferenciais, vantagens, estrutura"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setInstitutionalDialog(false); resetInstitutionalForm(); }}>
                  <X className="h-4 w-4 mr-1" />
                  Cancelar
                </Button>
                <Button onClick={saveInstitutional}>
                  <Save className="h-4 w-4 mr-1" />
                  Salvar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {institutionalItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma informação institucional publicada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Informação</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Consultas</TableHead>
                  <TableHead>Última consulta</TableHead>
                  <TableHead className="w-24 text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {institutionalItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <p className="font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground line-clamp-3">{getContentPreview(item)}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(item.tags || []).join(', ') || '—'}
                    </TableCell>
                    <TableCell className="font-medium">{item.consult_count || 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(item.last_consulted_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openInstitutionalDialog(item)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => archiveItem(item, 'Informação institucional excluída')}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
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
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <HelpCircle className="h-4 w-4" />
              FAQs e lógica de resposta
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Use este módulo para registrar ideias de resposta, conduções por cenário e orientações de IF e ELSE para dúvidas frequentes.
            </p>
          </div>
          <Dialog
            open={faqDialog}
            onOpenChange={(open) => {
              setFaqDialog(open);
              if (!open) resetFaqForm();
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => openFaqDialog()}>
                <Plus className="h-4 w-4 mr-1" />
                Nova FAQ
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingFaq ? 'Editar FAQ' : 'Nova FAQ'}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Título</label>
                  <Input
                    value={faqNome}
                    onChange={(e) => setFaqNome(e.target.value)}
                    placeholder="Ex: Quando o lead pergunta sobre prazo de matrícula"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Resposta ou lógica</label>
                  <Textarea
                    value={faqConteudo}
                    onChange={(e) => setFaqConteudo(e.target.value)}
                    placeholder="Descreva a resposta base ou a lógica que o agente deve seguir nessa situação."
                    className="min-h-40"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tags</label>
                  <Input
                    value={faqTags}
                    onChange={(e) => setFaqTags(e.target.value)}
                    placeholder="matricula, prazo, objeção"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setFaqDialog(false); resetFaqForm(); }}>
                  <X className="h-4 w-4 mr-1" />
                  Cancelar
                </Button>
                <Button onClick={saveFaq}>
                  <Save className="h-4 w-4 mr-1" />
                  Salvar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {faqItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma FAQ publicada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>FAQ</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Consultas</TableHead>
                  <TableHead>Última consulta</TableHead>
                  <TableHead className="w-24 text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {faqItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <p className="font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground line-clamp-3">{getContentPreview(item)}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(item.tags || []).join(', ') || '—'}
                    </TableCell>
                    <TableCell className="font-medium">{item.consult_count || 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(item.last_consulted_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openFaqDialog(item)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => archiveItem(item, 'FAQ excluída')}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
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
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Links institucionais
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Estes links servem somente para consulta interna do AgentHub. Eles alimentam o entendimento institucional do agente e não devem ser enviados ao lead.
            </p>
          </div>
          <Dialog
            open={linkDialog}
            onOpenChange={(open) => {
              setLinkDialog(open);
              if (!open) resetLinkForm();
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => openLinkDialog()}>
                <Plus className="h-4 w-4 mr-1" />
                Novo link
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingLink ? 'Editar link institucional' : 'Novo link institucional'}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Nome</label>
                  <Input
                    value={linkNome}
                    onChange={(e) => setLinkNome(e.target.value)}
                    placeholder="Ex: Página oficial de vestibular"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">URL</label>
                  <Input
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setLinkDialog(false); resetLinkForm(); }}>
                  <X className="h-4 w-4 mr-1" />
                  Cancelar
                </Button>
                <Button onClick={saveLink}>
                  <Save className="h-4 w-4 mr-1" />
                  Salvar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {links.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum link institucional publicado.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {links.map((link) => (
                <div key={link.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{link.label}</p>
                      <a
                        href={link.value.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline flex items-center gap-1 break-all"
                      >
                        <Link2 className="h-3 w-3 shrink-0" />
                        {link.value.url}
                      </a>
                    </div>
                    <Badge variant="outline">Interno</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>Consultas: <span className="font-medium text-foreground">{link.consult_count || 0}</span></p>
                    <p>Última consulta: {formatDateTime(link.last_consulted_at)}</p>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openLinkDialog(link)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => archiveItem(link, 'Link institucional excluído')}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Informações institucionais
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>O fluxo usa esse módulo para fortalecer argumentação, diferenciais e vantagens reais da instituição.</p>
            <p className="text-foreground font-medium">Itens publicados: {stats.institutional}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <HelpCircle className="h-4 w-4" />
              FAQs
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>O fluxo trata esse módulo como guia de resposta por situação, ajudando o agente a reagir com consistência.</p>
            <p className="text-foreground font-medium">Itens publicados: {stats.faq}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              Aplicação imediata
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>Assim que você salva ou edita um item publicado, ele já passa a ser lido nas próximas execuções do fluxo.</p>
            <p>Não depende de deploy nem de atualização manual de prompt.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
