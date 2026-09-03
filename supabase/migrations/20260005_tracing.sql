-- =============================================================================
-- Migration 5: Tracing (trace_span + llm_score)
-- Usado pelo sistema de tracing nativo das edge functions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS trace_span (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  parent_span_id UUID,
  service_name TEXT NOT NULL,
  span_name TEXT NOT NULL,
  span_kind TEXT NOT NULL DEFAULT 'span',
  conversation_id UUID,
  tenant_id UUID,
  user_phone TEXT,
  session_id TEXT,
  model TEXT,
  input JSONB,
  output JSONB,
  metadata JSONB DEFAULT '{}',
  tags JSONB DEFAULT '[]',
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  cost_cents NUMERIC(10,2),
  latency_ms INT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trace_span_trace_id ON trace_span(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_conversation_id ON trace_span(conversation_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_tenant_id ON trace_span(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_started_at ON trace_span(started_at DESC);

CREATE TABLE IF NOT EXISTS llm_score (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  span_id UUID,
  conversation_id UUID,
  score_name TEXT NOT NULL,
  score_type TEXT NOT NULL CHECK (score_type IN ('NUMERIC', 'TEXT', 'BOOLEAN')),
  value_numeric NUMERIC,
  value_text TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_score_trace_id ON llm_score(trace_id);
