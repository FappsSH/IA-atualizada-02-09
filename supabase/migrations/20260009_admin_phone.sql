-- Update admin phone number for notifications
UPDATE tenants
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{telefone_admin}', '"5569993720268"'),
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';
