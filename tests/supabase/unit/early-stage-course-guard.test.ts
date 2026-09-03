import { describe, expect, it } from 'vitest';
import {
    buildE1AskCityFallback,
    buildE1AskMotivationFallback,
    mentionsEarlyStageCourseDetails,
} from '../../../supabase/functions/ai-processor/early-stage-guard.ts';

describe('early stage course guard', () => {
    it('detecta detalhes de produto proibidos em E1 e E2', () => {
        expect(mentionsEarlyStageCourseDetails(
            'O curso está disponível na modalidade EAD, com duração de 8 semestres.',
        )).toBe(true);
    });

    it('fallback de E1 para cidade nao vaza detalhes de produto', () => {
        const text = buildE1AskCityFallback('Administração Pública');
        expect(text).toContain('Administração Pública');
        expect(text).toContain('cidade');
        expect(mentionsEarlyStageCourseDetails(text)).toBe(false);
    });

    it('fallback de E1 para motivacao nao vaza detalhes de produto', () => {
        const text = buildE1AskMotivationFallback('Farmácia');
        expect(text).toContain('Farmácia');
        expect(text).toContain('sonho');
        expect(mentionsEarlyStageCourseDetails(text)).toBe(false);
    });
});
