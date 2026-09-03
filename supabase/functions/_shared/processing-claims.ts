// Atomic persistent claims for debounce, outbound generation, read receipts.
// deno-lint-ignore-file
// @ts-nocheck

export async function claimWorkerLock(params: {
  supabase: any;
  lockName: string;
  holderId: string;
  ttlSeconds?: number;
}) {
  const { data, error } = await params.supabase.rpc('claim_worker_lock', {
    p_lock_name: params.lockName,
    p_holder_id: params.holderId,
    p_ttl_seconds: params.ttlSeconds ?? 20,
  });
  if (error) throw error;
  return data === true;
}

export async function releaseWorkerLock(params: {
  supabase: any;
  lockName: string;
  holderId: string;
}) {
  try {
    await params.supabase.rpc('release_worker_lock', {
      p_lock_name: params.lockName,
      p_holder_id: params.holderId,
    });
  } catch {
    return null;
  }
}

export async function claimOutboundGeneration(params: {
  supabase: any;
  generationKey: string;
  tenantId: string;
  leadId: string;
  debounceGroupId?: string | null;
  processingJobId?: string | null;
}) {
  const { data, error } = await params.supabase.rpc('claim_outbound_generation', {
    p_generation_key: params.generationKey,
    p_tenant_id: params.tenantId,
    p_lead_id: params.leadId,
    p_debounce_group_id: params.debounceGroupId || null,
    p_processing_job_id: params.processingJobId || null,
  });
  if (error) throw error;
  return data === true;
}

export async function claimReadReceipt(params: {
  supabase: any;
  tenantId: string;
  leadId: string;
  inboundMessageId: string;
  remoteJid?: string | null;
}) {
  const { data, error } = await params.supabase.rpc('claim_read_receipt', {
    p_tenant_id: params.tenantId,
    p_lead_id: params.leadId,
    p_inbound_message_id: params.inboundMessageId,
    p_remote_jid: params.remoteJid || null,
  });
  if (error) throw error;
  return data === true;
}

export async function completeReadReceipt(params: {
  supabase: any;
  inboundMessageId: string;
  success: boolean;
  routeUsed?: string | null;
  errorMessage?: string | null;
}) {
  const { error } = await params.supabase
    .from('read_receipt_claims')
    .update({
      status: params.success ? 'success' : 'failed',
      route_used: params.routeUsed || null,
      error_message: params.errorMessage || null,
      updated_at: new Date().toISOString(),
    })
    .eq('inbound_message_id', params.inboundMessageId);
  if (error) throw error;
}
