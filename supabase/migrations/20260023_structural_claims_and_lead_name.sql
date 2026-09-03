ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS raw_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_person_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_first_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_name_source TEXT,
  ADD COLUMN IF NOT EXISTS lead_name_confidence TEXT;

CREATE TABLE IF NOT EXISTS worker_claims (
  lock_name TEXT PRIMARY KEY,
  holder_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS debounce_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  processing_job_id UUID,
  outbound_generation_key TEXT NOT NULL UNIQUE,
  inbound_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  consolidated_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'processed', 'skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS debounce_groups_tenant_lead_idx
  ON debounce_groups(tenant_id, lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbound_generation_claims (
  generation_key TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  debounce_group_id UUID REFERENCES debounce_groups(id) ON DELETE SET NULL,
  processing_job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS read_receipt_claims (
  inbound_message_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  remote_jid TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'success', 'failed')),
  route_used TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION claim_worker_lock(
  p_lock_name TEXT,
  p_holder_id UUID,
  p_ttl_seconds INTEGER DEFAULT 20
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_holder UUID;
BEGIN
  INSERT INTO worker_claims(lock_name, holder_id, expires_at, created_at, updated_at)
  VALUES (p_lock_name, p_holder_id, now() + make_interval(secs => p_ttl_seconds), now(), now())
  ON CONFLICT (lock_name) DO UPDATE
    SET holder_id = EXCLUDED.holder_id,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
  WHERE worker_claims.expires_at <= now()
     OR worker_claims.holder_id = p_holder_id;

  SELECT holder_id INTO v_holder
  FROM worker_claims
  WHERE lock_name = p_lock_name;

  RETURN v_holder = p_holder_id;
END;
$$;

CREATE OR REPLACE FUNCTION release_worker_lock(
  p_lock_name TEXT,
  p_holder_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM worker_claims
  WHERE lock_name = p_lock_name
    AND holder_id = p_holder_id;
END;
$$;

CREATE OR REPLACE FUNCTION claim_outbound_generation(
  p_generation_key TEXT,
  p_tenant_id UUID,
  p_lead_id UUID,
  p_debounce_group_id UUID DEFAULT NULL,
  p_processing_job_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO outbound_generation_claims(
    generation_key,
    tenant_id,
    lead_id,
    debounce_group_id,
    processing_job_id
  )
  VALUES (
    p_generation_key,
    p_tenant_id,
    p_lead_id,
    p_debounce_group_id,
    p_processing_job_id
  )
  ON CONFLICT (generation_key) DO NOTHING;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION claim_read_receipt(
  p_tenant_id UUID,
  p_lead_id UUID,
  p_inbound_message_id TEXT,
  p_remote_jid TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO read_receipt_claims(
    inbound_message_id,
    tenant_id,
    lead_id,
    remote_jid,
    status
  )
  VALUES (
    p_inbound_message_id,
    p_tenant_id,
    p_lead_id,
    p_remote_jid,
    'processing'
  )
  ON CONFLICT (inbound_message_id) DO NOTHING;

  RETURN FOUND;
END;
$$;
