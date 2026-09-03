import { describe, expect, it } from 'vitest';
import { resolveTrustedLeadName } from '../../../supabase/functions/_shared/lead-name.ts';

describe('lead-name', () => {
    it('rejeita rotulo profissional como nome pessoal confiavel', () => {
        const result = resolveTrustedLeadName({
            pushName: 'Psicologa',
        });

        expect(result.leadNameConfidence).toBe('none');
        expect(result.leadNameUsed).toBe(false);
        expect(result.leadPersonName).toBeNull();
    });

    it('aceita nome pessoal completo como confiavel', () => {
        const result = resolveTrustedLeadName({
            pushName: 'Maria Eduarda Souza',
        });

        expect(result.leadNameConfidence).toBe('trusted');
        expect(result.leadNameUsed).toBe(true);
        expect(result.leadFirstName).toBe('Maria');
    });
});
