// Unified knowledge base access for SDR agents.
// Courses now live primarily in the structured catalog stored in Supabase.
// deno-lint-ignore-file
// @ts-nocheck

export type KnowledgeType =
  | 'course'
  | 'link'
  | 'general'
  | 'faq'
  | 'pricing_rule'
  | 'offer'
  | 'policy'
  | 'script'
  | 'objection_playbook'
  | 'claim';

function normalize(value: string) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function tokenize(value: string) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function buildSearchableText(item: any) {
  const rawValue = typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value ?? '');
  return normalize([
    item.label,
    item.key,
    item.searchable_text,
    rawValue,
    ...(item.tags || []),
  ].filter(Boolean).join(' '));
}

function scoreKnowledgeItem(item: any, query: string) {
  if (!query) return 1;

  const normalizedQuery = normalize(query);
  const tokens = tokenize(query);
  const label = normalize(item.label || '');
  const key = normalize(item.key || '');
  const searchText = buildSearchableText(item);

  let score = 0;

  if (label === normalizedQuery) score += 120;
  if (key === normalizedQuery) score += 100;
  if (label.includes(normalizedQuery)) score += 60;
  if (key.includes(normalizedQuery)) score += 45;
  if (searchText.includes(normalizedQuery)) score += 30;

  for (const token of tokens) {
    if (label.includes(token)) score += 18;
    if (key.includes(token)) score += 12;
    if (searchText.includes(token)) score += 6;
  }

  return score;
}

async function markKnowledgeConsulted(params: {
  supabase: any;
  items: any[];
  source: string;
}) {
  const consultedAt = new Date().toISOString();

  await Promise.all(
    (params.items || []).map(async (item: any) => {
      try {
        await params.supabase
          .from('knowledge_items')
          .update({
            consult_count: Number(item.consult_count || 0) + 1,
            last_consulted_at: consultedAt,
            last_consulted_source: params.source,
            updated_at: consultedAt,
          })
          .eq('id', item.id);
      } catch {
        return null;
      }
    }),
  );
}

export async function fetchKnowledgeItems(params: {
  supabase: any;
  tenantId: string;
  types?: KnowledgeType[];
  query?: string;
  limit?: number;
  trackUsage?: boolean;
  source?: string;
}) {
  const types = params.types?.length
    ? params.types
    : ['link', 'general', 'faq', 'pricing_rule', 'offer', 'policy', 'script', 'objection_playbook'];

  let query = params.supabase
    .from('knowledge_items')
    .select('id, type, key, label, value, active, status, searchable_text, tags, published_at, consult_count, last_consulted_at, last_consulted_source, created_at, updated_at')
    .eq('tenant_id', params.tenantId)
    .eq('active', true)
    .eq('status', 'published');

  if (types.length === 1) {
    query = query.eq('type', types[0]);
  } else {
    query = query.in('type', types);
  }

  const normalizedQuery = normalize(params.query || '');
  if (normalizedQuery) {
    const terms = Array.from(new Set([normalizedQuery, ...tokenize(normalizedQuery)])).slice(0, 6);
    const filters = terms
      .map((term) => term.replace(/[%_,]/g, ' ').trim())
      .filter(Boolean)
      .flatMap((term) => [
        `label.ilike.%${term}%`,
        `key.ilike.%${term}%`,
        `searchable_text.ilike.%${term}%`,
      ]);

    if (filters.length) {
      query = query.or(filters.join(','));
    }
  }

  if (params.limit) {
    query = query.limit(params.limit);
  }

  const { data, error } = await query.order('label', { ascending: true });
  if (error) {
    if (error.message?.includes('does not exist') || error.message?.includes('relation')) {
      return [];
    }
    throw error;
  }

  const items = data || [];
  if (params.trackUsage !== false && items.length > 0) {
    await markKnowledgeConsulted({
      supabase: params.supabase,
      items,
      source: params.source || 'prompt_base',
    });
  }

  return items;
}

export async function queryKnowledgeBase(params: {
  supabase: any;
  tenantId: string;
  type?: KnowledgeType;
  query?: string;
  limit?: number;
}) {
  const items = await fetchKnowledgeItems({
    supabase: params.supabase,
    tenantId: params.tenantId,
    types: params.type ? [params.type] : undefined,
    query: params.query,
    limit: params.query ? Math.max((params.limit ?? 20) * 4, 24) : Math.max(params.limit ?? 20, 20),
    trackUsage: false,
  });

  const ranked = items
    .map((item: any) => ({
      ...item,
      score: scoreKnowledgeItem(item, params.query || ''),
    }))
    .filter((item: any) => !params.query || item.score > 0)
    .sort((a: any, b: any) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, params.limit ?? 20);

  if (ranked.length > 0) {
    await markKnowledgeConsulted({
      supabase: params.supabase,
      items: ranked,
      source: params.type ? `tool_query:${params.type}` : 'tool_query',
    });
  }

  return ranked;
}

function normalizeModality(value: unknown) {
  const normalized = normalize(String(value || ''));
  if (normalized.includes('ead')) return 'ead';
  if (normalized.includes('semipresencial')) return 'semipresencial';
  return '';
}

function splitScope(value: unknown) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function claimMatchesStage(item: any, stage: string) {
  const normalizedStage = String(stage || '').trim().toUpperCase();
  if (!normalizedStage) return true;
  const scopes = [
    ...splitScope(item.scope),
    ...splitScope(item.stage),
    ...splitScope(item.value?.scope),
    ...splitScope(item.value?.stage),
  ].map((item) => item.toUpperCase());
  return scopes.length === 0 || scopes.includes('GLOBAL') || scopes.includes(normalizedStage);
}

function claimMatchesModality(item: any, modality: unknown) {
  const expected = normalizeModality(item.metadata?.modality || item.value?.modality);
  if (!expected) return true;
  return expected === normalizeModality(modality);
}

export async function getAuthorizedKnowledgeFacts(params: {
  supabase: any;
  tenantId: string;
  stage: string;
  modality?: unknown;
  processAction?: string | null;
  categories?: string[];
}) {
  let query = params.supabase
    .from('knowledge_items')
    .select('id, key, claim_key, category, label, value, scope, stage, active, authorized, source_type, status, priority, metadata, updated_at')
    .eq('tenant_id', params.tenantId)
    .eq('type', 'claim')
    .eq('active', true)
    .eq('authorized', true)
    .eq('source_type', 'admin_defined')
    .eq('status', 'published')
    .order('priority', { ascending: true })
    .order('label', { ascending: true });

  if (params.categories?.length) {
    query = query.in('category', params.categories);
  }

  const { data, error } = await query;
  if (error) {
    if (error.message?.includes('does not exist') || error.message?.includes('column') || error.message?.includes('relation')) {
      return [];
    }
    throw error;
  }

  const stage = String(params.stage || '').trim().toUpperCase();
  const allowE2Methodology = stage !== 'E2'
    || String(params.processAction || '').trim() === 'handle_travel_or_move_and_ask_vaccine_decider';

  return (data || [])
    .filter((item: any) => claimMatchesStage(item, stage))
    .filter((item: any) => claimMatchesModality(item, params.modality))
    .filter((item: any) => allowE2Methodology || item.category !== 'course_methodology')
    .map((item: any) => ({
      id: item.id,
      claim_key: item.claim_key || item.key,
      category: item.category,
      title: item.label,
      content: item.value?.content || item.value?.texto || item.value?.descricao || '',
      scope: item.scope || item.value?.scope || 'global',
      stage: item.stage || item.value?.stage || null,
      status: item.status,
      priority: item.priority,
      source_type: item.source_type,
      authorized: item.authorized === true,
    }))
    .filter((item: any) => item.content);
}

export function knowledgeItemsToPrompt(items: any[]) {
  const links = items.filter((item) => item.type === 'link').slice(0, 6);
  const institutional = items
    .filter((item) => item.type === 'general' || item.type === 'offer' || item.type === 'policy')
    .slice(0, 10);
  const faqs = items
    .filter((item) => item.type === 'faq' || item.type === 'script' || item.type === 'objection_playbook' || item.type === 'pricing_rule')
    .slice(0, 12);

  const linkLines = links.map((item) => `- ${item.label}: ${item.value?.url || ''}`);
  const institutionalLines = institutional.map((item) => {
    const content = String(item.value?.descricao || item.value?.resposta || item.value?.texto || '').slice(0, 220);
    return content ? `- ${item.label}: ${content}` : `- ${item.label}`;
  });
  const faqLines = faqs.map((item) => {
    const content = String(item.value?.resposta || item.value?.descricao || item.value?.texto || '').slice(0, 240);
    return content ? `- ${item.label}: ${content}` : `- ${item.label}`;
  });

  const sections = [
    "CATALOGO DE CURSOS:\n- Os cursos oficiais devem ser consultados pela tool consultar_conhecimento(tipo='course', query='...') usando o catalogo estruturado no banco.\n- Nunca invente curso, modalidade, duracao, area ou categoria sem consultar o catalogo oficial.",
  ];

  if (linkLines.length) {
    sections.push(`LINKS INSTITUCIONAIS DE REFERENCIA INTERNA:\n- Estes links existem apenas para consulta interna e aprendizado institucional do agente.\n- Nunca envie, ofereca ou mencione esses links ao lead.\n${linkLines.join('\n')}`);
  }
  if (institutionalLines.length) {
    sections.push(`INFORMACOES INSTITUCIONAIS E DIFERENCIAIS:\n- Use este bloco para entender vantagens, diferenciais, posicionamento e contexto institucional.\n${institutionalLines.join('\n')}`);
  }
  if (faqLines.length) {
    sections.push(`FAQ E LOGICA DE RESPOSTA:\n- Use este bloco como guia de IF/ELSE para responder duvidas, contornar situacoes e manter consistencia comercial.\n- Nao copie mecanicamente; adapte com naturalidade sem fugir da instrucao registrada.\n${faqLines.join('\n')}`);
  }

  return `\n\nBASE DE CONHECIMENTO UNIFICADA\n${sections.join('\n\n')}\n\nREGRAS PARA USAR ESTA BASE:
1. Use somente itens publicados desta base como verdade institucional.
2. Nunca invente curso, oferta, politica ou detalhe que nao esteja aqui.
3. Para consultas sobre cursos, use primeiro o catalogo estruturado via tool.
4. Se a busca do lead nao bater exatamente com o nome do curso, consulte semanticamente por proximidade de termos.
5. Links institucionais servem somente para referencia interna do agente e nao devem aparecer na mensagem ao lead.
6. Informacoes institucionais servem para reforcar diferenciais e vantagens reais da instituicao.
7. FAQs e playbooks servem para orientar a logica da resposta em cada situacao.`;
}
