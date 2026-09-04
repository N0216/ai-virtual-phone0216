-- ai-phone-personal-push-schema-v6-migration
-- Minimal, transactional and repeatable v6 migration. It intentionally does
-- not alter screen-chat tables/functions, push job constraints or pg_cron.
begin;

do $$
begin
  if to_regclass('public.ai_phone_cloud_meta') is null then
    raise exception 'AI_PHONE_V6: base personal-cloud schema is missing';
  end if;
end $$;

create table if not exists public.role_events (
  user_id text not null,
  role_id text not null,
  role_name text,
  source_type text not null,
  source_id text not null,
  title text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  event_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, role_id, source_type, source_id)
);
create index if not exists role_events_recent_idx
  on public.role_events (user_id, role_id, source_type, event_at desc);

-- This is the only existing constraint v6 changes. Validation happens inside
-- the transaction, so incompatible rows abort and restore the previous check.
alter table public.role_events drop constraint if exists role_events_source_type_check;
alter table public.role_events add constraint role_events_source_type_check check (
  source_type in ('offline_chat', 'custom_app', 'diary', 'moments', 'virtual_phone', 'call')
) not valid;
alter table public.role_events validate constraint role_events_source_type_check;

create table if not exists public.role_call_transcript_chunks (
  user_id text not null,
  role_id text not null,
  call_id text not null,
  transcript_version text not null,
  chunk_index integer not null,
  entry_id text not null,
  speaker text not null,
  occurred_at timestamptz not null,
  sender_name text,
  sender_character_id text,
  part_index integer not null,
  part_count integer not null,
  content text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, role_id, call_id, transcript_version, chunk_index),
  constraint role_call_transcript_chunks_speaker_check check (speaker in ('user', 'assistant')),
  constraint role_call_transcript_chunks_part_check check (
    chunk_index >= 0 and part_index >= 0 and part_count > 0 and part_index < part_count
  )
);
create index if not exists role_call_transcript_chunks_read_idx
  on public.role_call_transcript_chunks (user_id, role_id, call_id, transcript_version, chunk_index);

create table if not exists public.role_query_logs (
  id text primary key,
  user_id text not null,
  operation text not null,
  operation_label text not null,
  role_id text,
  role_name text,
  source_type text,
  source_label text,
  query_text text,
  result_count integer not null default 0,
  detail text,
  queried_at timestamptz not null default now()
);
create index if not exists role_query_logs_recent_idx
  on public.role_query_logs (user_id, queried_at desc);

alter table public.role_events enable row level security;
alter table public.role_call_transcript_chunks enable row level security;
alter table public.role_query_logs enable row level security;

revoke all on table public.role_events from public, anon, authenticated;
revoke all on table public.role_call_transcript_chunks from public, anon, authenticated;
revoke all on table public.role_query_logs from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.role_events,
  public.role_call_transcript_chunks,
  public.role_query_logs
to service_role;

-- The gateway calls this on every v6 health check. It verifies actual catalog
-- state instead of trusting ai_phone_cloud_meta.schema_version alone.
create or replace function public.ai_phone_schema_v6_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  tables_ready boolean;
  columns_ready boolean;
  constraints_ready boolean;
  rls_ready boolean;
  grants_ready boolean;
begin
  tables_ready := to_regclass('public.role_events') is not null
    and to_regclass('public.role_call_transcript_chunks') is not null
    and to_regclass('public.role_query_logs') is not null
    and to_regclass('public.role_events_recent_idx') is not null
    and to_regclass('public.role_call_transcript_chunks_read_idx') is not null
    and to_regclass('public.role_query_logs_recent_idx') is not null;

  select not exists (
    select required.table_name, required.name
    from (values
      ('role_events','user_id','text'), ('role_events','role_id','text'),
      ('role_events','role_name','text'), ('role_events','source_type','text'),
      ('role_events','source_id','text'), ('role_events','title','text'),
      ('role_events','content','text'), ('role_events','metadata','jsonb'),
      ('role_events','event_at','timestamptz'), ('role_events','updated_at','timestamptz'),
      ('role_call_transcript_chunks','user_id','text'), ('role_call_transcript_chunks','role_id','text'),
      ('role_call_transcript_chunks','call_id','text'), ('role_call_transcript_chunks','transcript_version','text'),
      ('role_call_transcript_chunks','chunk_index','int4'), ('role_call_transcript_chunks','entry_id','text'),
      ('role_call_transcript_chunks','speaker','text'), ('role_call_transcript_chunks','occurred_at','timestamptz'),
      ('role_call_transcript_chunks','sender_name','text'), ('role_call_transcript_chunks','sender_character_id','text'),
      ('role_call_transcript_chunks','part_index','int4'), ('role_call_transcript_chunks','part_count','int4'),
      ('role_call_transcript_chunks','content','text'), ('role_call_transcript_chunks','updated_at','timestamptz'),
      ('role_query_logs','id','text'), ('role_query_logs','user_id','text'),
      ('role_query_logs','operation','text'), ('role_query_logs','operation_label','text'),
      ('role_query_logs','role_id','text'), ('role_query_logs','role_name','text'),
      ('role_query_logs','source_type','text'), ('role_query_logs','source_label','text'),
      ('role_query_logs','query_text','text'), ('role_query_logs','result_count','int4'),
      ('role_query_logs','detail','text'), ('role_query_logs','queried_at','timestamptz')
    ) as required(table_name, name, udt)
    where not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = required.table_name
         and c.column_name = required.name
         and c.udt_name = required.udt
    )
  ) into columns_ready;

  select
    exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_events'::regclass
         and c.conname = 'role_events_source_type_check'
         and c.convalidated
         and pg_get_constraintdef(c.oid) like '%call%'
    )
    and exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_call_transcript_chunks'::regclass
         and c.contype = 'p'
         and c.convalidated
         and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id, role_id, call_id, transcript_version, chunk_index)'
    )
    and exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_events'::regclass
         and c.contype = 'p'
         and c.convalidated
         and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id, role_id, source_type, source_id)'
    )
    and exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_query_logs'::regclass
         and c.contype = 'p'
         and c.convalidated
         and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
    )
    and exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_call_transcript_chunks'::regclass
         and c.conname = 'role_call_transcript_chunks_speaker_check'
         and c.convalidated
    )
    and exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.role_call_transcript_chunks'::regclass
         and c.conname = 'role_call_transcript_chunks_part_check'
         and c.convalidated
    ) into constraints_ready;

  select bool_and(c.relrowsecurity)
    into rls_ready
    from pg_class c
   where c.oid in (
     'public.role_events'::regclass,
     'public.role_call_transcript_chunks'::regclass,
     'public.role_query_logs'::regclass
   );

  grants_ready := has_schema_privilege('service_role', 'public', 'USAGE')
    and has_table_privilege('service_role', 'public.role_events', 'SELECT')
    and has_table_privilege('service_role', 'public.role_events', 'INSERT')
    and has_table_privilege('service_role', 'public.role_events', 'UPDATE')
    and has_table_privilege('service_role', 'public.role_events', 'DELETE')
    and has_table_privilege('service_role', 'public.role_call_transcript_chunks', 'SELECT')
    and has_table_privilege('service_role', 'public.role_call_transcript_chunks', 'INSERT')
    and has_table_privilege('service_role', 'public.role_call_transcript_chunks', 'UPDATE')
    and has_table_privilege('service_role', 'public.role_call_transcript_chunks', 'DELETE')
    and has_table_privilege('service_role', 'public.role_query_logs', 'SELECT')
    and has_table_privilege('service_role', 'public.role_query_logs', 'INSERT')
    and has_table_privilege('service_role', 'public.role_query_logs', 'UPDATE')
    and has_table_privilege('service_role', 'public.role_query_logs', 'DELETE')
    and not has_table_privilege('anon', 'public.role_events', 'SELECT')
    and not has_table_privilege('anon', 'public.role_events', 'INSERT')
    and not has_table_privilege('anon', 'public.role_events', 'UPDATE')
    and not has_table_privilege('anon', 'public.role_events', 'DELETE')
    and not has_table_privilege('authenticated', 'public.role_events', 'SELECT')
    and not has_table_privilege('authenticated', 'public.role_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.role_events', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.role_events', 'DELETE')
    and not has_table_privilege('anon', 'public.role_call_transcript_chunks', 'SELECT')
    and not has_table_privilege('anon', 'public.role_call_transcript_chunks', 'INSERT')
    and not has_table_privilege('anon', 'public.role_call_transcript_chunks', 'UPDATE')
    and not has_table_privilege('anon', 'public.role_call_transcript_chunks', 'DELETE')
    and not has_table_privilege('authenticated', 'public.role_call_transcript_chunks', 'SELECT')
    and not has_table_privilege('authenticated', 'public.role_call_transcript_chunks', 'INSERT')
    and not has_table_privilege('authenticated', 'public.role_call_transcript_chunks', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.role_call_transcript_chunks', 'DELETE')
    and not has_table_privilege('anon', 'public.role_query_logs', 'SELECT')
    and not has_table_privilege('anon', 'public.role_query_logs', 'INSERT')
    and not has_table_privilege('anon', 'public.role_query_logs', 'UPDATE')
    and not has_table_privilege('anon', 'public.role_query_logs', 'DELETE')
    and not has_table_privilege('authenticated', 'public.role_query_logs', 'SELECT')
    and not has_table_privilege('authenticated', 'public.role_query_logs', 'INSERT')
    and not has_table_privilege('authenticated', 'public.role_query_logs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.role_query_logs', 'DELETE');

  return jsonb_build_object(
    'ready', tables_ready and columns_ready and constraints_ready and rls_ready and grants_ready,
    'tables', tables_ready,
    'columns', columns_ready,
    'constraints', constraints_ready,
    'rls', rls_ready,
    'grants', grants_ready
  );
end;
$function$;

revoke all on function public.ai_phone_schema_v6_health() from public, anon, authenticated;
grant execute on function public.ai_phone_schema_v6_health() to service_role;

do $$
declare
  health jsonb;
begin
  health := public.ai_phone_schema_v6_health();
  if coalesce((health ->> 'ready')::boolean, false) is not true then
    raise exception 'AI_PHONE_V6: structural verification failed: %', health;
  end if;
end $$;

-- Deliberately last: no statement other than COMMIT follows this version mark.
insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
values ('personal-cloud', 6, now())
on conflict (id) do update
  set schema_version = excluded.schema_version,
      updated_at = excluded.updated_at;

commit;
