-- =============================================================================
-- Migration 1: Schema base — Agente de Vendas
-- Substitui completamente as migrations _qta do projeto QtA.
-- Rodar na ordem: 1 → 2 → 3
-- =============================================================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- =============================================================================
-- Tenants (multi-tenancy — uma linha por empresa/cliente)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text UNIQUE NOT NULL,          -- ex: 'cruzeiro-vendas'
    name        text NOT NULL,
    config      jsonb NOT NULL DEFAULT '{}',   -- configurações livres por tenant
    ativo       boolean DEFAULT true,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now()
);

-- Insere seu tenant de vendas
INSERT INTO tenants (id, slug, name, config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'cruzeiro-vendas',
    'Cruzeiro do Sul — Vendas',
    jsonb_build_object(
        'canal', 'whatsapp',
        'modelo_ia', 'gpt-4.1',
        'max_iteracoes_subagente', 10,
        'business_hours', jsonb_build_object(
            'start', '08:00',
            'end', '22:00',
            'tz', 'America/Sao_Paulo'
        )
    )
)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- Leads
-- =============================================================================
CREATE TABLE IF NOT EXISTS leads (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id),
    telefone             text NOT NULL,                  -- número no formato 5511999999999
    nome                 text,

    -- Dados coletados pelo agente ao longo da conversa
    curso_interesse      text,                           -- curso que o lead mencionou
    modalidade           text CHECK (modalidade IN ('ead', 'semipresencial', NULL)),
    dor_principal        text CHECK (dor_principal IN ('tempo', 'dinheiro', 'ambos', NULL)),
    decisor_confirmado   boolean DEFAULT false,          -- true = lead decide sozinho
    viagem_programada    boolean,                        -- coleta na E2 (vacinas)
    valor_parcela        numeric(10,2),                  -- valor personalizado com bolsa

    -- Estado da conversa — campo mais importante
    etapa_atual          text NOT NULL DEFAULT 'E1'
                         CHECK (etapa_atual IN ('E1','E2','E3','E4','E5','E6','E7','encerrado','handoff')),

    -- Resultado final
    matriculado          boolean DEFAULT false,
    matricula_em         timestamptz,
    valor_matricula      numeric(10,2),

    -- Controle
    bloqueado            boolean DEFAULT false,          -- true = humano assumiu
    handoff_em           timestamptz,
    ultimo_contato_em    timestamptz,
    created_at           timestamptz DEFAULT now(),
    updated_at           timestamptz DEFAULT now(),

    UNIQUE (tenant_id, telefone)
);

CREATE INDEX IF NOT EXISTS leads_tenant_idx   ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS leads_etapa_idx    ON leads(etapa_atual);
CREATE INDEX IF NOT EXISTS leads_telefone_idx ON leads(telefone);

-- =============================================================================
-- Mensagens — histórico completo da conversa
-- =============================================================================
CREATE TABLE IF NOT EXISTS mensagens (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id              uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tenant_id            uuid NOT NULL,

    role                 text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    conteudo             text NOT NULL,

    -- Rastreabilidade
    etapa_no_momento     text,                           -- qual etapa estava quando essa msg foi enviada
    subagente_usado      text,                           -- qual subagente gerou a resposta
    whatsapp_message_id  text,                           -- id da mensagem no WhatsApp (dedup)

    -- Métricas do agente
    tokens_usados        integer,
    iteracoes            integer,
    tool_calls           jsonb,                          -- array de tools chamadas nessa interação

    created_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mensagens_lead_idx    ON mensagens(lead_id);
CREATE INDEX IF NOT EXISTS mensagens_tenant_idx  ON mensagens(tenant_id);
CREATE INDEX IF NOT EXISTS mensagens_wa_id_idx   ON mensagens(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

-- =============================================================================
-- Indicações — registra cada contato indicado pelo aluno pós-matrícula
-- =============================================================================
CREATE TABLE IF NOT EXISTS indicacoes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    lead_origem_id   uuid NOT NULL REFERENCES leads(id),  -- quem indicou
    telefone_indicado text NOT NULL,
    nome_indicado    text,
    status           text DEFAULT 'pendente' CHECK (status IN ('pendente','contactado','matriculado')),
    created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS indicacoes_tenant_idx ON indicacoes(tenant_id);
CREATE INDEX IF NOT EXISTS indicacoes_origem_idx ON indicacoes(lead_origem_id);

-- =============================================================================
-- Agent definitions — quais subagentes estão ativos por tenant
-- (mesmo padrão do AgentHub — permite ligar/desligar subagentes sem deploy)
-- =============================================================================
CREATE TABLE IF NOT EXISTS agent_definitions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id),
    subagent_key  text NOT NULL,                         -- 'E1', 'E2', ... 'E7'
    enabled       boolean NOT NULL DEFAULT true,
    config        jsonb NOT NULL DEFAULT '{}',           -- prompt_override, tools_override etc
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now(),
    UNIQUE (tenant_id, subagent_key)
);

-- Insere os 7 subagentes do processo comercial
INSERT INTO agent_definitions (tenant_id, subagent_key, enabled, config)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'E1', true,
     '{"nome":"Conexão e Qualificação","objetivo":"quebrar gelo, assumir autoridade, fechar acordo dos 5 min, identificar dor"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E2', true,
     '{"nome":"Vacinas e D.I.","objetivo":"bloquear objeções antecipadas, confirmar decisor, mapear viagens"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E3', true,
     '{"nome":"Apresentação do Produto","objetivo":"responder as 3 perguntas, enviar áudio, fazer lead vender pra si mesmo"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E4', true,
     '{"nome":"Fechamento Financeiro","objetivo":"ancoragem de preço, apresentar parcela com bolsa, confirmar que cabe no orçamento"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E5', true,
     '{"nome":"Validação e Matrícula","objetivo":"cobrar taxa de matrícula R$100, gerar número de aluno, confirmar vaga"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E6', true,
     '{"nome":"Pegar Indicações","objetivo":"aproveitar pico de euforia, pegar 20 contatos indicados"}'::jsonb),
    ('00000000-0000-0000-0000-000000000001', 'E7', true,
     '{"nome":"Preparar Indicados","objetivo":"fazer novo aluno mandar mensagem de aviso para os indicados"}'::jsonb)
ON CONFLICT (tenant_id, subagent_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now();

-- =============================================================================
-- Instâncias WhatsApp — uma por tenant (ou mais, se tiver múltiplos números)
-- =============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_instances (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    instance_name   text NOT NULL,                       -- nome na Evolution API
    numero          text,                                -- número conectado (preenchido após QR)
    status          text DEFAULT 'desconectado'
                    CHECK (status IN ('conectado','desconectado','conectando','banido')),
    provider        text DEFAULT 'evolution'
                    CHECK (provider IN ('evolution','meta')),
    config          jsonb DEFAULT '{}',                  -- webhook_url, token etc
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (tenant_id, instance_name)
);

INSERT INTO whatsapp_instances (tenant_id, instance_name, provider, config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'cruzeiro-vendas-principal',
    'evolution',
    '{}'::jsonb
)
ON CONFLICT (tenant_id, instance_name) DO NOTHING;
