ALTER TABLE course_catalog_sources
  DROP CONSTRAINT IF EXISTS course_catalog_sources_source_kind_check;

ALTER TABLE course_catalog_sources
  ADD CONSTRAINT course_catalog_sources_source_kind_check
  CHECK (source_kind IN ('vector_store_file', 'openai_file', 'manual_import'));
