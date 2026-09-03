-- =============================================================================
-- Migration 2: RLS — Row Level Security
-- Garante que cada tenant enxerga apenas seus próprios dados.
-- Rodar depois da migration 1.
-- =============================================================================

-- Helper: lê o tenant_id do contexto da sessão
-- As Edge Functions chamam set_config('app.tenant_id', ...) antes de qualquer query
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- =============================================================================
-- Habilita RLS nas tabelas
-- =============================================================================
ALTER TABLE leads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensagens            ENABLE ROW LEVEL SECURITY;
ALTER TABLE indicacoes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_instances   ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Policies — padrão: cada tenant só vê e modifica seus dados
-- service_role (usado pelas Edge Functions com SUPABASE_SECRET_KEY) tem
-- BYPASSRLS por padrão no Postgres — não precisa de policy separada
-- =============================================================================
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'leads',
        'mensagens',
        'indicacoes',
        'agent_definitions',
        'whatsapp_instances'
    ]) LOOP
        -- Remove policies antigas se existirem (idempotente)
        EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I_modify ON %I', t, t);

        -- Leitura: só o próprio tenant
        EXECUTE format($p$
            CREATE POLICY %I_select ON %I
            FOR SELECT
            USING (tenant_id = current_tenant_id())
        $p$, t, t);

        -- Escrita: só o próprio tenant
        EXECUTE format($p$
            CREATE POLICY %I_modify ON %I
            FOR ALL
            USING (tenant_id = current_tenant_id())
            WITH CHECK (tenant_id = current_tenant_id())
        $p$, t, t);
    END LOOP;
END $$;

-- tenants: qualquer usuário autenticado pode ler o próprio tenant (necessário para o dashboard)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenants_select' AND tablename = 'tenants') THEN
        CREATE POLICY tenants_select ON tenants
            FOR SELECT USING (true);  -- todos podem ler — não tem dado sensível aqui
    END IF;
END $$;

-- =============================================================================
-- View útil para o dashboard: leads com contagem de mensagens
-- =============================================================================
CREATE OR REPLACE VIEW vw_leads_resumo AS
SELECT
    l.id,
    l.tenant_id,
    l.telefone,
    l.nome,
    l.curso_interesse,
    l.modalidade,
    l.etapa_atual,
    l.matriculado,
    l.bloqueado,
    l.ultimo_contato_em,
    l.created_at,
    COUNT(m.id) AS total_mensagens,
    MAX(m.created_at) AS ultima_mensagem_em
FROM leads l
LEFT JOIN mensagens m ON m.lead_id = l.id
GROUP BY l.id;

-- View: funil de conversão por tenant (para o dashboard de métricas)
CREATE OR REPLACE VIEW vw_funil_conversao AS
SELECT
    tenant_id,
    etapa_atual,
    COUNT(*) AS total_leads,
    COUNT(*) FILTER (WHERE matriculado = true) AS matriculados,
    COUNT(*) FILTER (WHERE bloqueado = true) AS em_handoff
FROM leads
GROUP BY tenant_id, etapa_atual
ORDER BY tenant_id, etapa_atual;
