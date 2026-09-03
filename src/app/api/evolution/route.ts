import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function normalizeEvolutionBaseUrl(url: string) {
  return url.trim().replace(/\/manager\/?$/i, '').replace(/\/+$/, '');
}

function readEvolutionConfig(config: Record<string, any>) {
  return {
    baseUrl: normalizeEvolutionBaseUrl(
      config.evolution_api_url || process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080',
    ),
    apiKey: config.evolution_api_key || process.env.EVOLUTION_API_KEY || '',
    instanceName:
      config.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME || 'cruzeiro-vendas',
  };
}

function mergeEvolutionConfig(
  config: Record<string, any>,
  overrides?: {
    evolutionUrl?: string;
    evolutionKey?: string;
    evolutionInstanceName?: string;
  },
) {
  const stored = readEvolutionConfig(config);

  return {
    baseUrl: normalizeEvolutionBaseUrl(overrides?.evolutionUrl || stored.baseUrl),
    apiKey: overrides?.evolutionKey || stored.apiKey,
    instanceName: overrides?.evolutionInstanceName || stored.instanceName,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { action, instanceName, telephones, evolutionUrl, evolutionKey, evolutionInstanceName } =
      await req.json();

    const supabase = createServerClient();
    const { data: tenant } = await supabase
      .from('tenants')
      .select('config')
      .eq('id', DEFAULT_TENANT_ID)
      .single();

    const config = tenant?.config || {};
    const evolution = mergeEvolutionConfig(config, {
      evolutionUrl,
      evolutionKey,
      evolutionInstanceName,
    });

    if (!evolution.baseUrl || !evolution.apiKey) {
      return NextResponse.json(
        { error: 'Evolution API nao configurada. Defina URL, API Key e nome da instancia.' },
        { status: 400 },
      );
    }

    const targetInstance = instanceName || evolution.instanceName;
    if (!targetInstance) {
      return NextResponse.json({ error: 'Nome da instancia nao informado.' }, { status: 400 });
    }

    if (action === 'connectionState') {
      const res = await fetch(`${evolution.baseUrl}/instance/connectionState/${targetInstance}`, {
        headers: {
          apikey: evolution.apiKey,
          apiKey: evolution.apiKey,
        },
        cache: 'no-store',
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return NextResponse.json({ error: `HTTP ${res.status}: ${err}` }, { status: res.status });
      }

      return NextResponse.json(await res.json());
    }

    if (action === 'sendText') {
      const { telefone, text } = telephones?.[0] || {};
      if (!telefone || !text) {
        return NextResponse.json({ error: 'telefone e text obrigatorios' }, { status: 400 });
      }

      const number = telefone.replace(/^\+/, '').replace(/@.*/, '');
      const res = await fetch(`${evolution.baseUrl}/message/sendText/${targetInstance}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: evolution.apiKey,
          apiKey: evolution.apiKey,
        },
        body: JSON.stringify({
          number,
          text,
          options: { delay: 1200, presence: 'composing' },
        }),
      });

      const data = await res.json().catch(() => ({}));
      return NextResponse.json({ ok: res.ok, status: res.status, data });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
