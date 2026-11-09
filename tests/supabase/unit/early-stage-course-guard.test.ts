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

    it('fallback legado de E1 para cidade permanece desativado', () => {
        const text = buildE1AskCityFallback('Administração Pública');
        expect(text).toBe('');
        expect(mentionsEarlyStageCourseDetails(text)).toBe(false);
    });

    it('fallback legado de E1 para motivacao permanece desativado', () => {
        const text = buildE1AskMotivationFallback('Farmácia');
        expect(text).toBe('');
        expect(mentionsEarlyStageCourseDetails(text)).toBe(false);
    });
});
