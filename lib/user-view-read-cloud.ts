import { getInternalCapability } from "./internal-capability-storage";
import { isPersonalPushCloudActive, personalPushFetch } from "./personal-push-cloud";
import { USER_VIEW_READ_CAPABILITY_ID } from "./user-view-read";

export async function syncUserViewReadPolicyToCloud(enabled?: boolean): Promise<void> {
    if (!isPersonalPushCloudActive()) return;
    const capability = getInternalCapability(USER_VIEW_READ_CAPABILITY_ID);
    const resolved = enabled ?? Boolean(capability?.enabled && capability.mode !== "off");
    const response = await personalPushFetch("user-view-read-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: resolved }),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !data?.ok) throw new Error(data?.error || "本人视角只读策略同步失败");
}
