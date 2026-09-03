-- Expose PGMQ helpers in public schema so Supabase RPC calls can reach the extension.

create or replace function public.pgmq_send(
  queue_name text,
  msg jsonb,
  delay integer default 0
)
returns bigint
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.send(queue_name, msg, delay);
$$;

create or replace function public.pgmq_read(
  queue_name text,
  vt integer,
  qty integer
)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = public, pgmq
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  from pgmq.read(queue_name, vt, qty) as r;
$$;

create or replace function public.pgmq_delete(
  queue_name text,
  msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.delete(queue_name, msg_id);
$$;

create or replace function public.pgmq_archive(
  queue_name text,
  msg_id bigint
)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.archive(queue_name, msg_id);
$$;

grant execute on function public.pgmq_send(text, jsonb, integer) to postgres, anon, authenticated, service_role;
grant execute on function public.pgmq_read(text, integer, integer) to postgres, anon, authenticated, service_role;
grant execute on function public.pgmq_delete(text, bigint) to postgres, anon, authenticated, service_role;
grant execute on function public.pgmq_archive(text, bigint) to postgres, anon, authenticated, service_role;
