-- Números liberados pelo administrador ("atender <número>") ou que já foram leads da AgentHub.
-- Eles pulam a checagem de "contato antigo" (a lista de não atender continua valendo antes).
create table if not exists public.lead_allow_list (
  tenant_id uuid not null references tenants(id),
  telefone text not null,
  source text not null default 'admin_command',
  note text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, telefone)
);
alter table public.lead_allow_list enable row level security;
comment on table public.lead_allow_list is 'Números que a AgentHub deve atender mesmo com conversa anterior no WhatsApp (liberados pelo admin ou ex-leads).';
