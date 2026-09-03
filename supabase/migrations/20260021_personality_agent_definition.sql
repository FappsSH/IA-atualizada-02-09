-- =============================================================================
-- Migration 21: Garante o prompt global PERSONALITY na dashboard
-- =============================================================================

INSERT INTO agent_definitions (tenant_id, subagent_key, enabled, config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'PERSONALITY',
    true,
    jsonb_build_object(
        'nome', 'Personalidade Compartilhada',
        'objetivo', 'Definir identidade, tom, postura e regras globais que todos os subagentes devem seguir.',
        'default_prompt', ''
    )
)
ON CONFLICT (tenant_id, subagent_key) DO UPDATE
SET
    enabled = EXCLUDED.enabled,
    config = agent_definitions.config || EXCLUDED.config,
    updated_at = now();
