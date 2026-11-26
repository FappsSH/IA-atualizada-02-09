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

import { asksAboutExams, buildExamsReply } from '../../../supabase/functions/_shared/academic-questions.ts';
describe('provas (regra do admin 25/11)', () => {
  it('detecta', () => {
    expect(asksAboutExams('E as provas, como funcionam?')).toBe(true);
    expect(asksAboutExams('tem avaliação presencial?')).toBe(true);
    expect(asksAboutExams('Quanto custa?')).toBe(false);
  });
  it('semipresencial: primeiros semestres pela plataforma + tutores', () => {
    const r = buildExamsReply('semipresencial', 'Ana');
    expect(r).toContain('Nos primeiros semestres, as provas são feitas pela plataforma, Ana.');
    expect(r).toContain('tutores');
  });
  it('EAD: todas pela plataforma, sem ir ao polo, sem custo de deslocamento', () => {
    const r = buildExamsReply('ead', null);
    expect(r).toContain('Todas as provas são feitas pela plataforma, sem precisar ir até o polo.');
    expect(r).toContain('custo de deslocamento');
  });
});
