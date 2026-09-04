// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { commitCallTranscriptVersion } from "../lib/call-cloud-commit.ts";

function steps(log, failAt) {
  const run = name => async () => {
    log.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
  };
  return {
    uploadNewVersion: run("upload"),
    switchParentVersion: run("parent"),
    cleanupOldVersions: run("cleanup"),
  };
}

test("commits a call transcript in upload, parent switch, cleanup order", async () => {
  const log = [];
  await commitCallTranscriptVersion(steps(log));
  assert.deepEqual(log, ["upload", "parent", "cleanup"]);
});

test("does not switch the parent or clean old rows when upload fails", async () => {
  const log = [];
  await assert.rejects(commitCallTranscriptVersion(steps(log, "upload")), /upload failed/);
  assert.deepEqual(log, ["upload"]);
});

test("does not clean old rows when the parent version switch fails", async () => {
  const log = [];
  await assert.rejects(commitCallTranscriptVersion(steps(log, "parent")), /parent failed/);
  assert.deepEqual(log, ["upload", "parent"]);
});

test("reports cleanup failure only after the new parent version is durable", async () => {
  const log = [];
  await assert.rejects(commitCallTranscriptVersion(steps(log, "cleanup")), /cleanup failed/);
  assert.deepEqual(log, ["upload", "parent", "cleanup"]);
});
