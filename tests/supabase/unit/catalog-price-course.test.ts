import { describe, it, expect } from 'vitest';
import { detectCatalogIntentWithHistory } from '../../../supabase/functions/ai-processor/catalog-resolver.ts';
describe('curso dentro de pergunta de valor (conversa real 25/11)', () => {
  it('reconhece o curso', () => {
    for (const [m, q] of [['Oi\nQual o valor de adm', 'administra'], ['qual o valor de adm', 'administra'], ['Quanto custa a mensalidade de Pedagogia?', 'pedagogia'], ['Oi\nQuanto ta adm', 'administra'], ['quanto é psicologia?', 'psicologia']]) {
      const r: any = detectCatalogIntentWithHistory(m, []);
      expect(r.matched).toBe(true);
      expect(String(r.query).toLowerCase()).toContain(q);
    }
  });
  it('pergunta de valor sem curso nao vira curso', () => {
    const r: any = detectCatalogIntentWithHistory('Quanto custa a mensalidade?', []);
    expect(r.mode === 'specific' && /mensalidade/.test(String(r.query))).toBe(false);
  });
});
