import { describe, it, expect } from 'vitest';
import { asksInternshipHours, extractInternshipHours, isShortAcknowledgement, INTERNSHIP_HOURS_REPLY } from '../../../supabase/functions/_shared/academic-questions.ts';

describe('horas de estagio (regra do admin 24/11)', () => {
  it('detecta a pergunta', () => {
    for (const t of ['Quanto tempo de estágio tem?', 'Quantas horas de estágio?', 'qual a carga horária do estágio', 'o estagio dura quanto?']) expect(asksInternshipHours(t)).toBe(true);
    for (const t of ['Tem estágio?', 'Gostei do estágio na minha cidade', 'Quanto custa?']) expect(asksInternshipHours(t)).toBe(false);
  });
  it('frase exata definida pelo admin', () => {
    expect(INTERNSHIP_HOURS_REPLY).toBe('A quantidade de horas exatas eu vou solicitar pro setor acadêmico e te envio assim que receber, tudo bem?');
  });
  it('le as horas na resposta do admin', () => {
    expect(extractInternshipHours('Proposta enviada para Maria Silva. Estágio: 400 horas')).toBe('400 horas');
    expect(extractInternshipHours('Proposta enviada, estagio 360h')).toBe('360 horas');
    expect(extractInternshipHours('Proposta enviada para Maria Silva')).toBeNull();
  });
  it('reconhece confirmacao curta', () => {
    for (const t of ['Tudo bem', 'ok', 'Beleza!', 'pode ser', 'Fico no aguardo']) expect(isShortAcknowledgement(t)).toBe(true);
    expect(isShortAcknowledgement('Gostei muito do estágio')).toBe(false);
  });
});
