// Runtime configuration loader for Edge Functions.
// The tenant config from Supabase is the source of truth, with env vars as fallback.
// deno-lint-ignore-file
// @ts-nocheck
import { DEFAULT_MESSAGE_POLICY, normalizeMessagePolicy, type MessagePolicy } from './message-governance.ts';

export interface TenantRuntimeConfig {
  tenantId: string;
  businessHours: { start?: string; end?: string; tz?: string };
  evolution: {
    baseUrl: string;
    apiKey: string;
    instanceName: string;
  };
  model: {
    subagent: string;
  };
  temperature: number;
  maxIterations: number;
  openaiApiKey: string;
  openaiVectorStoreId: string;
  adminPhone: string;
  messagePolicy: MessagePolicy;
  rawConfig: Record<string, unknown>;
  env: Record<string, string>;
}

const DEFAULT_TIME_ZONE = 'America/Porto_Velho';

function normalizeEvolutionBaseUrl(url: string) {
  return url.replace(/\/manager\/?$/i, '').replace(/\/+$/, '');
}

export function resolveEdgeReachableUrl(url: string) {
  const normalized = normalizeEvolutionBaseUrl(url);

  return normalized
    .replace('http://localhost:', 'http://host.docker.internal:')
    .replace('https://localhost:', 'https://host.docker.internal:')
    .replace('http://127.0.0.1:', 'http://host.docker.internal:')
    .replace('https://127.0.0.1:', 'https://host.docker.internal:');
}

export async function loadTenantRuntimeConfig(
  supabase: any,
  tenantId: string,
  baseEnv: Record<string, string> = Deno.env.toObject(),
): Promise<TenantRuntimeConfig> {
  const { data: tenant } = await supabase
    .from('tenants')
    .select('config')
    .eq('id', tenantId)
    .maybeSingle();

  const config = tenant?.config ?? {};

  const openaiApiKey = config.openai_api_key || baseEnv.OPENAI_API_KEY || '';
  const openaiVectorStoreId = config.openai_vector_store_id || baseEnv.OPENAI_VECTOR_STORE_ID || '';
  const evolutionBaseUrl = resolveEdgeReachableUrl(config.evolution_api_url || baseEnv.EVOLUTION_API_URL || '');
  const evolutionApiKey = config.evolution_api_key || baseEnv.EVOLUTION_API_KEY || '';
  const evolutionInstanceName =
    config.evolution_instance_name ||
    baseEnv.EVOLUTION_INSTANCE_NAME ||
    'cruzeiro-vendas';
  const subagentModel =
    config.modelo_ia ||
    baseEnv.OPENAI_MODEL_SUBAGENT ||
    'gpt-4.1';
  const temperature = Number(config.temperatura ?? baseEnv.OPENAI_TEMPERATURE ?? 0.8);
  const maxIterations = Number(config.max_iteracoes_subagente ?? baseEnv.OPENAI_MAX_ITERATIONS_SUBAGENT ?? 10);
  const adminPhone = config.telefone_admin || baseEnv.ADMIN_PHONE || '';
  const businessHours = {
    ...(config.business_hours || {}),
    tz: config.business_hours?.tz || baseEnv.BUSINESS_HOURS_TZ || DEFAULT_TIME_ZONE,
  };
  const messagePolicy = normalizeMessagePolicy(config.message_policy || DEFAULT_MESSAGE_POLICY);

  return {
    tenantId,
    businessHours,
    evolution: {
      baseUrl: evolutionBaseUrl,
      apiKey: evolutionApiKey,
      instanceName: evolutionInstanceName,
    },
    model: {
      subagent: subagentModel,
    },
    temperature,
    maxIterations,
    openaiApiKey,
    openaiVectorStoreId,
    adminPhone,
    messagePolicy,
    rawConfig: config,
    env: {
      ...baseEnv,
      OPENAI_API_KEY: openaiApiKey,
      OPENAI_VECTOR_STORE_ID: openaiVectorStoreId,
      OPENAI_MODEL_SUBAGENT: subagentModel,
      OPENAI_TEMPERATURE: String(temperature),
      OPENAI_MAX_ITERATIONS_SUBAGENT: String(maxIterations),
      EVOLUTION_API_URL: evolutionBaseUrl,
      EVOLUTION_API_KEY: evolutionApiKey,
      EVOLUTION_INSTANCE_NAME: evolutionInstanceName,
      ADMIN_PHONE: adminPhone,
      BUSINESS_HOURS_TZ: businessHours.tz || DEFAULT_TIME_ZONE,
    },
  };
}
