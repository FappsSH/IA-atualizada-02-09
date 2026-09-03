CREATE TABLE IF NOT EXISTS course_catalog_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('vector_store_file', 'manual_import')),
  vector_file_id TEXT,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_key)
);

CREATE TABLE IF NOT EXISTS course_catalog_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID REFERENCES course_catalog_sources(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  catalog_group TEXT NOT NULL,
  area_slug TEXT,
  area_name TEXT,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized_canonical_name TEXT NOT NULL,
  normalized_display_name TEXT NOT NULL,
  normalized_search_text TEXT NOT NULL,
  degree_level TEXT NOT NULL CHECK (degree_level IN ('bacharelado', 'licenciatura', 'tecnologo', 'outro')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('ead', 'semipresencial', 'presencial', 'hibrido', 'indefinido')),
  duration_semesters SMALLINT,
  duration_years NUMERIC(4,2),
  duration_text TEXT NOT NULL,
  variant_kind TEXT NOT NULL DEFAULT 'standard' CHECK (variant_kind IN ('standard', 'egresso', 'area_basica', 'custom')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, normalized_display_name, delivery_mode)
);

CREATE TABLE IF NOT EXISTS course_catalog_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entry_id UUID NOT NULL REFERENCES course_catalog_entries(id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL,
  normalized_alias_text TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'search' CHECK (alias_kind IN ('display', 'canonical', 'search', 'short')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entry_id, normalized_alias_text)
);

CREATE INDEX IF NOT EXISTS course_catalog_sources_tenant_active_idx
  ON course_catalog_sources(tenant_id, active, source_key);

CREATE INDEX IF NOT EXISTS course_catalog_entries_tenant_active_idx
  ON course_catalog_entries(tenant_id, active, area_slug, degree_level, delivery_mode);

CREATE INDEX IF NOT EXISTS course_catalog_entries_display_idx
  ON course_catalog_entries(tenant_id, normalized_display_name);

CREATE INDEX IF NOT EXISTS course_catalog_entries_canonical_idx
  ON course_catalog_entries(tenant_id, normalized_canonical_name);

CREATE INDEX IF NOT EXISTS course_catalog_entries_search_idx
  ON course_catalog_entries(tenant_id, normalized_search_text);

CREATE INDEX IF NOT EXISTS course_catalog_aliases_search_idx
  ON course_catalog_aliases(tenant_id, normalized_alias_text);
