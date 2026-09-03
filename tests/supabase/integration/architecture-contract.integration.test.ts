import { describe, expect, it } from 'vitest';
import { applyMessageGovernance, DEFAULT_MESSAGE_POLICY, splitTextForMessagePolicy } from '../../../supabase/functions/_shared/message-governance.ts';
import { classifyInboundAgainstStageState, derivePendingCriterion } from '../../../supabase/functions/ai-processor/stage-state.ts';

describe('architecture contract integration', () => {
    it('welcome oficial permanece estrutural, mas resposta normal E1 nao vira segunda abertura', () => {
        const opening = [
            'Opa, muito bom dia!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.',
            'É um prazer enorme falar com você!!',
            'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.',
            'São pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
            'No que posso te ajudar hoje?',
        ].join('\n\n');

        const governedOpening = applyMessageGovernance({
            text: opening,
            policy: DEFAULT_MESSAGE_POLICY,
            stageAtual: 'E1',
            timeZone: 'America/Sao_Paulo',
        });

        expect(splitTextForMessagePolicy(governedOpening, DEFAULT_MESSAGE_POLICY)).toHaveLength(3);

        const normalE1Reply = 'Radiologia temos por aqui sim!!\n\nMe confirma de qual cidade você é?';
        const governedNormalReply = applyMessageGovernance({
            text: normalE1Reply,
            policy: DEFAULT_MESSAGE_POLICY,
            stageAtual: 'E1',
            timeZone: 'America/Sao_Paulo',
        });

        expect(governedNormalReply).toBe(normalE1Reply);
        expect(governedNormalReply).not.toContain('No que posso te ajudar hoje?');
    });

    it('catalogo usa estado soberano: area oficial, curso oferecido em frase natural e saida do browse', () => {
        const areaSelection = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                sales_context: {
                    catalog_mode: 'awaiting_area',
                    course_status: 'catalog_exploration',
                    available_catalog_areas: ['Saude e Beleza', 'Tecnologia'],
                },
            },
            history: [],
            latestUserMessage: 'tecnologia me chama atenção',
        });

        expect(areaSelection.classificationReason).toBe('selected_catalog_area');
        expect(areaSelection.statePatch.selected_area).toBe('Tecnologia');
        expect(areaSelection.statePatch.catalog_mode).toBe('awaiting_course');

        const courseSelection = classifyInboundAgainstStageState({
            stage: 'E1',
            leadSnapshot: {
                sales_context: {
                    ...areaSelection.statePatch,
                    related_area_courses: [
                        'Ciência da Computação',
                        'Análise e Desenvolvimento de Sistemas',
                        'Banco de Dados',
                    ],
                },
            },
            history: [],
            latestUserMessage: 'Análise e desenvolvimento de sistemas parece interessante',
        });

        expect(courseSelection.classificationReason).toBe('selected_catalog_course');
        expect(courseSelection.statePatch.curso_interesse).toBe('Análise e Desenvolvimento de Sistemas');
        expect(courseSelection.statePatch.catalog_mode).toBe('inactive');
        expect(courseSelection.statePatch.pending_criterion).toBe('city');
    });

    it('E2 nova regra: viagem ou mudanca resolve vacina 1 e nao cria availability_objection', () => {
        const resolution = classifyInboundAgainstStageState({
            stage: 'E2',
            leadSnapshot: {
                sales_context: {
                    e2_vaccine_availability_done: false,
                    e2_vaccine_decider_done: false,
                    e2_vaccine_agreement_done: false,
                },
            },
            history: [],
            latestUserMessage: 'vou viajar no próximo mês',
        });

        expect(resolution.classificationReason).toBe('resolved_pending_vaccine_1_travel_or_move');

        const leadAfterInbound = {
            sales_context: {
                ...resolution.statePatch,
                e2_vaccine_decider_done: false,
                e2_vaccine_agreement_done: false,
            },
        };

        expect(derivePendingCriterion({ stage: 'E2', leadSnapshot: leadAfterInbound, history: [] })).toBe('vaccine_decider');
    });
});
