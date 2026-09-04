import { CHECKPHONE_APP_SPECS } from "./checkphone-config";
import { buildCallCloudPayload } from "./call-cloud-sync";
import type { RoleEventSourceAdapter } from "./role-event-source-adapter";
import { compactRoleEventContent as compact, validRoleEventDate as validDate, type RoleCloudEvent } from "./role-event-types";

export type RoleEventCollectionContext = {
  adapter: RoleEventSourceAdapter;
  names: Map<string, string>;
  roleBySession: Map<string, { roleId: string; roleName: string } | null>;
};

export async function collectCallRoleEvents({ adapter, roleBySession }: RoleEventCollectionContext): Promise<RoleCloudEvent[]> {
  const records = (await Promise.all(adapter.loadChatSessions().map(session => adapter.loadLocalCallRecords(session.id)))).flat();
  return records.flatMap(record => {
    const role = roleBySession.get(record.sessionId);
    if (!role) return [];
    const payload = buildCallCloudPayload(record.transcript);
    const label = record.type === "video" ? "视频通话" : "语音通话";
    return [{
      roleId: role.roleId, roleName: role.roleName, sourceType: "call" as const, sourceId: record.id,
      title: `${role.roleId.startsWith("group:") ? "群" : ""}${label}`,
      content: compact([`${label} · ${record.state} · ${record.duration || "时长未知"}`, payload.preview || "（本次通话没有可用转录）"].join("\n")),
      eventAt: validDate(record.endedAt || record.updatedAt || record.startedAt),
      metadata: {
        sessionId: record.sessionId, callType: record.type, callState: record.state,
        initiatorRole: record.initiatorRole, startedAt: record.startedAt, endedAt: record.endedAt,
        duration: record.duration, transcriptVersion: payload.transcriptVersion,
        transcriptChunkCount: payload.chunks.length, transcriptEntryCount: record.transcript.length,
      },
      transcriptChunks: payload.chunks,
    }];
  });
}

export function collectOfflineChatRoleEvents({ adapter, names, roleBySession }: RoleEventCollectionContext): RoleCloudEvent[] {
  return adapter.loadChatSessions().flatMap(session => {
    if (session.isGroup) return [];
    const role = roleBySession.get(session.id);
    if (!role) return [];
    return adapter.loadChatOfflineTurns(session.id).map(turn => ({
      roleId: role.roleId, roleName: names.get(role.roleId) || role.roleName,
      sourceType: "offline_chat" as const, sourceId: turn.id, title: "小手机离线聊天",
      content: compact(`用户：${turn.userContent}\n角色：${turn.assistantContent}${turn.summary ? `\n本轮摘要：${turn.summary}` : ""}`),
      eventAt: validDate(turn.createdAt), metadata: { sessionId: session.id, summaryTag: turn.summaryTag },
    }));
  });
}

export function collectCustomAppRoleEvents({ adapter, names }: RoleEventCollectionContext): RoleCloudEvent[] {
  const events: RoleCloudEvent[] = adapter.loadCustomAppTimelineEntries().flatMap(entry => !entry.characterId ? [] : [{
    roleId: entry.characterId, roleName: names.get(entry.characterId) || entry.characterId,
    sourceType: "custom_app" as const, sourceId: `${entry.appId}:${entry.id}`,
    title: entry.appLabel || entry.appName || "自定义应用",
    content: compact([entry.summary, entry.detail].filter(Boolean).join("\n")),
    eventAt: validDate(entry.createdAt), metadata: { appId: entry.appId, appName: entry.appName, data: entry.data || {} },
  }]);
  for (const entry of adapter.loadAllBlackMarketTheaterProjectionEntries()) {
    if (!entry.characterId) continue;
    const isDream = /梦境|梦/.test(entry.theaterTitle);
    events.push({
      roleId: entry.characterId, roleName: names.get(entry.characterId) || entry.characterId,
      sourceType: "custom_app", sourceId: `black_market_theater:${entry.id}`,
      title: isDream ? `梦境·${entry.theaterTitle}` : `小剧场·${entry.theaterTitle || "剧情记录"}`,
      content: compact(entry.content), eventAt: validDate(entry.timestamp),
      metadata: { appId: "black_market_theater", sessionId: entry.sessionId, theaterTitle: entry.theaterTitle, contentKind: isDream ? "dream" : "story" },
    });
  }
  return events;
}

export function collectDiaryRoleEvents({ adapter, names }: RoleEventCollectionContext): RoleCloudEvent[] {
  return adapter.loadDiaryEntries().flatMap(entry => !entry.characterId ? [] : [{
    roleId: entry.characterId, roleName: entry.characterName || names.get(entry.characterId) || entry.characterId,
    sourceType: "diary" as const, sourceId: entry.id, title: entry.title || "角色日记",
    content: compact(entry.body), eventAt: validDate(entry.createdAt),
    metadata: { mood: entry.mood, weather: entry.weather, tags: entry.tags, trigger: entry.trigger },
  }]);
}

export function collectMomentsRoleEvents({ adapter, names }: RoleEventCollectionContext): RoleCloudEvent[] {
  const comments = adapter.loadAllMomentComments();
  const events: RoleCloudEvent[] = [];
  for (const post of adapter.loadMomentPosts()) {
    const roleIds = new Set<string>();
    if (post.authorType === "character") roleIds.add(post.authorId);
    post.visibility.forEach(id => names.has(id) && roleIds.add(id));
    for (const roleId of roleIds) {
      const related = comments.filter(comment => comment.postId === post.id);
      events.push({
        roleId, roleName: names.get(roleId) || roleId, sourceType: "moments", sourceId: `${post.id}:${roleId}`,
        title: "朋友圈动态", content: compact([post.content, ...related.map(item => `${item.authorName || item.authorId}：${item.content}`)].join("\n")),
        eventAt: validDate(post.createdAt), metadata: { authorType: post.authorType, authorId: post.authorId, location: post.location || "" },
      });
    }
  }
  return events;
}

export async function collectVirtualPhoneRoleEvents({ adapter, names }: RoleEventCollectionContext): Promise<RoleCloudEvent[]> {
  const events: RoleCloudEvent[] = [];
  for (const [roleId, roleName] of names) {
    const manifest = await adapter.loadPhoneManifest(roleId);
    if (!manifest) continue;
    for (const appId of manifest.allAppIds) {
      const snapshot = await adapter.loadPhoneSnapshot(roleId, appId);
      if (!snapshot) continue;
      const label = CHECKPHONE_APP_SPECS[appId]?.label || appId;
      events.push({
        roleId, roleName, sourceType: "virtual_phone", sourceId: `${appId}:${snapshot.updatedAt || snapshot.generatedAt}`,
        title: `角色手机·${label}`, content: compact(snapshot.summary || snapshot.payload),
        eventAt: validDate(snapshot.updatedAt || snapshot.generatedAt), metadata: { appId, snapshotId: snapshot.id },
      });
    }
  }
  return events;
}
