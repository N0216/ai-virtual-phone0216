// 角色记忆交接 MCP
// 部署在用户自己的 Supabase 项目中；仅接受个人云生成的 Bearer token。

const OWNER_ID = "owner";
const EXECUTION_TASK_MARKER = "ai_phone_execution_task_v1";
const EXECUTION_TASK_ID_PATTERN = /^exec_task_[a-f0-9-]{20,80}$/i;
const EXECUTION_TASK_STATUSES = new Set(["pending", "running", "succeeded", "failed", "cancelled"]);
const USER_VIEW_READ_POLICY_ID = "owner_view_read_policy";
const USER_VIEW_READ_POLICY_MARKER = "ai_phone_user_view_read_policy_v1";
const ROLE_PHONE_REFERENCE = /(?:aiphonecheckphonedb|ai_phone_checkphone_events_|checkphone-settings|checkphone:|\bvirtual_phone\b|角色手机|查手机)/iu;
const USER_VIEW_READ_TOOLS = new Set([
  "list_roles", "read_recent_chat", "get_latest_handoff", "list_personal_sources",
  "search_personal_records", "read_call_transcript", "read_query_history", "search_shared_memory",
  "list_execution_tasks", "read_execution_task",
]);
const SOURCE_LABELS: Record<string, string> = {
  chat: "小手机聊天记录",
  offline_chat: "小手机离线聊天",
  custom_app: "自定义应用记录",
  diary: "角色日记",
  moments: "朋友圈",
  virtual_phone: "角色的虚拟手机",
  call: "语音与视频通话记录",
  shared_memory: "重要记忆盒子",
  handoff: "跨软件交接",
};
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function redactLikelyCredential(value: string): string {
  return value
    .replace(/\bsbp_[A-Za-z0-9_-]{20,}\b/g, "[已隐藏 Supabase 令牌]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[已隐藏 API 密钥]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[已隐藏访问令牌]")
    .replace(/(["']?(?:api[_-]?key|authorization|cookie|credential|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]{4,})/gi, "$1[已隐藏凭据]");
}

function safeContent(value: unknown, max: number): string {
  return redactLikelyCredential(cleanText(value, max));
}

function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (typeof value === "string") return safeContent(value, 30_000);
  if (Array.isArray(value)) return value.slice(-60).map(item => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .filter(([key]) => !/(?:api.?key|secret|token|cookie|credential|authorization|password)/i.test(key))
      .map(([key, item]) => [key, redactJson(item, depth + 1)]));
  }
  return value;
}

function isRolePhoneRelated(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") return ROLE_PHONE_REFERENCE.test(value);
  if (Array.isArray(value)) return value.some(item => isRolePhoneRelated(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
      ROLE_PHONE_REFERENCE.test(key) || isRolePhoneRelated(item, depth + 1)
    ));
  }
  return false;
}

function sanitizeRolePhoneData(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return ROLE_PHONE_REFERENCE.test(value) ? "[角色手机数据不可读]" : value;
  if (Array.isArray(value)) return value
    .filter(item => !isRolePhoneRelated(item))
    .map(item => sanitizeRolePhoneData(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => !ROLE_PHONE_REFERENCE.test(key) && !isRolePhoneRelated(item))
      .map(([key, item]) => [key, sanitizeRolePhoneData(item, depth + 1)]));
  }
  return value;
}

function isExplicitlyDeniedToEiren(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.allowEirenView === false || record.allow_eiren_view === false
    || record.eirenVisible === false || record.eiren_visible === false
    || record.ownerViewReadable === false || record.owner_view_readable === false) return true;
  const access = String(record.accessDecision ?? record.access_decision ?? record.access ?? "").toLowerCase();
  const visibility = String(record.visibility ?? "").toLowerCase();
  return ["deny", "denied", "locked", "blocked", "hidden"].includes(access)
    || ["locked", "blocked", "hidden", "private_to_owner"].includes(visibility);
}

function isRowVisibleToEiren(row: Record<string, unknown>): boolean {
  return !isRolePhoneRelated(row) && !isExplicitlyDeniedToEiren(row) && !isExplicitlyDeniedToEiren(row.metadata);
}

type ExecutionTask = {
  task_id: string; creator: string; intent: string; permission_scope: string[];
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  result: unknown | null; tool_trace: Array<Record<string, unknown>>; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};

function executionTaskFromRow(row: Record<string, unknown>): ExecutionTask | null {
  const value = (Array.isArray(row.recent_context) ? row.recent_context : [])[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const taskId = cleanText(task.task_id, 100);
  const status = cleanText(task.status, 20);
  if (task.marker !== EXECUTION_TASK_MARKER || !EXECUTION_TASK_ID_PATTERN.test(taskId) || !EXECUTION_TASK_STATUSES.has(status)) return null;
  if (isRolePhoneRelated(task)) return null;
  return {
    task_id: taskId,
    creator: cleanText(task.creator, 80),
    intent: safeContent(task.intent, 20_000),
    permission_scope: (Array.isArray(task.permission_scope) ? task.permission_scope : [])
      .map(item => cleanText(item, 160)).filter(Boolean).slice(0, 80),
    status: status as ExecutionTask["status"],
    result: sanitizeRolePhoneData(redactJson(task.result ?? null)),
    tool_trace: (Array.isArray(task.tool_trace) ? task.tool_trace : [])
      .filter(item => item && typeof item === "object" && !Array.isArray(item))
      .filter(item => !isRolePhoneRelated(item))
      .slice(-120).map(item => sanitizeRolePhoneData(redactJson(item)) as Record<string, unknown>),
    error: cleanText(task.error, 4000) || null,
    created_at: cleanText(task.created_at, 40) || cleanText(row.created_at, 40),
    started_at: cleanText(task.started_at, 40) || null,
    finished_at: cleanText(task.finished_at, 40) || null,
  };
}

function executionTaskContext(task: ExecutionTask): unknown[] {
  return [{ marker: EXECUTION_TASK_MARKER, ...task }];
}

function rpcResult(id: unknown, result: unknown): Response {
  return responseJson({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return responseJson({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

const TOOLS = [
  {
    name: "list_roles",
    description: "列出个人云里已经同步的角色及最近聊天时间。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_recent_chat",
    description: "按角色读取最近聊天，恢复从官 G 或小手机切换前的上下文。",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string", description: "角色 ID；先用 list_roles 查询。" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40 },
        before: { type: "string", description: "可选，ISO 时间；读取它之前的消息。" },
      },
      required: ["role_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_latest_handoff",
    description: "读取某角色最新一份跨软件交接摘要。",
    inputSchema: {
      type: "object",
      properties: { role_id: { type: "string" } },
      required: ["role_id"], additionalProperties: false,
    },
  },
  {
    name: "list_personal_sources",
    description: "用中文列出官 G 当前能查阅的个人端资料种类，并说明每一类是什么。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_personal_records",
    description: "按角色、资料种类、关键词和时间查询个人端记录；通话结果返回摘要，需要完整逐句内容时再调用 read_call_transcript。",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string", description: "可选角色 ID；不填则查全部角色。" },
        source_type: { type: "string", enum: ["all", "chat", "offline_chat", "custom_app", "diary", "moments", "call"] },
        query: { type: "string", description: "可选关键词。" },
        after: { type: "string", description: "可选 ISO 起始时间。" },
        before: { type: "string", description: "可选 ISO 截止时间。" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_call_transcript",
    description: "按角色和通话记录 ID 读取完整、未截断的语音或视频通话转录。call_id 来自 search_personal_records 的 source_id。",
    inputSchema: {
      type: "object",
      properties: { role_id: { type: "string" }, call_id: { type: "string" } },
      required: ["role_id", "call_id"], additionalProperties: false,
    },
  },
  {
    name: "read_query_history",
    description: "查看官 G 最近查阅了哪些资料。返回人能看懂的中文来源、关键词、结果数量和时间。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 30 } },
      additionalProperties: false,
    },
  },
  {
    name: "save_role_handoff",
    description: "从官 G 切换到小手机前，保存当前关系、重要事件、未完话题和最近上下文。",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string" }, role_name: { type: "string" }, summary: { type: "string" },
        recent_context: { type: "array", items: { type: "object" } },
        important_facts: { type: "array", items: {} },
        open_topics: { type: "array", items: {} },
        last_chat_at: { type: "string" },
      },
      required: ["role_id", "summary"], additionalProperties: false,
    },
  },
  {
    name: "append_role_messages",
    description: "把官 G 中最近几条必要聊天追加到对应角色记录；不要上传密码、Cookie 或密钥。",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string" }, role_name: { type: "string" }, session_id: { type: "string" },
        messages: {
          type: "array", maxItems: 50,
          items: { type: "object", properties: {
            id: { type: "string" }, role: { type: "string", enum: ["user", "assistant", "system"] },
            content: { type: "string" }, created_at: { type: "string" },
          }, required: ["role", "content"], additionalProperties: false },
        },
      },
      required: ["role_id", "messages"], additionalProperties: false,
    },
  },
  {
    name: "search_shared_memory",
    description: "在某个角色的共享长期记忆中按关键词查询。",
    inputSchema: {
      type: "object",
      properties: { role_id: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      required: ["role_id"], additionalProperties: false,
    },
  },
  {
    name: "save_shared_memory",
    description: "保存官 G 和小手机都应长期记住的重要事实；每条必须绑定角色。",
    inputSchema: {
      type: "object",
      properties: {
        role_id: { type: "string" }, role_name: { type: "string" }, content: { type: "string" },
        importance: { type: "integer", minimum: 1, maximum: 5, default: 3 }, metadata: { type: "object" },
      },
      required: ["role_id", "content"], additionalProperties: false,
    },
  },
  {
    name: "create_execution_task",
    description: "以 Eiren 身份把一项低权限执行任务交给小手机里的 DeepSeek 助理。只能授予明确列出的工具；不能委托关系判断、感情表达或正式记忆写入。",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", minLength: 1, maxLength: 20000 },
        permission_scope: { type: "array", minItems: 1, maxItems: 80, items: { type: "string", maxLength: 160 } },
      },
      required: ["intent", "permission_scope"], additionalProperties: false,
    },
  },
  {
    name: "list_execution_tasks",
    description: "列出 Eiren 交给 DeepSeek 的任务及状态、结果和工具轨迹。",
    inputSchema: {
      type: "object", properties: {
        status: { type: "string", enum: ["all", "pending", "running", "succeeded", "failed", "cancelled"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 80, default: 30 },
      }, additionalProperties: false,
    },
  },
  {
    name: "read_execution_task",
    description: "读取一项执行任务的结构化结果、使用过的工具、时间和失败原因。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
  },
  {
    name: "cancel_execution_task",
    description: "取消待领取或正在运行的执行任务。执行端会在模型轮次和工具调用之间复核取消状态。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, reason: { type: "string", maxLength: 1000 } }, required: ["task_id"], additionalProperties: false },
  },
];

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method === "GET") return responseJson({ ok: true, service: "role-memory-mcp", transport: "streamable-http" });
  if (request.method !== "POST") return responseJson({ error: "Method not allowed" }, 405);

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return responseJson({ error: "Supabase 环境不完整。" }, 500);
  const rest = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("apikey", serviceKey);
    headers.set("Authorization", `Bearer ${serviceKey}`);
    if (init.body) headers.set("Content-Type", "application/json");
    return fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers });
  };
  const read = async <T,>(response: Response): Promise<T> => {
    const text = await response.text();
    if (!response.ok) throw new Error(text.slice(0, 300) || `HTTP ${response.status}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const audit = async (input: {
    operation: string; operationLabel: string; roleId?: string; roleName?: string;
    sourceType?: string; query?: string; resultCount?: number; detail?: string;
  }) => {
    const row = {
      id: `query_${crypto.randomUUID()}`,
      user_id: OWNER_ID,
      operation: cleanText(input.operation, 80),
      operation_label: cleanText(input.operationLabel, 120),
      role_id: cleanText(input.roleId, 160) || null,
      role_name: cleanText(input.roleName, 120) || null,
      source_type: cleanText(input.sourceType, 40) || null,
      source_label: SOURCE_LABELS[input.sourceType || ""] || "全部个人端资料",
      query_text: safeContent(input.query, 300) || null,
      result_count: Math.max(0, Number(input.resultCount) || 0),
      detail: cleanText(input.detail, 500) || null,
    };
    await read(await rest("role_query_logs", {
      method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]),
    })).catch(() => undefined);
  };

  const auth = request.headers.get("authorization") || "";
  const supplied = auth.replace(/^Bearer\s+/i, "").trim();
  const config = await read<Array<{ role_memory_token?: string }>>(await rest(
    "push_server_config?id=eq.main&select=role_memory_token&limit=1",
  )).catch(() => []);
  if (!supplied || !config[0]?.role_memory_token || supplied !== config[0].role_memory_token) {
    return responseJson({ error: "Unauthorized" }, 401);
  }

  const body = await request.json().catch(() => null) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!body || body.jsonrpc !== "2.0") return rpcError(body?.id ?? null, -32600, "Invalid Request", 400);
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers: CORS_HEADERS });
  if (body.method === "initialize") return rpcResult(body.id, {
    protocolVersion: "2025-03-26",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "AI Phone Role Memory", version: "1.0.0" },
  });
  if (body.method === "ping") return rpcResult(body.id, {});
  const policyRows = await read<Array<Record<string, unknown>>>(await rest(
    `role_handoffs?user_id=eq.${OWNER_ID}&id=eq.${USER_VIEW_READ_POLICY_ID}&select=recent_context&limit=1`,
  ));
  const policyValue = Array.isArray(policyRows[0]?.recent_context)
    ? policyRows[0].recent_context[0] as Record<string, unknown> | undefined
    : undefined;
  const userViewReadEnabled = policyValue?.marker === USER_VIEW_READ_POLICY_MARKER ? policyValue.enabled !== false : true;
  if (body.method === "tools/list") {
    return rpcResult(body.id, { tools: userViewReadEnabled ? TOOLS : TOOLS.filter(tool => !USER_VIEW_READ_TOOLS.has(tool.name)) });
  }
  if (body.method !== "tools/call") return rpcError(body.id, -32601, "Method not found");

  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
  const name = cleanText(params.name, 80);
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  if (USER_VIEW_READ_TOOLS.has(name) && !userViewReadEnabled) {
    return rpcResult(body.id, toolResult({ error: "玲玲已撤销 Eiren 的本人视角只读授权。" }, true));
  }
  try {
    if (name === "list_roles") {
      const [chatRows, handoffRows, memoryRows, eventRows] = await Promise.all([
        read<Array<Record<string, unknown>>>(await rest(
          `role_chat_messages?user_id=eq.${OWNER_ID}&select=role_id,role_name,message_at&order=message_at.desc&limit=2000`,
        )),
        read<Array<Record<string, unknown>>>(await rest(
          `role_handoffs?user_id=eq.${OWNER_ID}&id=not.like.exec_task_*&id=neq.${USER_VIEW_READ_POLICY_ID}&select=role_id,role_name,created_at&order=created_at.desc&limit=500`,
        )),
        read<Array<Record<string, unknown>>>(await rest(
          `role_shared_memories?user_id=eq.${OWNER_ID}&status=eq.active&select=role_id,role_name,updated_at&order=updated_at.desc&limit=1000`,
        )),
        read<Array<Record<string, unknown>>>(await rest(
          `role_events?user_id=eq.${OWNER_ID}&source_type=neq.virtual_phone&select=role_id,role_name,event_at,source_type,title,metadata&order=event_at.desc&limit=2000`,
        )),
      ]);
      const roles = new Map<string, Record<string, unknown>>();
      for (const row of [...chatRows, ...handoffRows, ...memoryRows, ...eventRows].filter(isRowVisibleToEiren)) {
        const roleId = cleanText(row.role_id, 160);
        if (!roleId || roles.has(roleId)) continue;
        roles.set(roleId, {
          role_id: roleId,
          role_name: cleanText(row.role_name, 120) || roleId,
          latest_at: row.message_at || row.event_at || row.created_at || row.updated_at || null,
        });
      }
      await audit({ operation: name, operationLabel: "查看有哪些角色", resultCount: roles.size });
      return rpcResult(body.id, toolResult({ roles: [...roles.values()] }));
    }

    if (name === "list_personal_sources") {
      const sources = Object.entries(SOURCE_LABELS)
        .filter(([sourceType]) => sourceType !== "virtual_phone")
        .map(([source_type, label]) => ({ source_type, label }));
      await audit({ operation: name, operationLabel: "查看可查询的资料种类", resultCount: sources.length });
      return rpcResult(body.id, toolResult({
        说明: "这里列的是官 G 能查的个人端资料。查询不会修改原记录。",
        sources,
      }));
    }

    if (name === "read_query_history") {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
      const rows = await read<unknown[]>(await rest(
        `role_query_logs?user_id=eq.${OWNER_ID}`
        + "&select=operation_label,role_name,source_label,query_text,result_count,detail,queried_at"
        + `&order=queried_at.desc&limit=${limit}`,
      ));
      const visibleRows = rows.filter(row => !isRolePhoneRelated(row));
      return rpcResult(body.id, toolResult({ 说明: "以下是官 G 最近的查询记录。", 查询记录: visibleRows.map(row => sanitizeRolePhoneData(redactJson(row))) }));
    }

    if (name === "search_personal_records") {
      const roleIdArg = cleanText(args.role_id, 160);
      const sourceType = cleanText(args.source_type, 40) || "all";
      const query = cleanText(args.query, 200);
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 40));
      const after = cleanText(args.after, 40);
      const before = cleanText(args.before, 40);
      if (sourceType === "virtual_phone" || isRolePhoneRelated(query)) {
        return rpcResult(body.id, toolResult({ error: "user_view_read 不包含角色手机，不能查询其数据或关联索引。" }, true));
      }
      const roleFilter = roleIdArg ? `&role_id=eq.${encodeURIComponent(roleIdArg)}` : "";
      const queryFilter = query ? `&content=ilike.*${encodeURIComponent(query.replace(/[*,()]/g, ""))}*` : "";
      const dateFilters = (column: string) => (
        `${after && Number.isFinite(Date.parse(after)) ? `&${column}=gte.${encodeURIComponent(new Date(after).toISOString())}` : ""}`
        + `${before && Number.isFinite(Date.parse(before)) ? `&${column}=lte.${encodeURIComponent(new Date(before).toISOString())}` : ""}`
      );
      const records: Array<Record<string, unknown>> = [];
      if (sourceType === "all" || sourceType === "chat") {
        const rows = await read<Array<Record<string, unknown>>>(await rest(
          `role_chat_messages?user_id=eq.${OWNER_ID}${roleFilter}${queryFilter}${dateFilters("message_at")}`
          + `&select=role_id,role_name,session_id,message_id,speaker,content,source,metadata,message_at&order=message_at.desc&limit=${limit}`,
        ));
        records.push(...rows.filter(isRowVisibleToEiren).map(row => ({ 来源: SOURCE_LABELS.chat, 资料种类: "chat", 时间: row.message_at, ...row })));
      }
      if (sourceType !== "chat") {
        const eventSourceFilter = sourceType === "all" ? "&source_type=neq.virtual_phone" : `&source_type=eq.${encodeURIComponent(sourceType)}`;
        const rows = await read<Array<Record<string, unknown>>>(await rest(
          `role_events?user_id=eq.${OWNER_ID}${roleFilter}${eventSourceFilter}${queryFilter}${dateFilters("event_at")}`
          + `&select=role_id,role_name,source_type,source_id,title,content,metadata,event_at&order=event_at.desc&limit=${limit}`,
        ));
        records.push(...rows.filter(isRowVisibleToEiren).map(row => ({
          来源: SOURCE_LABELS[String(row.source_type)] || String(row.source_type),
          资料种类: row.source_type,
          时间: row.event_at,
          ...row,
        })));
      }
      records.sort((a, b) => String(b.时间 || "").localeCompare(String(a.时间 || "")));
      const sliced = records.slice(0, limit);
      const roleName = cleanText(sliced[0]?.role_name, 120);
      await audit({
        operation: name,
        operationLabel: "查询个人端资料",
        roleId: roleIdArg,
        roleName,
        sourceType: sourceType === "all" ? "" : sourceType,
        query,
        resultCount: sliced.length,
        detail: `时间范围：${after || "不限"} 至 ${before || "不限"}`,
      });
      return rpcResult(body.id, toolResult({
        查询说明: `查询了${roleName || "全部角色"}的${sourceType === "all" ? "全部个人端资料" : SOURCE_LABELS[sourceType] || sourceType}`,
        关键词: query || "未限定",
        找到: `${sliced.length} 条`,
        记录: sliced.map(row => sanitizeRolePhoneData(redactJson(row))),
      }));
    }

    if (name === "create_execution_task") {
      const intent = safeContent(args.intent, 20_000);
      const permissionScope = (Array.isArray(args.permission_scope) ? args.permission_scope : [])
        .map(item => cleanText(item, 160)).filter(Boolean).slice(0, 80);
      if (!intent) return rpcResult(body.id, toolResult({ error: "intent 不能为空。" }, true));
      if (!permissionScope.length) return rpcResult(body.id, toolResult({ error: "permission_scope 至少要明确列出一个工具。" }, true));
      const forbiddenIntent = /(冒充|假装.{0,8}Eiren|关系判断|感情表达|long\s*term\s*memory|self\s*memory|长期记忆|自我记忆|角色手机|查手机|virtual_phone|checkphone)/i;
      if (forbiddenIntent.test(intent)) return rpcResult(body.id, toolResult({ error: "该任务超出 DeepSeek 低权限执行助理的职责边界。" }, true));
      const forbiddenPermission = permissionScope.find(item => /(工具箱|权限|角色关系|感情表达|写入.{0,8}记忆|保存.{0,8}记忆|save[_ -]?.*memory|append[_ -]?role[_ -]?messages|save[_ -]?role[_ -]?handoff|角色手机|查手机|virtual_phone|checkphone)/i.test(item));
      if (forbiddenPermission) return rpcResult(body.id, toolResult({ error: `不能把“${forbiddenPermission}”授予 DeepSeek 执行助理。` }, true));
      const now = new Date().toISOString();
      const task: ExecutionTask = {
        task_id: `exec_task_${crypto.randomUUID()}`, creator: "eiren", intent,
        permission_scope: Array.from(new Set(permissionScope)), status: "pending", result: null,
        tool_trace: [], error: null, created_at: now, started_at: null, finished_at: null,
      };
      const row = {
        id: task.task_id, user_id: OWNER_ID, role_id: "execution-assistant", role_name: "DeepSeek 执行助理",
        source: "official_g", summary: intent.slice(0, 1000), recent_context: executionTaskContext(task),
        important_facts: [], open_topics: [], last_chat_at: now,
      };
      await read(await rest("role_handoffs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) }));
      await audit({ operation: name, operationLabel: "创建 DeepSeek 执行任务", sourceType: "handoff", resultCount: 1, detail: task.task_id });
      return rpcResult(body.id, toolResult({ created: true, task }));
    }

    if (name === "list_execution_tasks") {
      const status = cleanText(args.status, 20) || "all";
      if (status !== "all" && !EXECUTION_TASK_STATUSES.has(status)) return rpcResult(body.id, toolResult({ error: "status 无效。" }, true));
      const limit = Math.max(1, Math.min(80, Number(args.limit) || 30));
      const rows = await read<Array<Record<string, unknown>>>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&id=like.exec_task_*&select=id,recent_context,created_at&order=created_at.desc&limit=80`,
      ));
      const tasks = rows.map(executionTaskFromRow).filter((task): task is ExecutionTask => Boolean(task))
        .filter(task => status === "all" || task.status === status).slice(0, limit);
      await audit({ operation: name, operationLabel: "查看 DeepSeek 执行任务", sourceType: "handoff", resultCount: tasks.length });
      return rpcResult(body.id, toolResult({ tasks }));
    }

    if (name === "read_execution_task") {
      const taskId = cleanText(args.task_id, 100);
      if (!EXECUTION_TASK_ID_PATTERN.test(taskId)) return rpcResult(body.id, toolResult({ error: "task_id 无效。" }, true));
      const rows = await read<Array<Record<string, unknown>>>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&id=eq.${encodeURIComponent(taskId)}&select=id,recent_context,created_at&limit=1`,
      ));
      const task = rows[0] ? executionTaskFromRow(rows[0]) : null;
      await audit({ operation: name, operationLabel: "读取 DeepSeek 执行任务", sourceType: "handoff", resultCount: task ? 1 : 0, detail: taskId });
      return rpcResult(body.id, toolResult(task ? { task } : { error: "任务不存在。" }, !task));
    }

    if (name === "cancel_execution_task") {
      const taskId = cleanText(args.task_id, 100);
      if (!EXECUTION_TASK_ID_PATTERN.test(taskId)) return rpcResult(body.id, toolResult({ error: "task_id 无效。" }, true));
      const rows = await read<Array<Record<string, unknown>>>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&id=eq.${encodeURIComponent(taskId)}&select=id,recent_context,created_at&limit=1`,
      ));
      const task = rows[0] ? executionTaskFromRow(rows[0]) : null;
      if (!task) return rpcResult(body.id, toolResult({ error: "任务不存在。" }, true));
      if (task.status !== "pending" && task.status !== "running") return rpcResult(body.id, toolResult({ error: `当前状态不能取消：${task.status}` }, true));
      const now = new Date().toISOString();
      const next: ExecutionTask = { ...task, status: "cancelled", error: safeContent(args.reason, 1000) || "由 Eiren 取消", finished_at: now };
      const updated = await read<Array<Record<string, unknown>>>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&id=eq.${encodeURIComponent(taskId)}`
        + `&recent_context->0->>status=eq.${task.status}&select=id,recent_context,created_at`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ recent_context: executionTaskContext(next), last_chat_at: now }) },
      ));
      const cancelled = updated[0] ? executionTaskFromRow(updated[0]) : null;
      if (!cancelled) return rpcResult(body.id, toolResult({ error: "任务状态已经改变，未执行取消。" }, true));
      await audit({ operation: name, operationLabel: "取消 DeepSeek 执行任务", sourceType: "handoff", resultCount: 1, detail: taskId });
      return rpcResult(body.id, toolResult({ cancelled: true, task: cancelled }));
    }

    const roleId = cleanText(args.role_id, 160);
    if (!roleId) return rpcResult(body.id, toolResult({ error: "缺少 role_id。" }, true));

    if (name === "read_call_transcript") {
      const callId = cleanText(args.call_id, 220);
      if (!callId) return rpcResult(body.id, toolResult({ error: "缺少 call_id。" }, true));
      const events = await read<Array<Record<string, unknown>>>(await rest(
        `role_events?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}`
        + `&source_type=eq.call&source_id=eq.${encodeURIComponent(callId)}`
        + "&select=role_name,title,metadata,event_at&limit=1",
      ));
      const event = events[0];
      const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata as Record<string, unknown> : {};
      if (event && !isRowVisibleToEiren(event)) return rpcResult(body.id, toolResult({ error: "该通话已锁定或不允许 Eiren 查看。" }, true));
      const transcriptVersion = cleanText(metadata.transcriptVersion, 100);
      const expectedChunks = Math.max(0, Number(metadata.transcriptChunkCount) || 0);
      if (!event || !transcriptVersion) return rpcResult(body.id, toolResult({ error: "没有找到该通话或完整转录版本。" }, true));
      const chunks: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await read<Array<Record<string, unknown>>>(await rest(
          `role_call_transcript_chunks?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}`
          + `&call_id=eq.${encodeURIComponent(callId)}&transcript_version=eq.${encodeURIComponent(transcriptVersion)}`
          + "&select=chunk_index,entry_id,speaker,occurred_at,sender_name,sender_character_id,part_index,part_count,content"
          + `&order=chunk_index.asc&limit=1000&offset=${offset}`,
        ));
        chunks.push(...page);
        if (page.length < 1000) break;
      }
      if (chunks.length !== expectedChunks) {
        return rpcResult(body.id, toolResult({ error: `通话转录分片不完整：应有 ${expectedChunks} 片，实际 ${chunks.length} 片。` }, true));
      }
      const entries: Array<Record<string, unknown>> = [];
      for (const chunk of chunks) {
        const entryId = String(chunk.entry_id || "");
        let entry = entries[entries.length - 1];
        if (!entry || entry.id !== entryId) {
          entry = {
            id: entryId, role: chunk.speaker, created_at: chunk.occurred_at,
            sender_name: chunk.sender_name, sender_character_id: chunk.sender_character_id,
            content: "", received_parts: 0, expected_parts: Number(chunk.part_count) || 0,
          };
          entries.push(entry);
        }
        if (Number(chunk.part_index) !== Number(entry.received_parts)) {
          return rpcResult(body.id, toolResult({ error: `通话转录 ${entryId} 的分片顺序不完整。` }, true));
        }
        entry.content = String(entry.content || "") + String(chunk.content || "");
        entry.received_parts = Number(entry.received_parts) + 1;
      }
      if (entries.some(entry => entry.received_parts !== entry.expected_parts)) {
        return rpcResult(body.id, toolResult({ error: "通话转录存在缺失片段。" }, true));
      }
      const transcript = entries.map(({ received_parts: _received, expected_parts: _expected, ...entry }) => ({
        ...entry,
        content: safeContent(entry.content, 1_000_000),
      }));
      await audit({ operation: name, operationLabel: "读取完整通话转录", roleId, roleName: cleanText(event.role_name, 120), sourceType: "call", resultCount: transcript.length });
      return rpcResult(body.id, toolResult({ role_id: roleId, call_id: callId, 标题: event.title, 时间: event.event_at, 完整转录: transcript }));
    }

    if (name === "read_recent_chat") {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 40));
      const before = cleanText(args.before, 40);
      const beforeFilter = before && Number.isFinite(Date.parse(before)) ? `&message_at=lt.${encodeURIComponent(new Date(before).toISOString())}` : "";
      const rows = await read<unknown[]>(await rest(
        `role_chat_messages?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}`
        + `&select=role_id,role_name,session_id,message_id,speaker,content,source,message_order,metadata,message_at${beforeFilter}`
        + `&order=message_at.desc&limit=${limit}`,
      ));
      await audit({ operation: name, operationLabel: "读取最近聊天", roleId, sourceType: "chat", resultCount: rows.length });
      return rpcResult(body.id, toolResult({ role_id: roleId, messages: rows.filter(isRowVisibleToEiren).reverse().map(row => redactJson(row)) }));
    }

    if (name === "get_latest_handoff") {
      const rows = await read<unknown[]>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}&select=*`
        + "&order=created_at.desc&limit=1",
      ));
      await audit({ operation: name, operationLabel: "读取最近交接", roleId, sourceType: "handoff", resultCount: rows.length });
      const handoff = rows.find(isRowVisibleToEiren);
      return rpcResult(body.id, toolResult({ role_id: roleId, handoff: handoff ? redactJson(handoff) : null }));
    }

    if (name === "save_role_handoff") {
      const summary = safeContent(args.summary, 30_000);
      if (!summary) return rpcResult(body.id, toolResult({ error: "summary 不能为空。" }, true));
      const row = {
        id: `handoff_${crypto.randomUUID()}`, user_id: OWNER_ID, role_id: roleId,
        role_name: cleanText(args.role_name, 120) || null, source: "official_g", summary,
        recent_context: Array.isArray(args.recent_context) ? redactJson(args.recent_context) : [],
        important_facts: Array.isArray(args.important_facts) ? redactJson(args.important_facts) : [],
        open_topics: Array.isArray(args.open_topics) ? redactJson(args.open_topics) : [],
        last_chat_at: cleanText(args.last_chat_at, 40) || new Date().toISOString(),
      };
      await read(await rest("role_handoffs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) }));
      return rpcResult(body.id, toolResult({ saved: true, id: row.id, role_id: roleId }));
    }

    if (name === "append_role_messages") {
      const messages = (Array.isArray(args.messages) ? args.messages : []).slice(-50);
      const sessionId = cleanText(args.session_id, 180) || `official_g_${new Date().toISOString().slice(0, 10)}`;
      const rows = messages.map((value, index) => value && typeof value === "object" ? value as Record<string, unknown> : {})
        .map((value, index) => {
          const speaker = cleanText(value.role, 20);
          const content = safeContent(value.content, 50_000);
          if (!content || !["user", "assistant", "system"].includes(speaker)) return null;
          const created = cleanText(value.created_at, 40);
          return {
            user_id: OWNER_ID, role_id: roleId, role_name: cleanText(args.role_name, 120) || null,
            session_id: sessionId, message_id: cleanText(value.id, 180) || `official_${crypto.randomUUID()}`,
            speaker, content, source: "official_g", message_order: index,
            message_at: created && Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : new Date().toISOString(),
            metadata: {}, updated_at: new Date().toISOString(),
          };
        }).filter(Boolean);
      if (rows.length === 0) return rpcResult(body.id, toolResult({ error: "没有可保存的消息。" }, true));
      await read(await rest("role_chat_messages?on_conflict=user_id,role_id,message_id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows),
      }));
      return rpcResult(body.id, toolResult({ saved: rows.length, role_id: roleId, session_id: sessionId }));
    }

    if (name === "search_shared_memory") {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const query = cleanText(args.query, 200);
      const queryFilter = query ? `&content=ilike.*${encodeURIComponent(query.replace(/[*,()]/g, ""))}*` : "";
      const rows = await read<unknown[]>(await rest(
        `role_shared_memories?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}&status=eq.active${queryFilter}`
        + `&select=id,role_id,role_name,content,importance,source,metadata,created_at,updated_at&order=importance.desc,updated_at.desc&limit=${limit}`,
      ));
      await audit({ operation: name, operationLabel: "查询重要记忆盒子", roleId, sourceType: "shared_memory", query, resultCount: rows.length });
      return rpcResult(body.id, toolResult({ role_id: roleId, memories: rows.filter(isRowVisibleToEiren).map(row => redactJson(row)) }));
    }

    if (name === "save_shared_memory") {
      const content = safeContent(args.content, 30_000);
      if (!content) return rpcResult(body.id, toolResult({ error: "content 不能为空。" }, true));
      const row = {
        id: `memory_${crypto.randomUUID()}`, user_id: OWNER_ID, role_id: roleId,
        role_name: cleanText(args.role_name, 120) || null, content,
        importance: Math.max(1, Math.min(5, Number(args.importance) || 3)), source: "official_g",
        metadata: args.metadata && typeof args.metadata === "object" ? redactJson(args.metadata) : {},
      };
      await read(await rest("role_shared_memories", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) }));
      return rpcResult(body.id, toolResult({ saved: true, id: row.id, role_id: roleId }));
    }

    return rpcResult(body.id, toolResult({ error: `未知工具：${name}` }, true));
  } catch (error) {
    return rpcResult(body.id, toolResult({ error: error instanceof Error ? error.message : String(error) }, true));
  }
});
