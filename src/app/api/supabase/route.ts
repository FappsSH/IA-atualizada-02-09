import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

const ALLOWED_TABLES = new Set([
  'agent_definitions',
  'followup_config',
  'followup_schedule',
  'indicacoes',
  'knowledge_items',
  'leads',
  'mensagens',
  'tenants',
  'trace_span',
  'whatsapp_instances',
]);

type MatchValue =
  | string
  | number
  | boolean
  | null
  | { in?: Array<string | number | boolean>; neq?: string | number | boolean | null };

interface QueryPayload {
  table: string;
  method: 'select' | 'insert' | 'update' | 'count';
  columns?: string;
  match?: Record<string, MatchValue>;
  order?: { column: string; ascending?: boolean };
  range?: [number, number];
  limit?: number;
  body?: Record<string, unknown>;
}

function applyMatch<T>(
  query: T,
  match?: Record<string, MatchValue>,
): T {
  if (!match) return query;

  let next = query as any;
  for (const [column, value] of Object.entries(match)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value && Array.isArray(value.in)) {
        next = next.in(column, value.in);
      }
      if ('neq' in value) {
        next = next.neq(column, value.neq);
      }
      continue;
    }

    if (value === null) {
      next = next.is(column, null);
      continue;
    }

    next = next.eq(column, value);
  }

  return next;
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as QueryPayload;
    const { table, method, columns = '*', match, order, range, limit, body } = payload;

    if (!ALLOWED_TABLES.has(table)) {
      return NextResponse.json(
        { error: `Table not allowed: ${table}` },
        { status: 400 },
      );
    }

    const supabase = createServerClient();

    if (method === 'count') {
      let query = supabase.from(table).select('*', { count: 'exact', head: true });
      query = applyMatch(query, match);
      const { count, error } = await query;

      return NextResponse.json({ count: count ?? 0, error: error?.message ?? null });
    }

    if (method === 'select') {
      let query = supabase.from(table).select(columns);
      query = applyMatch(query, match);

      if (order?.column) {
        query = query.order(order.column, { ascending: order.ascending ?? true });
      }
      if (range) {
        query = query.range(range[0], range[1]);
      } else if (typeof limit === 'number') {
        query = query.limit(limit);
      }

      const { data, error, count } = await query;
      return NextResponse.json({ data, count: count ?? null, error: error?.message ?? null });
    }

    if (method === 'insert') {
      if (!body) {
        return NextResponse.json({ error: 'body is required for insert' }, { status: 400 });
      }

      const { data, error } = await supabase.from(table).insert(body).select();
      return NextResponse.json({ data, error: error?.message ?? null });
    }

    if (method === 'update') {
      if (!body || !match) {
        return NextResponse.json(
          { error: 'body and match are required for update' },
          { status: 400 },
        );
      }

      let query = supabase.from(table).update(body);
      query = applyMatch(query, match);
      const { error } = await query;

      return NextResponse.json({ error: error?.message ?? null });
    }

    return NextResponse.json({ error: `Unknown method: ${method}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}
