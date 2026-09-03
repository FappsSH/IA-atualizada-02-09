-- Runtime and dashboard lookup optimizations for the SDR workflow.

CREATE INDEX IF NOT EXISTS leads_tenant_updated_idx
  ON leads(tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS leads_tenant_stage_updated_idx
  ON leads(tenant_id, etapa_atual, updated_at DESC);

CREATE INDEX IF NOT EXISTS leads_active_pipeline_idx
  ON leads(tenant_id, updated_at DESC)
  WHERE etapa_atual <> 'encerrado' AND etapa_atual <> 'inativo';

CREATE INDEX IF NOT EXISTS knowledge_items_published_lookup_idx
  ON knowledge_items(tenant_id, active, status, type, label);

CREATE INDEX IF NOT EXISTS lead_events_tenant_created_idx
  ON lead_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mensagens_lead_created_idx
  ON mensagens(lead_id, created_at DESC);
