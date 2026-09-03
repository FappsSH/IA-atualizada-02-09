// router.ts — Roteia etapa_atual do lead para o subagente correto (E1-E7)
// deno-lint-ignore-file
// @ts-nocheck

import type { Subagent } from './subagent.ts';

// Mapeamento direto: etapa_atual no banco → subagente
// Simples e sem ambiguidade — a etapa no banco sempre reflete onde o lead está
const ETAPA_TO_SUBAGENT: Record<string, Subagent> = {
    E1: 'E1',  // Conexão e Qualificação
    E2: 'E2',  // Vacinas e D.I.
    E3: 'E3',  // Apresentação do Produto
    E4: 'E4',  // Fechamento Financeiro
    E5: 'E5',  // Validação e Matrícula
    E6: 'E6',  // Pegar Indicações
    E7: 'E7',  // Preparar Indicados
};

// Etapas que o agente NÃO atende — humano está no controle
const ETAPAS_BLOQUEADAS = new Set(['encerrado', 'handoff', 'inativo']);

export function routeByEtapa(etapaAtual: string): Subagent {
    if (ETAPAS_BLOQUEADAS.has(etapaAtual)) {
        throw new Error(`LEAD_BLOQUEADO:${etapaAtual}`);
    }

    const subagent = ETAPA_TO_SUBAGENT[etapaAtual];
    if (!subagent) {
        // Lead novo sem etapa definida — começa do E1
        if (!etapaAtual) return 'E1';
        throw new Error(`ETAPA_DESCONHECIDA:${etapaAtual}`);
    }

    return subagent;
}
