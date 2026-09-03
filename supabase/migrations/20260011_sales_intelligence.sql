-- Phase 2: sales intelligence memory and lead event tracking

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS sales_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proposta_enviada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pronto_matricula_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultima_classificacao_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultimo_resumo_ia TEXT;

CREATE TABLE IF NOT EXISTS lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, event_key)
);

CREATE INDEX IF NOT EXISTS lead_events_tenant_idx ON lead_events(tenant_id);
CREATE INDEX IF NOT EXISTS lead_events_lead_idx ON lead_events(lead_id);
CREATE INDEX IF NOT EXISTS lead_events_type_idx ON lead_events(event_type);
