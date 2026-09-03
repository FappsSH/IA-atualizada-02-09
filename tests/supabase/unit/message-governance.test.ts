import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MESSAGE_POLICY,
    applyMessageGovernance,
    splitTextForMessagePolicy,
} from '../../../supabase/functions/_shared/message-governance.ts';

describe('message governance', () => {
    it('mantem a abertura da E1 no formato exato de 3 mensagens', () => {
        const text = [
            'Opa, muito bom dia Helton!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.',
            'É um prazer enorme falar com você!!',
            'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.',
            'São pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
            'No que posso te ajudar hoje?',
        ].join('\n\n');

        const governed = applyMessageGovernance({
            text,
            policy: DEFAULT_MESSAGE_POLICY,
            stageAtual: 'E1',
            timeZone: 'America/Sao_Paulo',
        });

        expect(governed).toContain('\n---\n');

        const parts = splitTextForMessagePolicy(governed, DEFAULT_MESSAGE_POLICY);
        expect(parts).toHaveLength(3);
        expect(parts[0]).toBe([
            'Opa, muito bom dia Helton!! Eu sou Helton, especialista em carreiras da Universidade Cruzeiro do Sul.',
            'É um prazer enorme falar com você!!',
        ].join('\n\n'));
        expect(parts[1]).toBe([
            'Primeiramente eu quero te parabenizar pela iniciativa em entrar em contato conosco.',
            'São pessoas como você que fazemos questão de acompanhar!! Meus parabéns.',
        ].join('\n\n'));
        expect(parts[2]).toBe('No que posso te ajudar hoje?');
    });

    it('nao transforma resposta normal da E1 em boas-vindas ou troca saudacao', () => {
        const text = 'Boa tarde!! Radiologia temos por aqui.\n\nMe confirma de qual cidade voce e?';

        const governed = applyMessageGovernance({
            text,
            policy: DEFAULT_MESSAGE_POLICY,
            stageAtual: 'E1',
            timeZone: 'America/Sao_Paulo',
        });

        expect(governed).toBe(text);
        expect(governed).not.toContain('No que posso te ajudar hoje?');
    });
});
