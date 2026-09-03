import { describe, it, expect } from 'vitest';
import { redactPII, redactObject } from '../../../supabase/functions/_shared/redact-pii.ts';

describe('redactPII', () => {
    it('redige CPF em vários formatos', () => {
        expect(redactPII('Meu CPF é 123.456.789-00.')).toContain('[CPF]');
        expect(redactPII('CPF 12345678900')).toContain('[CPF]');
    });
    it('redige CNPJ', () => {
        expect(redactPII('CNPJ 05.415.271/0001-21')).toContain('[CNPJ]');
        expect(redactPII('05415271000121')).toContain('[CNPJ]');
    });
    it('redige email', () => {
        expect(redactPII('contato@exemplo.com.br quando puder')).toContain('[EMAIL]');
    });
    it('redige telefone BR', () => {
        expect(redactPII('me chama no (11) 99999-9999')).toContain('[PHONE]');
        expect(redactPII('+55 11 99999-9999')).toContain('[PHONE]');
    });
    it('preserva texto neutro', () => {
        const out = redactPII('Obrigado, vou conferir com nossa equipe.');
        expect(out).toBe('Obrigado, vou conferir com nossa equipe.');
    });
});

describe('redactObject', () => {
    it('redige campos especificos em profundidade', () => {
        const obj = {
            text: 'CPF 12345678900',
            meta: { content: 'email teste@x.com', other: 'CPF 123.456.789-00' },
        };
        const out: any = redactObject(obj);
        expect(out.text).toContain('[CPF]');
        expect(out.meta.content).toContain('[EMAIL]');
        // 'other' não está na lista padrão de campos
        expect(out.meta.other).toContain('123.456.789-00');
    });
});
