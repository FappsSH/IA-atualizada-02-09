UPDATE tenants
SET config = jsonb_set(
  jsonb_set(
    COALESCE(config, '{}'::jsonb),
    '{message_policy,formatting,force_separate_messages}',
    'false'::jsonb,
    true
  ),
  '{message_policy,formatting,long_message_char_threshold}',
  '240'::jsonb,
  true
)
WHERE id = '00000000-0000-0000-0000-000000000001';
