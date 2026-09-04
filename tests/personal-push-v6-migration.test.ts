// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(resolve(root, "public/ai-phone-push/schema-v6.sql"), "utf8");
const baseSchema = readFileSync(resolve(root, "public/ai-phone-push/schema.sql"), "utf8");
const gateway = readFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), "utf8");
const deployRoute = readFileSync(resolve(root, "app/api/push/deploy-personal/route.ts"), "utf8");

test("v6 migration is transactional, minimal and preserves legacy screen sessions", () => {
  assert.match(migration, /^-- ai-phone-personal-push-schema-v6-migration[\s\S]*?\nbegin;/);
  assert.match(migration.trimEnd(), /commit;$/);
  assert.doesNotMatch(migration, /drop\s+table/i);
  assert.doesNotMatch(migration, /push_screen_sessions/i);
  assert.doesNotMatch(migration, /push_jobs_kind_check/i);
  assert.doesNotMatch(migration, /ai_phone_screen_chat_/i);
  assert.doesNotMatch(migration, /cron\.(?:schedule|unschedule)/i);
  assert.doesNotMatch(baseSchema, /drop\s+table\s+if\s+exists\s+public\.push_screen_sessions/i);
});

test("v6 marks the schema version only after structural verification", () => {
  const verifyAt = migration.indexOf("health := public.ai_phone_schema_v6_health()");
  const versionAt = migration.indexOf("values ('personal-cloud', 6, now())");
  const commitAt = migration.lastIndexOf("commit;");
  assert.ok(verifyAt >= 0);
  assert.ok(versionAt > verifyAt);
  assert.ok(commitAt > versionAt);
  assert.equal(migration.slice(versionAt + 1, commitAt).includes("create table"), false);
  assert.match(migration, /alter table public\.role_call_transcript_chunks enable row level security/);
  assert.match(migration, /revoke all on table public\.role_call_transcript_chunks from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table/);
});

test("gateway health checks the real v6 catalog health function", () => {
  const healthBlock = gateway.slice(gateway.indexOf('if (action === "health")'), gateway.indexOf('if (action === "role-memory-access"'));
  assert.match(healthBlock, /rpc\/ai_phone_schema_v6_health/);
  assert.match(healthBlock, /schemaV6Health\?\.ready !== true/);
  assert.match(healthBlock, /return json\([\s\S]*503\)/);
});

test("chunk upload never deletes old versions and finalize verifies the active parent first", () => {
  const uploadAt = gateway.indexOf('if (action === "role-call-transcript-sync"');
  const finalizeAt = gateway.indexOf('if (action === "role-call-transcript-finalize"');
  const eventsAt = gateway.indexOf('if (action === "role-events-sync"');
  const uploadBlock = gateway.slice(uploadAt, finalizeAt);
  const finalizeBlock = gateway.slice(finalizeAt, eventsAt);
  assert.ok(uploadAt >= 0 && finalizeAt > uploadAt && eventsAt > finalizeAt);
  assert.doesNotMatch(uploadBlock, /method:\s*"DELETE"/);
  assert.match(finalizeBlock, /source_type=eq\.call/);
  assert.match(finalizeBlock, /activeVersion !== transcriptVersion/);
  assert.ok(finalizeBlock.indexOf("activeVersion !== transcriptVersion") < finalizeBlock.indexOf('method: "DELETE"'));
});

test("existing personal clouds run only v6 migration while new projects initialize first", () => {
  assert.match(deployRoute, /if \(!dedicatedProject\.initialized\)/);
  assert.match(deployRoute, /query: schemaSql\.replaceAll/);
  assert.match(deployRoute, /query: schemaV6Sql/);
  assert.ok(deployRoute.indexOf("if (!dedicatedProject.initialized)") < deployRoute.indexOf("query: schemaV6Sql"));
});
