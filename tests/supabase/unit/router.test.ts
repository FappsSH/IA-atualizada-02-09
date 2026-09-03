import { describe, it, expect } from 'vitest';
import { routeByEtapa } from '../../../supabase/functions/ai-processor/router.ts';

describe('routeByEtapa', () => {
    it.each([
        ['E1', 'E1'],
        ['E2', 'E2'],
        ['E3', 'E3'],
        ['E4', 'E4'],
        ['E5', 'E5'],
        ['E6', 'E6'],
        ['E7', 'E7'],
    ] as const)('maps %s → %s', (etapa, expected) => {
        expect(routeByEtapa(etapa)).toBe(expected);
    });

    it('starts at E1 for empty etapa', () => {
        expect(routeByEtapa('')).toBe('E1');
    });

    it('throws on blocked etapa (encerrado)', () => {
        expect(() => routeByEtapa('encerrado')).toThrow(/LEAD_BLOQUEADO/);
    });

    it('throws on blocked etapa (handoff)', () => {
        expect(() => routeByEtapa('handoff')).toThrow(/LEAD_BLOQUEADO/);
    });

    it('throws on unknown etapa', () => {
        expect(() => routeByEtapa('coluna_inexistente')).toThrow(/ETAPA_DESCONHECIDA/);
    });
});
