import { describe, it, expect } from 'vitest';
import { passesGuard, GUARDED_TOOLS } from '../../../supabase/functions/_shared/confirmation-guard.ts';

describe('passesGuard', () => {
    it('lets non-guarded tools through', () => {
        expect(passesGuard({ toolName: 'ler_lead', recentUserMessages: [] })).toBe(true);
    });

    it('blocks guarded tool without affirmative', () => {
        expect(passesGuard({
            toolName: 'registrar_matricula',
            recentUserMessages: ['quanto fica?', 'ah entendi'],
        })).toBe(false);
    });

    it.each(['sim', 'pode mandar', 'aceito', 'confirmo', 'ok pode', 'fechado', 'topo'])(
        'unlocks on "%s"',
        (text) => {
            expect(passesGuard({
                toolName: 'registrar_matricula',
                recentUserMessages: [text],
            })).toBe(true);
        },
    );

    it('all guarded tools are listed', () => {
        expect(GUARDED_TOOLS.size).toBe(1);
        expect(GUARDED_TOOLS.has('registrar_matricula')).toBe(true);
    });
});
