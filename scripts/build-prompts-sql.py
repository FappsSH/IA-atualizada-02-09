"""Gera supabase/prompts/apply-prompts.sql a partir dos arquivos .md de prompts."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
prompts_dir = root / 'supabase' / 'prompts'
keys = ['PERSONALITY', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']
tenant = '00000000-0000-0000-0000-000000000001'

lines = [
    '-- Gerado por scripts/build-prompts-sql.py. Não editar à mão.',
    'BEGIN;',
    'CREATE TABLE IF NOT EXISTS public.agent_definitions_backup (',
    '  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '  id UUID, tenant_id UUID, subagent_key TEXT, config JSONB',
    ');',
    'ALTER TABLE public.agent_definitions_backup ENABLE ROW LEVEL SECURITY;',
    f"INSERT INTO public.agent_definitions_backup (id, tenant_id, subagent_key, config)",
    f"  SELECT id, tenant_id, subagent_key, config FROM public.agent_definitions WHERE tenant_id = '{tenant}';",
]
for key in keys:
    text = (prompts_dir / f'{key}.md').read_text(encoding='utf-8').strip()
    assert '$prompt$' not in text
    lines.append(
        f"UPDATE public.agent_definitions SET config = coalesce(config, '{{}}'::jsonb) || jsonb_build_object("
        f"'prompt_override', $prompt${text}$prompt$, 'prompt_updated_at', to_jsonb(now()::text)), updated_at = now() "
        f"WHERE tenant_id = '{tenant}' AND subagent_key = '{key}';"
    )
lines.append(
    "SELECT subagent_key, length(config->>'prompt_override') AS chars, config->>'prompt_updated_at' AS updated "
    f"FROM public.agent_definitions WHERE tenant_id = '{tenant}' ORDER BY subagent_key;"
)
lines.append('COMMIT;')
(prompts_dir / 'apply-prompts.sql').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('ok', len(keys), 'prompts')
