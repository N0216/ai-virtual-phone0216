export type CallTranscriptVersionCommitSteps = {
  uploadNewVersion: () => Promise<void>;
  switchParentVersion: () => Promise<void>;
  cleanupOldVersions: () => Promise<void>;
};

/**
 * Preserve the previously readable transcript until the parent role_event has
 * durably switched to the new version. Cleanup is intentionally last: a
 * cleanup failure only leaves harmless old rows for a retry, while an upload
 * or parent failure can never remove the currently referenced transcript.
 */
export async function commitCallTranscriptVersion(steps: CallTranscriptVersionCommitSteps): Promise<void> {
  await steps.uploadNewVersion();
  await steps.switchParentVersion();
  await steps.cleanupOldVersions();
}
