import { describe, expect, it } from 'vitest';
import { COURSE_CATALOG_ENTRIES } from '../../../scripts/course-catalog-dataset.ts';

function normalize(value: string) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

describe('course catalog aliases', () => {
    it('mantem os aliases comerciais ligados aos cursos oficiais', () => {
        const expected: Record<string, string[]> = {
            administracao: ['adm', 'administracao de empresas'],
            'ciencias contabeis': ['contador', 'contabilidade'],
            'analise e desenvolvimento de sistemas': ['ads'],
            'arquitetura e urbanismo': ['arquitetura', 'arquiteto'],
            'ciencias biologicas': ['biologia'],
            'ciencias economicas': ['economia'],
            'estetica e cosmetica': ['estetica'],
            'estudos teoricos psicanaliticos e sociais': ['psicanalise'],
            'gestao da tecnologia da informacao': ['ti', 't i'],
            'gestao de negocios imobiliarios': ['corretor de imoveis', 'corretor'],
            'gestao de recursos humanos': ['rh', 'r h'],
            'seguranca no trabalho': ['seguranca do trabalho'],
            'servico social': ['assistente social'],
            'terapia ocupacional': ['to', 't o'],
            fonoaudiologia: ['fono'],
            'optica e optometria': ['optica'],
        };

        for (const [courseName, aliases] of Object.entries(expected)) {
            const matches = COURSE_CATALOG_ENTRIES.filter((entry) => normalize(entry.canonical_name) === courseName);
            expect(matches.length, `curso ausente: ${courseName}`).toBeGreaterThan(0);
            for (const entry of matches) {
                const normalizedAliases = (entry.aliases || []).map(normalize);
                for (const alias of aliases) expect(normalizedAliases).toContain(alias);
            }
        }
    });

    it('cadastra Fonoaudiologia como bacharelado semipresencial de oito semestres', () => {
        const course = COURSE_CATALOG_ENTRIES.find((entry) => normalize(entry.canonical_name) === 'fonoaudiologia');
        expect(course).toMatchObject({
            display_name: 'FONOAUDIOLOGIA (BACHARELADO)',
            degree_level: 'bacharelado',
            delivery_mode: 'semipresencial',
            duration_semesters: 8,
            duration_years: 4,
        });
    });
});
