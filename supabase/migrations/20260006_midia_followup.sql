-- =============================================================================
-- Migration 6: Mídia (áudio) + Follow-up Programado
-- Adiciona suporte a mensagens de mídia na tabela mensagens
-- e cria a tabela de agendamento de follow-up proativo.
-- =============================================================================

-- =============================================================================
-- 1. Colunas de mídia na tabela mensagens
-- =============================================================================
ALTER TABLE mensagens
    ADD COLUMN IF NOT EXISTS tipo          text CHECK (tipo IN ('texto', 'audio', 'imagem', 'video', 'documento')),
    ADD COLUMN IF NOT EXISTS mime_type     text,
    ADD COLUMN IF NOT EXISTS media_url     text,
    ADD COLUMN IF NOT EXISTS transcricao   text;

-- =============================================================================
-- 2. Adiciona 'inativo' no CHECK de etapa_atual (follow-up pode finalizar lead)
-- =============================================================================
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_etapa_atual_check;
ALTER TABLE leads ADD CONSTRAINT leads_etapa_atual_check
    CHECK (etapa_atual IN ('E1','E2','E3','E4','E5','E6','E7','encerrado','handoff','inativo'));

-- =============================================================================
-- 3. Tabela followup_schedule — agenda follow-ups proativos
-- =============================================================================
CREATE TABLE IF NOT EXISTS followup_schedule (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),

    -- Controle da tentativa atual
    attempt         INT NOT NULL DEFAULT 1,
    max_attempts    INT NOT NULL DEFAULT 6,
    schedule_at     TIMESTAMPTZ NOT NULL,           -- quando disparar esta tentativa

    -- Contexto para geração da mensagem (congelado no agendamento)
    trigger_reason  TEXT,                            -- 'lead_parou', 'lead_indeciso'
    last_context    JSONB,                           -- snapshot do lead na hora do agendamento

    -- Histórico de mensagens já enviadas como follow-up (anti-repetição)
    sent_messages   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array de { text, sent_at, attempt }

    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','cancelled','expired')),

    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    UNIQUE (lead_id, attempt)
);

CREATE INDEX IF NOT EXISTS followup_schedule_pending_idx ON followup_schedule(status, schedule_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS followup_schedule_lead_idx    ON followup_schedule(lead_id);

-- =============================================================================
-- 4. Função: calcula próximo schedule_at baseado no número da tentativa
--    Intervalos: 30min → 1h → 3h → 24h → 48h → 72h
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_followup_next_schedule(
    p_attempt INT
) RETURNS INTERVAL
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE p_attempt
        WHEN 1 THEN INTERVAL '30 minutes'
        WHEN 2 THEN INTERVAL '1 hour'
        WHEN 3 THEN INTERVAL '3 hours'
        WHEN 4 THEN INTERVAL '24 hours'
        WHEN 5 THEN INTERVAL '48 hours'
        WHEN 6 THEN INTERVAL '72 hours'
        ELSE INTERVAL '7 days'
    END;
$$;

-- =============================================================================
-- 5. Cron: followup-worker roda a cada 15 minutos
-- =============================================================================
SELECT cron.unschedule('vendas_followup_tick')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'vendas_followup_tick'
);

SELECT cron.schedule(
    'vendas_followup_tick',
    '0,15,30,45 * * * *',
    $$ SELECT fn_call_edge_function('followup-worker', '{}'::jsonb); $$
);
