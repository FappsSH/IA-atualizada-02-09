import { describe, expect, it } from 'vitest';
import { detectCatalogIntentWithHistory, detectContextualReplyKind } from '../../../supabase/functions/ai-processor/catalog-resolver.ts';

describe('catalog resolver', () => {
    it('reconhece "quero X" como curso especifico apos a abertura da E1', () => {
        const result = detectCatalogIntentWithHistory(
            'Quero Administracao Publica',
            [{ role: 'assistant', content: 'Opa, muito bom dia! No que posso te ajudar hoje?' }],
        );

        expect(result.matched).toBe(true);
        expect(result.mode).toBe('specific');
        expect(result.query).toBe('Administracao Publica');
    });

    it('reconhece aceite para ver alternativas como browse', () => {
        const result = detectCatalogIntentWithHistory(
            'Sim, pode me mostrar outras opcoes dessa area',
            [{ role: 'assistant', content: 'Posso te mostrar alternativas dessa mesma area, se fizer sentido para voce.' }],
        );

        expect(result.matched).toBe(true);
        expect(result.mode).toBe('browse');
    });

    it('nao trata Licenciatura como cidade quando ultima pergunta foi sobre cidade', () => {
        const result = detectContextualReplyKind(
            'Licenciatura',
            [{ role: 'assistant', content: 'Me conta de qual cidade voce e?' }],
        );

        expect(result).toBeNull();
    });

    it('nao trata Licenciatura como nova consulta de catalogo quando ultima pergunta foi de linha', () => {
        const result = detectCatalogIntentWithHistory(
            'Licenciatura',
            [{ role: 'assistant', content: 'Qual linha voce gostaria de seguir? Bacharelado ou Licenciatura?' }],
        );

        expect(result.matched).toBe(false);
        expect(result.mode).toBeNull();
    });

    it('trata exploracao ampla como catalog_exploration_intent', () => {
        const result = detectCatalogIntentWithHistory(
            'Estou procurando uma graduacao. Quais opcoes tem?',
            [{ role: 'assistant', content: 'No que posso te ajudar hoje?' }],
        );

        expect(result.matched).toBe(true);
        expect(result.mode).toBe('browse_catalog');
    });

    it('trata "quero saber os cursos que voces tem" como catalogo amplo', () => {
        const result = detectCatalogIntentWithHistory(
            'Quero saber os cursos que voces tem',
            [{ role: 'assistant', content: 'No que posso te ajudar hoje?' }],
        );

        expect(result.matched).toBe(true);
        expect(result.mode).toBe('browse_catalog');
    });
});
