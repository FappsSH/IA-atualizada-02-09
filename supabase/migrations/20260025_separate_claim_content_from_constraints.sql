-- Keep speakable claim content separate from editorial constraints.

UPDATE knowledge_items
SET
  value = jsonb_set(
    jsonb_set(
      value,
      '{content}',
      to_jsonb('A comunicação comercial pode apresentar o time de tutores como um dos melhores do Brasil.'::text),
      true
    ),
    '{metadata}',
    COALESCE(metadata, '{}'::jsonb) || '{"forbidden_strengthening":["numero_1_do_brasil","ranking_tecnico"]}'::jsonb,
    true
  ),
  metadata = COALESCE(metadata, '{}'::jsonb) || '{"forbidden_strengthening":["numero_1_do_brasil","ranking_tecnico"]}'::jsonb,
  searchable_text = trim(concat_ws(
    ' ',
    label,
    key,
    category,
    'A comunicação comercial pode apresentar o time de tutores como um dos melhores do Brasil.',
    scope,
    stage
  )),
  updated_at = now()
WHERE type = 'claim'
  AND claim_key = 'tutoring_best_in_brazil';
