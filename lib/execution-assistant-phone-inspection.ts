import type { DesktopIconId } from "./desktop-config";

export const EXECUTION_ASSISTANT_INSPECTION_START_EVENT = "ai-phone-execution-inspection-start";
export const EXECUTION_ASSISTANT_INSPECTION_STEP_EVENT = "ai-phone-execution-inspection-step";
export const EXECUTION_ASSISTANT_INSPECTION_END_EVENT = "ai-phone-execution-inspection-end";

export type ExecutionAssistantInspectionStart = {
    taskId: string;
    intent: string;
    assistantName: string;
};

export type ExecutionAssistantInspectionStep = {
    taskId: string;
    toolName: string;
    label: string;
    targetApp: DesktopIconId | null;
};

export type ExecutionAssistantInspectionEnd = {
    taskId: string;
    outcome: "succeeded" | "failed" | "cancelled";
};

const INTERACTION_TOOLS = new Set(["列出可查看的互动", "查看最近聊天", "查看通话内容"]);
const PHONE_MANAGEMENT_TOOLS = new Set(["查看小手机设置", "查看设备操作日志"]);
const LOCAL_LIBRARY_TOOLS = new Set(["列出资料目录", "读取资料文件", "查看资料字段", "搜索资料记录", "读取资料记录"]);

export function inspectionTargetForTool(toolName: string): Pick<ExecutionAssistantInspectionStep, "label" | "targetApp"> {
    if (INTERACTION_TOOLS.has(toolName)) return { label: "正在查看获准的互动内容", targetApp: "chat" };
    if (PHONE_MANAGEMENT_TOOLS.has(toolName)) return { label: "正在查看小手机状态与操作记录", targetApp: "settings" };
    if (LOCAL_LIBRARY_TOOLS.has(toolName)) return { label: "正在查看获准的本地资料", targetApp: "resources" };
    if (toolName === "角色电脑") return { label: "正在查看获准的文件与电脑资料", targetApp: "resources" };
    if (/Reality Bridge|现实桥|快捷指令/iu.test(toolName)) return { label: "正在处理现实桥任务", targetApp: "realitybridge" };
    return { label: `正在调用「${toolName}」`, targetApp: null };
}

function dispatch<T>(name: string, detail: T): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

export function beginExecutionAssistantInspection(detail: ExecutionAssistantInspectionStart): void {
    dispatch(EXECUTION_ASSISTANT_INSPECTION_START_EVENT, detail);
}

export function reportExecutionAssistantInspectionStep(taskId: string, toolName: string): void {
    const target = inspectionTargetForTool(toolName);
    dispatch<ExecutionAssistantInspectionStep>(EXECUTION_ASSISTANT_INSPECTION_STEP_EVENT, {
        taskId,
        toolName,
        ...target,
    });
}

export function endExecutionAssistantInspection(detail: ExecutionAssistantInspectionEnd): void {
    dispatch(EXECUTION_ASSISTANT_INSPECTION_END_EVENT, detail);
}
