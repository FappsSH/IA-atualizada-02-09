import { describe, it, expect } from 'vitest';
import * as V from '../../../supabase/functions/_shared/output-validator.ts';
describe('ajudar melhor', () => {
  it('remove', () => {
    const fn: any = (V as any).validateOutboundText;
    const out = JSON.stringify(fn('Aqui na instituição, temos várias opções de graduação.\n\nPara te ajudar melhor, me conta qual área você mais se identifica?'));
    expect(out).not.toMatch(/ajudar melhor/i);
    expect(out).toMatch(/Me conta qual área/);
  });
});
