-- Align tenant default model with the SDR decision to use GPT-4.1.

UPDATE tenants
SET config = jsonb_set(config, '{modelo_ia}', '"gpt-4.1"', true)
WHERE COALESCE(config->>'modelo_ia', '') IN ('', 'gpt-4.1-mini');
