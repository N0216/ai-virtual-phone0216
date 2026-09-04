import {
  collectCallRoleEvents,
  collectCustomAppRoleEvents,
  collectDiaryRoleEvents,
  collectMomentsRoleEvents,
  collectOfflineChatRoleEvents,
  collectVirtualPhoneRoleEvents,
  type RoleEventCollectionContext,
} from "./role-event-collectors";
import { createLegacyRoleEventSourceAdapter, type RoleEventSourceAdapter } from "./role-event-source-adapter";
export type { RoleCloudEvent, RoleCloudEventSource } from "./role-event-types";

/**
 * Source-specific collectors behind a compatibility adapter. The default path
 * keeps every existing local source and the deployed v6 payload unchanged.
 */
export async function collectRoleCloudEvents(
  suppliedAdapter: RoleEventSourceAdapter = createLegacyRoleEventSourceAdapter(),
) {
  const characters = suppliedAdapter.loadCharacters();
  const names = new Map(characters.map(character => [character.id, character.name || character.id]));
  const contacts = suppliedAdapter.loadChatContacts();
  const sessions = suppliedAdapter.loadChatSessions();
  const roleBySession = new Map(sessions.map(session => {
    if (session.isGroup) return [session.id, {
      roleId: `group:${session.id}`,
      roleName: session.alias?.trim() || session.groupName?.trim() || "群聊",
    }] as const;
    const roleId = contacts.find(contact => contact.id === session.contactId)?.characterId || "";
    return [session.id, roleId ? { roleId, roleName: names.get(roleId) || roleId } : null] as const;
  }));
  const context: RoleEventCollectionContext = { adapter: suppliedAdapter, names, roleBySession };
  const [calls, virtualPhone] = await Promise.all([
    collectCallRoleEvents(context),
    collectVirtualPhoneRoleEvents(context),
  ]);
  return [
    ...calls,
    ...collectOfflineChatRoleEvents(context),
    ...collectCustomAppRoleEvents(context),
    ...collectDiaryRoleEvents(context),
    ...collectMomentsRoleEvents(context),
    ...virtualPhone,
  ].sort((a, b) => a.eventAt.localeCompare(b.eventAt));
}
