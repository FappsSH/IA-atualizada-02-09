import { describe, expect, it } from 'vitest';
import { getCourseDisplayName } from '../../../supabase/functions/_shared/course-display.ts';

describe('course-display', () => {
    it('remove prefixos tecnicos do nome do curso', () => {
        expect(getCourseDisplayName('CST EM RADIOLOGIA')).toBe('Radiologia');
        expect(getCourseDisplayName('CIENCIAS BIOLOGICAS (LICENCIATURA)')).toBe('Ciências Biológicas');
    });

    it('recupera display conversacional de cursos normalizados sem acento', () => {
        expect(getCourseDisplayName('CST EM ANALISE E DESENVOLVIMENTO DE SISTEMAS')).toBe('Análise e Desenvolvimento de Sistemas');
        expect(getCourseDisplayName('CIENCIA DA COMPUTACAO (BACHARELADO)')).toBe('Ciência da Computação');
        expect(getCourseDisplayName('CST EM GESTAO DA TECNOLOGIA DA INFORMACAO')).toBe('Gestão da Tecnologia da Informação');
    });

    it('recupera display conversacional de cursos de saude sem acento', () => {
        expect(getCourseDisplayName('ESTETICA E COSMETICA')).toBe('Estética e Cosmética');
        expect(getCourseDisplayName('GESTAO DA SAUDE PUBLICA')).toBe('Gestão da Saúde Pública');
        expect(getCourseDisplayName('FARMACIA')).toBe('Farmácia');
    });
});
