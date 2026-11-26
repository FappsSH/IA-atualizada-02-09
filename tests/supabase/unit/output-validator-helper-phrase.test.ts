import { describe, it, expect } from 'vitest';
import * as V from '../../../supabase/functions/_shared/output-validator.ts';
describe('ajudar melhor', () => {
  it('remove', () => {
    const fn: any = (V as any).validateOutboundText;
    const out = JSON.stringify(fn('Aqui na instituição, temos várias opções de graduação.\n\nPara te ajudar melhor, me conta qual área você mais se identifica?'));
    expect(out).not.toMatch(/ajudar melhor/i);
    expect(out).toMatch(/Me conta qual área/);
  });
  it('remove fecho de suporte', () => {
    const fn: any = (V as any).validateOutboundText;
    const out = JSON.stringify(fn('Todas as provas são feitas pela plataforma.\n\nSe precisar de mais detalhes ou tiver outras dúvidas, fique à vontade para perguntar.'));
    expect(out).not.toMatch(/vontade|outras d/i);
    expect(out).toMatch(/plataforma/);
  });
});
