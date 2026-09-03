import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const dashboardSqlUrl = process.env.SUPABASE_DASHBOARD_SQL_URL || 'https://supabase.com/dashboard';
const supabase = createClient(supabaseUrl, serviceKey);

const tenantId = '00000000-0000-0000-0000-000000000001';

const items = [
  { tenant_id: tenantId, type: 'course', key: 'administracao', label: 'Administracao', value: { modalidade: 'EAD', duracao: '4 anos', descricao: 'Bacharelado em Administracao' } },
  { tenant_id: tenantId, type: 'course', key: 'pedagogia', label: 'Pedagogia', value: { modalidade: 'EAD', duracao: '3 anos', descricao: 'Licenciatura em Pedagogia' } },
  { tenant_id: tenantId, type: 'course', key: 'ciencias-contabeis', label: 'Ciencias Contabeis', value: { modalidade: 'EAD', duracao: '4 anos', descricao: 'Bacharelado em Ciencias Contabeis' } },
  { tenant_id: tenantId, type: 'course', key: 'servico-social', label: 'Servico Social', value: { modalidade: 'EAD', duracao: '3 anos', descricao: 'Bacharelado em Servico Social' } },
  { tenant_id: tenantId, type: 'course', key: 'gestao-recursos-humanos', label: 'Gestao de Recursos Humanos', value: { modalidade: 'EAD', duracao: '2 anos', descricao: 'Tecnologo em Gestao de Recursos Humanos' } },
  { tenant_id: tenantId, type: 'course', key: 'marketing-digital', label: 'Marketing Digital', value: { modalidade: 'EAD', duracao: '2 anos', descricao: 'Tecnologo em Marketing Digital' } },
  { tenant_id: tenantId, type: 'course', key: 'analise-desenvolvimento-sistemas', label: 'Analise e Desenvolvimento de Sistemas', value: { modalidade: 'EAD', duracao: '2.5 anos', descricao: 'Tecnologo em Analise e Desenvolvimento de Sistemas' } },
  { tenant_id: tenantId, type: 'course', key: 'enfermagem', label: 'Enfermagem', value: { modalidade: 'Semipresencial', duracao: '5 anos', descricao: 'Bacharelado em Enfermagem' } },
  { tenant_id: tenantId, type: 'link', key: 'site-oficial', label: 'Site Oficial', value: { url: 'https://faculdadefapps.com.br' } },
  { tenant_id: tenantId, type: 'link', key: 'instagram', label: 'Instagram', value: { url: 'https://instagram.com/faculdadefapps' } },
  { tenant_id: tenantId, type: 'link', key: 'portal-do-aluno', label: 'Portal do Aluno', value: { url: 'https://portal.faculdadefapps.com.br' } },
  { tenant_id: tenantId, type: 'general', key: 'empresa', label: 'Sobre a Fapps', value: { descricao: 'Faculdade Fapps - Educacao de qualidade a distancia e semipresencial.' } },
  { tenant_id: tenantId, type: 'general', key: 'diferenciais', label: 'Diferenciais', value: { descricao: 'Mensalidades acessiveis, corpo docente qualificado, plataforma EAD moderna.' } },
];

async function main() {
  const { error: checkError } = await supabase.from('knowledge_items').select('id').limit(1);

  if (checkError?.message?.includes('Could not find the table') || checkError?.message?.includes('does not exist')) {
    console.log('');
    console.log('Knowledge base table not found.');
    console.log(`Open your Supabase SQL editor: ${dashboardSqlUrl}`);
    console.log('Then run the SQL that creates knowledge_items before executing this seed again.');
    process.exit(1);
  }

  if (checkError) {
    console.error('Error checking table:', checkError.message);
    process.exit(1);
  }

  console.log('Table exists. Inserting seed data...');

  const { error: insertError } = await supabase
    .from('knowledge_items')
    .upsert(items, { onConflict: 'tenant_id,type,key', ignoreDuplicates: true });

  if (insertError) {
    console.error('Error inserting seed data:', insertError.message);
    process.exit(1);
  }

  console.log(`OK: ${items.length} items inserted (or already existed).`);

  const { count } = await supabase
    .from('knowledge_items')
    .select('*', { count: 'exact', head: true });

  console.log(`Total items in table: ${count}`);
  console.log('OK: Knowledge base seed complete.');
}

main().catch(console.error);
