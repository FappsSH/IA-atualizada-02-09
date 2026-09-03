import { describe, expect, it } from 'vitest';
import { buildE3PresentationMessages, formatDurationYearsFromSemesters } from '../../../supabase/functions/ai-processor/e3-presentation.ts';

describe('E3 structural presentation', () => {
  it('deriva duracao em anos sem arredondar livremente', () => {
    expect(formatDurationYearsFromSemesters(8)).toBe('4 anos');
    expect(formatDurationYearsFromSemesters(6)).toBe('3 anos');
    expect(formatDurationYearsFromSemesters(4)).toBe('2 anos');
    expect(formatDurationYearsFromSemesters(5)).toBe('2 anos e meio');
  });

  it('gera 3 blocos na ordem instituicao curso fechamento', () => {
    const result = buildE3PresentationMessages({
      leadSnapshot: {
        lead_first_name: 'Jessica',
        lead_name_confidence: 'trusted',
        curso_interesse: 'CST em Radiologia',
        modalidade: 'ead',
        sales_context: {
          course_display_name: 'CST em Radiologia',
          duration_semesters: 6,
        },
      },
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toContain('Universidade Cruzeiro do Sul');
    expect(result.messages[1]).toContain('Radiologia');
    expect(result.messages[1]).toContain('6 semestres');
    expect(result.messages[1]).toContain('3 anos');
    expect(result.messages[1]).toContain('EAD');
    expect(result.messages[2]).toContain('Jessica');
  });

  it('nao verbaliza claims institucionais fortes sem autorizacao', () => {
    const result = buildE3PresentationMessages({
      leadSnapshot: {
        curso_interesse: 'Administracao',
        sales_context: {},
      },
    });

    expect(result.messages.join('\n')).not.toContain('60 anos');
    expect(result.messages.join('\n')).not.toContain('nota maxima');
    expect(result.messages.join('\n')).not.toContain('melhores do Brasil');
    expect(result.pendingClaims).toContain('market_years');
    expect(result.pendingClaims).toContain('tutor_awards_best_brazil');
  });
});
