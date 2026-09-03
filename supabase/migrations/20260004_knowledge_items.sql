-- =============================================================================
-- Migration 4: Knowledge Base (knowledge_items)
-- Guarda cursos, links institucionais e informações gerais para os agentes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  type TEXT NOT NULL CHECK (type IN ('course', 'link', 'general')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type, key)
);

-- Seed: Cursos
INSERT INTO knowledge_items (tenant_id, type, key, label, value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'course', 'administracao', 'Administração', '{"modalidade": "EAD", "duracao": "4 anos", "descricao": "Bacharelado em Administração"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'pedagogia', 'Pedagogia', '{"modalidade": "EAD", "duracao": "3 anos", "descricao": "Licenciatura em Pedagogia"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'ciencias-contabeis', 'Ciências Contábeis', '{"modalidade": "EAD", "duracao": "4 anos", "descricao": "Bacharelado em Ciências Contábeis"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'servico-social', 'Serviço Social', '{"modalidade": "EAD", "duracao": "3 anos", "descricao": "Bacharelado em Serviço Social"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'gestao-recursos-humanos', 'Gestão de Recursos Humanos', '{"modalidade": "EAD", "duracao": "2 anos", "descricao": "Tecnólogo em Gestão de Recursos Humanos"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'marketing-digital', 'Marketing Digital', '{"modalidade": "EAD", "duracao": "2 anos", "descricao": "Tecnólogo em Marketing Digital"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'analise-desenvolvimento-sistemas', 'Análise e Desenvolvimento de Sistemas', '{"modalidade": "EAD", "duracao": "2.5 anos", "descricao": "Tecnólogo em Análise e Desenvolvimento de Sistemas"}'),
  ('00000000-0000-0000-0000-000000000001', 'course', 'enfermagem', 'Enfermagem', '{"modalidade": "Semipresencial", "duracao": "5 anos", "descricao": "Bacharelado em Enfermagem"}')
ON CONFLICT (tenant_id, type, key) DO NOTHING;

-- Seed: Links Institucionais
INSERT INTO knowledge_items (tenant_id, type, key, label, value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'link', 'site-oficial', 'Site Oficial', '{"url": "https://faculdadefapps.com.br"}'),
  ('00000000-0000-0000-0000-000000000001', 'link', 'instagram', 'Instagram', '{"url": "https://instagram.com/faculdadefapps"}'),
  ('00000000-0000-0000-0000-000000000001', 'link', 'portal-do-aluno', 'Portal do Aluno', '{"url": "https://portal.faculdadefapps.com.br"}')
ON CONFLICT (tenant_id, type, key) DO NOTHING;

-- Seed: Informações Gerais
INSERT INTO knowledge_items (tenant_id, type, key, label, value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'general', 'empresa', 'Sobre a Fapps', '{"descricao": "Faculdade Fapps - Educação de qualidade a distância e semipresencial."}'),
  ('00000000-0000-0000-0000-000000000001', 'general', 'diferenciais', 'Diferenciais', '{"descricao": "Mensalidades acessíveis, corpo docente qualificado, plataforma EAD moderna."}')
ON CONFLICT (tenant_id, type, key) DO NOTHING;
