import { loadChatOfflineTurns } from "./chat-offline-storage";
import { loadChatContacts, loadChatSessions } from "./chat-storage";
import { loadPhoneManifest, loadPhoneSnapshot } from "./checkphone-storage";
import { loadCharacters } from "./character-storage";
import { loadCustomAppTimelineEntries } from "./custom-app-storage";
import { loadDiaryEntries } from "./diary-entry-storage";
import { loadAllMomentComments, loadMomentPosts } from "./moments-storage";
import { loadAllBlackMarketTheaterProjectionEntries } from "./black-market-storage";
import { loadLocalCallRecords } from "./call-record-storage";

/** Compatibility adapter for sources that are still stored inside the phone. */
export type RoleEventSourceAdapter = {
  loadCharacters: typeof loadCharacters;
  loadChatContacts: typeof loadChatContacts;
  loadChatSessions: typeof loadChatSessions;
  loadChatOfflineTurns: typeof loadChatOfflineTurns;
  loadCustomAppTimelineEntries: typeof loadCustomAppTimelineEntries;
  loadDiaryEntries: typeof loadDiaryEntries;
  loadAllMomentComments: typeof loadAllMomentComments;
  loadMomentPosts: typeof loadMomentPosts;
  loadAllBlackMarketTheaterProjectionEntries: typeof loadAllBlackMarketTheaterProjectionEntries;
  loadPhoneManifest: typeof loadPhoneManifest;
  loadPhoneSnapshot: typeof loadPhoneSnapshot;
  loadLocalCallRecords: typeof loadLocalCallRecords;
};

export function createLegacyRoleEventSourceAdapter(): RoleEventSourceAdapter {
  return {
    loadCharacters, loadChatContacts, loadChatSessions, loadChatOfflineTurns,
    loadCustomAppTimelineEntries, loadDiaryEntries, loadAllMomentComments,
    loadMomentPosts, loadAllBlackMarketTheaterProjectionEntries,
    loadPhoneManifest, loadPhoneSnapshot, loadLocalCallRecords,
  };
}
