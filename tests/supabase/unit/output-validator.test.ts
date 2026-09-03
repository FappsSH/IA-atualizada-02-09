import { describe, expect, it } from 'vitest';
import { validateOutboundText } from '../../../supabase/functions/_shared/output-validator.ts';

describe('validateOutboundText', () => {
    it('remove narracao interna e termos proibidos de transicao', () => {
        const result = validateOutboundText(
            'Perfeito.\n\nVamos seguir para a proxima etapa.\n\nAgora eu uso avancar_etapa por aqui.',
        );

        expect(result.text).toBe('Perfeito.');
        expect(result.changed).toBe(true);
        expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('remove marcadores tecnicos brutos de catalogo', () => {
        const result = validateOutboundText(
            '*EDUCACAO FISICA*\n\n- BACHARELADO\n- LICENCIATURA\n\nAREA BASICA DE INGRESSO',
        );

        expect(result.text).not.toContain('AREA BASICA DE INGRESSO');
        expect(result.text).toContain('BACHARELADO');
    });
});

