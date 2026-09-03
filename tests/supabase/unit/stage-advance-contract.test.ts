import { describe, expect, it } from 'vitest';
import { createSupabaseMock } from '../../_shared/supabase-mock.ts';
import { tool_avancar_etapa, tool_consultar_conhecimento } from '../../../supabase/functions/ai-processor/tools.ts';

describe('tool_avancar_etapa', () => {
    it('bloqueia E1 para E2 quando faltar curso validado, linha ou motivacao', async () => {
        const supabase = createSupabaseMock({
            leads: [{
                id: 'lead-1',
                etapa_atual: 'E1',
                nome: 'Helton',
                cidade: 'Porto Velho',
                curso_interesse: 'Historia',
                modalidade: null,
                dor_principal: null,
                sales_context: {
                    course_validated: true,
                    line_selection_required: true,
                    linha_formacao: null,
                    motivacao_principal: '',
                },
            }],
        });

        const result = await tool_avancar_etapa({
            supabase,
            tenantId: 'tenant-1',
            leadId: 'lead-1',
            telefone: '5511999999999',
            env: {},
        }, {});

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('missing_e1_requirements');
        expect(result.missing_fields).toContain('linha_formacao');
        expect(result.missing_fields).toContain('motivacao_principal');
    });

    it('permite E1 para E2 sem modalidade quando os criterios reais ja foram cumpridos', async () => {
        const supabase = createSupabaseMock({
            leads: [{
                id: 'lead-1b',
                etapa_atual: 'E1',
                nome: 'Helton',
                cidade: 'Vila Bela',
                curso_interesse: 'ADMINISTRACAO',
                modalidade: null,
                dor_principal: null,
                sales_context: {
                    course_validated: true,
                    line_selection_required: false,
                    linha_formacao: '',
                    motivacao_principal: 'Eu sempre quis fazer mesmo',
                },
            }],
        });

        const result = await tool_avancar_etapa({
            supabase,
            tenantId: 'tenant-1',
            leadId: 'lead-1b',
            telefone: '5511999999999',
            env: {},
        }, {});

        expect(result.ok).toBe(true);
    });
});

describe('tool_consultar_conhecimento', () => {
    it('persiste curso validado, linha e modalidade da oferta quando curso e encontrado', async () => {
        const supabase = createSupabaseMock({
            leads: [{
                id: 'lead-2',
                tenant_id: 'tenant-1',
                etapa_atual: 'E1',
                nome: 'Helton',
                cidade: null,
                curso_interesse: null,
                modalidade: null,
                dor_principal: null,
                sales_context: {},
            }],
            course_catalog_entries: [{
                tenant_id: 'tenant-1',
                active: true,
                display_name: 'HISTORIA (LICENCIATURA)',
                canonical_name: 'HISTORIA LICENCIATURA',
                normalized_search_text: 'historia licenciatura',
                degree_level: 'licenciatura',
                delivery_mode: 'semipresencial',
                duration_text: '8 semestres',
                area_slug: 'educacao',
                area_name: 'Educacao',
                source_key: 'cursos_licenciaturas',
                course_catalog_aliases: [],
            }],
            mensagens: [],
        });

        const result = await tool_consultar_conhecimento({
            supabase,
            tenantId: 'tenant-1',
            leadId: 'lead-2',
            telefone: '5511999999999',
            env: {},
        }, {
            tipo: 'course',
            query: 'HISTORIA (LICENCIATURA)',
        });

        expect(result.match_status).toBe('found');
        expect(supabase.tables.leads.rows[0].curso_interesse).toBe('HISTORIA (LICENCIATURA)');
        expect(supabase.tables.leads.rows[0].modalidade).toBe('semipresencial');
        expect((supabase.tables.leads.rows[0].sales_context as any).course_validated).toBe(true);
        expect((supabase.tables.leads.rows[0].sales_context as any).linha_formacao).toBe('Licenciatura');
    });

    it('resolve segmento fechado para curso indisponivel e oferece alternativas reais', async () => {
        const supabase = createSupabaseMock({
            leads: [{
                id: 'lead-3',
                tenant_id: 'tenant-1',
                etapa_atual: 'E1',
                nome: 'Helton',
                cidade: null,
                curso_interesse: null,
                modalidade: null,
                dor_principal: null,
                sales_context: {},
            }],
            course_catalog_entries: [
                {
                    tenant_id: 'tenant-1',
                    active: true,
                    display_name: 'CST EM RADIOLOGIA',
                    canonical_name: 'Radiologia',
                    normalized_search_text: 'cst em radiologia saude',
                    degree_level: 'tecnologo',
                    delivery_mode: 'ead',
                    duration_text: '6 semestres',
                    area_slug: 'saude-e-beleza',
                    area_name: 'Saude e Beleza',
                    source_key: 'saude',
                    course_catalog_aliases: [],
                },
                {
                    tenant_id: 'tenant-1',
                    active: true,
                    display_name: 'CST EM ESTETICA E COSMETICA',
                    canonical_name: 'Estetica e Cosmetica',
                    normalized_search_text: 'cst em estetica e cosmetica saude beleza',
                    degree_level: 'tecnologo',
                    delivery_mode: 'ead',
                    duration_text: '6 semestres',
                    area_slug: 'saude-e-beleza',
                    area_name: 'Saude e Beleza',
                    source_key: 'saude',
                    course_catalog_aliases: [],
                },
            ],
            mensagens: [],
        });

        const result = await tool_consultar_conhecimento({
            supabase,
            tenantId: 'tenant-1',
            leadId: 'lead-3',
            telefone: '5511999999999',
            env: {},
        }, {
            tipo: 'course',
            query: 'Psicoterapia',
            lookup_mode_hint: 'specific',
        });

        expect(result.match_status).toBe('not_found');
        expect(result.requested_area).toBe('Saude e Beleza');
        expect(result.requested_area_source).toBe('semantic_segment_resolution');
        expect(result.requested_area_confidence).toBe('high');
        expect(result.related_area_courses).toContain('Radiologia');
        expect((supabase.tables.leads.rows[0].sales_context as any).course_status).toBe('segment_options_available');
        expect((supabase.tables.leads.rows[0].sales_context as any).requested_course).toBe('Psicoterapia');
    });

    it('mantem segment_unavailable quando curso fora da taxonomia nao tem segmento confiavel', async () => {
        const supabase = createSupabaseMock({
            leads: [{
                id: 'lead-4',
                tenant_id: 'tenant-1',
                etapa_atual: 'E1',
                nome: 'Helton',
                cidade: null,
                curso_interesse: null,
                modalidade: null,
                dor_principal: null,
                sales_context: {},
            }],
            course_catalog_entries: [{
                tenant_id: 'tenant-1',
                active: true,
                display_name: 'CST EM RADIOLOGIA',
                canonical_name: 'Radiologia',
                normalized_search_text: 'cst em radiologia saude',
                degree_level: 'tecnologo',
                delivery_mode: 'ead',
                duration_text: '6 semestres',
                area_slug: 'saude-e-beleza',
                area_name: 'Saude e Beleza',
                source_key: 'saude',
                course_catalog_aliases: [],
            }],
            mensagens: [],
        });

        const result = await tool_consultar_conhecimento({
            supabase,
            tenantId: 'tenant-1',
            leadId: 'lead-4',
            telefone: '5511999999999',
            env: {},
        }, {
            tipo: 'course',
            query: 'Astrofisica Quantica',
            lookup_mode_hint: 'specific',
        });

        expect(result.match_status).toBe('not_found');
        expect(result.requested_area).toBeNull();
        expect(result.related_area_courses).toEqual([]);
        expect((supabase.tables.leads.rows[0].sales_context as any).course_status).toBe('segment_unavailable');
    });
});
