// Factory padronizado para client Supabase em Edge Functions.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function createServiceClient(env: Record<string, string> = Deno.env.toObject()) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL/SERVICE_ROLE_KEY ausentes');
  return createClient(url, key, { auth: { persistSession: false } });
}


