import { describe, expect, it } from 'vitest';
import { detectPersonalityOutputViolations } from '../../../supabase/functions/ai-processor/output-guard.ts';

// As falas canônicas da especificação nunca podem ser reprovadas pelo guard.
const run = (params: Record<string, unknown>) => detectPersonalityOutputViolations({ courseStatus: 'confirmed_available', ...params } as any);

describe('guard aceita as falas canonicas da especificacao', () => {
  it('E1 escolha do curso', () => {
    const r = run({
      stage: 'E1',
      processAction: 'ask_city',
      latestUserMessage: 'Quero saber sobre Farmácia',
      text: 'Que escolha de graduação excelente!! Tenho certeza que você terá muitas oportunidades nessa área.\n\nMe confirma de qual cidade você é, por gentileza.',
    });
    expect(r.personality_violations).toEqual([]);
  });

  it('E1 cidade -> motivacao', () => {
    const r = run({
      stage: 'E1',
      processAction: 'ask_motivation',
      latestUserMessage: 'Sou de Porto Velho',
      text: 'Perfeito!!\n\nMe conta, você já trabalha nessa área ou essa graduação representa um sonho ou objetivo pessoal pra você?',
    });
    expect(r.personality_violations).toEqual([]);
  });

  it.each([
    ['Sempre foi meu sonho', 'Olha só, que bacana!! Então é algo que você já queria há bastante tempo.'],
    ['Minha família toda fez, quero fazer também', 'Olha só, então isso já vem de família!! Muito legal você querer seguir esse caminho também.'],
    ['Surgiu uma oportunidade', 'Olha só, então essa graduação apareceu em uma ótima hora pra você!!'],
    ['Já trabalho na área', 'Muito bom!! Então você já conhece um pouco desse universo na prática.'],
  ])('E1 reacao a motivacao: %s', (inbound, text) => {
    const r = run({ stage: 'E1', processAction: 'complete_stage', latestUserMessage: inbound, text });
    expect(r.personality_violations).toEqual([]);
  });

  it('E2 mudanca EAD seguida da pergunta do decisor', () => {
    const r = run({
      stage: 'E2',
      processAction: 'ask_vaccine_decider',
      pendingCriterion: 'vaccine_decider',
      latestUserMessage: 'Vou me mudar para Cuiabá em março',
      text: 'Perfeito!! Mesmo com essa mudança, você consegue continuar estudando normalmente porque seu curso é EAD.\n\nVocê pode assistir às aulas no dia e horário que melhor se encaixar na sua rotina, respeitando as datas e os compromissos acadêmicos, e os tutores também ajudam com esse acompanhamento.\n\nE na hora de tomar essa decisão, você costuma decidir sozinho ou tem alguém que participa com você?',
    });
    expect(r.personality_violations).toEqual([]);
  });

  it('E2 sem viagem nao pode repetir o tema', () => {
    const r = run({
      stage: 'E2',
      processAction: 'ask_vaccine_decider',
      latestUserMessage: 'Não tenho viagem nem mudança',
      text: 'Que bom que não tem viagem planejada!! E na hora de tomar essa decisão, você costuma decidir sozinho ou tem alguém que participa com você?',
    });
    expect(r.personality_guard_triggered).toBe(true);
  });

  it('E6 convite canonico nao e narracao de processo', () => {
    const r = run({
      stage: 'E6',
      processAction: 'follow_stage_contract',
      text: 'Antes de encerrarmos, quero te fazer um último convite.\n\nTem alguém próximo de você que também esteja pensando em começar uma graduação e que você gostaria de indicar?',
    });
    expect(r.flow_narration_detected).toBe(false);
  });
});

import { classifyInboundAgainstStageState as classifyStageMessage } from '../../../supabase/functions/ai-processor/stage-state.ts';
describe('area exata vira selecao de area', () => {
  it('"Tecnologia" com pendencia de curso seleciona a area', () => {
    const r: any = (classifyStageMessage as any)({
      stage: 'E1',
      latestUserMessage: 'Tecnologia',
      leadSnapshot: { sales_context: { pending_criterion: 'course_selection', related_area_courses: ['Gestão da Tecnologia da Informação'] } },
      history: [],
      pendingCriterion: 'course_selection',
    });
    expect(r.classificationReason).toBe('selected_catalog_area');
  });
});

describe('E3 nao repete a imagem da instituicao', () => {
  it('bloqueia diploma/tutores premiados nos textos da apresentacao', () => {
    const r = detectPersonalityOutputViolations({
      stage: 'E3',
      processAction: 'present_e3_structured_blocks',
      courseStatus: 'confirmed_available',
      text: 'Poder seguir os passos deles é maravilhoso, e com um diploma reconhecido internacionalmente você vai longe.\n---\nVocê terá todo o suporte de tutores premiados.',
    } as any);
    expect(r.personality_violations).toContain('e3_repeats_institution_image');
  });
});
