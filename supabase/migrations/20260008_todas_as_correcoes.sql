-- =============================================================================
-- Migration 8: Correções solicitadas
-- Adiciona coluna cidade na tabela leads + telefone_admin no config do tenant
-- =============================================================================

-- 1. Coluna cidade na tabela leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS cidade TEXT;

-- 2. Adiciona telefone_admin no config do tenant principal
UPDATE tenants
SET config = jsonb_set(
    config,
    '{telefone_admin}',
    '"5511999999999"'  -- ← o dono deve atualizar este valor pelo dashboard Configurações
),
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND (config->>'telefone_admin' IS NULL OR config->>'telefone_admin' = '');
