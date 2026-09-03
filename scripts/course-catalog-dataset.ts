export const COURSE_CATALOG_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export interface CourseCatalogSourceSeed {
  source_key: string;
  source_name: string;
  source_kind: 'vector_store_file' | 'openai_file';
  vector_file_id: string;
  description: string;
}

export interface CourseCatalogEntrySeed {
  source_key: string;
  catalog_group: string;
  area_slug: string | null;
  area_name: string | null;
  canonical_name: string;
  display_name: string;
  degree_level: 'bacharelado' | 'licenciatura' | 'tecnologo' | 'outro';
  delivery_mode: 'ead' | 'semipresencial';
  duration_semesters: number;
  duration_years: number;
  duration_text: string;
  variant_kind?: 'standard' | 'egresso' | 'area_basica' | 'custom';
  aliases?: string[];
}

export const COURSE_CATALOG_SOURCES: CourseCatalogSourceSeed[] = [
  {
    source_key: 'cursos_tecnologos',
    source_name: 'Cursos_Tecnologos_Organizado.md',
    source_kind: 'vector_store_file',
    vector_file_id: 'file-94dsis34qJXXQ27NN6WXCn',
    description: 'Catalogo principal de cursos tecnologos.',
  },
  {
    source_key: 'cursos_area_saude_beleza',
    source_name: 'Cursos_Area_Saude_e_Beleza_Organizado.md',
    source_kind: 'vector_store_file',
    vector_file_id: 'file-DKWxTZMKfXnLXoG2R37x1j',
    description: 'Catalogo estruturado de cursos da area de saude e beleza.',
  },
  {
    source_key: 'cursos_area_tecnologia',
    source_name: 'Cursos_Area_Tecnologia_Organizado.md',
    source_kind: 'vector_store_file',
    vector_file_id: 'file-Fj8PvPyxoNJFdN5z5ypdk8',
    description: 'Catalogo estruturado de cursos da area de tecnologia.',
  },
  {
    source_key: 'cursos_licenciaturas',
    source_name: 'Cursos_Licenciaturas_Organizado.md',
    source_kind: 'vector_store_file',
    vector_file_id: 'file-REHk81KdnqaHuN79GJ8uSP',
    description: 'Catalogo estruturado de licenciaturas.',
  },
  {
    source_key: 'cursos_area_educacao',
    source_name: 'Cursos_Area_Educacao_Organizado.md',
    source_kind: 'vector_store_file',
    vector_file_id: 'file-VxAfUukgzhMhdog1369MuM',
    description: 'Catalogo estruturado da area de educacao.',
  },
  {
    source_key: 'lista_completa_de_cursos',
    source_name: 'Lista_completa_de_cursos.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-8WGVwKG4g3CxoyfMtc34nu',
    description: 'Arquivo complementar com lista completa de cursos. Conteudo pendente de ingestao por falta de creditos na API.',
  },
  {
    source_key: 'cursos_ead',
    source_name: 'Cursos_EAD_Organizado.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-6yYsSGDmV5kdZ4Kbp4AiyL',
    description: 'Arquivo complementar de cursos EAD. Conteudo pendente de ingestao por falta de creditos na API.',
  },
  {
    source_key: 'cursos_area_gestao_negocios',
    source_name: 'Cursos_Area_Gestao_e_Negocios_Organizado.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-K4Wh5VxrypQZz8zTuPNDeh',
    description: 'Arquivo complementar da area de gestao e negocios. Conteudo pendente de ingestao por falta de creditos na API.',
  },
  {
    source_key: 'cursos_semipresenciais',
    source_name: 'Cursos_Semipresenciais_Organizado.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-2HbNecgWVkUcMzdBMUkSAB',
    description: 'Arquivo complementar de cursos semipresenciais. Conteudo pendente de ingestao por falta de creditos na API.',
  },
  {
    source_key: 'cursos_bacharelados',
    source_name: 'Cursos_Bacharelados_Organizado.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-ChBQ1Sxevy8Vb6EKEurix4',
    description: 'Arquivo complementar de bacharelados. Conteudo pendente de ingestao por falta de creditos na API.',
  },
  {
    source_key: 'cursos_area_ambiental_agro',
    source_name: 'Cursos_Area_Ambiental_e_Agro_Organizado.md',
    source_kind: 'openai_file',
    vector_file_id: 'file-ScQboZwQ6LJ8Nc3cAFizoa',
    description: 'Arquivo complementar da area ambiental e agro. Conteudo pendente de ingestao por falta de creditos na API.',
  },
];

export const COURSE_CATALOG_ENTRIES: CourseCatalogEntrySeed[] = [
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Biomedicina', display_name: 'BIOMEDICINA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Farmacia', display_name: 'FARMACIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Fisioterapia', display_name: 'FISIOTERAPIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Naturologia', display_name: 'NATUROLOGIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Nutricao', display_name: 'NUTRICAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Optica e Optometria', display_name: 'OPTICA E OPTOMETRIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_saude_beleza', catalog_group: 'area_saude_beleza', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Terapia Ocupacional', display_name: 'TERAPIA OCUPACIONAL (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },

  { source_key: 'cursos_area_tecnologia', catalog_group: 'area_tecnologia', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Ciencia da Computacao', display_name: 'CIENCIA DA COMPUTACAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_tecnologia', catalog_group: 'area_tecnologia', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Engenharia de Computacao', display_name: 'ENGENHARIA DE COMPUTACAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_tecnologia', catalog_group: 'area_tecnologia', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Engenharia de Software', display_name: 'ENGENHARIA DE SOFTWARE (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_tecnologia', catalog_group: 'area_tecnologia', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Sistemas de Informacao', display_name: 'SISTEMAS DE INFORMACAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },

  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Artes Visuais', display_name: 'ARTES VISUAIS (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Ciencias Biologicas', display_name: 'CIENCIAS BIOLOGICAS (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Ciencias Sociais', display_name: 'CIENCIAS SOCIAIS (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Educacao Especial', display_name: 'EDUCACAO ESPECIAL (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Educacao Fisica', display_name: 'EDUCACAO FISICA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Filosofia', display_name: 'FILOSOFIA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Fisica', display_name: 'FISICA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Geografia', display_name: 'GEOGRAFIA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Historia', display_name: 'HISTORIA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Letras - Libras', display_name: 'LETRAS - LIBRAS (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Letras - Portugues e Espanhol', display_name: 'LETRAS - PORTUGUES E ESPANHOL (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Letras - Portugues e Ingles', display_name: 'LETRAS - PORTUGUES E INGLES (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Letras - Portugues e Japones', display_name: 'LETRAS - PORTUGUES E JAPONES (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Matematica', display_name: 'MATEMATICA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Pedagogia', display_name: 'PEDAGOGIA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos', aliases: ['Pedagogia'] },
  { source_key: 'cursos_licenciaturas', catalog_group: 'licenciaturas', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Quimica', display_name: 'QUIMICA (LICENCIATURA)', degree_level: 'licenciatura', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },

  { source_key: 'cursos_area_educacao', catalog_group: 'area_educacao', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Educacao Fisica', display_name: 'EDUCACAO FISICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_educacao', catalog_group: 'area_educacao', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Educacao Fisica', display_name: 'EDUCACAO FISICA (BACHARELADO) (P/ EGRESSO ED FISICA LIC)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos', variant_kind: 'egresso' },
  { source_key: 'cursos_area_educacao', catalog_group: 'area_educacao', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Educacao Fisica', display_name: 'EDUCACAO FISICA (AREA BASICA DE INGRESSO)', degree_level: 'outro', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos', variant_kind: 'area_basica' },
  { source_key: 'cursos_area_educacao', catalog_group: 'area_educacao', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Ciencias Sociais', display_name: 'CIENCIAS SOCIAIS (LICENCIADOS EM GEO, FILOS E HIST)', degree_level: 'outro', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos', variant_kind: 'custom' },

  { source_key: 'cursos_area_ambiental_agro', catalog_group: 'area_ambiental_agro', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Agronomia', display_name: 'AGRONOMIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 10, duration_years: 5, duration_text: '10 Semestres - 5 Anos' },
  { source_key: 'cursos_area_ambiental_agro', catalog_group: 'area_ambiental_agro', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia Ambiental', display_name: 'ENGENHARIA AMBIENTAL (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 10, duration_years: 5, duration_text: '10 Semestres - 5 Anos' },

  { source_key: 'cursos_area_gestao_negocios', catalog_group: 'area_gestao_negocios', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Administracao', display_name: 'ADMINISTRACAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_gestao_negocios', catalog_group: 'area_gestao_negocios', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Administracao Publica', display_name: 'ADMINISTRACAO PUBLICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_gestao_negocios', catalog_group: 'area_gestao_negocios', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Ciencias Contabeis', display_name: 'CIENCIAS CONTABEIS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_gestao_negocios', catalog_group: 'area_gestao_negocios', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Ciencias Economicas', display_name: 'CIENCIAS ECONOMICAS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_area_gestao_negocios', catalog_group: 'area_gestao_negocios', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Relacoes Internacionais', display_name: 'RELACOES INTERNACIONAIS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },

  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Arquitetura e Urbanismo', display_name: 'ARQUITETURA E URBANISMO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 10, duration_years: 5, duration_text: '10 Semestres - 5 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Ciencia Politica', display_name: 'CIENCIA POLITICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Ciencias Biologicas', display_name: 'CIENCIAS BIOLOGICAS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia Civil', display_name: 'ENGENHARIA CIVIL (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 10, duration_years: 5, duration_text: '10 Semestres - 5 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia de Producao', display_name: 'ENGENHARIA DE PRODUCAO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia Eletrica', display_name: 'ENGENHARIA ELETRICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia Mecanica', display_name: 'ENGENHARIA MECANICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Engenharia Mecatronica', display_name: 'ENGENHARIA MECATRONICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Filosofia', display_name: 'FILOSOFIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Fisica', display_name: 'FISICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Geografia', display_name: 'GEOGRAFIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Historia', display_name: 'HISTORIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Interdisciplinar em Humanidades', display_name: 'INTERDISCIPLINAR EM HUMANIDADES (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Jornalismo', display_name: 'JORNALISMO (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Matematica', display_name: 'MATEMATICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Estudos Teoricos Psicanaliticos e Sociais', display_name: 'ESTUDOS TEORICOS PSICANALITICOS E SOCIAIS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Psicopedagogia', display_name: 'PSICOPEDAGOGIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Publicidade e Propaganda', display_name: 'PUBLICIDADE E PROPAGANDA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Relacoes Publicas', display_name: 'RELACOES PUBLICAS (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Servico Social', display_name: 'SERVICO SOCIAL (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Teologia', display_name: 'TEOLOGIA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'ead', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },
  { source_key: 'cursos_bacharelados', catalog_group: 'bacharelados', area_slug: 'educacao', area_name: 'Educacao', canonical_name: 'Quimica', display_name: 'QUIMICA (BACHARELADO)', degree_level: 'bacharelado', delivery_mode: 'semipresencial', duration_semesters: 8, duration_years: 4, duration_text: '8 Semestres - 4 Anos' },

  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Analise de Dados de Alta Performance', display_name: 'CST EM ANALISE DE DADOS DE ALTA PERFORMANCE', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Analise e Desenvolvimento de Sistemas', display_name: 'CST EM ANALISE E DESENVOLVIMENTO DE SISTEMAS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos', aliases: ['ADS'] },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Banco de Dados', display_name: 'CST EM BANCO DE DADOS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Ciberseguranca', display_name: 'CST EM CIBERSEGURANCA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Ciencia de Dados', display_name: 'CST EM CIENCIA DE DADOS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Coaching e Mentoring', display_name: 'CST EM COACHING E MENTORING', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Coding', display_name: 'CST EM CODING', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Comercio Exterior', display_name: 'CST EM COMERCIO EXTERIOR', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Computacao em Nuvem', display_name: 'CST EM COMPUTACAO EM NUVEM', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Conciliacao, Mediacao e Arbitragem', display_name: 'CST EM CONCILIACAO, MEDIACAO E ARBITRAGEM', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Criminologia', display_name: 'CST EM CRIMINOLOGIA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Desenvolvimento Back-End', display_name: 'CST EM DESENVOLVIMENTO BACK-END', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Desenvolvimento Full Stack', display_name: 'CST EM DESENVOLVIMENTO FULL STACK', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Desenvolvimento Mobile', display_name: 'CST EM DESENVOLVIMENTO MOBILE', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design de Animacao', display_name: 'CST EM DESIGN DE ANIMACAO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design de Experiencia', display_name: 'CST EM DESIGN DE EXPERIENCIA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design de Interiores', display_name: 'CST EM DESIGN DE INTERIORES', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design de Moda', display_name: 'CST EM DESIGN DE MODA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design de Produto', display_name: 'CST EM DESIGN DE PRODUTO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'design', area_name: 'Design e Criacao', canonical_name: 'Design Grafico', display_name: 'CST EM DESIGN GRAFICO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Empreendedorismo', display_name: 'CST EM EMPREENDEDORISMO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Estetica e Cosmetica', display_name: 'CST EM ESTETICA E COSMETICA', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Eventos', display_name: 'CST EM EVENTOS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Fotografia', display_name: 'CST EM FOTOGRAFIA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gastronomia', area_name: 'Gastronomia', canonical_name: 'Gastronomia', display_name: 'CST EM GASTRONOMIA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Gerontologia', display_name: 'CST EM GERONTOLOGIA', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 6, duration_years: 3, duration_text: '6 Semestres - 3 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Gestao Ambiental', display_name: 'CST EM GESTAO AMBIENTAL', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao Comercial', display_name: 'CST EM GESTAO COMERCIAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao da Producao Industrial', display_name: 'CST EM GESTAO DA PRODUCAO INDUSTRIAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao da Qualidade', display_name: 'CST EM GESTAO DA QUALIDADE', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Gestao da Saude Publica', display_name: 'CST EM GESTAO DA SAUDE PUBLICA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 6, duration_years: 3, duration_text: '6 Semestres - 3 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Gestao da Tecnologia da Informacao', display_name: 'CST EM GESTAO DA TECNOLOGIA DA INFORMACAO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao das Organizacoes do Terceiro Setor', display_name: 'CST EM GESTAO DAS ORGANIZACOES DO TERCEIRO SETOR', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao de Cooperativas', display_name: 'CST EM GESTAO DE COOPERATIVAS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao de Negocios Imobiliarios', display_name: 'CST EM GESTAO DE NEGOCIOS IMOBILIARIOS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao de Recursos Humanos', display_name: 'CST EM GESTAO DE RECURSOS HUMANOS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao de Seguranca Privada', display_name: 'CST EM GESTAO DE SEGURANCA PRIVADA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao de Turismo', display_name: 'CST EM GESTAO DE TURISMO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao Desportiva e de Lazer', display_name: 'CST EM GESTAO DESPORTIVA E DE LAZER', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'ambiental-agro', area_name: 'Ambiental e Agro', canonical_name: 'Gestao do Agronegocio', display_name: 'CST EM GESTAO DO AGRONEGOCIO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Gestao Financeira', display_name: 'CST EM GESTAO FINANCEIRA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Gestao Hospitalar', display_name: 'CST EM GESTAO HOSPITALAR', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 6, duration_years: 3, duration_text: '6 Semestres - 3 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Gestao Publica', display_name: 'CST EM GESTAO PUBLICA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Influenciador Digital', display_name: 'CST EM INFLUENCIADOR DIGITAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Inteligencia Artificial', display_name: 'CST EM INTELIGENCIA ARTIFICIAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos', aliases: ['IA'] },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Internet das Coisas', display_name: 'CST EM INTERNET DAS COISAS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos', aliases: ['IoT'] },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Jogos Digitais', display_name: 'CST EM JOGOS DIGITAIS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Logistica', display_name: 'CST EM LOGISTICA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Marketing', display_name: 'CST EM MARKETING', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Marketing Digital', display_name: 'CST EM MARKETING DIGITAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Pericia Judicial e Extrajudicial', display_name: 'CST EM PERICIA JUDICIAL E EXTRAJUDICIAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Podologia', display_name: 'CST EM PODOLOGIA', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Processos Gerenciais', display_name: 'CST EM PROCESSOS GERENCIAIS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Producao Audiovisual', display_name: 'CST EM PRODUCAO AUDIOVISUAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Producao Cultural', display_name: 'CST EM PRODUCAO CULTURAL', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'criacao', area_name: 'Criacao e Midia', canonical_name: 'Producao Midiatica', display_name: 'CST EM PRODUCAO MIDIATICA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Radiologia', display_name: 'CST EM RADIOLOGIA', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 6, duration_years: 3, duration_text: '6 Semestres - 3 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Redes de Computadores', display_name: 'CST EM REDES DE COMPUTADORES', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'gestao-negocios', area_name: 'Gestao e Negocios', canonical_name: 'Secretariado', display_name: 'CST EM SECRETARIADO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Seguranca da Informacao', display_name: 'CST EM SEGURANCA DA INFORMACAO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Seguranca no Trabalho', display_name: 'CST EM SEGURANCA NO TRABALHO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Seguranca no Transito', display_name: 'CST EM SEGURANCA NO TRANSITO', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Seguranca Publica', display_name: 'CST EM SEGURANCA PUBLICA', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Servicos Juridicos e Notariais', display_name: 'CST EM SERVICOS JURIDICOS E NOTARIAIS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'juridico', area_name: 'Juridico e Publico', canonical_name: 'Servicos Penais', display_name: 'CST EM SERVICOS PENAIS', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'tecnologia', area_name: 'Tecnologia', canonical_name: 'Sistemas para Internet', display_name: 'CST EM SISTEMAS PARA INTERNET', degree_level: 'tecnologo', delivery_mode: 'ead', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
  { source_key: 'cursos_tecnologos', catalog_group: 'tecnologos', area_slug: 'saude-beleza', area_name: 'Saude e Beleza', canonical_name: 'Terapias Integrativas e Complementares', display_name: 'CST EM TERAPIAS INTEGRATIVAS E COMPLEMENTARES', degree_level: 'tecnologo', delivery_mode: 'semipresencial', duration_semesters: 4, duration_years: 2, duration_text: '4 Semestres - 2 Anos' },
];
