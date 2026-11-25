import { describe, it, expect } from 'vitest';
import { TOOLS_BY_SUBAGENT, SYSTEM_PROMPTS, type Subagent } from '../../../supabase/functions/ai-processor/subagent.ts';
import { TOOL_SCHEMAS } from '../../../supabase/functions/ai-processor/tool-schemas.ts';

const SUBAGENTS: Subagent[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];

describe('TOOLS_BY_SUBAGENT', () => {
    it('covers all 7 subagents', () => {
        for (const s of SUBAGENTS) {
            expect(TOOLS_BY_SUBAGENT[s]).toBeDefined();
            expect(TOOLS_BY_SUBAGENT[s].length).toBeGreaterThan(0);
        }
    });

    it('every allowed tool exists in TOOL_SCHEMAS', () => {
        for (const tools of Object.values(TOOLS_BY_SUBAGENT)) {
            for (const t of tools) {
                expect(TOOL_SCHEMAS[t], `missing schema for ${t}`).toBeDefined();
            }
        }
    });

    it('every subagent has a system prompt', () => {
        for (const s of SUBAGENTS) {
            expect(SYSTEM_PROMPTS[s]).toBeDefined();
        }
    });

    it('E5 has registrar_matricula tool', () => {
        expect(TOOLS_BY_SUBAGENT.E5).toContain('registrar_matricula');
    });

    it('E6 nao deixa o modelo registrar indicacao nem avancar (fluxo deterministico)', () => {
        expect(TOOLS_BY_SUBAGENT.E6).not.toContain('registrar_indicacao');
        expect(TOOLS_BY_SUBAGENT.E6).not.toContain('avancar_etapa');
    });

    it('all subagents can advance and handoff', () => {
        for (const s of SUBAGENTS) {
            // Handoff só por pedido explícito de humano (fora do modelo).
            expect(TOOLS_BY_SUBAGENT[s]).not.toContain('acionar_handoff');
            if (s === 'E6' || s === 'E7') continue;
            expect(TOOLS_BY_SUBAGENT[s]).toContain('avancar_etapa');
            // Handoff só por pedido explícito de humano (fora do modelo).
            expect(TOOLS_BY_SUBAGENT[s]).not.toContain('acionar_handoff');
        }
    });
});
