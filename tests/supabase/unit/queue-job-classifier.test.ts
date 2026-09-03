import { describe, expect, it } from 'vitest';
import { classifyQueueJobState, selectProcessableQueueJob } from '../../../supabase/functions/_shared/queue-job-classifier.ts';

const nowMs = new Date('2026-09-02T20:00:00.000Z').getTime();
const staleMs = 90_000;

describe('queue job classifier', () => {
  it('classifica grupo processed como already_completed e acknowledge', () => {
    const result = classifyQueueJobState({
      currentGroup: { status: 'processed', processed_at: '2026-09-02T19:59:00.000Z' },
      existingClaim: { created_at: '2026-09-02T19:59:00.000Z' },
      staleMs,
      nowMs,
    });

    expect(result.classification).toBe('already_completed');
    expect(result.processable).toBe(false);
    expect(result.acknowledge).toBe(true);
  });

  it('classifica claim fresco como actively_processing sem apagar job', () => {
    const result = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:59:30.000Z' },
      existingClaim: { created_at: '2026-09-02T19:59:30.000Z' },
      staleMs,
      nowMs,
    });

    expect(result.classification).toBe('actively_processing');
    expect(result.processable).toBe(false);
    expect(result.acknowledge).toBe(false);
  });

  it('classifica claim velho com grupo velho como stale_duplicate e acknowledge', () => {
    const result = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:55:00.000Z' },
      existingClaim: { created_at: '2026-09-02T19:55:00.000Z' },
      staleMs,
      nowMs,
    });

    expect(result.classification).toBe('stale_duplicate');
    expect(result.processable).toBe(false);
    expect(result.acknowledge).toBe(true);
  });

  it('preserva ordem quando ha processamento fresco anterior do mesmo lead', () => {
    const result = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:59:50.000Z' },
      existingClaim: null,
      hasFreshEarlierSameLead: true,
      staleMs,
      nowMs,
    });

    expect(result.classification).toBe('actively_processing_same_lead');
    expect(result.processable).toBe(false);
    expect(result.acknowledge).toBe(false);
  });

  it('classifica job sem claim como processable', () => {
    const result = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:59:50.000Z' },
      existingClaim: null,
      staleMs,
      nowMs,
    });

    expect(result.classification).toBe('processable');
    expect(result.processable).toBe(true);
    expect(result.acknowledge).toBe(false);
  });

  it('skip de job concluido nao impede processar proximo job', () => {
    const completed = classifyQueueJobState({
      currentGroup: { status: 'processed', processed_at: '2026-09-02T19:59:00.000Z' },
      existingClaim: { created_at: '2026-09-02T19:59:00.000Z' },
      staleMs,
      nowMs,
    });
    const processable = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:59:50.000Z' },
      existingClaim: null,
      staleMs,
      nowMs,
    });

    const result = selectProcessableQueueJob({
      maxScan: 2,
      jobs: [
        { msgId: 1, state: completed, leadId: 'lead-a' },
        { msgId: 2, state: processable, leadId: 'lead-a' },
      ],
    });

    expect(result.processableJobFound).toBe(true);
    expect(result.selectedMsgId).toBe(2);
    expect(result.attempts).toHaveLength(2);
  });

  it('pula duplicate e completed antes de selecionar terceiro job', () => {
    const duplicate = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:55:00.000Z' },
      existingClaim: { created_at: '2026-09-02T19:55:00.000Z' },
      staleMs,
      nowMs,
    });
    const completed = classifyQueueJobState({
      currentGroup: { status: 'processed', processed_at: '2026-09-02T19:59:00.000Z' },
      existingClaim: { created_at: '2026-09-02T19:59:00.000Z' },
      staleMs,
      nowMs,
    });
    const processable = classifyQueueJobState({
      currentGroup: { status: 'processing', updated_at: '2026-09-02T19:59:50.000Z' },
      existingClaim: null,
      staleMs,
      nowMs,
    });

    const result = selectProcessableQueueJob({
      maxScan: 3,
      jobs: [
        { msgId: 1, state: duplicate, leadId: 'lead-a' },
        { msgId: 2, state: completed, leadId: 'lead-b' },
        { msgId: 3, state: processable, leadId: 'lead-c' },
      ],
    });

    expect(result.processableJobFound).toBe(true);
    expect(result.selectedMsgId).toBe(3);
    expect(result.attempts.map((attempt) => attempt.classification)).toEqual([
      'stale_duplicate',
      'already_completed',
      'processable',
    ]);
  });
});
