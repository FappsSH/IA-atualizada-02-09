import { describe, it, expect } from 'vitest';
import { extractReferralName, userDeclinesReferral, looksLikeReferralPhone } from '../../../supabase/functions/_shared/referral.ts';
describe('referral', () => {
  it('names', () => {
    expect(extractReferralName('Tenho um amigo que quer')).toBeNull();
    expect(extractReferralName('Tenho sim, minha irmã')).toBeNull();
    expect(extractReferralName('Pedro Alves')).toBe('Pedro Alves');
    expect(extractReferralName('pedro alves')).toBe('Pedro Alves');
    expect(extractReferralName('Sim, a Maria')).toBe('Maria');
    expect(extractReferralName('minha irmã Ana Souza')).toBe('Ana Souza');
    expect(extractReferralName('Ana Souza')).toBe('Ana Souza');
    expect(extractReferralName('Não, obrigada')).toBeNull();
    expect(extractReferralName('Valeu!')).toBeNull();
    expect(extractReferralName('Sim')).toBeNull();
  });
  it('decline', () => {
    for (const t of ['Não, obrigada', 'não', 'Não tenho ninguém agora', 'Agora não', 'ninguém', 'Nao conheco ninguem']) expect(userDeclinesReferral(t)).toBe(true);
    for (const t of ['Tenho sim', 'Sim, a Maria', 'Pedro Alves', '69 99999-0000']) expect(userDeclinesReferral(t)).toBe(false);
  });
  it('phone', () => {
    expect(looksLikeReferralPhone('+55 (69) 98888-7777')).toBe(true);
    expect(looksLikeReferralPhone('69 99999-0000')).toBe(true);
    expect(looksLikeReferralPhone('Pedro')).toBe(false);
  });
});
