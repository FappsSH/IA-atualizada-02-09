import { describe, expect, it } from 'vitest';
import { classifyInboundAgainstStageState, derivePendingCriterion, getNextCatalogAction, getNextE1Criterion } from '../../../supabase/functions/ai-processor/stage-state.ts';

describe('stage state classification', () => {
    it('mantem pending criterion em course_line quando o curso esta ambiguo', () => {
        const leadSnapshot = {
            curso_interesse: 'CIENCIAS BIOLOGICAS',
            sales_context: {
                course_status: 'ambiguous_available',
                course_validated: false,
                line_selection_required: true,
                available_course_lines: ['Bacharelado', 'Licenciatura'],
            },
        };

        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBe('course_line');
        expect(getNextE1Criterion({ leadSnapshot })).toBe('course_line');
    });

    it('resolve escolha de linha como evento contextual e consolida confirmed_available', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                curso_interesse: 'CIENCIAS BIOLOGICAS',
                sales_context: {
                    course_status: 'ambiguous_available',
                    course_validated: false,
                    line_selection_required: true,
                    available_course_lines: ['Bacharelado', 'Licenciatura'],
                },
            },
            history: [
                { role: 'assistant', content: 'Qual linha voce pretende seguir?' },
            ],
            latestUserMessage: 'Licenciatura',
        });

        expect(result.classification).toBe('contextual_course_line');
        expect(result.statePatch.linha_formacao).toBe('Licenciatura');
        expect(result.statePatch.course_status).toBe('confirmed_available');
        expect(result.statePatch.course_validated).toBe(true);
    });

    it('mantem E1 aguardando escolha de alternativa quando ha opcoes de segmento', () => {
        const leadSnapshot = {
            sales_context: {
                course_status: 'segment_options_available',
                related_area_courses: ['BIOMEDICINA (BACHARELADO)'],
                requested_area_name: 'Saude e Beleza',
            },
        };

        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBe('alternative_course_selection');
        expect(getNextE1Criterion({ leadSnapshot })).toBe('alternative_course_selection');
    });

    it('confirmed_available em E1 vai obrigatoriamente para city antes de motivation', () => {
        const leadSnapshot = {
            curso_interesse: 'ADMINISTRACAO PUBLICA (BACHARELADO)',
            sales_context: {
                course_status: 'confirmed_available',
                course_validated: true,
                linha_formacao: 'Bacharelado',
                line_selection_required: false,
                motivacao_principal: '',
            },
        };

        expect(getNextE1Criterion({ leadSnapshot })).toBe('city');
        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBe('city');
    });

    it('cidade antiga sem confirmacao no fluxo atual nao fecha criterio de city', () => {
        const leadSnapshot = {
            curso_interesse: 'ADMINISTRACAO PUBLICA (BACHARELADO)',
            cidade: 'Vilhena',
            sales_context: {
                course_status: 'confirmed_available',
                course_validated: true,
                linha_formacao: 'Bacharelado',
                line_selection_required: false,
                e1_city_confirmed: false,
                motivacao_principal: '',
            },
        };

        expect(getNextE1Criterion({ leadSnapshot })).toBe('city');
    });

    it('resolve escolha de curso apresentado na area e sai do browse', () => {
        const leadSnapshot = {
            sales_context: {
                catalog_mode: 'awaiting_course',
                course_status: 'catalog_area_selected',
                requested_area_name: 'Tecnologia',
                related_area_courses: [
                    'Ciência da Computação',
                    'Análise e Desenvolvimento de Sistemas',
                    'Banco de Dados',
                ],
            },
        };

        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history: [
                { role: 'assistant', content: '*Tecnologia*\n\n- Ciência da Computação\n- Análise e Desenvolvimento de Sistemas\n- Banco de Dados\n\nQual desses mais combina com o que você está buscando?' },
            ],
            latestUserMessage: 'Analise e desenvolvimento de sistemas',
        });

        expect(result.classificationReason).toBe('selected_catalog_course');
        expect(result.statePatch.curso_interesse).toBe('Análise e Desenvolvimento de Sistemas');
        expect(result.statePatch.catalog_mode).toBe('inactive');
        expect(result.statePatch.pending_criterion).toBe('city');
    });

    it('resolve curso oferecido dentro de frase natural sem relistar area', () => {
        const leadSnapshot = {
                sales_context: {
                    catalog_mode: 'awaiting_course',
                    course_status: 'catalog_area_selected',
                    requested_area_name: 'Tecnologia',
                    related_area_courses: [
                        'Ciencia Da Computacao',
                        'Analise E Desenvolvimento De Sistemas',
                        'Banco de Dados',
                        'Ciberseguranca',
                    ],
                },
        };
        const history = [
                { role: 'assistant', content: '*Tecnologia*\n\n- CiÃªncia da ComputaÃ§Ã£o\n- AnÃ¡lise e Desenvolvimento de Sistemas\n- Banco de Dados\n\nQual desses mais combina com o que vocÃª estÃ¡ buscando?' },
        ];
        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history,
            latestUserMessage: 'Analise e desenvolvimento de sistemas parece interessante',
        });

        expect(result.classificationReason).toBe('selected_catalog_course');
        expect(result.authorizedCourseChange).toBe(true);
        expect(result.statePatch.course_status).toBe('confirmed_available');
        expect(result.statePatch.catalog_mode).toBe('inactive');
        expect(result.statePatch.course_was_selected_from_offered_list).toBe(true);
        expect(result.statePatch.pending_criterion).toBe('city');

        const banco = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history,
            latestUserMessage: 'Banco de dados me chamou mais atencao',
        });
        expect(banco.classificationReason).toBe('selected_catalog_course');
        expect(banco.statePatch.curso_interesse).toBe('Banco de Dados');

        const ciber = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history,
            latestUserMessage: 'Gostei de Ciberseguranca',
        });
        expect(ciber.classificationReason).toBe('selected_catalog_course');
        expect(ciber.statePatch.curso_interesse).toBe('Ciberseguranca');
    });

    it('resolve frase natural de area escolhida e obriga listar cursos no mesmo fluxo', () => {
        const leadSnapshot = {
            sales_context: {
                catalog_mode: 'awaiting_area',
                course_status: 'catalog_exploration',
            },
        };

        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history: [
                { role: 'assistant', content: 'Pra eu te mostrar melhor e nao te mandar lista enorme de uma vez, com qual area voce mais se identifica?' },
            ],
            latestUserMessage: 'Area da tecnologia me chama a atencao',
        });

        expect(result.classificationReason).toBe('selected_catalog_area');
        expect(result.explicitNewIntent).toBe(true);
        expect(result.statePatch.selected_area).toBe('Tecnologia');
        expect(result.statePatch.catalog_mode).toBe('awaiting_course');
        expect(result.statePatch.pending_criterion).toBe('course_selection');

        const patchedLeadSnapshot = {
            sales_context: {
                ...leadSnapshot.sales_context,
                ...result.statePatch,
            },
        };
        expect(getNextCatalogAction({ leadSnapshot: patchedLeadSnapshot })).toBe('wait_or_select_course');
        expect(getNextE1Criterion({ leadSnapshot: patchedLeadSnapshot })).toBe('course_selection');
    });

    it('nao trata pedido explicito de mais opcoes como escolha de curso', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                sales_context: {
                    catalog_mode: 'awaiting_course',
                    course_status: 'catalog_area_selected',
                    related_area_courses: ['Banco de Dados'],
                },
            },
            history: [],
            latestUserMessage: 'Tem mais opções?',
        });

        expect(result.classificationReason).not.toBe('selected_catalog_course');
        expect(result.matched).toBe(false);
    });

    it('apos escolher linha em curso ambiguo, o proximo criterio volta para city quando cidade estiver ausente', () => {
        const baseLeadSnapshot = {
            curso_interesse: 'CIENCIAS BIOLOGICAS',
            sales_context: {
                course_status: 'ambiguous_available',
                course_validated: false,
                line_selection_required: true,
                available_course_lines: ['Bacharelado', 'Licenciatura'],
            },
        };

        const lineResolution = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: baseLeadSnapshot,
            history: [
                { role: 'assistant', content: 'Qual linha voce pretende seguir?' },
            ],
            latestUserMessage: 'Licenciatura',
        });

        const patchedLeadSnapshot = {
            ...baseLeadSnapshot,
            sales_context: {
                ...baseLeadSnapshot.sales_context,
                ...lineResolution.statePatch,
            },
        };

        expect(getNextE1Criterion({ leadSnapshot: patchedLeadSnapshot })).toBe('city');
        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot: patchedLeadSnapshot, history: [] })).toBe('city');
    });

    it('nao resolve Licenciatura como cidade quando pending criterion e city', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                curso_interesse: 'CIENCIAS BIOLOGICAS',
                sales_context: {
                    course_status: 'confirmed_available',
                    course_validated: true,
                    linha_formacao: 'Licenciatura',
                    line_selection_required: false,
                    e1_city_confirmed: false,
                },
            },
            history: [
                { role: 'assistant', content: 'De qual cidade voce e?' },
            ],
            latestUserMessage: 'Licenciatura',
        });

        expect(result.classification).not.toBe('contextual_response');
        expect(result.classificationReason).not.toBe('resolved_pending_city');
    });

    it('segment_unavailable passa a usar new_direction como criterio da E1', () => {
        const leadSnapshot = {
            sales_context: {
                course_status: 'segment_unavailable',
                course_validated: false,
                requested_area_name: null,
                related_area_courses: [],
            },
        };

        expect(getNextE1Criterion({ leadSnapshot })).toBe('new_direction');
        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBe('new_direction');
    });

    it('apos motivacao resolvida, E1 retorna complete', () => {
        const leadSnapshot = {
            curso_interesse: 'ADMINISTRACAO PUBLICA (BACHARELADO)',
            cidade: 'Vilhena',
            sales_context: {
                course_status: 'confirmed_available',
                course_validated: true,
                linha_formacao: 'Bacharelado',
                line_selection_required: false,
                e1_city_confirmed: true,
                motivacao_principal: 'Ja trabalho na area',
            },
        };

        expect(getNextE1Criterion({ leadSnapshot })).toBeNull();
        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBeNull();
    });

    it('prioriza motivacao contextual em E1 antes de qualquer nova consulta', () => {
        const leadSnapshot = {
            curso_interesse: 'CST EM GESTAO PUBLICA',
            cidade: 'Jacinopolis',
            sales_context: {
                course_validated: true,
                line_selection_required: false,
                motivacao_principal: '',
                e1_city_confirmed: true,
                last_agent_question_type: 'motivation',
            },
        };

        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot,
            history: [
                { role: 'assistant', content: 'Agora me conta, voce ja trabalha na area ou esse curso representa um sonho ou objetivo pessoal pra voce?' },
            ],
            latestUserMessage: 'Quero fazer ele para concurso',
        });

        expect(derivePendingCriterion({ stage: 'E1', leadSnapshot, history: [] })).toBe('motivation');
        expect(result.classification).toBe('contextual_response');
        expect(result.classificationReason).toBe('resolved_pending_motivation');
        expect(result.statePatch.motivacao_principal).toBe('Quero fazer ele para concurso');
    });

    it('mantem resposta condicional de preco pendente na vacina 3 em E2', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E2',
            leadSnapshot: {
                sales_context: {
                    e2_vaccine_availability_done: true,
                    e2_vaccine_decider_done: true,
                    e2_vaccine_agreement_done: false,
                },
            },
            history: [
                { role: 'assistant', content: 'Se fizer sentido pra voce e a bolsa ficar boa, seguimos para inscricao. Combinado?' },
            ],
            latestUserMessage: 'Dependendo do valor, sim',
        });

        expect(result.classification).toBe('contextual_response');
        expect(result.classificationReason).toBe('conditional_price_pending_confirmation');
        expect(result.statePatch.e2_commercial_agreement_status).toBe('conditional_price_pending_confirmation');
        expect(result.statePatch.e2_vaccine_agreement_done).toBe(false);
    });

    it('resolve confirmacao depois de resposta condicional de preco em E2', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E2',
            leadSnapshot: {
                sales_context: {
                    e2_vaccine_availability_done: true,
                    e2_vaccine_decider_done: true,
                    e2_commercial_agreement_status: 'conditional_price_pending_confirmation',
                    e2_vaccine_agreement_done: false,
                },
            },
            history: [
                { role: 'assistant', content: 'Vou te passar o valor, mas primeiro quero apresentar o curso. Tudo bem assim?' },
            ],
            latestUserMessage: 'Pode ser',
        });

        expect(result.classificationReason).toBe('resolved_pending_vaccine_3_conditional_confirmation');
        expect(result.statePatch.e2_commercial_agreement_status).toBe('resolved');
        expect(result.statePatch.e2_vaccine_agreement_done).toBe(true);
    });

    it('registra participante da decisao sem tratar como objecao em E2', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E2',
            leadSnapshot: {
                sales_context: {
                    e2_vaccine_availability_done: true,
                    e2_vaccine_decider_done: false,
                },
            },
            history: [
                { role: 'assistant', content: 'Voce decide sozinho ou conversa com alguem antes?' },
            ],
            latestUserMessage: 'Preciso conversar com meu marido',
        });

        expect(result.classificationReason).toBe('resolved_pending_vaccine_2');
        expect(result.statePatch.e2_decision_maker_status).toBe('resolved');
        expect(result.statePatch.e2_decision_participant).toBe('marido');
    });

    it('resolve viagem ou mudanca como contexto tratavel na vacina 1 em E2', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E2',
            leadSnapshot: {
                sales_context: {
                    e2_vaccine_availability_done: false,
                },
            },
            history: [
                { role: 'assistant', content: 'Tem alguma viagem ou mudanca que possa interferir no inicio?' },
            ],
            latestUserMessage: 'Vou me mudar no proximo mes',
        });

        expect(result.classificationReason).toBe('resolved_pending_vaccine_1_travel_or_move');
        expect(result.statePatch.e2_availability_status).toBe('resolved');
        expect(result.statePatch.e2_availability_objection_kind).toBe('travel_or_move');

        const patchedLeadSnapshot = {
            sales_context: {
                ...result.statePatch,
                e2_vaccine_decider_done: false,
                e2_vaccine_agreement_done: false,
            },
        };
        expect(derivePendingCriterion({ stage: 'E2', leadSnapshot: patchedLeadSnapshot, history: [] })).toBe('vaccine_decider');
    });

    it('usa area oficial do catalogo ao resolver selecao de area', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                sales_context: {
                    catalog_mode: 'awaiting_area',
                    course_status: 'catalog_exploration',
                    available_catalog_areas: ['Saude e Beleza', 'Tecnologia'],
                },
            },
            history: [],
            latestUserMessage: 'saude me interessa',
        });

        expect(result.classificationReason).toBe('selected_catalog_area');
        expect(result.statePatch.selected_area).toBe('Saude e Beleza');
        expect(result.statePatch.requested_area_name).toBe('Saude e Beleza');
    });

    it('trata nome do indicado como contexto em E6 e nao como nova consulta', () => {
        const result = classifyInboundAgainstStageState({
            stage: 'E6',
            leadSnapshot: {
                sales_context: {
                    e6_feedback_collected: true,
                    e6_recommended_service: true,
                    pending_indication_name: '',
                },
            },
            history: [
                { role: 'assistant', content: 'Me passa primeiro o nome dessa pessoa.' },
            ],
            latestUserMessage: 'Joao Pereira',
        });

        expect(result.classification).toBe('contextual_response');
        expect(result.classificationReason).toBe('resolved_pending_referral_name');
        expect(result.statePatch.pending_indication_name).toBe('Joao Pereira');
    });
});
