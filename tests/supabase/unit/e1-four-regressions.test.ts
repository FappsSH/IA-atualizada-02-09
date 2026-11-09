import { describe, expect, it } from 'vitest';
import { buildStageContractContext } from '../../../supabase/functions/ai-processor/subagent.ts';
import { classifyInboundAgainstStageState, getNextE1Criterion, getNextE2Criterion } from '../../../supabase/functions/ai-processor/stage-state.ts';
import { getCourseDisplayName } from '../../../supabase/functions/_shared/course-display.ts';
import { COURSE_CATALOG_ENTRIES } from '../../../scripts/course-catalog-dataset.ts';
import { detectCatalogIntentWithHistory } from '../../../supabase/functions/ai-processor/catalog-resolver.ts';
import { detectPersonalityOutputViolations } from '../../../supabase/functions/ai-processor/output-guard.ts';
import { resolveTrustedLeadName } from '../../../supabase/functions/_shared/lead-name.ts';

const courseLead = {
  curso_interesse: 'ADMINISTRACAO (BACHARELADO)',
  sales_context: { course_status: 'confirmed_available', course_display_name: 'Administração', course_validated: true, available_course_lines: ['Bacharelado'] },
};
function contract(leadSnapshot: any, pendingCriterionBefore: string | null, inboundResolution = '') {
  return buildStageContractContext({ stage: 'E1', leadSnapshot, pendingCriterionBefore,
    pendingCriterionAfter: getNextE1Criterion({ leadSnapshot }), stageMatched: !!inboundResolution,
    currentCourseInterest: leadSnapshot.curso_interesse, currentCity: leadSnapshot.cidade || '', inboundResolution });
}
describe('quatro regressões E1 do teste manual', () => {
  it('A: Helton e profissão não viram nome confiável do lead', () => {
    expect(resolveTrustedLeadName({ pushName: 'Helton Barcelos' })).toMatchObject({
      leadPersonName: null,
      leadFirstName: '',
      leadNameUsed: false,
    });
    expect(resolveTrustedLeadName({ pushName: 'Psicóloga' })).toMatchObject({
      leadPersonName: null,
      leadFirstName: '',
      leadNameUsed: false,
    });
  });
  it('B: nome pessoal confiável usa só primeiro nome', () => {
    expect(resolveTrustedLeadName({ pushName: 'João Silva' })).toMatchObject({
      leadPersonName: 'João Silva',
      leadFirstName: 'João',
      leadNameConfidence: 'trusted',
      leadNameUsed: true,
    });
  });
  it('D: a fonte importada mantém os nomes canônicos acentuados', () => {
    for (const name of ['Administração', 'Análise e Desenvolvimento de Sistemas', 'Gestão Pública', 'Ciências Biológicas']) {
      const entries = COURSE_CATALOG_ENTRIES.filter((entry) => entry.canonical_name === name);
      expect(entries.length, name).toBeGreaterThan(0);
      for (const entry of entries) expect(getCourseDisplayName(entry.display_name)).toBe(name);
    }
  });
  it('A: contrato transporta estado de curso e cidade sem voz editorial', () => {
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: courseLead, history: [], latestUserMessage: 'Quero saber sobre administração' });
    expect(resolution.statePatch).not.toHaveProperty('cidade');
    const result = contract(courseLead, 'course');
    expect(courseLead.sales_context.course_status).toBe('confirmed_available');
    expect(result.processAction).toBe('ask_city');
    expect(result.allowedIntent).toBe('ask_city');
    expect(result.speakableFacts).toMatchObject({ course_display_name: 'Administração', resolved_this_turn: 'course', moment_type: 'meaningful', e1_behavior: 'selected_course_to_city', pending_criterion_after: 'city' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('clearly_confirm_course_is_offered');
    expect(serialized).not.toContain('human_positive_reaction');
    expect(serialized).not.toContain('explicit_availability_confirmation_required');
    expect(serialized).not.toContain('allowed_behavior');
    expect(serialized).not.toContain('forbidden_behavior');
    expect(serialized).not.toContain('availability');
    expect(serialized).not.toContain('offered');
    expect(serialized).not.toContain('available');
    expect(serialized).not.toContain('course_available');
    expect(serialized).not.toContain('course_offered');
    expect(result.speakableFacts).not.toHaveProperty('course_status');
    expect(result.speakableFacts).not.toHaveProperty('modality');
    expect(result.speakableFacts).not.toHaveProperty('duration');
    expect(result.speakableFacts).not.toHaveProperty('available_course_lines');
    expect(result).not.toHaveProperty('text');
  });
  it('B: cidade resolve; reação passa a dado operacional, com pergunta de motivação', () => {
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: courseLead, history: [], latestUserMessage: 'Sou de Porto Velho' });
    expect(resolution.statePatch.e1_city_confirmed).toBe(true);
    const lead = { ...courseLead, cidade: resolution.statePatch.cidade, sales_context: { ...courseLead.sales_context, ...resolution.statePatch } };
    const result = contract(lead, 'city', resolution.classificationReason);
    expect(result.processAction).toBe('ask_motivation');
    expect(result.speakableFacts).toMatchObject({ resolved_this_turn: 'city', moment_type: 'operational', course_selection_reaction_allowed: false, pending_criterion_after: 'motivation' });
    expect(result.speakableFacts).not.toHaveProperty('reaction_target');
  });
  it('B: resposta curta de cidade apos pergunta de cidade nao vira curso nem catalogo', () => {
    const history = [{ role: 'assistant', content: 'Por gentileza, me informe em qual cidade voce mora.' }];
    const intent = detectCatalogIntentWithHistory('Buritis', history);
    expect(intent).toMatchObject({ matched: false, mode: null, query: '' });
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: courseLead, history, latestUserMessage: 'Buritis' });
    expect(resolution.classificationReason).toBe('resolved_pending_city');
    expect(resolution.statePatch).toMatchObject({ cidade: 'Buritis', e1_city_confirmed: true, pending_criterion: 'motivation' });
  });
  it('C: motivação persistida completa E1 mesmo quando pending before já é null', () => {
    const before = { ...courseLead, cidade: 'Porto Velho', sales_context: { ...courseLead.sales_context, e1_city_confirmed: true } };
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history: [], latestUserMessage: 'Eu sempre quis fazer mesmo' });
    expect(resolution.classificationReason).toBe('resolved_pending_motivation');
    const after = { ...before, sales_context: { ...before.sales_context, ...resolution.statePatch } };
    expect(getNextE1Criterion({ leadSnapshot: after })).toBeNull(); // null is the existing complete representation.
    const result = contract(after, null, resolution.classificationReason);
    expect(result).toMatchObject({ processAction: 'complete_stage', speakableFacts: { resolved_this_turn: 'motivation', moment_type: 'meaningful', motivation_principal: 'Eu sempre quis fazer mesmo' } });
    expect(result.speakableFacts).not.toHaveProperty('reaction_target');
    expect(getNextE2Criterion({ leadSnapshot: after })).toBe('vaccine_availability');
  });
  it.each(['Administração', 'Análise e Desenvolvimento de Sistemas', 'Gestão Pública', 'Ciências Biológicas', 'Saúde'])('D: mantém display canônico %s apesar da chave interna normalizada', (name) => {
    const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const lead = { curso_interesse: key, sales_context: { ...courseLead.sales_context, course_display_name: name, curso_base_nome: key } };
    expect(getCourseDisplayName(name)).toBe(name);
    expect(contract(lead, 'course').speakableFacts.course_name).toBe(name);
  });

  it('C: frase de familia resolve motivacao e contrato E1 complete so permite reacao', () => {
    const before = { ...courseLead, cidade: 'Porto Velho', sales_context: { ...courseLead.sales_context, e1_city_confirmed: true } };
    const message = 'Minha familia toda fez, quero fazer tambem';
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history: [], latestUserMessage: message });
    expect(resolution.classificationReason).toBe('resolved_pending_motivation');
    expect(resolution.statePatch).toMatchObject({ motivacao_principal: message, pending_criterion: null });
    const after = { ...before, sales_context: { ...before.sales_context, ...resolution.statePatch } };
    expect(getNextE1Criterion({ leadSnapshot: after })).toBeNull();
    const e1Contract = contract(after, 'motivation', resolution.classificationReason);
    expect(e1Contract).toMatchObject({ processAction: 'complete_stage', speakableFacts: { resolved_this_turn: 'motivation', moment_type: 'meaningful', motivation_principal: message } });
    expect(getNextE2Criterion({ leadSnapshot: after })).toBe('vaccine_availability');
  });
  it.each([
    'Vou verificar algumas informacoes importantes para te ajudar. Um momento, por favor.',
    'Vou consultar algumas informacoes e ja sigo por aqui.',
    'Aguarde um momento enquanto estou analisando.',
    'Vou buscar informacoes antes de continuar.',
  ])('G: guard reprova espera/processamento tecnico: %s', (text) => {
    const guard = detectPersonalityOutputViolations({ stage: 'E1', processAction: 'complete_stage', text });
    expect(guard.personality_guard_triggered).toBe(true);
    expect(guard.personality_violations.some((item) => item.startsWith('flow_narration:') || item === 'flow_progress_narration')).toBe(true);
  });
  it('C: E1 complete bloqueia vazamento semantico da pergunta de E2 mesmo sem interrogacao', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'complete_stage',
      text: 'Que legal saber que sempre foi seu sonho fazer Administracao!! Tambem quero saber se voce tem alguma viagem ou mudanca planejada',
    });
    expect(guard.personality_guard_triggered).toBe(true);
    expect(guard.personality_violations).toContain('next_stage_leakage:e2_vaccine_availability');
  });
  it('C: E1 complete bloqueia menção explícita à E2 como vazamento de etapa', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'complete_stage',
      text: 'Na E2, vou te ajudar com os passos necessários para avançar na sua graduação em Farmácia.',
    });
    expect(guard.personality_guard_triggered).toBe(true);
    expect(guard.personality_violations).toContain('next_stage_leakage:e2_vaccine_availability');
  });
  it('A: guard não exige verbalização de oferta quando course_status já é factual', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'ask_city',
      courseStatus: 'confirmed_available',
      text: 'Farmácia é uma escolha com bastante sentido para esse caminho.\n\nDe qual cidade você fala?',
    });
    expect(guard.personality_violations).not.toContain('missing_offer_confirmation');
    expect(guard.personality_guard_triggered).toBe(false);
  });
  it('A: guard reprova vazamento de disponibilidade interna no ask_city', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'ask_city',
      courseStatus: 'confirmed_available',
      text: 'O curso de Farmácia está disponível por aqui!\n\nMe confirma de qual cidade você é?',
    });
    expect(guard.personality_guard_triggered).toBe(true);
    expect(guard.personality_violations).toContain('internal_state_leakage:course_availability');
  });
  it.each(['Agora, só para concluir, você já trabalha na área?', 'Para seguirmos, de qual cidade você é?', 'Agora falta apenas entender sua motivação'])('G: guard reprova narração de processo: %s', (text) => {
    const guard = detectPersonalityOutputViolations({ stage: 'E1', processAction: 'ask_motivation', text });
    expect(guard.personality_guard_triggered).toBe(true);
    expect(guard.personality_violations.some((item) => item.startsWith('flow_narration:') || item === 'flow_progress_narration')).toBe(true);
  });
  it('B: guard aceita pergunta natural de motivacao', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'ask_motivation',
      text: 'Perfeito, Jose! Agora, me conta: o que te motivou a escolher Administracao? E um sonho, um objetivo pessoal ou algo relacionado a sua carreira?',
    });
    expect(guard.personality_violations).not.toContain('question_mismatch:ask_motivation');
  });
  it('B: guard pede abertura de motivacao como ponte, nao pergunta separada', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'ask_motivation',
      text: 'Agora, me conta, o que te motiva a seguir a graduacao em Educacao Fisica?\n\nVoce ja trabalha na area ou essa graduacao representa um sonho ou objetivo pessoal?',
    });
    expect(guard.personality_violations).toContain('motivation_opening_should_be_statement');
  });
  it('E2: mudanca de cidade resolve disponibilidade e pergunta decisor', () => {
    const lead = {
      ...courseLead,
      cidade: 'Jaciparana',
      etapa_atual: 'E2',
      sales_context: {
        ...courseLead.sales_context,
        pending_criterion: 'vaccine_availability',
        last_agent_question_type: 'vaccine_availability',
      },
    };
    const resolution = classifyInboundAgainstStageState({
      stage: 'E2',
      leadSnapshot: lead,
      history: [],
      latestUserMessage: 'Tenho sim, vou mudar de cidade mes que vem',
    });
    expect(resolution.classificationReason).toBe('resolved_pending_vaccine_1_travel_or_move');
    expect(resolution.statePatch).toMatchObject({
      e2_vaccine_availability_done: true,
      e2_availability_objection_kind: 'travel_or_move',
      pending_criterion: 'vaccine_decider',
    });
  });
  it('E2: resposta de marido resolve decisor mesmo se pending ficou preso', () => {
    const lead = {
      ...courseLead,
      cidade: 'Jaciparana',
      etapa_atual: 'E2',
      sales_context: {
        ...courseLead.sales_context,
        pending_criterion: 'vaccine_availability',
        last_agent_question_type: 'vaccine_decider',
      },
    };
    const resolution = classifyInboundAgainstStageState({
      stage: 'E2',
      leadSnapshot: lead,
      history: [],
      latestUserMessage: 'converso com o meu marido',
    });
    expect(resolution.classificationReason).toBe('resolved_pending_vaccine_2_from_last_question');
    expect(resolution.statePatch).toMatchObject({
      e2_vaccine_decider_done: true,
      e2_decision_participant: 'marido',
      pending_criterion: 'vaccine_agreement',
    });
  });
  it('E2: guard bloqueia repetir viagem depois de resposta de decisor', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E2',
      processAction: 'ask_vaccine_availability',
      latestUserMessage: 'converso com o meu marido',
      text: 'Agora, me diz, voce tem alguma viagem ou mudanca planejada que possa interferir no inicio do curso?',
    });
    expect(guard.personality_violations).toContain('repeated_previous_question_after_decider_answer');
  });
  it('E1: gosto pela area resolve motivacao e nao vira catalogo', () => {
    const history = [{ role: 'assistant', content: 'Me conta, voce ja trabalha nessa area ou essa graduacao representa um sonho ou objetivo pessoal pra voce?' }];
    const before = {
      ...courseLead,
      curso_interesse: 'PEDAGOGIA (LICENCIATURA)',
      cidade: 'Pimenta Bueno',
      sales_context: {
        ...courseLead.sales_context,
        course_display_name: 'Pedagogia',
        curso_base_nome: 'pedagogia',
        linha_formacao: 'Licenciatura',
        e1_city_confirmed: true,
        pending_criterion: 'motivation',
        last_agent_question_type: 'motivation',
      },
    };
    const message = 'Eu gosto muito da area da educacao';
    expect(detectCatalogIntentWithHistory(message, history)).toMatchObject({ matched: false, mode: null, query: '' });
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history, latestUserMessage: message });
    expect(resolution.classificationReason).toBe('resolved_pending_motivation');
    expect(resolution.statePatch).toMatchObject({ motivacao_principal: message, pending_criterion: null });
    const after = { ...before, sales_context: { ...before.sales_context, ...resolution.statePatch } };
    expect(getNextE1Criterion({ leadSnapshot: after })).toBeNull();
  });
  it('E1: nao trabalho fica motivacao parcial e nao completa E1', () => {
    const before = { ...courseLead, cidade: 'Pimenta Bueno', sales_context: { ...courseLead.sales_context, e1_city_confirmed: true, pending_criterion: 'motivation' } };
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history: [], latestUserMessage: 'Nao trabalho' });
    expect(resolution.classificationReason).toBe('partial_pending_motivation_work_status');
    const after = { ...before, sales_context: { ...before.sales_context, ...resolution.statePatch } };
    expect(getNextE1Criterion({ leadSnapshot: after })).toBe('motivation');
  });
  it('E1: eu ja disse durante motivacao nao vira curso', () => {
    const history = [{ role: 'assistant', content: 'Me conta, voce ja trabalha nessa area ou essa graduacao representa um sonho ou objetivo pessoal pra voce?' }];
    const before = { ...courseLead, cidade: 'Pimenta Bueno', sales_context: { ...courseLead.sales_context, e1_city_confirmed: true, pending_criterion: 'motivation', last_agent_question_type: 'motivation' } };
    expect(detectCatalogIntentWithHistory('eu ja disse', history)).toMatchObject({ matched: false, mode: null, query: '' });
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history, latestUserMessage: 'eu ja disse' });
    expect(resolution.classificationReason).toBe('motivation_already_answered_complaint');
    expect(resolution.statePatch).toMatchObject({ pending_criterion: 'motivation' });
  });
  it('E1: guard reprova preambulo processual na pergunta de motivacao', () => {
    const guard = detectPersonalityOutputViolations({
      stage: 'E1',
      processAction: 'ask_motivation',
      text: 'Agora, para entender melhor sua motivacao na Pedagogia.\n\nVoce ja trabalha nessa area ou essa graduacao representa um sonho ou objetivo pessoal pra voce?',
    });
    expect(guard.personality_violations).toContain('motivation_process_preamble');
  });
  it.each([
    'surgiu uma oportunidade',
    'apareceu uma oportunidade pra mim',
    'recebi uma proposta',
    'quero mudar de area',
    'quero fazer para concurso',
    'Cara, eu sempre sonhei em fazer porque minha família toda é da área',
  ])('C: resolve motivation por motivo suficiente: %s', (message) => {
    const before = { ...courseLead, cidade: 'Porto Velho', sales_context: { ...courseLead.sales_context, e1_city_confirmed: true } };
    const resolution = classifyInboundAgainstStageState({ stage: 'E1', leadSnapshot: before, history: [], latestUserMessage: message });
    expect(resolution.classificationReason).toBe('resolved_pending_motivation');
    expect(resolution.statePatch).toMatchObject({ motivacao_principal: message, pending_criterion: null });
    const after = { ...before, sales_context: { ...before.sales_context, ...resolution.statePatch } };
    expect(getNextE1Criterion({ leadSnapshot: after })).toBeNull();
    expect(contract(after, 'motivation', resolution.classificationReason)).toMatchObject({
      processAction: 'complete_stage',
      speakableFacts: { resolved_this_turn: 'motivation' },
    });
    expect(contract(after, 'motivation', resolution.classificationReason).speakableFacts).not.toHaveProperty('reaction_target');
    expect(getNextE2Criterion({ leadSnapshot: after })).toBe('vaccine_availability');
  });
});
