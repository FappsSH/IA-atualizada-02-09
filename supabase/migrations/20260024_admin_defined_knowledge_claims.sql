-- Admin-defined commercial and academic claims.
-- These rows are factual authority for E2/E3 speakable claims.

ALTER TABLE knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_type_check;

ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_type_check
  CHECK (type IN ('course', 'link', 'general', 'faq', 'pricing_rule', 'offer', 'policy', 'script', 'objection_playbook', 'claim'));

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS claim_key TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS authorized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_claim_key_unique
  ON knowledge_items(tenant_id, claim_key)
  WHERE type = 'claim' AND claim_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_items_claim_authority_idx
  ON knowledge_items(tenant_id, type, active, status, authorized, scope, stage, priority)
  WHERE type = 'claim';

WITH claim_seed(claim_key, category, title, content, scope, stage, priority, metadata) AS (
  VALUES
    ('institution_is_university', 'institution', 'Universidade', 'A Universidade Cruzeiro do Sul é uma Universidade.', 'E3', 'E3', 10, '{}'::jsonb),
    ('institution_diploma_international_recognition', 'institution', 'Diploma fora do Brasil', 'Por sermos uma Universidade, o diploma possui reconhecimento também fora do Brasil.', 'E3', 'E3', 20, '{}'::jsonb),
    ('institution_university_advantage_vs_college', 'institution', 'Diferencial vs Faculdade/Centro Universitário', 'Esse reconhecimento internacional do diploma é um diferencial que Faculdade ou Centro Universitário não oferece da mesma forma.', 'E3', 'E3', 30, '{}'::jsonb),
    ('institution_60_plus_years', 'institution', 'Mais de 60 anos', 'A instituição possui mais de 60 anos de mercado educacional.', 'E3', 'E3', 40, '{}'::jsonb),
    ('institution_maximum_mec_rating', 'institution', 'Nota máxima MEC', 'A instituição possui nota máxima no MEC.', 'E3', 'E3', 50, '{}'::jsonb),
    ('institution_maximum_mec_since_beginning', 'institution', 'Nota máxima desde o início', 'A instituição é nota máxima no MEC desde quando começou.', 'E3', 'E3', 60, '{}'::jsonb),
    ('tutoring_full_journey_support', 'tutoring', 'Tutores durante toda a jornada', 'O aluno conta com tutores durante toda a jornada da graduação, do começo ao fim.', 'E3', 'E3', 70, '{}'::jsonb),
    ('tutoring_deadline_reminders', 'tutoring', 'Tutores lembram datas', 'Os tutores ajudam o aluno a se manter atento às datas e prazos e fazem lembretes relacionados a esses compromissos acadêmicos.', 'E2,E3', 'E2,E3', 80, '{}'::jsonb),
    ('tutoring_awarded', 'tutoring', 'Tutores premiados', 'O time de tutores já foi premiado várias vezes em nível nacional.', 'E3', 'E3', 90, '{}'::jsonb),
    ('tutoring_best_in_brazil', 'tutoring', 'Um dos melhores times de tutores do Brasil', 'A comunicação comercial pode apresentar o time de tutores como um dos melhores do Brasil.', 'E3', 'E3', 100, '{"forbidden_strengthening":["numero_1_do_brasil","ranking_tecnico"]}'::jsonb),
    ('ead_flexible_study_schedule', 'course_methodology', 'EAD flexibilidade', 'Na modalidade EAD, o aluno pode assistir às aulas no dia e horário que melhor se encaixar em sua rotina, respeitando as datas e os compromissos acadêmicos da graduação.', 'E2,E3', 'E2,E3', 110, '{"modality":"EAD"}'::jsonb),
    ('ead_dates_with_tutor_support', 'course_methodology', 'EAD com lembretes de tutores', 'Mesmo tendo flexibilidade de horário no EAD, o aluno precisa se atentar às datas acadêmicas, e os tutores ajudam com lembretes e acompanhamento dessas datas.', 'E2,E3', 'E2,E3', 120, '{"modality":"EAD"}'::jsonb),
    ('semipresencial_live_online_classes', 'course_methodology', 'Semipresencial ao vivo', 'Na modalidade semipresencial, especialmente nos primeiros semestres, o aluno possui aulas ao vivo pela plataforma, podendo acompanhar de onde estiver.', 'E2,E3', 'E2,E3', 130, '{"modality":"SEMIPRESENCIAL"}'::jsonb),
    ('semipresencial_online_live_experience', 'course_methodology', 'Experiência semipresencial', 'A experiência das aulas ao vivo no semipresencial funciona de forma semelhante a uma aula presencial, porém com o aluno acompanhando pela plataforma.', 'E2,E3', 'E2,E3', 140, '{"modality":"SEMIPRESENCIAL"}'::jsonb)
)
INSERT INTO knowledge_items (
  tenant_id,
  type,
  key,
  claim_key,
  category,
  label,
  value,
  scope,
  stage,
  active,
  authorized,
  source_type,
  status,
  priority,
  metadata,
  searchable_text,
  published_at,
  updated_at
)
SELECT
  '00000000-0000-0000-0000-000000000001',
  'claim',
  claim_key,
  claim_key,
  category,
  title,
  jsonb_build_object(
    'title', title,
    'content', content,
    'category', category,
    'scope', scope,
    'stage', stage,
    'source_type', 'admin_defined',
    'authorized', true,
    'metadata', metadata
  ),
  scope,
  stage,
  true,
  true,
  'admin_defined',
  'published',
  priority,
  metadata,
  trim(concat_ws(' ', title, claim_key, category, content, scope, stage, metadata::text)),
  now(),
  now()
FROM claim_seed
ON CONFLICT (tenant_id, type, key) DO UPDATE SET
  claim_key = EXCLUDED.claim_key,
  category = EXCLUDED.category,
  label = EXCLUDED.label,
  value = EXCLUDED.value,
  scope = EXCLUDED.scope,
  stage = EXCLUDED.stage,
  active = true,
  authorized = true,
  source_type = 'admin_defined',
  status = 'published',
  priority = EXCLUDED.priority,
  metadata = EXCLUDED.metadata,
  searchable_text = EXCLUDED.searchable_text,
  published_at = COALESCE(knowledge_items.published_at, now()),
  updated_at = now();
