// tool-schemas.ts — JSON Schemas das tools do Agente de Vendas Fapps
// deno-lint-ignore-file
// @ts-nocheck
import type { ToolSpec } from '../_shared/openai-client.ts';

export const TOOL_SCHEMAS: Record<string, ToolSpec> = {
    ler_lead: {
        type: 'function',
        function: {
            name: 'ler_lead',
            description:
                'Lê os dados atuais do lead no Supabase: nome, curso_interesse, modalidade, ' +
                'dor_principal, decisor_confirmado, etapa_atual, objecoes_tratadas, bloqueado e outros campos. ' +
                'Use no início de cada turno para ter o contexto mais recente.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },

    atualizar_lead: {
        type: 'function',
        function: {
            name: 'atualizar_lead',
            description:
                'Atualiza campos do lead na tabela leads. Use para registrar informações coletadas ' +
                'durante a conversa (nome, curso_interesse, modalidade, dor_principal, decisor_confirmado, ' +
                'viagem_programada, valor_parcela). NÃO use para avançar etapa — use avancar_etapa para isso.',
            parameters: {
                type: 'object',
                properties: {
                    nome: { type: 'string', description: 'Nome completo do lead.' },
                    cidade: { type: 'string', description: 'Cidade onde o lead mora.' },
                    curso_interesse: { type: 'string', description: 'Curso de interesse do lead.' },
                    modalidade: {
                        type: 'string',
                        enum: ['ead', 'semipresencial'],
                        description: 'Modalidade do curso.',
                    },
                    dor_principal: {
                        type: 'string',
                        enum: ['tempo', 'dinheiro', 'ambos'],
                        description: 'Principal dor/objeção do lead.',
                    },
                    decisor_confirmado: {
                        type: 'boolean',
                        description: 'Lead confirmou que decide sozinho?',
                    },
                    viagem_programada: {
                        type: 'boolean',
                        description: 'Lead tem viagem programada?',
                    },
                    valor_parcela: {
                        type: 'number',
                        description: 'Valor da parcela acordado.',
                    },
                },
            },
        },
    },

    avancar_etapa: {
        type: 'function',
        function: {
            name: 'avancar_etapa',
            description:
                'Avança o lead para a próxima etapa do processo comercial. ' +
                'Se nenhuma etapa_destino for informada, avança para a próxima etapa natural (E1→E2→...→encerrado). ' +
                'Use etapa_destino apenas para casos especiais (ex: pular etapa ou forçar encerrado). ' +
                'Só avance quando os critérios da etapa atual estiverem completos.',
            parameters: {
                type: 'object',
                properties: {
                    etapa_destino: {
                        type: 'string',
                        enum: ['E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'encerrado'],
                        description:
                            'OPCIONAL. Etapa para a qual avançar. Se omitido, avança para a próxima etapa natural. ' +
                            'E2=Vacinas/DI, E3=Apresentação, E4=Fechamento financeiro, ' +
                            'E5=Validação matrícula, E6=Indicações, E7=Preparar indicados, ' +
                            'encerrado=ciclo completo.',
                    },
                },
            },
        },
    },

    registrar_matricula: {
        type: 'function',
        function: {
            name: 'registrar_matricula',
            description:
                'Registra que o lead confirmou a matrícula. ' +
                'REQUER confirmação explícita do lead antes de executar (ex: "sim", "confirmo", "pode fazer"). ' +
                'Esta ação é irreversível — marca lead como matriculado=true e salva valor_pago e forma_pagamento.',
            parameters: {
                type: 'object',
                required: ['valor_pago', 'forma_pagamento'],
                properties: {
                    valor_pago: {
                        type: 'number',
                        description: 'Valor efetivamente pago pelo lead na matrícula.',
                    },
                    forma_pagamento: {
                        type: 'string',
                        description: 'Forma de pagamento utilizada (ex: "boleto", "PIX", "cartão").',
                    },
                },
            },
        },
    },

    registrar_indicacao: {
        type: 'function',
        function: {
            name: 'registrar_indicacao',
            description:
                'Registra uma indicação feita pelo lead na etapa E6 ou E7. ' +
                'Salva na tabela indicacoes vinculada ao lead atual como indicador.',
            parameters: {
                type: 'object',
                required: ['telefone_indicado'],
                properties: {
                    telefone_indicado: {
                        type: 'string',
                        description: 'Telefone do indicado no formato E.164 (ex: +5511999998888).',
                    },
                    nome_indicado: {
                        type: 'string',
                        description: 'Nome da pessoa indicada (opcional, mas recomendado).',
                    },
                },
            },
        },
    },

    acionar_handoff: {
        type: 'function',
        function: {
            name: 'acionar_handoff',
            description:
                'Escala o atendimento para um consultor humano e silencia a IA. ' +
                'Use em: pedidos de desconto não-padrão, reclamações, situações sensíveis, ' +
                'dúvidas que a IA não consegue resolver, ou quando o lead pede explicitamente falar com humano.',
            parameters: {
                type: 'object',
                required: ['motivo'],
                properties: {
                    motivo: {
                        type: 'string',
                        description:
                            'Motivo do handoff em uma frase. Ex: "lead pediu desconto especial", ' +
                            '"reclamação sobre processo de matrícula", "pergunta sobre bolsa não padrão".',
                    },
                    urgencia: {
                        type: 'string',
                        enum: ['normal', 'alta'],
                        description: 'Urgência do handoff (default: normal).',
                    },
                },
            },
        },
    },

    notificar_admin: {
        type: 'function',
        function: {
            name: 'notificar_admin',
            description:
                'Notifica o administrador do sistema sobre um evento importante via WhatsApp. ' +
                'Use quando: lead perguntou valor antes da etapa certa, lead confirmou matrícula, ' +
                'lead pediu desconto, ou quando você não souber responder algo. ' +
                'A notificação é interna — o lead não vê. Continue a conversa normalmente após notificar.',
            parameters: {
                type: 'object',
                required: ['motivo'],
                properties: {
                    motivo: {
                        type: 'string',
                        enum: [
                            'lead_perguntou_valor_antes_etapa',
                            'lead_pronto_matricula',
                            'matricula_confirmada',
                            'lead_pediu_desconto',
                            'restricao_financeira',
                            'nao_sei_responder',
                        ],
                        description: 'Motivo da notificação.',
                    },
                    detalhes: {
                        type: 'string',
                        description: 'Detalhes adicionais sobre o evento (opcional). Ex: "Lead perguntou sobre parcelamento em 12x".',
                    },
                },
            },
        },
    },

    consultar_conhecimento: {
        type: 'function',
        function: {
            name: 'consultar_conhecimento',
            description:
                'Consulta a base de conhecimento institucional. ' +
                'Para tipo=course, consulta o catalogo oficial de cursos no catalogo estruturado do banco. ' +
                'Para link e general, consulta a base publicada do Supabase. ' +
                'Use para verificar se um curso existe antes de mencioná-lo ou para obter detalhes como modalidade, duração e descrição.',
            parameters: {
                type: 'object',
                properties: {
                    tipo: {
                        type: 'string',
                        enum: ['course', 'link', 'general'],
                        description: 'Filtrar por tipo: course (cursos), link (links institucionais), general (informações gerais).',
                    },
                    query: {
                        type: 'string',
                        description: 'Texto para buscar no nome do item (label) ou na chave (key). Ex: "Administração", "Instagram".',
                    },
                },
            },
        },
    },
};
