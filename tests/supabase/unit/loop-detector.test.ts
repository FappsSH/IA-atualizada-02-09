import { describe, it, expect } from 'vitest';
import { detectLoop, hashArgs } from '../../../supabase/functions/_shared/loop-detector.ts';

describe('detectLoop', () => {
    it('returns false for short history', () => {
        expect(detectLoop([{ name: 'a', argsHash: hashArgs({}) }])).toBe(false);
    });

    it('detects 3 identical calls', () => {
        const h = Array.from({ length: 3 }, () => ({ name: 'consultar_preco_sheets', argsHash: hashArgs({ x: 1 }) }));
        expect(detectLoop(h)).toBe(true);
    });

    it('ignores when args differ', () => {
        const h = [
            { name: 'consultar_preco_sheets', argsHash: hashArgs({ x: 1 }) },
            { name: 'consultar_preco_sheets', argsHash: hashArgs({ x: 2 }) },
            { name: 'consultar_preco_sheets', argsHash: hashArgs({ x: 1 }) },
        ];
        expect(detectLoop(h)).toBe(false);
    });
});
