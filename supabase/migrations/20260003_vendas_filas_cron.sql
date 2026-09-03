-- =============================================================================
-- Migration 3: Filas PGMQ + Cron
-- Pré-requisito: extensões pgmq, pg_cron, pg_net habilitadas no Supabase Dashboard
-- (Database → Extensions → procurar e habilitar cada uma)
-- Rodar depois das migrations 1 e 2.
-- =============================================================================

-- =============================================================================
-- Filas PGMQ
-- =============================================================================

-- Fila principal: mensagens chegando do WhatsApp aguardando processamento
SELECT pgmq.create('whatsapp_inbound')
WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'whatsapp_inbound'
);

-- Fila de mensagens programadas (follow-up, cadências futuras)
SELECT pgmq.create('scheduled_messages')
WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'scheduled_messages'
);

-- Dead Letter Queue: mensagens que falharam após 3 tentativas
SELECT pgmq.create('dlq')
WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'dlq'
);

-- =============================================================================
-- Helper: chama Edge Function via pg_net (lê URL e key do Vault)
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_call_edge_function(
    function_name text,
    payload jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    supa_url    text;
    service_key text;
    request_id  bigint;
BEGIN
    SELECT decrypted_secret INTO supa_url
    FROM vault.decrypted_secrets
    WHERE name = 'app_supabase_url' LIMIT 1;

    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'app_service_role_key' LIMIT 1;

    IF supa_url IS NULL OR service_key IS NULL THEN
        RAISE WARNING 'Vault: app_supabase_url ou app_service_role_key não configurados. Rode os INSERTs do vault abaixo.';
        RETURN NULL;
    END IF;

    SELECT net.http_post(
        url     := supa_url || '/functions/v1/' || function_name,
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        body    := payload
    ) INTO request_id;

    RETURN request_id;
END;
$$;

-- =============================================================================
-- Cron: ai-processor roda a cada 10 segundos
-- Consome a fila whatsapp_inbound e processa uma mensagem por vez
-- =============================================================================
SELECT cron.unschedule('vendas_ai_processor_tick')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'vendas_ai_processor_tick'
);

SELECT cron.schedule(
    'vendas_ai_processor_tick',
    '10 seconds',
    $$ SELECT fn_call_edge_function('ai-processor', '{}'::jsonb); $$
);

-- =============================================================================
-- Cron: debounce-worker — consolida mensagens em rajada (janela de 4s)
-- Evita que o agente responda cada mensagem separadamente quando o lead
-- manda várias em sequência rápida
-- =============================================================================
SELECT cron.unschedule('vendas_debounce_tick')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'vendas_debounce_tick'
);

SELECT cron.schedule(
    'vendas_debounce_tick',
    '10 seconds',
    $$ SELECT fn_call_edge_function('debounce-worker', '{}'::jsonb); $$
);

-- =============================================================================
-- ATENÇÃO: após rodar essa migration, execute estes dois comandos
-- manualmente no SQL Editor do Supabase para salvar seus secrets no Vault:
--
--   SELECT vault.create_secret('https://SEU_REF.supabase.co', 'app_supabase_url');
--   SELECT vault.create_secret('sua_service_role_key_aqui',   'app_service_role_key');
--
-- Substitua SEU_REF e sua_service_role_key_aqui pelos valores reais do seu projeto.
-- Esses valores ficam em: Supabase Dashboard → Settings → API
-- =============================================================================
