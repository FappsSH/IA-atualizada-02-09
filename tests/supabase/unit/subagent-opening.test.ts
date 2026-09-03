import { describe, expect, it } from 'vitest';
import { shouldSendInitialE1Opening } from '../../../supabase/functions/ai-processor/subagent.ts';

describe('shouldSendInitialE1Opening', () => {
    it('nao abre welcome interno no subagent mesmo no primeiro turno de E1', () => {
        const result = shouldSendInitialE1Opening({
            subagent: 'E1',
            history: [{ role: 'user', content: 'oi' }],
            latestUserMessage: 'oi',
        });

        expect(result).toBe(false);
    });

    it('nao reabre fallback interno quando lead ja chega falando curso', () => {
        const result = shouldSendInitialE1Opening({
            subagent: 'E1',
            history: [{ role: 'user', content: 'voces tem radiologia?' }],
            latestUserMessage: 'voces tem radiologia?',
        });

        expect(result).toBe(false);
    });

    it('nao reabre boas-vindas quando a conversa ja teve resposta do agente', () => {
        const result = shouldSendInitialE1Opening({
            subagent: 'E1',
            history: [
                { role: 'user', content: 'oi' },
                { role: 'assistant', content: 'Opa, muito bom dia Helton!! Eu sou Helton...' },
                { role: 'user', content: 'bom dia' },
            ],
            latestUserMessage: 'bom dia',
        });

        expect(result).toBe(false);
    });
});
