import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

interface TenantRecord {
  id: string;
  config?: Record<string, unknown>;
}

interface WhatsAppInstanceRecord {
  id: string;
  tenant_id: string;
  instance_name: string;
  numero: string | null;
  status: string;
  provider: string | null;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

const RESET_TEST_TABLES = [
  'admin_runtime_logs',
  'followup_log',
  'followup_schedule',
  'lead_events',
  'lead_admin_checkpoints',
  'indicacoes',
  'mensagens',
  'leads',
] as const;

const RESET_TEST_QUEUES = [
  'messages_vendas',
  'ai_processing_vendas',
] as const;

function normalizeEvolutionBaseUrl(url: string) {
  return url.trim().replace(/\/manager\/?$/i, '').replace(/\/+$/, '');
}

function normalizePhone(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '');
}

async function loadSnapshot(supabase: ReturnType<typeof createServerClient>) {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', DEFAULT_TENANT_ID)
    .maybeSingle();

  if (tenantError) {
    throw new Error(`Erro ao carregar tenant: ${tenantError.message}`);
  }

  const { data: instances, error: instancesError } = await supabase
    .from('whatsapp_instances')
    .select('*')
    .eq('tenant_id', DEFAULT_TENANT_ID)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (instancesError) {
    throw new Error(`Erro ao carregar instancias: ${instancesError.message}`);
  }

  const typedTenant = tenant as TenantRecord | null;
  const typedInstances = (instances || []) as WhatsAppInstanceRecord[];
  const config = typedTenant?.config || {};
  const preferredInstanceName =
    (config.evolution_instance_name as string | undefined)?.trim() ||
    process.env.EVOLUTION_INSTANCE_NAME ||
    '';

  const activeWhatsapp =
    typedInstances.find((item) => item.instance_name === preferredInstanceName) ||
    typedInstances[0] ||
    null;

  return {
    tenant: typedTenant,
    whatsapp: activeWhatsapp,
    whatsappInstances: typedInstances,
  };
}

async function upsertActiveWhatsappInstance(
  supabase: ReturnType<typeof createServerClient>,
  payload: {
    preferredInstanceName: string;
    numero?: string;
    currentWhatsappId?: string | null;
  },
) {
  const preferredInstanceName = payload.preferredInstanceName.trim();
  const numero = normalizePhone(payload.numero);

  const { data: existingInstances, error: listError } = await supabase
    .from('whatsapp_instances')
    .select('*')
    .eq('tenant_id', DEFAULT_TENANT_ID)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (listError) {
    throw new Error(`Erro ao listar instancias: ${listError.message}`);
  }

  const typedExistingInstances = (existingInstances || []) as WhatsAppInstanceRecord[];
  const currentById = payload.currentWhatsappId
    ? typedExistingInstances.find((item) => item.id === payload.currentWhatsappId)
    : null;
  const currentByName =
    typedExistingInstances.find((item) => item.instance_name === preferredInstanceName) || null;
  const selected = currentByName || currentById || typedExistingInstances[0] || null;

  if (selected) {
    const { data, error } = await supabase
      .from('whatsapp_instances')
      .update({
        instance_name: preferredInstanceName,
        numero: numero || null,
        provider: 'evolution',
      })
      .eq('id', selected.id)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Erro ao atualizar instancia WhatsApp: ${error.message}`);
    }

    return data;
  }

  const { data, error } = await supabase
    .from('whatsapp_instances')
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      instance_name: preferredInstanceName,
      numero: numero || null,
      status: 'desconectado',
      provider: 'evolution',
      config: {},
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Erro ao criar instancia WhatsApp: ${error.message}`);
  }

  return data;
}

async function purgeQueue(
  supabase: ReturnType<typeof createServerClient>,
  queueName: string,
) {
  let removed = 0;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await supabase.rpc('pgmq_read', {
      queue_name: queueName,
      vt: 1,
      qty: 100,
    });

    if (error) {
      throw new Error(`Erro ao ler fila ${queueName}: ${error.message}`);
    }

    const messages = Array.isArray(data) ? data : [];
    if (messages.length === 0) {
      break;
    }

    for (const message of messages) {
      const msgId = Number(message?.msg_id);
      if (!Number.isFinite(msgId)) continue;

      const { error: deleteError } = await supabase.rpc('pgmq_delete', {
        queue_name: queueName,
        msg_id: msgId,
      });

      if (deleteError) {
        throw new Error(`Erro ao remover mensagem ${msgId} da fila ${queueName}: ${deleteError.message}`);
      }

      removed += 1;
    }
  }

  return removed;
}

export async function GET() {
  try {
    const supabase = createServerClient();
    const snapshot = await loadSnapshot(supabase);
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const section = body?.section as string | undefined;
    const payload = body?.payload || {};
    const supabase = createServerClient();

    if (section === 'evolution') {
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('config')
        .eq('id', DEFAULT_TENANT_ID)
        .single();

      if (tenantError) {
        throw new Error(`Erro ao carregar tenant: ${tenantError.message}`);
      }

      const evolution_api_url = normalizeEvolutionBaseUrl(payload.evolution_api_url || '');
      const evolution_api_key = String(payload.evolution_api_key || '').trim();
      const evolution_instance_name = String(payload.evolution_instance_name || '').trim();

      if (!evolution_api_url || !evolution_api_key || !evolution_instance_name) {
        return NextResponse.json(
          { error: 'Preencha URL, API Key e nome da instancia da Evolution.' },
          { status: 400 },
        );
      }

      const nextConfig = {
        ...(tenant?.config || {}),
        evolution_api_url,
        evolution_api_key,
        evolution_instance_name,
      };

      const { error: updateTenantError } = await supabase
        .from('tenants')
        .update({ config: nextConfig })
        .eq('id', DEFAULT_TENANT_ID);

      if (updateTenantError) {
        throw new Error(`Erro ao salvar configuracao da Evolution: ${updateTenantError.message}`);
      }

      await upsertActiveWhatsappInstance(supabase, {
        preferredInstanceName: evolution_instance_name,
        numero: payload.numero,
        currentWhatsappId: payload.current_whatsapp_id || null,
      });

      return NextResponse.json(await loadSnapshot(supabase));
    }

    if (section === 'whatsapp') {
      const instanceName = String(payload.instance_name || '').trim();
      if (!instanceName) {
        return NextResponse.json({ error: 'Informe o nome da instancia.' }, { status: 400 });
      }

      await upsertActiveWhatsappInstance(supabase, {
        preferredInstanceName: instanceName,
        numero: payload.numero,
        currentWhatsappId: payload.current_whatsapp_id || null,
      });

      return NextResponse.json(await loadSnapshot(supabase));
    }

    if (section === 'reset_test_data') {
      const queueResults: Record<string, number> = {};

      for (const queueName of RESET_TEST_QUEUES) {
        queueResults[queueName] = await purgeQueue(supabase, queueName);
      }

      for (const table of RESET_TEST_TABLES) {
        const { error } = await supabase
          .from(table)
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000');

        if (error) {
          throw new Error(`Erro ao limpar ${table}: ${error.message}`);
        }
      }

      return NextResponse.json({
        ok: true,
        cleared: RESET_TEST_TABLES,
        cleared_queues: queueResults,
      });
    }

    return NextResponse.json({ error: 'Secao invalida.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}
