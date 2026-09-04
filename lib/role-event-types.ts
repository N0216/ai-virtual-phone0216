import type { CallTranscriptChunk } from "./call-cloud-sync";

export type RoleCloudEventSource = "offline_chat" | "custom_app" | "diary" | "moments" | "virtual_phone" | "call";

export type RoleCloudEvent = {
  roleId: string;
  roleName: string;
  sourceType: RoleCloudEventSource;
  sourceId: string;
  title: string;
  content: string;
  eventAt: string;
  metadata?: Record<string, unknown>;
  transcriptChunks?: CallTranscriptChunk[];
};

export const ROLE_EVENT_MAX_CONTENT = 30_000;

export function compactRoleEventContent(value: unknown, max = ROLE_EVENT_MAX_CONTENT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text || "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function validRoleEventDate(value: string | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}
