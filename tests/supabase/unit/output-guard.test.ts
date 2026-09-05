import { describe, expect, it } from 'vitest';
import { detectPersonalityOutputViolations } from '../../../supabase/functions/ai-processor/output-guard.ts';

describe('personality output guard', () => {
  it('detecta narracao de fluxo global', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E2',
      text: 'Para seguirmos com o processo, preciso te perguntar uma coisa.',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.flow_narration_detected).toBe(true);
    expect(result.personality_violations).toContain('flow_narration:para seguirmos');
  });

  it('detecta narracao semantica de progresso do fluxo', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Administracao Publica esta disponivel por aqui.\n\nIsso nos ajuda a avancar no processo. De qual cidade voce e?',
      processAction: 'ask_city',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('flow_progress_narration');
  });

  it('detecta repeticao desnecessaria da cidade', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Otimo saber que voce e de Vilhena!\n\nAgora, me conta...',
      latestUserMessage: 'Vilhena',
      contextualReplyKind: 'city',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.repeated_fact_detected).toBe(true);
    expect(result.personality_violations).toContain('redundant_city_restatement');
  });

  it('detecta repeticao de cidade mesmo quando proxima acao ja e motivacao', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Que legal que voce e de Vilhena! Me conta, voce ja trabalha nessa area?',
      latestUserMessage: 'Sou de Vilhena',
      savedCity: 'Vilhena',
      processAction: 'ask_motivation',
      pendingCriterion: 'motivation',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('redundant_city_restatement');
  });

  it('detecta repeticao da vacina 2 quando a acao ja e vacina 3', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E2',
      text: 'Voce decide por voce mesmo ou costuma conversar com alguem antes?\n\nCombinado?',
      processAction: 'ask_vaccine_agreement',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('repeated_resolved_criterion:vaccine_decider');
  });

  it('detecta mencao desnecessaria de linha unica na E1', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Administracao Publica esta disponivel por aqui no formato de Bacharelado.',
      courseStatus: 'confirmed_available',
      availableCourseLines: ['Bacharelado'],
      pendingCriterion: 'city',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('unnecessary_single_line_mention:bacharelado');
  });

  it('detecta area inferida em segment_unavailable', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Posso te mostrar alternativas proximas na area de ciencias exatas.',
      courseStatus: 'segment_unavailable',
      requestedArea: null,
      relatedAreaCourses: [],
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.ungrounded_output_detected).toBe(true);
    expect(result.personality_violations).toContain('ungrounded_output:segment_unavailable_inferred_area');
  });

  it('detecta ciencias exatas como area inferida em segment_unavailable', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Posso ajudar a encontrar outras alternativas dentro da area de fisica ou ciencias exatas.',
      courseStatus: 'segment_unavailable',
      requestedArea: null,
      relatedAreaCourses: [],
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('ungrounded_output:segment_unavailable_inferred_area');
  });

  it('detecta pergunta divergente do process_action esperado', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Otima escolha!\n\nAgora, me conta, voce ja trabalha nessa area ou isso e um sonho?',
      processAction: 'ask_city',
      courseStatus: 'confirmed_available',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('question_mismatch:ask_city');
  });

  it('valida alternativas de segmento com process_action proprio', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Temos algumas opcoes nessa mesma area.\n\nQual dessas opcoes faz mais sentido para voce?',
      processAction: 'present_segment_options_and_wait_selection',
      courseStatus: 'segment_options_available',
      requestedArea: 'Saude e Beleza',
      relatedAreaCourses: ['BIOMEDICINA (BACHARELADO)'],
    });

    expect(result.personality_guard_triggered).toBe(false);
    expect(result.final_personality_valid).toBe(true);
  });

  it('reprova tom de beco sem saida em curso indisponivel', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Infelizmente, a graduacao em Psicoterapia nao esta entre as opcoes. Mas estou aqui para ajudar, por favor me fale outro curso.',
      processAction: 'ask_for_new_direction',
      courseStatus: 'segment_unavailable',
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations.some((item) => item.startsWith('unavailable_dead_end_tone:'))).toBe(true);
  });

  it('reprova curso relacionado inventado quando nao ha segmento confiavel', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Nao temos Astrofisica Quantica, ficarei feliz em ajudar com cursos relacionados.',
      processAction: 'ask_for_new_direction',
      courseStatus: 'segment_unavailable',
      requestedArea: null,
      relatedAreaCourses: [],
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('ungrounded_output:segment_unavailable_inferred_area');
    expect(result.personality_violations.some((item) => item.startsWith('unavailable_dead_end_tone:'))).toBe(true);
  });

  it('nao trata Sistemas em nome de curso como narracao de sistema', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E1',
      text: 'Boa escolha!!\n\n*Tecnologia*\n\n- Analise e Desenvolvimento de Sistemas\n\nQual desses cursos mais combina com o que voce esta buscando?',
      processAction: 'present_area_courses_and_wait_selection',
      courseStatus: 'catalog_area_selected',
      requestedArea: 'Tecnologia',
      relatedAreaCourses: ['Analise e Desenvolvimento de Sistemas'],
    });

    expect(result.personality_violations).not.toContain('system_narration:sistema');
    expect(result.personality_guard_triggered).toBe(false);
  });

  it('bloqueia claim E3 quando a claim_key nao veio autorizada', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E3',
      text: 'Somos nota máxima no MEC desde quando começamos.',
      processAction: 'present_e3_structured_blocks',
      e3AuthorizedClaimKeys: [],
    });

    expect(result.personality_guard_triggered).toBe(true);
    expect(result.personality_violations).toContain('unauthorized_stage_fact:desde quando comecamos');
  });

  it('libera claim E3 quando a claim_key veio autorizada pelo banco', () => {
    const result = detectPersonalityOutputViolations({
      stage: 'E3',
      text: 'Somos nota máxima no MEC desde quando começamos.',
      processAction: 'present_e3_structured_blocks',
      e3AuthorizedClaimKeys: ['institution_maximum_mec_since_beginning'],
    });

    expect(result.personality_guard_triggered).toBe(false);
  });
});
