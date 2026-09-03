import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseFunctionsUrl = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || '';
const placeholderUrl = 'https://placeholder.supabase.co';
const placeholderKey = 'placeholder-key';

let browserClient: any = null;
let cachedUrl = '';

function getMissingConfigMessage() {
  return 'Supabase nao configurado. Preencha NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no arquivo .env.local.';
}

function isBrowserSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function isServerSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey && serviceRoleKey);
}

function isRealtimeEnabled() {
  return Boolean(supabaseUrl && supabaseAnonKey && !supabaseAnonKey.includes('your-anon-key'));
}

function isFunctionsConfigured() {
  return Boolean(
    supabaseFunctionsUrl &&
    supabaseAnonKey &&
    !supabaseFunctionsUrl.includes('your-') &&
    !supabaseAnonKey.includes('your-anon-key'),
  );
}

function createPlaceholderClient() {
  return createClient(placeholderUrl, placeholderKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

export function createBrowserClient(): any {
  if (browserClient && cachedUrl === supabaseUrl && supabaseUrl) {
    return browserClient;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    if (!browserClient) {
      browserClient = createPlaceholderClient();
    }
    return browserClient;
  }

  cachedUrl = supabaseUrl;
  browserClient = createClient(supabaseUrl, supabaseAnonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return browserClient;
}

export function createServerClient(): any {
  if (!isServerSupabaseConfigured()) {
    throw new Error(getMissingConfigMessage());
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    global: {
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        return fetch(url, { ...init, cache: 'no-store' } as RequestInit & { cache: RequestCache });
      },
    },
  });
}

export function getSupabaseConfigStatus() {
  return {
    configured: isBrowserSupabaseConfigured(),
    realtimeEnabled: isRealtimeEnabled(),
    functionsConfigured: isFunctionsConfigured(),
    missingConfigMessage: getMissingConfigMessage(),
    functionsUrl: supabaseFunctionsUrl,
    anonKey: supabaseAnonKey,
  };
}

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export async function serverQuery<T = any>(table: string, opts?: {
  columns?: string;
  match?: Record<string, any>;
  order?: { column: string; ascending?: boolean };
  range?: [number, number];
  limit?: number;
}): Promise<{ data: T[] | null; error: string | null; count: number | null }> {
  if (!isBrowserSupabaseConfigured()) {
    return { data: null, error: getMissingConfigMessage(), count: null };
  }

  const res = await fetch('/api/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, method: 'select', ...opts }),
  });
  const json = await res.json();
  return { data: json.data as T[], error: json.error || null, count: json.count ?? null };
}

export async function serverCount(table: string, match?: Record<string, any>): Promise<{ count: number | null; error: string | null }> {
  if (!isBrowserSupabaseConfigured()) {
    return { count: null, error: getMissingConfigMessage() };
  }

  const res = await fetch('/api/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, method: 'count', match }),
  });
  const json = await res.json();
  return { count: json.count ?? null, error: json.error || null };
}

export async function serverInsert<T = any>(table: string, body: any): Promise<{ data: T | null; error: string | null }> {
  if (!isBrowserSupabaseConfigured()) {
    return { data: null, error: getMissingConfigMessage() };
  }

  const res = await fetch('/api/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, method: 'insert', body }),
  });
  const json = await res.json();
  return { data: (json.data?.[0] || null) as T | null, error: json.error || null };
}

export async function serverUpdate(table: string, body: any, match: Record<string, any>): Promise<{ error: string | null }> {
  if (!isBrowserSupabaseConfigured()) {
    return { error: getMissingConfigMessage() };
  }

  const res = await fetch('/api/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, method: 'update', body, match }),
  });
  const json = await res.json();
  return { error: json.error || null };
}
