import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const GATEWAY_SLUG = "ai-phone-push";
const GENERATE_SLUG = "push-generate";
const RESULT_SLUG = "push-shortcut-result";
const BRIDGE_SLUG = "push-bridge";
const SCREEN_SLUG = "screen-chat";
const ROLE_MEMORY_MCP_SLUG = "role-memory-mcp";

type DeployRequest = {
  projectRef?: string;
  token?: string;
  gatewayCode?: string;
  generateCode?: string;
  resultCode?: string;
  bridgeCode?: string;
  screenChatCode?: string;
  roleMemoryMcpCode?: string;
  schemaSql?: string;
  schemaV6Sql?: string;
};

async function upstreamMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `Supabase 返回 HTTP ${response.status}`;
  try {
    const data = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "";
    return (message || text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
async function deployFunction(params: {
  projectRef: string;
  token: string;
  slug: string;
  code: string;
}): Promise<Response> {
  const form = new FormData();
  form.append("metadata", JSON.stringify({
    name: params.slug,
    entrypoint_path: "index.ts",
    verify_jwt: false,
  }));
  form.append("file", new Blob([params.code], { type: "application/typescript" }), "index.ts");
  return fetch(
    `https://api.supabase.com/v1/projects/${params.projectRef}/functions/deploy?slug=${params.slug}`,
    { method: "POST", headers: { Authorization: `Bearer ${params.token}` }, body: form },
  );
}

async function assertDedicatedProject(params: {
  projectRef: string;
  token: string;
}): Promise<{ ok: true; initialized: boolean } | { ok: false; status: number; error: string }> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${params.projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `select case
        when to_regclass('public.ai_phone_cloud_meta') is not null then 'personal-cloud-safe-v2'
        when not exists (
          select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and c.relname <> all (array[
              'push_server_config', 'push_subscriptions', 'push_jobs', 'push_outbox',
              'push_shortcut_commands', 'push_bridge_config', 'push_bridge_snapshots',
              'push_screen_sessions', 'push_screen_threads',
              'role_chat_messages', 'role_handoffs', 'role_shared_memories'
            ])
        ) then 'personal-cloud-safe-v2'
        else 'shared-project-blocked'
      end as deployment_guard,
      to_regclass('public.ai_phone_cloud_meta') is not null as initialized`,
      read_only: true,
    }),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, error: await upstreamMessage(response) };
  }

  const rows = await response.json().catch(() => null) as Array<{ deployment_guard?: unknown; initialized?: unknown }> | null;
  const guard = Array.isArray(rows) && typeof rows[0]?.deployment_guard === "string"
    ? rows[0].deployment_guard
    : "";
  if (guard === "shared-project-blocked") {
    return {
      ok: false,
      status: 409,
      error: "检测到该项目包含其他业务表，已中止个人云部署。请使用新建的独立 Supabase 项目。",
    };
  }
  if (guard !== "personal-cloud-safe-v2") {
    return { ok: false, status: 502, error: "无法确认目标项目为独立个人云，已中止部署。" };
  }
  return { ok: true, initialized: rows?.[0]?.initialized === true };
}

export async function POST(request: Request) {
  let payload: DeployRequest;
  try {
    payload = await request.json() as DeployRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误。" }, { status: 400 });
  }

  const projectRef = typeof payload.projectRef === "string" ? payload.projectRef.trim() : "";
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const gatewayCode = typeof payload.gatewayCode === "string" ? payload.gatewayCode : "";
  const generateCode = typeof payload.generateCode === "string" ? payload.generateCode : "";
  const resultCode = typeof payload.resultCode === "string" ? payload.resultCode : "";
  const bridgeCode = typeof payload.bridgeCode === "string" ? payload.bridgeCode : "";
  const screenChatCode = typeof payload.screenChatCode === "string" ? payload.screenChatCode : "";
  const roleMemoryMcpCode = typeof payload.roleMemoryMcpCode === "string" ? payload.roleMemoryMcpCode : "";
  const schemaSql = typeof payload.schemaSql === "string" ? payload.schemaSql : "";
  const schemaV6Sql = typeof payload.schemaV6Sql === "string" ? payload.schemaV6Sql : "";

  if (!/^[a-z0-9]{15,40}$/.test(projectRef)) {
    return NextResponse.json({ ok: false, error: "Supabase 项目标识无效。" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ ok: false, error: "缺少 Access Token。" }, { status: 400 });
  if (
    !gatewayCode.includes("ai-phone-personal-push-gateway")
    || !gatewayCode.includes("Deno.serve")
    || gatewayCode.length > 600_000
  ) {
    return NextResponse.json({ ok: false, error: "离线推送网关部署包无效。" }, { status: 400 });
  }
  if (
    !generateCode.includes("离线推送·兜底生成执行器")
    || !generateCode.includes("Deno.serve")
    || generateCode.length > 900_000
  ) {
    return NextResponse.json({ ok: false, error: "离线生成器部署包无效。" }, { status: 400 });
  }
  if (
    !resultCode.includes("iPhone 快捷指令结果入口")
    || !resultCode.includes("Deno.serve")
    || resultCode.length > 600_000
  ) {
    return NextResponse.json({ ok: false, error: "快捷指令结果入口部署包无效。" }, { status: 400 });
  }
  if (
    !bridgeCode.includes("现实桥服务端联动执行器")
    || !bridgeCode.includes("Deno.serve")
    || bridgeCode.length > 900_000
  ) {
    return NextResponse.json({ ok: false, error: "现实桥联动执行器部署包无效。" }, { status: 400 });
  }
  if (
    !screenChatCode.includes("屏幕速聊·同步问答入口")
    || !screenChatCode.includes("Deno.serve")
    || screenChatCode.length > 600_000
  ) {
    return NextResponse.json({ ok: false, error: "屏幕速聊入口部署包无效。" }, { status: 400 });
  }
  if (
    !schemaV6Sql.startsWith("-- ai-phone-personal-push-schema-v6-migration")
    || !schemaV6Sql.includes("begin;")
    || !schemaV6Sql.includes("public.ai_phone_schema_v6_health()")
    || !schemaV6Sql.trimEnd().endsWith("commit;")
    || schemaV6Sql.length > 120_000
  ) {
    return NextResponse.json({ ok: false, error: "个人云 v6 数据库迁移脚本无效。" }, { status: 400 });
  }
  if (
    !roleMemoryMcpCode.includes("角色记忆交接 MCP")
    || !roleMemoryMcpCode.includes("Deno.serve")
    || roleMemoryMcpCode.length > 600_000
  ) {
    return NextResponse.json({ ok: false, error: "角色记忆 MCP 部署包无效。" }, { status: 400 });
  }
  if (
    !schemaSql.startsWith("-- ai-phone-personal-push-schema-v1")
    || !schemaSql.includes("create table if not exists public.push_jobs")
    || !schemaSql.includes("__PROJECT_REF__")
    || schemaSql.length > 300_000
  ) {
    return NextResponse.json({ ok: false, error: "离线推送数据库脚本无效。" }, { status: 400 });
  }

  try {
    // 必须在部署同名函数之前检查。主项目也有 push-generate / push-bridge；
    // 若先部署再查库，错误目标会先覆盖生产函数版本。
    const dedicatedProject = await assertDedicatedProject({ projectRef, token });
    if (!dedicatedProject.ok) {
      return NextResponse.json(
        { ok: false, step: "检查独立项目失败", error: dedicatedProject.error },
        { status: dedicatedProject.status },
      );
    }

    // Full schema is only for a genuinely new personal-cloud project. Existing
    // projects run the minimal transactional v6 migration and therefore do not
    // recreate unrelated constraints, screen-chat functions or cron jobs.
    if (!dedicatedProject.initialized) {
      const initialDatabase = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: schemaSql.replaceAll("__PROJECT_REF__", projectRef), read_only: false }),
      });
      if (!initialDatabase.ok) {
        return NextResponse.json(
          { ok: false, step: "初始化离线推送数据库失败", error: await upstreamMessage(initialDatabase) },
          { status: initialDatabase.status },
        );
      }
    }

    const migration = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: schemaV6Sql, read_only: false }),
    });
    if (!migration.ok) {
      return NextResponse.json(
        { ok: false, step: "升级个人云数据库到 v6 失败", error: await upstreamMessage(migration) },
        { status: migration.status },
      );
    }

    const gateway = await deployFunction({ projectRef, token, slug: GATEWAY_SLUG, code: gatewayCode });
    if (!gateway.ok) {
      return NextResponse.json(
        { ok: false, step: "部署离线推送网关失败", error: await upstreamMessage(gateway) },
        { status: gateway.status },
      );
    }

    const generator = await deployFunction({ projectRef, token, slug: GENERATE_SLUG, code: generateCode });
    if (!generator.ok) {
      return NextResponse.json(
        { ok: false, step: "部署离线生成器失败", error: await upstreamMessage(generator) },
        { status: generator.status },
      );
    }

    const result = await deployFunction({ projectRef, token, slug: RESULT_SLUG, code: resultCode });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, step: "部署快捷指令结果入口失败", error: await upstreamMessage(result) },
        { status: result.status },
      );
    }

    const bridge = await deployFunction({ projectRef, token, slug: BRIDGE_SLUG, code: bridgeCode });
    if (!bridge.ok) {
      return NextResponse.json(
        { ok: false, step: "部署现实桥联动执行器失败", error: await upstreamMessage(bridge) },
        { status: bridge.status },
      );
    }

    const screenChat = await deployFunction({ projectRef, token, slug: SCREEN_SLUG, code: screenChatCode });
    if (!screenChat.ok) {
      return NextResponse.json(
        { ok: false, step: "部署屏幕速聊入口失败", error: await upstreamMessage(screenChat) },
        { status: screenChat.status },
      );
    }

    const roleMemoryMcp = await deployFunction({
      projectRef,
      token,
      slug: ROLE_MEMORY_MCP_SLUG,
      code: roleMemoryMcpCode,
    });
    if (!roleMemoryMcp.ok) {
      return NextResponse.json(
        { ok: false, step: "部署角色记忆 MCP 失败", error: await upstreamMessage(roleMemoryMcp) },
        { status: roleMemoryMcp.status },
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "暂时无法连接 Supabase 管理接口。" }, { status: 502 });
  }
}
