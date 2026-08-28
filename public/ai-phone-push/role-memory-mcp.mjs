// 角色记忆交接 MCP
// 部署在用户自己的 Supabase 项目中；仅接受个人云生成的 Bearer token。

const OWNER_ID = "owner";
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
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[已隐藏访问令牌]");
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
      .map(([key, item]) => [key, redactJson(item, depth + 1)]));
  }
  return value;
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
  if (body.method === "tools/list") return rpcResult(body.id, { tools: TOOLS });
  if (body.method !== "tools/call") return rpcError(body.id, -32601, "Method not found");

  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
  const name = cleanText(params.name, 80);
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  try {
    if (name === "list_roles") {
      const [chatRows, handoffRows, memoryRows] = await Promise.all([
        read<Array<Record<string, unknown>>>(await rest(
          `role_chat_messages?user_id=eq.${OWNER_ID}&select=role_id,role_name,message_at&order=message_at.desc&limit=2000`,
        )),
        read<Array<Record<string, unknown>>>(await rest(
          `role_handoffs?user_id=eq.${OWNER_ID}&select=role_id,role_name,created_at&order=created_at.desc&limit=500`,
        )),
        read<Array<Record<string, unknown>>>(await rest(
          `role_shared_memories?user_id=eq.${OWNER_ID}&status=eq.active&select=role_id,role_name,updated_at&order=updated_at.desc&limit=1000`,
        )),
      ]);
      const roles = new Map<string, Record<string, unknown>>();
      for (const row of [...chatRows, ...handoffRows, ...memoryRows]) {
        const roleId = cleanText(row.role_id, 160);
        if (!roleId || roles.has(roleId)) continue;
        roles.set(roleId, {
          role_id: roleId,
          role_name: cleanText(row.role_name, 120) || roleId,
          latest_at: row.message_at || row.created_at || row.updated_at || null,
        });
      }
      return rpcResult(body.id, toolResult({ roles: [...roles.values()] }));
    }

    const roleId = cleanText(args.role_id, 160);
    if (!roleId) return rpcResult(body.id, toolResult({ error: "缺少 role_id。" }, true));

    if (name === "read_recent_chat") {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 40));
      const before = cleanText(args.before, 40);
      const beforeFilter = before && Number.isFinite(Date.parse(before)) ? `&message_at=lt.${encodeURIComponent(new Date(before).toISOString())}` : "";
      const rows = await read<unknown[]>(await rest(
        `role_chat_messages?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}`
        + `&select=role_id,role_name,session_id,message_id,speaker,content,source,message_order,metadata,message_at${beforeFilter}`
        + `&order=message_at.desc&limit=${limit}`,
      ));
      return rpcResult(body.id, toolResult({ role_id: roleId, messages: rows.reverse() }));
    }

    if (name === "get_latest_handoff") {
      const rows = await read<unknown[]>(await rest(
        `role_handoffs?user_id=eq.${OWNER_ID}&role_id=eq.${encodeURIComponent(roleId)}&select=*`
        + "&order=created_at.desc&limit=1",
      ));
      return rpcResult(body.id, toolResult({ role_id: roleId, handoff: rows[0] || null }));
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
      return rpcResult(body.id, toolResult({ role_id: roleId, memories: rows }));
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
