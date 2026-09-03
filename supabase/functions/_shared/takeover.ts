// Controle central de pausa para envio quando o lead saiu do fluxo automatico.
// "takeover" aqui cobre tanto bloqueio manual quanto handoff humano.
import { getPendingAdminCheckpoint } from './admin-checkpoints.ts';

type SupabaseLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: any; error: { message: string } | null }>;
      };
    };
  };
};

export interface TakeoverStatus {
  paused: boolean;
  reason: string | null;
  until: string | null;
}

export async function checkTakeover(
  supabase: SupabaseLike,
  leadId: string,
): Promise<TakeoverStatus> {
  const pendingCheckpoint = await getPendingAdminCheckpoint(supabase, leadId).catch(() => null);
  if (pendingCheckpoint?.id) {
    return {
      paused: true,
      reason: `admin_checkpoint:${pendingCheckpoint.checkpoint_admin}`,
      until: pendingCheckpoint.paused_at ?? null,
    };
  }

  const { data, error } = await supabase
    .from('leads')
    .select('bloqueado, etapa_atual, handoff_em')
    .eq('id', leadId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao validar takeover: ${error.message}`);
  }

  if (!data) {
    return { paused: false, reason: null, until: null };
  }

  if (data.bloqueado) {
    return {
      paused: true,
      reason: data.etapa_atual === 'handoff' ? 'handoff' : 'bloqueado',
      until: data.handoff_em ?? null,
    };
  }

  if (data.etapa_atual === 'handoff') {
    return {
      paused: true,
      reason: 'handoff',
      until: data.handoff_em ?? null,
    };
  }

  return { paused: false, reason: null, until: null };
}
