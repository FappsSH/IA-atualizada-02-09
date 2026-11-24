-- Contatos que a AgentHub não atende (equipe, alunos, amigos, contatos antigos).
CREATE TABLE IF NOT EXISTS public.lead_ignore_list (
    tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    telefone    TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, telefone)
);

ALTER TABLE public.lead_ignore_list ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lead_ignore_list IS
  'Telefones (só dígitos, celular BR com nono dígito) que a AgentHub nunca atende. Fontes: import_evolution, auto_prior_conversation, admin_command, manual.';
