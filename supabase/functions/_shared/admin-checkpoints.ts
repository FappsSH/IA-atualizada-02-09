// Controle estruturado de checkpoints administrativos por lead.
// deno-lint-ignore-file
// @ts-nocheck

function normalizePhone(value: string | null | undefined) {
  return String(value || '').replace(/\D/g, '');
}

function comparablePhoneVariants(value: string | null | undefined) {
  const phone = normalizePhone(value);
  const variants = new Set<string>(phone ? [phone] : []);

  // A Evolution pode entregar números móveis brasileiros sem o nono dígito.
  // Para identificação do administrador, ambas as formas representam o mesmo
  // número; a conclusão continua exigindo a resposta vinculada ao checkpoint.
  if (/^55\d{2}9\d{8}$/.test(phone)) {
    variants.add(`${phone.slice(0, 4)}${phone.slice(5)}`);
  }
  if (/^55\d{10}$/.test(phone)) {
    variants.add(`${phone.slice(0, 4)}9${phone.slice(4)}`);
  }

  return variants;
}

async function readLeadSalesContext(supabase: any, leadId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select('sales_context')
    .eq('id', leadId)
    .maybeSingle();

  if (error) throw new Error(`Erro ao ler sales_context do lead: ${error.message}`);
  return { ...(data?.sales_context || {}) } as Record<string, unknown>;
}

async function mergeLeadSalesContext(supabase: any, leadId: string, patch: Record<string, unknown>) {
  const current = await readLeadSalesContext(supabase, leadId);
  const next = { ...current, ...patch };

  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) delete next[key];
  });

  const { error } = await supabase
    .from('leads')
    .update({
      sales_context: next,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId);

  if (error) throw new Error(`Erro ao atualizar sales_context do lead: ${error.message}`);
  return next;
}

function normalizeConfirmationText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProposalSentConfirmation(value: string | null | undefined) {
  const text = normalizeConfirmationText(value);
  return /\b(proposta\s+(?:foi\s+)?(?:enviada|encaminhada|mandada)|(?:enviei|encaminhei|mande[i])\s+(?:a\s+)?proposta)\b/.test(text);
}

function normalizeProposalLeadName(value: string | null | undefined) {
  return normalizeConfirmationText(value).replace(/\b(da|de|do|das|dos)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getProposalLeadFullName(supabase: any, checkpoint: any) {
  const { data, error } = await supabase
    .from('leads')
    .select('nome')
    .eq('id', checkpoint.lead_id)
    .maybeSingle();
  if (error) throw new Error(`Erro ao ler nome do lead para checkpoint: ${error.message}`);
  const leadName = String(data?.nome || '').trim();
  if (leadName) return leadName;

  return String(
    checkpoint?.metadata?.proposal_full_name
    || checkpoint?.metadata?.lead_nome
    || '',
  ).trim();
}

async function isNamedProposalConfirmation(supabase: any, checkpoint: any, text: string) {
  if (!isProposalSentConfirmation(text)) return { valid: false, leadName: '' };
  const leadName = await getProposalLeadFullName(supabase, checkpoint);
  const normalizedLeadName = normalizeProposalLeadName(leadName);
  const normalizedText = normalizeProposalLeadName(text);
  return {
    valid: normalizedLeadName.split(' ').filter(Boolean).length >= 2
      && normalizedText.includes(normalizedLeadName),
    leadName,
  };
}

export async function getPendingAdminCheckpoint(supabase: any, leadId: string) {
  const { data, error } = await supabase
    .from('lead_admin_checkpoints')
    .select('*')
    .eq('lead_id', leadId)
    .eq('status_checkpoint', 'pending')
    .order('paused_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Erro ao ler checkpoint administrativo: ${error.message}`);
  return data;
}

export async function createAdminCheckpoint(params: {
  supabase: any;
  tenantId: string;
  leadId: string;
  etapaPausada: string;
  motivoPausa: string;
  checkpointAdmin: 'proposal_send' | 'enrollment_processing';
  adminMessageId?: string | null;
  adminPhoneOrId?: string | null;
  resumeFrom?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();

  const { data: existingPending, error: existingError } = await params.supabase
    .from('lead_admin_checkpoints')
    .select('id')
    .eq('lead_id', params.leadId)
    .eq('checkpoint_admin', params.checkpointAdmin)
    .eq('status_checkpoint', 'pending')
    .maybeSingle();

  if (existingError) throw new Error(`Erro ao verificar checkpoint pendente: ${existingError.message}`);

  if (existingPending?.id) {
    return existingPending;
  }

  const { data, error } = await params.supabase
    .from('lead_admin_checkpoints')
    .insert({
      tenant_id: params.tenantId,
      lead_id: params.leadId,
      etapa_pausada: params.etapaPausada,
      fluxo_pausado: true,
      motivo_pausa: params.motivoPausa,
      checkpoint_admin: params.checkpointAdmin,
      status_checkpoint: 'pending',
      admin_message_id: params.adminMessageId ?? null,
      admin_phone_or_id: normalizePhone(params.adminPhoneOrId) || params.adminPhoneOrId || null,
      paused_at: now,
      resume_from: params.resumeFrom ?? params.etapaPausada,
      metadata: params.metadata || {},
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (error) throw new Error(`Erro ao criar checkpoint administrativo: ${error.message}`);

  const { error: leadError } = await params.supabase
    .from('leads')
    .update({
      bloqueado: true,
      handoff_em: now,
      updated_at: now,
    })
    .eq('id', params.leadId);

  if (leadError) throw new Error(`Erro ao pausar lead para checkpoint administrativo: ${leadError.message}`);
  return data;
}

export async function completeAdminCheckpointByReply(params: {
  supabase: any;
  tenantId: string;
  adminReplyToMessageId: string;
  adminPhoneOrId: string;
  text: string;
}) {
  const replyId = String(params.adminReplyToMessageId || '').trim();
  if (!replyId) return { ok: false, reason: 'missing_reply_message_id' };

  const { data: checkpoint, error: checkpointError } = await params.supabase
    .from('lead_admin_checkpoints')
    .select('*')
    .eq('tenant_id', params.tenantId)
    .eq('admin_message_id', replyId)
    .eq('status_checkpoint', 'pending')
    .maybeSingle();

  if (checkpointError) {
    throw new Error(`Erro ao localizar checkpoint por reply do admin: ${checkpointError.message}`);
  }

  if (!checkpoint?.id) {
    return { ok: false, reason: 'checkpoint_not_found' };
  }

  if (checkpoint.checkpoint_admin === 'proposal_send') {
    const confirmation = await isNamedProposalConfirmation(params.supabase, checkpoint, params.text);
    if (!confirmation.valid) {
      return { ok: false, reason: 'proposal_confirmation_name_mismatch' };
    }
  }

  const now = new Date().toISOString();
  const normalizedAdmin = normalizePhone(params.adminPhoneOrId) || params.adminPhoneOrId;

  const nextSalesContextPatch: Record<string, unknown> = checkpoint.checkpoint_admin === 'proposal_send'
    ? {
        proposal_checkpoint_completed: true,
        proposal_checkpoint_pending: false,
        e4_post_proposal_opening_pending: true,
        e4_post_proposal_opening_sent: false,
        e4_proposal_followup_scheduled: false,
      }
    : {
        enrollment_checkpoint_completed: true,
        enrollment_checkpoint_pending: false,
        payment_declared: false,
        payment_confirmed: true,
      };

  await mergeLeadSalesContext(params.supabase, checkpoint.lead_id, nextSalesContextPatch);

  const leadPatch: Record<string, unknown> = {
    bloqueado: false,
    handoff_em: null,
    updated_at: now,
  };

  if (checkpoint.checkpoint_admin === 'proposal_send') {
    leadPatch.etapa_atual = checkpoint.resume_from || checkpoint.etapa_pausada || 'E4';
  } else {
    leadPatch.etapa_atual = 'E5';
    leadPatch.matriculado = true;
    leadPatch.matricula_em = now;
  }

  const { error: leadError } = await params.supabase
    .from('leads')
    .update(leadPatch)
    .eq('id', checkpoint.lead_id);

  if (leadError) throw new Error(`Erro ao reativar lead apos checkpoint: ${leadError.message}`);

  const { data: updatedCheckpoint, error: updateError } = await params.supabase
    .from('lead_admin_checkpoints')
    .update({
      status_checkpoint: 'completed',
      fluxo_pausado: false,
      completed_at: now,
      admin_phone_or_id: normalizedAdmin,
      updated_at: now,
    })
    .eq('id', checkpoint.id)
    .select('*')
    .single();

  if (updateError) throw new Error(`Erro ao concluir checkpoint administrativo: ${updateError.message}`);

  return {
    ok: true,
    checkpoint: updatedCheckpoint,
    lead_id: checkpoint.lead_id,
    next_stage: leadPatch.etapa_atual,
    lead_name: checkpoint.checkpoint_admin === 'proposal_send'
      ? await getProposalLeadFullName(params.supabase, checkpoint)
      : '',
  };
}

export async function completeSinglePendingProposalByAdminConfirmation(params: {
  supabase: any;
  tenantId: string;
  adminPhoneOrId: string;
  text: string;
}) {
  if (!isProposalSentConfirmation(params.text)) {
    return { ok: false, reason: 'unrecognized_admin_confirmation' };
  }

  const { data: checkpoints, error } = await params.supabase
    .from('lead_admin_checkpoints')
    .select('*')
    .eq('tenant_id', params.tenantId)
    .eq('checkpoint_admin', 'proposal_send')
    .eq('status_checkpoint', 'pending')
    .order('paused_at', { ascending: true });

  if (error) throw new Error(`Erro ao localizar checkpoint pendente de proposta: ${error.message}`);
  if (!checkpoints?.length) return { ok: false, reason: 'proposal_checkpoint_not_found' };
  const matchingCheckpoints = [];
  for (const checkpoint of checkpoints) {
    const confirmation = await isNamedProposalConfirmation(params.supabase, checkpoint, params.text);
    if (confirmation.valid) matchingCheckpoints.push({ checkpoint, leadName: confirmation.leadName });
  }
  if (!matchingCheckpoints.length) return { ok: false, reason: 'proposal_confirmation_name_mismatch' };
  if (matchingCheckpoints.length !== 1) return { ok: false, reason: 'ambiguous_pending_proposal_checkpoints' };

  const { checkpoint, leadName } = matchingCheckpoints[0];
  const now = new Date().toISOString();
  const normalizedAdmin = normalizePhone(params.adminPhoneOrId) || params.adminPhoneOrId;

  await mergeLeadSalesContext(params.supabase, checkpoint.lead_id, {
    proposal_checkpoint_completed: true,
    proposal_checkpoint_pending: false,
    e4_post_proposal_opening_pending: true,
    e4_post_proposal_opening_sent: false,
    e4_proposal_followup_scheduled: false,
  });

  const nextStage = checkpoint.resume_from || checkpoint.etapa_pausada || 'E4';
  const { error: leadError } = await params.supabase
    .from('leads')
    .update({ bloqueado: false, handoff_em: null, etapa_atual: nextStage, updated_at: now })
    .eq('id', checkpoint.lead_id);
  if (leadError) throw new Error(`Erro ao reativar lead apos confirmacao administrativa: ${leadError.message}`);

  const { data: updatedCheckpoint, error: updateError } = await params.supabase
    .from('lead_admin_checkpoints')
    .update({
      status_checkpoint: 'completed',
      fluxo_pausado: false,
      completed_at: now,
      admin_phone_or_id: normalizedAdmin,
      updated_at: now,
    })
    .eq('id', checkpoint.id)
    .select('*')
    .single();
  if (updateError) throw new Error(`Erro ao concluir checkpoint por confirmacao administrativa: ${updateError.message}`);

  return { ok: true, checkpoint: updatedCheckpoint, lead_id: checkpoint.lead_id, next_stage: nextStage, lead_name: leadName };
}

export function isAuthorizedAdminPhone(candidate: string, adminPhone: string) {
  const candidateVariants = comparablePhoneVariants(candidate);
  const adminVariants = comparablePhoneVariants(adminPhone);
  return [...candidateVariants].some((phone) => adminVariants.has(phone));
}
