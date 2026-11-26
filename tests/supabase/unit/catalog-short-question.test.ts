import { describe, it, expect } from 'vitest';
import { detectCatalogIntentWithHistory } from '../../../supabase/functions/ai-processor/catalog-resolver.ts';
describe('pergunta curta de curso', () => {
  it('detecta', () => {
    for (const [m,q] of [['E Medicina?','medicina'],['Tem Psicologia?','psicologia'],['E Administração, vocês têm?','administra']]) {
      const r: any = detectCatalogIntentWithHistory(m, []);
      expect(r.matched).toBe(true); expect(String(r.query).toLowerCase()).toContain(q);
    }
  });
});
