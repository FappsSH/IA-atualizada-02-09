import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../supabase/functions/ai-processor/tool-schemas.ts';

describe('TOOL_SCHEMAS', () => {
    it('has 8 entries for the Fapps sales pipeline including admin alerts', () => {
        expect(Object.keys(TOOL_SCHEMAS)).toHaveLength(8);
    });

    it('contains all expected tool names', () => {
        const names = Object.keys(TOOL_SCHEMAS);
        expect(names).toContain('ler_lead');
        expect(names).toContain('atualizar_lead');
        expect(names).toContain('avancar_etapa');
        expect(names).toContain('registrar_matricula');
        expect(names).toContain('registrar_indicacao');
        expect(names).toContain('acionar_handoff');
        expect(names).toContain('notificar_admin');
        expect(names).toContain('consultar_conhecimento');
    });

    it('every schema is function type with name + parameters', () => {
        for (const [k, v] of Object.entries(TOOL_SCHEMAS)) {
            expect(v.type).toBe('function');
            expect(v.function.name).toBe(k);
            expect(v.function.parameters).toBeDefined();
        }
    });

    it('avancar_etapa accepts the current optional etapa_destino contract', () => {
        const p = TOOL_SCHEMAS.avancar_etapa.function.parameters as any;
        expect(p.required ?? []).not.toContain('etapa_destino');
        expect(p.properties.etapa_destino.enum).toEqual(['E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'encerrado']);
    });

    it('atualizar_lead defines known top-level field names', () => {
        const p = TOOL_SCHEMAS.atualizar_lead.function.parameters as any;
        expect(p.properties.nome).toBeDefined();
        expect(p.properties.curso_interesse).toBeDefined();
        expect(p.properties.dor_principal).toBeDefined();
        expect(p.properties.cidade).toBeDefined();
    });

    it('consultar_conhecimento accepts tipo and query filters', () => {
        const p = TOOL_SCHEMAS.consultar_conhecimento.function.parameters as any;
        expect(p.properties.tipo.enum).toContain('course');
        expect(p.properties.tipo.enum).toContain('link');
        expect(p.properties.query).toBeDefined();
    });
});
