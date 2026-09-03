-- =============================================================================
-- Migration 7: Configurável Follow-up Scheduling
-- Cria tabela de configuração de intervalos + tabela de logs
-- e função de trigger para notificar mudanças na config
-- =============================================================================

-- 1. Tabela de configuração de intervalos (substitui hardcoded do worker)
CREATE TABLE IF NOT EXISTS followup_config (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    attempt         INT NOT NULL CHECK (attempt BETWEEN 1 AND 6),
    interval_minutes INT NOT NULL DEFAULT 30,
    label           TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, attempt)
);

-- Seed default intervals for the main tenant
INSERT INTO followup_config (tenant_id, attempt, interval_minutes, label)
VALUES
    ('00000000-0000-0000-0000-000000000001', 1, 30,  '30 minutos'),
    ('00000000-0000-0000-0000-000000000001', 2, 60,  '1 hora'),
    ('00000000-0000-0000-0000-000000000001', 3, 180, '3 horas'),
    ('00000000-0000-0000-0000-000000000001', 4, 1440, '24 horas'),
    ('00000000-0000-0000-0000-000000000001', 5, 2880, '48 horas'),
    ('00000000-0000-0000-0000-000000000001', 6, 4320, '72 horas')
ON CONFLICT (tenant_id, attempt) DO NOTHING;

-- 2. Tabela de log de execução do followup-worker
CREATE TABLE IF NOT EXISTS followup_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    schedule_id     UUID REFERENCES followup_schedule(id) ON DELETE SET NULL,
    attempt         INT,
    status          TEXT NOT NULL CHECK (status IN ('processed', 'skipped', 'error', 'cancelled')),
    error_message   TEXT,
    lead_etapa      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_log_tenant_created_idx ON followup_log(tenant_id, created_at DESC);

-- 3. Função: obtém intervalo configurado para uma tentativa (com fallback)
CREATE OR REPLACE FUNCTION fn_followup_get_interval(
    p_tenant_id UUID,
    p_attempt INT,
    OUT interval_minutes INT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    SELECT fc.interval_minutes INTO interval_minutes
    FROM followup_config fc
    WHERE fc.tenant_id = p_tenant_id AND fc.attempt = p_attempt AND fc.enabled;

    IF NOT FOUND THEN
        interval_minutes := CASE p_attempt
            WHEN 1 THEN 30
            WHEN 2 THEN 60
            WHEN 3 THEN 180
            WHEN 4 THEN 1440
            WHEN 5 THEN 2880
            WHEN 6 THEN 4320
            ELSE 1440
        END;
    END IF;
END;
$$;
