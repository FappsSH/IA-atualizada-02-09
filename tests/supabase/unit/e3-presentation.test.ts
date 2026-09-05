import { describe, expect, it } from 'vitest';
import { buildE3PresentationMessages, formatDurationYearsFromSemesters } from '../../../supabase/functions/ai-processor/e3-presentation.ts';

const adminFacts = [
  { claim_key: 'institution_is_university', category: 'institution', content: 'A Universidade Cruzeiro do Sul é uma Universidade.' },
  { claim_key: 'institution_diploma_international_recognition', category: 'institution', content: 'Por sermos uma Universidade, o diploma possui reconhecimento também fora do Brasil.' },
  { claim_key: 'institution_university_advantage_vs_college', category: 'institution', content: 'Esse reconhecimento internacional do diploma é um diferencial que Faculdade ou Centro Universitário não oferece da mesma forma.' },
  { claim_key: 'institution_60_plus_years', category: 'institution', content: 'A instituição possui mais de 60 anos de mercado educacional.' },
  { claim_key: 'institution_maximum_mec_rating', category: 'institution', content: 'A instituição possui nota máxima no MEC.' },
  { claim_key: 'institution_maximum_mec_since_beginning', category: 'institution', content: 'A instituição é nota máxima no MEC desde quando começou.' },
  { claim_key: 'tutoring_full_journey_support', category: 'tutoring', content: 'O aluno conta com tutores durante toda a jornada da graduação, do começo ao fim.' },
  { claim_key: 'tutoring_deadline_reminders', category: 'tutoring', content: 'Os tutores ajudam o aluno a se manter atento às datas e prazos e fazem lembretes relacionados a esses compromissos acadêmicos.' },
  { claim_key: 'tutoring_awarded', category: 'tutoring', content: 'O time de tutores já foi premiado várias vezes em nível nacional.' },
  { claim_key: 'tutoring_best_in_brazil', category: 'tutoring', content: 'A comunicação comercial pode apresentar o time de tutores como um dos melhores do Brasil, sem afirmar ranking técnico ou número 1.' },
  { claim_key: 'ead_flexible_study_schedule', category: 'course_methodology', content: 'Na modalidade EAD, o aluno pode assistir às aulas no dia e horário que melhor se encaixar em sua rotina, respeitando as datas e os compromissos acadêmicos da graduação.' },
];

describe('E3 structural presentation', () => {
  it('deriva duracao em anos sem arredondar livremente', () => {
    expect(formatDurationYearsFromSemesters(8)).toBe('4 anos');
    expect(formatDurationYearsFromSemesters(6)).toBe('3 anos');
    expect(formatDurationYearsFromSemesters(4)).toBe('2 anos');
    expect(formatDurationYearsFromSemesters(5)).toBe('2 anos e meio');
  });

  it('gera 3 blocos na ordem instituicao curso fechamento', () => {
    const result = buildE3PresentationMessages({
      authorizedFacts: adminFacts,
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
    expect(result.messages[0]).toContain('Cruzeiro do Sul');
    expect(result.messages[1]).toContain('Radiologia');
    expect(result.messages[1]).toContain('6 semestres');
    expect(result.messages[1]).toContain('3 anos');
    expect(result.messages[1]).toContain('EAD');
    expect(result.messages[2]).toContain('Jessica');
    expect(result.messages.join('\n')).toContain('mais de 60 anos');
    expect(result.messages.join('\n')).toContain('nota máxima no MEC');
    expect(result.messages.join('\n')).toContain('reconhecimento também fora do Brasil');
    expect(result.messages.join('\n')).toContain('nota máxima no MEC desde quando começou');
    expect(result.messages.join('\n')).toContain('melhores do Brasil');
  });

  it('nao verbaliza claims administrativos sem fonte ativa recebida', () => {
    const result = buildE3PresentationMessages({
      leadSnapshot: {
        curso_interesse: 'Administracao',
        sales_context: {},
      },
    });

    expect(result.messages.join('\n')).not.toContain('faculdade isolada');
    expect(result.messages.join('\n')).not.toContain('melhores do Brasil');
    expect(result.pendingClaims).toContain('institution_is_university');
    expect(result.pendingClaims).toContain('tutoring_deadline_reminders');
  });
});
