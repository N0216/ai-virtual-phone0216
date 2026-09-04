-- ai-phone-personal-push-schema-v1
-- 由小手机一键部署到用户自己的 Supabase；__PROJECT_REF__ 会在部署时替换。

-- 硬保险：只允许空项目、旧版个人云项目或已由本应用标记的专用项目。
-- 不依赖作者站点的某张业务表，因此自部署站点也能得到同样保护。
do $$
declare
  has_marker boolean := to_regclass('public.ai_phone_cloud_meta') is not null;
  has_unknown_public_table boolean;
begin
  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname <> all (array[
        'ai_phone_cloud_meta',
        'push_server_config', 'push_subscriptions', 'push_jobs', 'push_outbox',
        'push_shortcut_commands', 'push_bridge_config', 'push_bridge_snapshots',
        'push_screen_sessions', 'push_screen_threads',
        'role_chat_messages', 'role_handoffs', 'role_shared_memories',
        'role_events', 'role_call_transcript_chunks', 'role_query_logs'
      ])
  ) into has_unknown_public_table;

  if not has_marker and has_unknown_public_table then
    raise exception 'AI_PHONE_GUARD: 目标项目已包含其他业务表，拒绝部署个人云服务，请使用新建的专用项目';
  end if;
end $$;

create table if not exists public.ai_phone_cloud_meta (
  id text primary key,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
values ('personal-cloud', 5, now())
on conflict (id) do update set schema_version = excluded.schema_version, updated_at = excluded.updated_at;

create table if not exists public.push_server_config (
  id text primary key,
  vapid_public_key text not null,
  vapid_private_key text not null,
  cron_secret text,
  payload_key text,
  site_origin text,
  created_at timestamptz not null default now()
);
alter table public.push_server_config add column if not exists cron_secret text;
alter table public.push_server_config add column if not exists payload_key text;
alter table public.push_server_config add column if not exists site_origin text;
alter table public.push_server_config add column if not exists role_memory_token text;

-- 官 G 与小手机共用的角色上下文。三类数据彼此分开，并且每行都绑定 role_id，
-- 因此不同角色、群聊和会话不会串在一起。
create table if not exists public.role_chat_messages (
  user_id text not null,
  role_id text not null,
  role_name text,
  session_id text not null,
  message_id text not null,
  speaker text not null,
  content text not null,
  source text not null default 'phone',
  message_order double precision,
  metadata jsonb not null default '{}'::jsonb,
  message_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, role_id, message_id),
  constraint role_chat_messages_speaker_check check (speaker in ('user', 'assistant', 'system')),
  constraint role_chat_messages_source_check check (source in ('phone', 'official_g', 'import'))
);
create index if not exists role_chat_messages_recent_idx
  on public.role_chat_messages (user_id, role_id, message_at desc);
create index if not exists role_chat_messages_session_idx
  on public.role_chat_messages (user_id, role_id, session_id, message_at desc);

create table if not exists public.role_handoffs (
  id text primary key,
  user_id text not null,
  role_id text not null,
  role_name text,
  source text not null default 'official_g',
  summary text not null,
  recent_context jsonb not null default '[]'::jsonb,
  important_facts jsonb not null default '[]'::jsonb,
  open_topics jsonb not null default '[]'::jsonb,
  last_chat_at timestamptz,
  created_at timestamptz not null default now(),
  constraint role_handoffs_source_check check (source in ('phone', 'official_g', 'import'))
);
create index if not exists role_handoffs_recent_idx
  on public.role_handoffs (user_id, role_id, created_at desc);

create table if not exists public.role_shared_memories (
  id text primary key,
  user_id text not null,
  role_id text not null,
  role_name text,
  content text not null,
  importance integer not null default 3,
  source text not null default 'phone',
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint role_shared_memories_importance_check check (importance between 1 and 5),
  constraint role_shared_memories_source_check check (source in ('phone', 'official_g', 'import')),
  constraint role_shared_memories_status_check check (status in ('active', 'archived'))
);
create index if not exists role_shared_memories_recent_idx
  on public.role_shared_memories (user_id, role_id, status, updated_at desc);

-- 个人端“发生过什么”的只读资料目录。普通聊天仍保存在 role_chat_messages，
-- 这里收纳离线聊天、角色日记、朋友圈、自定义应用和角色虚拟手机快照。
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
  primary key (user_id, role_id, source_type, source_id),
  constraint role_events_source_type_check check (
    source_type in ('offline_chat', 'custom_app', 'diary', 'moments', 'virtual_phone')
  )
);
create index if not exists role_events_recent_idx
  on public.role_events (user_id, role_id, source_type, event_at desc);

alter table public.role_events drop constraint if exists role_events_source_type_check;
alter table public.role_events add constraint role_events_source_type_check check (
  source_type in ('offline_chat', 'custom_app', 'diary', 'moments', 'virtual_phone', 'call')
);

-- 完整通话转录按稳定版本和顺序分片；父 role_events 只在整版上传完成后切换版本。
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

-- 官 G 每次查了哪里、查了什么，用中文留痕；不保存访问令牌。
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

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  fail_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.push_jobs (
  id text primary key,
  user_id text not null,
  trigger_key text not null,
  kind text not null,
  execute_at timestamptz not null,
  status text not null default 'pending',
  payload jsonb not null,
  result_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_jobs_status_check check (status in ('pending', 'running', 'done', 'cancelled', 'failed'))
);
alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('followup', 'reply_bailout', 'timed_task', 'bridge_scan', 'shortcut_resume'));
create unique index if not exists push_jobs_trigger_idx on public.push_jobs (user_id, trigger_key);
create index if not exists push_jobs_due_idx on public.push_jobs (status, execute_at);

create table if not exists public.push_outbox (
  id text primary key,
  user_id text not null,
  job_id text,
  session_id text,
  trigger_key text,
  raw_text text not null,
  meta jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index if not exists push_outbox_user_idx
  on public.push_outbox (user_id, consumed_at, created_at);

-- push-generate 的普通离线任务不会访问快捷指令表；保留兼容表，避免未来升级时重建数据库。
create table if not exists public.push_shortcut_commands (
  id text primary key,
  user_id text not null,
  action_id text not null,
  action_name text not null,
  shortcut_name text not null,
  delivery_mode text not null default 'push',
  callback_token text not null,
  action_args jsonb not null default '{}'::jsonb,
  result_mode text not null default 'none',
  status text not null default 'pending',
  result jsonb,
  error text,
  expires_at timestamptz not null,
  notified_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 快捷指令图片结果只在第二轮生成期间临时保存。桶保持私有，Edge Function
-- 使用 service_role 上传/读取/删除；不向 anon 或 authenticated 开放策略。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shortcut-command-media',
  'shortcut-command-media',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 现实桥离线联动：规则/云配置/触发状态 + 每条规则的 prompt 快照。
-- bridge_token 供 iPhone 快捷指令免登录唤醒扫描（网关 bridge-wake 动作）。
create table if not exists public.push_bridge_config (
  user_id text primary key,
  bridge_token text not null,
  rules jsonb not null default '[]'::jsonb,
  cloud_config jsonb,
  rule_runs jsonb not null default '{}'::jsonb,
  daily_cap integer not null default 20,
  daily_count jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_bridge_config_token_idx on public.push_bridge_config (bridge_token);
-- 离线快捷动作目录：角色离线回复输出【快捷动作：名称】时按它匹配执行
alter table public.push_bridge_config add column if not exists shortcut_actions jsonb not null default '[]'::jsonb;

create table if not exists public.push_bridge_snapshots (
  user_id text not null,
  rule_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, rule_id)
);

-- v2 的 push_screen_sessions 可能仍含旧截图或聊天缓存。升级脚本不得删除它；
-- 如需清理，必须在另一次经过备份和用户确认的数据迁移中处理。

create table if not exists public.push_screen_threads (
  user_id text not null,
  character_id text not null,
  session_id text not null,
  pending_turns jsonb not null default '[]'::jsonb,
  next_sequence integer not null default 0,
  lock_token text,
  lock_expires_at timestamptz,
  usage_day date not null default ((now() at time zone 'utc')::date),
  usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id),
  constraint push_screen_threads_pending_array check (jsonb_typeof(pending_turns) = 'array')
);

-- 原子取得每个角色的生成锁并扣减日额度。不同悬浮球请求不会同时覆盖上下文。
create or replace function public.ai_phone_screen_chat_begin(
  p_user_id text,
  p_character_id text,
  p_session_id text,
  p_lock_token text,
  p_daily_cap integer
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_pending jsonb;
  v_sequence integer;
  v_session text;
  v_today date := (now() at time zone 'utc')::date;
begin
  insert into public.push_screen_threads (user_id, character_id, session_id)
  values (p_user_id, p_character_id, p_session_id)
  on conflict (user_id, character_id) do nothing;

  update public.push_screen_threads
     set pending_turns = case when session_id = p_session_id then pending_turns else '[]'::jsonb end,
         next_sequence = case when session_id = p_session_id then next_sequence else 0 end,
         session_id = p_session_id,
         lock_token = p_lock_token,
         lock_expires_at = now() + interval '130 seconds',
         usage_count = case when usage_day = v_today then usage_count + 1 else 1 end,
         usage_day = v_today,
         updated_at = now()
   where user_id = p_user_id
     and character_id = p_character_id
     and (lock_token is null or lock_expires_at is null or lock_expires_at <= now())
     and (usage_day <> v_today or usage_count < greatest(1, least(p_daily_cap, 500)))
  returning pending_turns, next_sequence, session_id
       into v_pending, v_sequence, v_session;

  if found then
    return jsonb_build_object(
      'status', 'ok',
      'pendingTurns', v_pending,
      'nextSequence', v_sequence,
      'sessionId', v_session
    );
  end if;

  if exists (
    select 1 from public.push_screen_threads
     where user_id = p_user_id and character_id = p_character_id
       and lock_token is not null and lock_expires_at > now()
  ) then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object('status', 'daily_cap');
end;
$function$;

-- 上下文水位与回传箱在同一事务提交；任何一步失败，本轮都不会伪装成成功。
create or replace function public.ai_phone_screen_chat_finish(
  p_user_id text,
  p_character_id text,
  p_lock_token text,
  p_pending_turns jsonb,
  p_next_sequence integer,
  p_outbox_id text,
  p_session_id text,
  p_trigger_key text,
  p_raw_text text,
  p_meta jsonb
) returns boolean
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if jsonb_typeof(p_pending_turns) <> 'array' then return false; end if;
  update public.push_screen_threads
     set pending_turns = p_pending_turns,
         next_sequence = greatest(next_sequence, p_next_sequence),
         lock_token = null,
         lock_expires_at = null,
         updated_at = now()
   where user_id = p_user_id and character_id = p_character_id and lock_token = p_lock_token;
  if not found then return false; end if;

  insert into public.push_outbox (
    id, user_id, job_id, session_id, trigger_key, raw_text, meta
  ) values (
    p_outbox_id, p_user_id, null, p_session_id, p_trigger_key, p_raw_text, p_meta
  ) on conflict (id) do nothing;
  return true;
end;
$function$;

create or replace function public.ai_phone_screen_chat_abort(
  p_user_id text,
  p_character_id text,
  p_lock_token text
) returns boolean
language sql
security invoker
set search_path = public
as $function$
  update public.push_screen_threads
     set lock_token = null, lock_expires_at = null, updated_at = now()
   where user_id = p_user_id and character_id = p_character_id and lock_token = p_lock_token
  returning true;
$function$;

alter table public.push_server_config enable row level security;
alter table public.ai_phone_cloud_meta enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
alter table public.push_outbox enable row level security;
alter table public.push_shortcut_commands enable row level security;
alter table public.push_bridge_config enable row level security;
alter table public.push_bridge_snapshots enable row level security;
alter table public.push_screen_threads enable row level security;
alter table public.role_chat_messages enable row level security;
alter table public.role_handoffs enable row level security;
alter table public.role_shared_memories enable row level security;
alter table public.role_events enable row level security;
alter table public.role_call_transcript_chunks enable row level security;
alter table public.role_query_logs enable row level security;

-- 屏幕速聊表和 RPC 只由 Edge Function 的 service_role 使用；客户端角色没有表级权限。
revoke all on table public.push_screen_threads from public, anon, authenticated;
revoke all on table public.role_chat_messages from public, anon, authenticated;
revoke all on table public.role_handoffs from public, anon, authenticated;
revoke all on table public.role_shared_memories from public, anon, authenticated;
revoke all on table public.role_events from public, anon, authenticated;
revoke all on table public.role_call_transcript_chunks from public, anon, authenticated;
revoke all on table public.role_query_logs from public, anon, authenticated;

-- 2026 年起新项目不会自动把 public 新表暴露给 Data API。
-- 网关和生成器只以 service_role 访问，绝不授予 anon 或 authenticated。
grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.push_server_config,
  public.ai_phone_cloud_meta,
  public.push_subscriptions,
  public.push_jobs,
  public.push_outbox,
  public.push_shortcut_commands,
  public.push_bridge_config,
  public.push_bridge_snapshots,
  public.push_screen_threads,
  public.role_chat_messages,
  public.role_handoffs,
  public.role_shared_memories,
  public.role_events,
  public.role_call_transcript_chunks,
  public.role_query_logs
to service_role;

revoke all on function public.ai_phone_screen_chat_begin(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.ai_phone_screen_chat_finish(text, text, text, jsonb, integer, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ai_phone_screen_chat_abort(text, text, text) from public, anon, authenticated;
grant execute on function public.ai_phone_screen_chat_begin(text, text, text, text, integer) to service_role;
grant execute on function public.ai_phone_screen_chat_finish(text, text, text, jsonb, integer, text, text, text, text, jsonb) to service_role;
grant execute on function public.ai_phone_screen_chat_abort(text, text, text) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'ai-phone-personal-push-jobs-scan';

-- 每分钟扫描一次到期任务。任务到点后最晚 60 秒被派发，对离线兜底推送足够；
-- 相比 10 秒一扫，cron.job_run_details 日志量降到 1/6，数据库更省。
-- bridge_scan（现实桥收件箱扫描）派给 push-bridge，其余派给 push-generate。
select cron.schedule('ai-phone-personal-push-jobs-scan', '* * * * *', $CRON$
  update public.push_jobs
     set status = 'pending', updated_at = now()
   where status = 'running' and updated_at < now() - interval '20 minutes';

  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-generate',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind <> 'bridge_scan'
     order by execute_at asc
     limit 10
  ) j;

  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-bridge',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind = 'bridge_scan'
     order by execute_at asc
     limit 5
  ) j;
$CRON$);

-- pg_cron 运行日志清理：只保留最近 3 天，防止 cron.job_run_details 无限增长。
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'ai-phone-personal-push-cron-cleanup';

select cron.schedule('ai-phone-personal-push-cron-cleanup', '0 3 * * *', $CRON$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
$CRON$);
