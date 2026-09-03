import { describe, expect, it } from 'vitest';
import {
  detectAmbiguousCourseLineViolations,
  detectSegmentUnavailableViolations,
} from '../../../supabase/functions/ai-processor/early-stage-guard.ts';

describe('early stage contract guards', () => {
  it('detecta linha inventada fora do conjunto fechado permitido', () => {
    const violations = detectAmbiguousCourseLineViolations(
      'Ciencias Biologicas\n\n- Bacharelado\n- Licenciatura\n\nQual linha voce prefere seguir?',
      ['Bacharelado'],
    );

    expect(violations).toContain('invalid_course_line:licenciatura');
  });

  it('detecta placeholders proibidos em curso ambiguo', () => {
    const violations = detectAmbiguousCourseLineViolations(
      'Temos Bacharelado e outras opcoes parecidas.\n\nQual linha voce pretende seguir?',
      ['Bacharelado', 'Licenciatura'],
    );

    expect(violations).toContain('placeholder_line:outras opcoes');
  });

  it('detecta referencia falsa de mesma area sem area confiavel', () => {
    const violations = detectSegmentUnavailableViolations(
      'Esse curso nao esta disponivel. Posso te mostrar opcoes parecidas nessa area?',
      null,
      [],
    );

    expect(violations).toContain('invalid_segment_reference:opcoes parecidas nessa area');
  });

  it('nao acusa violacao quando ha area confiavel e alternativas reais', () => {
    const violations = detectSegmentUnavailableViolations(
      'Nessa area temos outras opcoes que podem fazer sentido.',
      'Saude e Beleza',
      ['Biomedicina'],
    );

    expect(violations).toEqual([]);
  });
});
