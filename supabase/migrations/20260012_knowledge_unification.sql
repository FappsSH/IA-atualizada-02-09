-- Phase 3: knowledge base unification

ALTER TABLE knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_type_check;

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS searchable_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_type_check
  CHECK (type IN ('course', 'link', 'general', 'faq', 'pricing_rule', 'offer', 'policy', 'script', 'objection_playbook'));

ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_status_check
  CHECK (status IN ('draft', 'published', 'archived'));

UPDATE knowledge_items
SET
  status = COALESCE(status, 'published'),
  published_at = COALESCE(published_at, created_at, now()),
  searchable_text = TRIM(
    CONCAT_WS(
      ' ',
      COALESCE(label, ''),
      COALESCE(key, ''),
      COALESCE(value::text, '')
    )
  )
WHERE searchable_text = '';

CREATE INDEX IF NOT EXISTS knowledge_items_status_idx ON knowledge_items(tenant_id, status, type);
CREATE INDEX IF NOT EXISTS knowledge_items_searchable_idx ON knowledge_items(tenant_id, type, active, status);
