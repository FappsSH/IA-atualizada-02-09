-- Phase 4: knowledge dashboard cleanup and real-time consultation metrics

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS searchable_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS consult_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_consulted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_consulted_source text;

CREATE INDEX IF NOT EXISTS knowledge_items_consulted_idx
  ON knowledge_items(tenant_id, type, last_consulted_at DESC);

UPDATE knowledge_items
SET
  status = COALESCE(status, 'published'),
  searchable_text = CASE
    WHEN COALESCE(searchable_text, '') <> '' THEN searchable_text
    ELSE TRIM(CONCAT_WS(' ', COALESCE(label, ''), COALESCE(key, ''), COALESCE(value::text, '')))
  END,
  published_at = COALESCE(published_at, created_at, now())
WHERE true;

UPDATE knowledge_items
SET
  active = false,
  status = 'archived',
  updated_at = now()
WHERE type = 'course'
  AND active = true;
