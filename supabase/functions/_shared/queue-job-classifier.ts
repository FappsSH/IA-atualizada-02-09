// Queue job lifecycle classifier shared by Edge runtime and tests.
// deno-lint-ignore-file
// @ts-nocheck

function timeValue(value: string | null | undefined) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isQueueTimestampStale(value: string | null | undefined, staleMs: number, nowMs = Date.now()) {
  const time = timeValue(value);
  return !time || nowMs - time > staleMs;
}

export function classifyQueueJobState(params: {
  currentGroup?: Record<string, unknown> | null;
  existingClaim?: Record<string, unknown> | null;
  hasFreshEarlierSameLead?: boolean;
  staleMs: number;
  nowMs?: number;
}) {
  const nowMs = params.nowMs ?? Date.now();
  const currentGroup = params.currentGroup || null;
  const existingClaim = params.existingClaim || null;

  if (params.hasFreshEarlierSameLead === true) {
    return {
      classification: 'actively_processing_same_lead',
      skipReason: 'earlier_same_lead_processing',
      claimStatus: existingClaim ? 'claimed' : 'unclaimed',
      processingStatus: String(currentGroup?.status || '') || null,
      processable: false,
      acknowledge: false,
    };
  }

  if (currentGroup?.status === 'processed' || currentGroup?.processed_at) {
    return {
      classification: 'already_completed',
      skipReason: 'debounce_group_processed',
      claimStatus: existingClaim ? 'claimed' : 'unclaimed',
      processingStatus: String(currentGroup.status || '') || null,
      processable: false,
      acknowledge: true,
    };
  }

  if (existingClaim) {
    const claimStale = isQueueTimestampStale(String(existingClaim.created_at || ''), params.staleMs, nowMs);
    const groupStale = isQueueTimestampStale(String(currentGroup?.updated_at || ''), params.staleMs, nowMs);
    const stale = claimStale && groupStale;
    return {
      classification: stale ? 'stale_duplicate' : 'actively_processing',
      skipReason: stale ? 'claimed_stale' : 'claimed_active',
      claimStatus: 'claimed',
      processingStatus: String(currentGroup?.status || '') || null,
      processable: false,
      acknowledge: stale,
    };
  }

  return {
    classification: 'processable',
    skipReason: null,
    claimStatus: 'unclaimed',
    processingStatus: String(currentGroup?.status || '') || null,
    processable: true,
    acknowledge: false,
  };
}

export function selectProcessableQueueJob(params: {
  jobs: Array<{
    msgId: number;
    state: ReturnType<typeof classifyQueueJobState>;
    leadId?: string | null;
  }>;
  maxScan: number;
}) {
  const attempts: Array<Record<string, unknown>> = [];
  const limit = Math.max(0, params.maxScan || 0);

  for (const job of params.jobs.slice(0, limit)) {
    attempts.push({
      msgId: job.msgId,
      leadId: job.leadId || null,
      classification: job.state.classification,
      skipped: job.state.processable !== true,
      acknowledged: job.state.acknowledge === true,
    });

    if (job.state.processable === true) {
      return {
        selectedMsgId: job.msgId,
        processableJobFound: true,
        attempts,
      };
    }
  }

  return {
    selectedMsgId: null,
    processableJobFound: false,
    attempts,
  };
}
