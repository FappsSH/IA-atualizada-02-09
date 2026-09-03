import { createClient } from '@supabase/supabase-js';
import {
  COURSE_CATALOG_ENTRIES,
  COURSE_CATALOG_SOURCES,
  COURSE_CATALOG_TENANT_ID,
  type CourseCatalogEntrySeed,
} from './course-catalog-dataset.ts';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

function normalizeText(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchText(entry: CourseCatalogEntrySeed) {
  return normalizeText([
    entry.display_name,
    entry.canonical_name,
    entry.area_name || '',
    entry.area_slug || '',
    entry.catalog_group,
    entry.degree_level,
    entry.delivery_mode,
    entry.duration_text,
    ...(entry.aliases || []),
  ].join(' '));
}

function buildAliases(entry: CourseCatalogEntrySeed) {
  const aliases = new Map<string, { alias_text: string; alias_kind: string; is_primary: boolean }>();

  const pushAlias = (aliasText: string, aliasKind: string, isPrimary = false) => {
    const alias = String(aliasText || '').trim();
    const normalized = normalizeText(alias);
    if (!alias || !normalized || aliases.has(normalized)) return;
    aliases.set(normalized, {
      alias_text: alias,
      alias_kind: aliasKind,
      is_primary: isPrimary,
    });
  };

  pushAlias(entry.display_name, 'display', true);
  pushAlias(entry.canonical_name, 'canonical');

  if (entry.display_name.startsWith('CST EM ')) {
    pushAlias(entry.display_name.replace(/^CST EM\s+/i, ''), 'short');
  }

  for (const alias of entry.aliases || []) {
    pushAlias(alias, 'search');
  }

  return Array.from(aliases.entries()).map(([normalized_alias_text, payload]) => ({
    ...payload,
    normalized_alias_text,
  }));
}

async function ensureTablesExist() {
  const { error } = await supabase
    .from('course_catalog_sources')
    .select('id')
    .limit(1);

  if (error?.message?.includes('does not exist') || error?.message?.includes('Could not find the table')) {
    throw new Error(
      'As tabelas do catalogo estruturado ainda nao existem. Aplique a migration 20260018_structured_course_catalog.sql antes de rodar este sync.',
    );
  }

  if (error) throw error;
}

async function syncSources() {
  const payload = COURSE_CATALOG_SOURCES.map((source) => ({
    tenant_id: COURSE_CATALOG_TENANT_ID,
    source_key: source.source_key,
    source_name: source.source_name,
    source_kind: source.source_kind,
    vector_file_id: source.vector_file_id,
    description: source.description,
    active: true,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('course_catalog_sources')
    .upsert(payload, { onConflict: 'tenant_id,source_key' });

  if (error) throw error;

  const { data, error: readError } = await supabase
    .from('course_catalog_sources')
    .select('id, source_key')
    .eq('tenant_id', COURSE_CATALOG_TENANT_ID)
    .in('source_key', COURSE_CATALOG_SOURCES.map((item) => item.source_key));

  if (readError) throw readError;
  return new Map((data || []).map((item: any) => [item.source_key, item.id]));
}

async function replaceEntries(sourceIds: Map<string, string>) {
  const sourceKeys = COURSE_CATALOG_SOURCES.map((item) => item.source_key);

  const { data: existingEntries, error: existingError } = await supabase
    .from('course_catalog_entries')
    .select('id')
    .eq('tenant_id', COURSE_CATALOG_TENANT_ID)
    .in('source_key', sourceKeys);

  if (existingError && !existingError.message?.includes('does not exist')) {
    throw existingError;
  }

  const existingEntryIds = (existingEntries || []).map((item: any) => item.id).filter(Boolean);
  if (existingEntryIds.length) {
    const { error: deleteAliasesError } = await supabase
      .from('course_catalog_aliases')
      .delete()
      .eq('tenant_id', COURSE_CATALOG_TENANT_ID)
      .in('entry_id', existingEntryIds);

    if (deleteAliasesError) throw deleteAliasesError;
  }

  const { error: deleteEntriesError } = await supabase
    .from('course_catalog_entries')
    .delete()
    .eq('tenant_id', COURSE_CATALOG_TENANT_ID)
    .in('source_key', sourceKeys);

  if (deleteEntriesError) throw deleteEntriesError;

  const entryPayload = COURSE_CATALOG_ENTRIES.map((entry) => ({
    tenant_id: COURSE_CATALOG_TENANT_ID,
    source_id: sourceIds.get(entry.source_key) || null,
    source_key: entry.source_key,
    catalog_group: entry.catalog_group,
    area_slug: entry.area_slug,
    area_name: entry.area_name,
    canonical_name: entry.canonical_name,
    display_name: entry.display_name,
    normalized_canonical_name: normalizeText(entry.canonical_name),
    normalized_display_name: normalizeText(entry.display_name),
    normalized_search_text: buildSearchText(entry),
    degree_level: entry.degree_level,
    delivery_mode: entry.delivery_mode,
    duration_semesters: entry.duration_semesters,
    duration_years: entry.duration_years,
    duration_text: entry.duration_text,
    variant_kind: entry.variant_kind || 'standard',
    active: true,
    updated_at: new Date().toISOString(),
  }));

  const { data: insertedEntries, error: insertEntriesError } = await supabase
    .from('course_catalog_entries')
    .insert(entryPayload)
    .select('id, display_name, delivery_mode');

  if (insertEntriesError) throw insertEntriesError;

  const entryByKey = new Map(
    (insertedEntries || []).map((entry: any) => [`${entry.display_name}::${entry.delivery_mode}`, entry.id]),
  );

  const aliasPayload = COURSE_CATALOG_ENTRIES.flatMap((entry) => {
    const entryId = entryByKey.get(`${entry.display_name}::${entry.delivery_mode}`);
    if (!entryId) return [];

    return buildAliases(entry).map((alias) => ({
      tenant_id: COURSE_CATALOG_TENANT_ID,
      entry_id: entryId,
      alias_text: alias.alias_text,
      normalized_alias_text: alias.normalized_alias_text,
      alias_kind: alias.alias_kind,
      is_primary: alias.is_primary,
    }));
  });

  if (aliasPayload.length) {
    const { error: insertAliasesError } = await supabase
      .from('course_catalog_aliases')
      .insert(aliasPayload);

    if (insertAliasesError) throw insertAliasesError;
  }

  return {
    entries: insertedEntries?.length || 0,
    aliases: aliasPayload.length,
  };
}

async function main() {
  await ensureTablesExist();
  const sourceIds = await syncSources();
  const counts = await replaceEntries(sourceIds);

  console.log(`OK: ${sourceIds.size} fontes sincronizadas.`);
  console.log(`OK: ${counts.entries} cursos sincronizados.`);
  console.log(`OK: ${counts.aliases} aliases sincronizados.`);
}

main().catch((error) => {
  console.error('Falha ao sincronizar catalogo estruturado:', error.message || error);
  process.exit(1);
});
