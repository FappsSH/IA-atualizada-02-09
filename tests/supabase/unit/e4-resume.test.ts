import { describe, it, expect } from 'vitest';
import { buildE4ResumeMessages, E4_RESUME_QUESTIONS } from '../../../supabase/functions/ai-processor/e4-resume.ts';

describe('retomada da proposta (texto aprovado 25/11)', () => {
  it('familia + marido', () => {
    const m = buildE4ResumeMessages({ firstName: 'Maria', motivation: 'Minha família toda fez, quero fazer também', course: 'Farmácia', decisionParticipant: 'marido' });
    expect(m).toEqual([
      'Prontinho Maria!! A proposta já está com você.\n\nMontei pensando exatamente no que você me contou, de seguir esse caminho da sua família em Farmácia.',
      'E fica à vontade pra mostrar pro seu marido também. Se ele tiver qualquer dúvida, pode me mandar por aqui.',
      E4_RESUME_QUESTIONS,
    ]);
  });
  it('decide sozinha: sem a frase do decisor', () => {
    const m = buildE4ResumeMessages({ firstName: null, motivation: 'Já trabalho como auxiliar numa escola', course: 'Pedagogia', decisionParticipant: 'self' });
    expect(m.length).toBe(2);
    expect(m[0]).toContain('Prontinho!! A proposta já está com você.');
    expect(m[0]).toContain('de você já trabalhar na área e querer ir além em Pedagogia');
    expect(m[1]).toBe('Consegue me dar um retorno até o fim do dia pra gente garantir essa oportunidade? Ou já podemos garantir essa oportunidade agora?');
  });
  it('esposa e crescimento', () => {
    const m = buildE4ResumeMessages({ firstName: 'Rafael', motivation: 'Quero crescer na empresa onde trabalho', course: 'Administração', decisionParticipant: 'esposa' });
    expect(m[0]).toContain('de crescer na empresa onde você trabalha');
    expect(m[1]).toBe('E fica à vontade pra mostrar pra sua esposa também. Se ela tiver qualquer dúvida, pode me mandar por aqui.');
  });
});
