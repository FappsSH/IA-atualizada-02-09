-- =============================================================================
-- Migration 15: Checkpoints administrativos correlacionados por mensagem
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_admin_checkpoints (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id),
    lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    etapa_pausada     text NOT NULL,
    fluxo_pausado     boolean NOT NULL DEFAULT true,
    motivo_pausa      text,
    checkpoint_admin  text NOT NULL
                      CHECK (checkpoint_admin IN ('proposal_send', 'enrollment_processing')),
    status_checkpoint text NOT NULL DEFAULT 'pending'
                      CHECK (status_checkpoint IN ('pending', 'completed', 'cancelled', 'error')),
    admin_message_id  text,
    admin_phone_or_id text,
    paused_at         timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    resume_from       text,
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_admin_checkpoints_lead_idx
    ON lead_admin_checkpoints(lead_id, paused_at DESC);

CREATE INDEX IF NOT EXISTS lead_admin_checkpoints_pending_idx
    ON lead_admin_checkpoints(status_checkpoint, checkpoint_admin, paused_at DESC)
    WHERE status_checkpoint = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS lead_admin_checkpoints_pending_unique
    ON lead_admin_checkpoints(lead_id, checkpoint_admin)
    WHERE status_checkpoint = 'pending';

CREATE TABLE IF NOT EXISTS admin_runtime_logs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    admin_phone     text,
    event_type      text NOT NULL,
    reply_to_message_id text,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_runtime_logs_tenant_created_idx
    ON admin_runtime_logs(tenant_id, created_at DESC);
