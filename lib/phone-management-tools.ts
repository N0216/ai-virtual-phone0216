type PhoneManagementScope = "summary" | "appearance" | "desktop" | "chat" | "call" | "entry";

export type PhoneManagementQuery = {
    scope?: PhoneManagementScope;
    sessionName?: string;
    characterId?: string;
};

export type PhoneManagementContext = {
    sessionId?: string;
    characterId?: string;
    characterDisplayName?: string;
};

type PhoneThemeProfile = {
    name?: string;
    wallpaperAssetId?: string | null;
    wallpaperBlur?: number;
    wallpaperOpacity?: number;
    wallpaperScale?: number;
    wallpaperX?: number;
    wallpaperY?: number;
    wallpaperLibrary?: unknown[];
    fontAssetId?: string | null;
    fontFamily?: string;
    hideTopBar?: boolean;
    statusBarDropPx?: number;
    cssOverrides?: Record<string, string>;
    globalCustomCSS?: string;
    enableGlobalShadows?: boolean;
    enableGlobalBorder?: boolean;
    globalBorderColor?: string;
};

type PhoneEntrySettings = {
    activeSplashPresetId: string;
    splashPresets: Array<{ id: string; name: string; css: string; background: string; foreground: string; durationMs: number }>;
};

type PhoneChatContact = { id: string; characterId: string; nickname?: string };
type PhoneChatSession = {
    id: string;
    contactId: string;
    updatedAt?: string;
    alias?: string;
    isGroup?: boolean;
    groupName?: string;
    participantIds?: string[];
    backgroundImage?: string;
    customCSS?: string;
    isMuted?: boolean;
    bilingualTranslationEnabled?: boolean;
    collapseBilingualTranslation?: boolean;
    voiceBackground?: string;
    voiceCallLanguage?: string;
    voiceCallTranslationLanguage?: string;
    voiceCallAppearance?: {
        visualStyle?: "original" | "noir";
        showLatinName?: boolean;
        latinName?: string;
        captionFont?: "serif" | "system" | "rounded";
        orbTone?: "mist" | "lilac" | "blue" | "rose";
    };
    callRecordStyle?: "original" | "wechat";
    callRecordTemplates?: Record<string, string>;
    callRecordAppearance?: Record<string, string>;
};

type PhoneStatusRegion = { mode: "native" | "off" | "custom"; contract: string; renderHtml: string; previewRaw?: string };
type PhoneDesktopState = {
    pages: Record<string, Array<{ id: string; row: number; col: number }>>;
    dock: string[];
    folders: Record<string, { name: string; icons: string[] }>;
    widgets: Array<{ id: string; type: string; size: string; page: number; row: number; col: number }>;
    diyTemplateCount: number;
};

export type PhoneManagementReadDeps = {
    readTheme(): Promise<PhoneThemeProfile> | PhoneThemeProfile;
    readEntry(): Promise<{ settings: PhoneEntrySettings; activePreset: PhoneEntrySettings["splashPresets"][number] }>
        | { settings: PhoneEntrySettings; activePreset: PhoneEntrySettings["splashPresets"][number] };
    readDesktop(): Promise<PhoneDesktopState>;
    readChatSessions(): Promise<PhoneChatSession[]>;
    readChatContacts(): Promise<PhoneChatContact[]>;
    readCharacterLabels(): Promise<Record<string, string>> | Record<string, string>;
    readStatusRegion(sessionId: string): Promise<PhoneStatusRegion> | PhoneStatusRegion;
};

export type PhoneManagementToolResult = {
    name: "查看小手机设置" | "修改小手机设置" | "撤销小手机设置修改";
    success: boolean;
    data?: string;
    error?: string;
    userNotice?: string;
};

export type PhoneSettingsWriteScope = "chat" | "call";

export type PhoneSettingsChange = {
    scope?: PhoneSettingsWriteScope;
    sessionName?: string;
    characterId?: string;
    updates?: Record<string, unknown>;
};

export type PhoneSettingsUndoRequest = {
    undoId?: string;
    sessionName?: string;
    characterId?: string;
};

type PhoneSettingsUndoRecord = {
    id: string;
    sessionId: string;
    characterId?: string;
    displayName: string;
    scope: PhoneSettingsWriteScope;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    changedKeys: string[];
    createdAt: string;
    undoneAt?: string;
};

type AbsentPhoneSetting = { __phoneSettingAbsent: true };
const ABSENT_PHONE_SETTING: AbsentPhoneSetting = { __phoneSettingAbsent: true };

export type PhoneManagementWriteDeps = {
    readChatSessions(): Promise<PhoneChatSession[]>;
    readChatContacts(): Promise<PhoneChatContact[]>;
    readCharacterLabels(): Promise<Record<string, string>> | Record<string, string>;
    writeChatSessions(sessions: PhoneChatSession[]): Promise<void>;
    readUndoHistory(): Promise<PhoneSettingsUndoRecord[]> | PhoneSettingsUndoRecord[];
    writeUndoHistory(records: PhoneSettingsUndoRecord[]): Promise<void>;
    now(): string;
    makeId(): string;
};

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|cookie|bearer)/iu;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~-]{12,}|\b(?:sk|sbp)_[a-z0-9_-]{12,}|\beyJ[a-z0-9_-]{20,}\.[a-z0-9._-]{10,})/iu;
const MAX_SAFE_STRING = 500;

/** 最后一层保险：即使以后读取器增加字段，也不会把密钥、data URL 或超长原文交给模型。 */
export function sanitizePhoneManagementValue(value: unknown, key = "", depth = 0): unknown {
    if (SENSITIVE_KEY.test(key)) return "[已隐藏]";
    if (depth > 8) return "[层级过深，已省略]";
    if (typeof value === "string") {
        if (/^data:/iu.test(value)) return `[Data URL 已省略，共 ${value.length} 字符]`;
        if (SECRET_TEXT.test(value)) return "[敏感值已隐藏]";
        if (value.length > MAX_SAFE_STRING) return `[长文本已省略，共 ${value.length} 字符]`;
        return value;
    }
    if (Array.isArray(value)) return value.map(item => sanitizePhoneManagementValue(item, key, depth + 1));
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        output[childKey] = sanitizePhoneManagementValue(childValue, childKey, depth + 1);
    }
    return output;
}

function cssSummary(css: unknown) {
    const text = typeof css === "string" ? css : "";
    return { 已设置: Boolean(text.trim()), 字符数: text.length };
}

function buildAppearance(theme: PhoneThemeProfile) {
    const overrides = theme.cssOverrides && typeof theme.cssOverrides === "object" ? theme.cssOverrides : {};
    return {
        作用范围: "全局设置",
        主题名称: theme.name || "默认主题",
        字体: {
            字体族: theme.fontFamily || "系统默认",
            已上传自定义字体文件: Boolean(theme.fontAssetId),
            说明: "只报告是否存在字体文件，不返回文件、Data URL 或资源 ID",
        },
        壁纸: {
            当前已选择: Boolean(theme.wallpaperAssetId),
            壁纸库数量: Array.isArray(theme.wallpaperLibrary) ? theme.wallpaperLibrary.length : 0,
            模糊度: theme.wallpaperBlur ?? 0,
            透明度: theme.wallpaperOpacity ?? 0.9,
            缩放百分比: theme.wallpaperScale ?? 100,
            水平位置百分比: theme.wallpaperX ?? 50,
            垂直位置百分比: theme.wallpaperY ?? 50,
        },
        手机外观: {
            隐藏模拟顶部栏: theme.hideTopBar !== false,
            安全区上移像素: theme.statusBarDropPx ?? 0,
            全局阴影: theme.enableGlobalShadows !== false,
            全局描边: Boolean(theme.enableGlobalBorder),
            描边颜色: theme.globalBorderColor || "#000000",
        },
        CSS变量覆盖: { 数量: Object.keys(overrides).length, 变量名: Object.keys(overrides).slice(0, 40) },
        全局自定义CSS: cssSummary(theme.globalCustomCSS),
    };
}

function buildDesktop(desktop: PhoneDesktopState) {
    const pageSummary = Object.fromEntries(Object.entries(desktop.pages).map(([page, icons]) => [page, {
        图标数量: icons.length,
        图标: icons.map(icon => icon.id),
    }]));
    const widgetsPerPage: Record<string, number> = {};
    for (const widget of desktop.widgets) widgetsPerPage[`page${widget.page}`] = (widgetsPerPage[`page${widget.page}`] || 0) + 1;
    return {
        作用范围: "全局设置",
        桌面页面: pageSummary,
        Dock: desktop.dock,
        文件夹数量: Object.keys(desktop.folders).length,
        组件: { 总数: desktop.widgets.length, 各页数量: widgetsPerPage, DIY模板数量: desktop.diyTemplateCount },
    };
}

function buildEntry(entry: Awaited<ReturnType<PhoneManagementReadDeps["readEntry"]>>) {
    const preset = entry.activePreset;
    return {
        作用范围: "全局设置",
        模式: "开屏动画",
        当前方案: preset.name,
        方案类型: preset.id.startsWith("builtin-") ? "内置" : "自定义",
        动画时长毫秒: preset.durationMs,
        背景色: preset.background,
        前景色: preset.foreground,
        自定义CSS: cssSummary(preset.css),
        已保存自定义方案数: entry.settings.splashPresets.filter(item => !item.id.startsWith("builtin-")).length,
        说明: "当前没有 iPhone 锁屏模式，只保留可替换开屏动画",
    };
}

type ResolvedSession = { session: PhoneChatSession; characterId?: string; displayName: string };

function sessionDisplayName(session: PhoneChatSession, contact: PhoneChatContact | undefined, labels: Record<string, string>) {
    if (session.isGroup) return session.groupName || session.alias || "群聊";
    const characterId = contact?.characterId;
    return session.alias || contact?.nickname || (characterId ? labels[characterId] : "") || "未命名会话";
}

function resolveSession(
    sessions: PhoneChatSession[],
    contacts: PhoneChatContact[],
    labels: Record<string, string>,
    query: PhoneManagementQuery,
    context: PhoneManagementContext,
): ResolvedSession | null {
    const contactById = new Map(contacts.map(contact => [contact.id, contact]));
    const contactByCharacterId = new Map(contacts.map(contact => [contact.characterId, contact]));
    const wrap = (session: PhoneChatSession): ResolvedSession => {
        const contact = contactByCharacterId.get(session.contactId) || contactById.get(session.contactId);
        const characterId = contact?.characterId || (!session.isGroup ? session.contactId : undefined);
        return { session, characterId, displayName: sessionDisplayName(session, contact, labels) };
    };
    if (context.sessionId) {
        const current = sessions.find(session => session.id === context.sessionId);
        if (current && !query.sessionName && !query.characterId) return wrap(current);
    }
    const requestedCharacter = query.characterId || context.characterId;
    if (query.sessionName?.trim()) {
        const needle = query.sessionName.trim().toLocaleLowerCase();
        const named = sessions.map(wrap).filter(item => (
            item.displayName.toLocaleLowerCase() === needle
            || item.displayName.toLocaleLowerCase().includes(needle)
            || item.session.id === query.sessionName
        ));
        return named.length === 1 ? named[0] : null;
    }
    if (requestedCharacter) {
        const contactIds = new Set(contacts
            .filter(contact => contact.characterId === requestedCharacter)
            .flatMap(contact => [contact.id, contact.characterId]));
        return sessions
            .filter(session => session.contactId === requestedCharacter || contactIds.has(session.contactId) || session.participantIds?.includes(requestedCharacter))
            .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
            .map(wrap)[0] || null;
    }
    return null;
}

function buildScopeInfo(resolved: ResolvedSession) {
    return {
        级别: "会话级设置",
        会话ID: resolved.session.id,
        会话名称: resolved.displayName,
        关联角色: resolved.characterId ? { 级别: "角色关联信息", 角色ID: resolved.characterId, 角色名称: resolved.displayName } : null,
    };
}

function buildChat(resolved: ResolvedSession, status: PhoneStatusRegion) {
    const innerState = status.mode === "off"
        ? "随本会话状态区一起关闭"
        : status.mode === "custom"
            ? "本会话使用自定义状态区；是否包含内心取决于自定义契约"
            : "随本会话原生状态区启用";
    return {
        作用范围: buildScopeInfo(resolved),
        聊天背景已设置: Boolean(resolved.session.backgroundImage),
        会话自定义CSS: cssSummary(resolved.session.customCSS),
        静音: Boolean(resolved.session.isMuted),
        双语翻译: resolved.session.bilingualTranslationEnabled !== false,
        折叠双语翻译: resolved.session.collapseBilingualTranslation !== false,
        状态区: {
            模式: status.mode,
            自定义契约: cssSummary(status.contract),
            自定义渲染: cssSummary(status.renderHtml),
        },
        内心独白: {
            当前状态: innerState,
            独立角色级开关: "不存在",
            说明: "当前内心独白与会话状态区绑定，本次只查询，不重构",
        },
    };
}

function buildCall(resolved: ResolvedSession) {
    const appearance = resolved.session.voiceCallAppearance || {};
    return {
        作用范围: buildScopeInfo(resolved),
        语音背景已设置: Boolean(resolved.session.voiceBackground),
        主要语言: resolved.session.voiceCallLanguage || "auto",
        字幕翻译语言: resolved.session.voiceCallTranslationLanguage ?? "zh-CN",
        通话外观: {
            样式: appearance.visualStyle || "noir",
            显示英文名: appearance.showLatinName !== false,
            英文名: appearance.latinName || "未单独设置",
            字幕字体: appearance.captionFont || "serif",
            光圈色调: appearance.orbTone || "mist",
        },
        挂断记录: {
            样式: resolved.session.callRecordStyle || "original",
            自定义文案数量: Object.keys(resolved.session.callRecordTemplates || {}).length,
            自定义外观字段数量: Object.keys(resolved.session.callRecordAppearance || {}).length,
        },
    };
}

async function createDefaultDeps(): Promise<PhoneManagementReadDeps> {
    const [kv, themeTypes, themeStorage, entryStorage, desktopStorage, widgetStorage, chatDbModule, statusRegion] = await Promise.all([
        import("./kv-db"), import("./theme-types"), import("./theme-storage"), import("./entry-experience-storage"),
        import("./desktop-layout-storage"), import("./widget-storage"), import("./chat-db"), import("./chat-status-region"),
    ]);
    return {
        readTheme: () => {
            const raw = kv.kvGet(themeStorage.THEME_PROFILE_STORAGE_KEY);
            if (!raw) return themeTypes.normalizeThemeProfile(themeTypes.DEFAULT_THEME_PROFILE);
            try { return themeTypes.normalizeThemeProfile(JSON.parse(raw)); }
            catch { return themeTypes.normalizeThemeProfile(themeTypes.DEFAULT_THEME_PROFILE); }
        },
        readEntry: () => {
            const settings = entryStorage.readEntryExperienceSettings();
            return { settings, activePreset: entryStorage.getSplashPreset(settings) };
        },
        readDesktop: async () => {
            const folders = desktopStorage.loadDesktopFolders();
            const raw = kv.kvGet(desktopStorage.ICON_LAYOUT_STORAGE_KEY);
            let parsed: unknown = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
            const layout = desktopStorage.normalizeDesktopIconLayout(parsed, new Set(Object.keys(folders)));
            return {
                pages: layout,
                dock: desktopStorage.loadDockLayout(),
                folders,
                widgets: widgetStorage.loadWidgets(),
                diyTemplateCount: widgetStorage.loadDIYTemplates().length,
            };
        },
        readChatSessions: () => chatDbModule.chatDb.sessions.toArray(),
        readChatContacts: () => chatDbModule.chatDb.contacts.toArray(),
        readCharacterLabels: () => {
            const raw = kv.kvGet("ai_phone_characters_v1");
            try {
                const parsed = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(parsed)) return {};
                return Object.fromEntries(parsed.flatMap(item => (
                    item && typeof item.id === "string" && typeof item.name === "string" ? [[item.id, item.name]] : []
                )));
            } catch { return {}; }
        },
        readStatusRegion: statusRegion.getStatusRegionConfig,
    };
}

const PHONE_SETTINGS_UNDO_KEY = "ai_phone_settings_undo_v1";
const MAX_UNDO_RECORDS = 30;
let undoMigrationRegistered = false;
const CHAT_SETTING_KEYS = new Set(["isMuted", "bilingualTranslationEnabled", "collapseBilingualTranslation"]);
const CALL_SETTING_KEYS = new Set([
    "visualStyle", "showLatinName", "latinName", "captionFont", "orbTone",
    "voiceCallLanguage", "voiceCallTranslationLanguage", "callRecordStyle",
]);
const ENUM_VALUES: Record<string, readonly string[]> = {
    visualStyle: ["original", "noir"],
    captionFont: ["serif", "system", "rounded"],
    orbTone: ["mist", "lilac", "blue", "rose"],
    callRecordStyle: ["original", "wechat"],
};
const LANGUAGE_VALUE = /^(?:auto|none|zh-CN|zh-TW|en|ja|ko|fr|de|es|ru|custom:.{1,32})$/u;

async function createDefaultWriteDeps(): Promise<PhoneManagementWriteDeps> {
    const [chatStorage, chatDbModule, kv] = await Promise.all([
        import("./chat-storage"), import("./chat-db"), import("./kv-db"),
    ]);
    if (!undoMigrationRegistered) {
        kv.registerKvMigration(PHONE_SETTINGS_UNDO_KEY);
        undoMigrationRegistered = true;
    }
    return {
        readChatSessions: () => chatDbModule.chatDb.sessions.toArray(),
        readChatContacts: () => chatDbModule.chatDb.contacts.toArray(),
        readCharacterLabels: () => {
            const raw = kv.kvGet("ai_phone_characters_v1");
            try {
                const parsed = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(parsed)) return {};
                return Object.fromEntries(parsed.flatMap(item => (
                    item && typeof item.id === "string" && typeof item.name === "string" ? [[item.id, item.name]] : []
                )));
            } catch { return {}; }
        },
        writeChatSessions: async sessions => {
            await chatDbModule.chatDb.sessions.bulkPut(sessions as never[]);
            chatStorage.saveChatSessions(sessions as never[]);
        },
        readUndoHistory: () => {
            const raw = kv.kvGet(PHONE_SETTINGS_UNDO_KEY);
            try {
                const parsed = raw ? JSON.parse(raw) : [];
                return Array.isArray(parsed) ? parsed : [];
            } catch { return []; }
        },
        writeUndoHistory: records => kv.kvSetAsync(PHONE_SETTINGS_UNDO_KEY, JSON.stringify(records.slice(0, MAX_UNDO_RECORDS))),
        now: () => new Date().toISOString(),
        makeId: () => `phone_setting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };
}

function validateSettingsPatch(scope: PhoneSettingsWriteScope, raw: unknown): { patch?: Record<string, unknown>; error?: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "updates 必须是设置对象" };
    const patch = { ...(raw as Record<string, unknown>) };
    const keys = Object.keys(patch);
    if (keys.length === 0) return { error: "没有提供要修改的设置" };
    const allowed = scope === "chat" ? CHAT_SETTING_KEYS : CALL_SETTING_KEYS;
    const unknown = keys.filter(key => !allowed.has(key));
    if (unknown.length > 0) return { error: `这一块暂不允许修改：${unknown.join("、")}` };
    for (const [key, value] of Object.entries(patch)) {
        if (["isMuted", "bilingualTranslationEnabled", "collapseBilingualTranslation", "showLatinName"].includes(key)) {
            if (typeof value !== "boolean") return { error: `${key} 必须是 true 或 false` };
        } else if (key === "latinName") {
            if (typeof value !== "string" || value.trim().length > 80) return { error: "latinName 必须是不超过 80 字的文字" };
            patch[key] = value.trim();
        } else if (key === "voiceCallLanguage" || key === "voiceCallTranslationLanguage") {
            if (typeof value !== "string" || !LANGUAGE_VALUE.test(value)) return { error: `${key} 不是支持的语言值` };
        } else if (!ENUM_VALUES[key]?.includes(String(value))) {
            return { error: `${key} 不是允许的选项` };
        }
    }
    return { patch };
}

function readSetting(session: PhoneChatSession, key: string): unknown {
    if (["visualStyle", "showLatinName", "latinName", "captionFont", "orbTone"].includes(key)) {
        return session.voiceCallAppearance?.[key as keyof NonNullable<PhoneChatSession["voiceCallAppearance"]>];
    }
    return session[key as keyof PhoneChatSession];
}

function isAbsentPhoneSetting(value: unknown): value is AbsentPhoneSetting {
    return Boolean(value && typeof value === "object" && (value as Partial<AbsentPhoneSetting>).__phoneSettingAbsent === true);
}

function applySettings(session: PhoneChatSession, patch: Record<string, unknown>): PhoneChatSession {
    const next = { ...session };
    const appearance = { ...(session.voiceCallAppearance || {}) };
    let touchedAppearance = false;
    for (const [key, value] of Object.entries(patch)) {
        if (["visualStyle", "showLatinName", "latinName", "captionFont", "orbTone"].includes(key)) {
            touchedAppearance = true;
            if (isAbsentPhoneSetting(value)) delete (appearance as Record<string, unknown>)[key];
            else (appearance as Record<string, unknown>)[key] = value;
        } else {
            if (isAbsentPhoneSetting(value)) delete (next as Record<string, unknown>)[key];
            else (next as Record<string, unknown>)[key] = value;
        }
    }
    if (touchedAppearance) {
        if (Object.keys(appearance).length > 0) next.voiceCallAppearance = appearance;
        else delete next.voiceCallAppearance;
    }
    return next;
}

function sameSettingValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function loadWriteTarget(
    query: Pick<PhoneSettingsChange, "sessionName" | "characterId">,
    context: PhoneManagementContext,
    deps: PhoneManagementWriteDeps,
) {
    const [sessions, contacts, labels] = await Promise.all([
        deps.readChatSessions(), deps.readChatContacts(), deps.readCharacterLabels(),
    ]);
    const resolved = resolveSession(sessions, contacts, labels, query, context);
    return { sessions, resolved };
}

export async function changePhoneManagementSettings(
    request: PhoneSettingsChange,
    context: PhoneManagementContext,
    suppliedDeps?: PhoneManagementWriteDeps,
): Promise<PhoneManagementToolResult> {
    const scope = request.scope;
    if (scope !== "chat" && scope !== "call") {
        return { name: "修改小手机设置", success: false, error: "必须明确 scope 是 chat 还是 call" };
    }
    const checked = validateSettingsPatch(scope, request.updates);
    if (!checked.patch) return { name: "修改小手机设置", success: false, error: checked.error };
    const deps = suppliedDeps || await createDefaultWriteDeps();
    const { sessions, resolved } = await loadWriteTarget(request, context, deps);
    if (!resolved) return { name: "修改小手机设置", success: false, error: "找不到唯一的目标会话；请从目标角色聊天中调用" };

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(checked.patch)) {
        const previous = readSetting(resolved.session, key);
        if (sameSettingValue(previous, value)) continue;
        before[key] = previous === undefined ? ABSENT_PHONE_SETTING : previous;
        after[key] = value;
    }
    const changedKeys = Object.keys(after);
    if (changedKeys.length === 0) {
        return { name: "修改小手机设置", success: true, data: "设置本来就是这个状态，没有产生修改。", userNotice: "设置没有变化" };
    }

    const nextSessions = sessions.map(item => item.id === resolved.session.id ? applySettings(item, after) : item);
    const undoRecord: PhoneSettingsUndoRecord = {
        id: deps.makeId(), sessionId: resolved.session.id, characterId: resolved.characterId,
        displayName: resolved.displayName, scope, before, after, changedKeys, createdAt: deps.now(),
    };
    const history = await deps.readUndoHistory();
    try {
        await deps.writeChatSessions(nextSessions);
        await deps.writeUndoHistory([undoRecord, ...history].slice(0, MAX_UNDO_RECORDS));
    } catch (error) {
        try { await deps.writeChatSessions(sessions); } catch { /* 保留原始错误，回滚失败由下方明确提示 */ }
        try { await deps.writeUndoHistory(history); } catch { /* 至少恢复同步缓存；持久层错误仍由原始错误表达 */ }
        return { name: "修改小手机设置", success: false, error: `保存失败，未确认修改成功：${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("phone-management-settings-updated", { detail: { sessionId: resolved.session.id, changedKeys } }));
    const data = { 会话: resolved.displayName, 范围: scope === "chat" ? "聊天设置" : "通话设置", 已修改: changedKeys, 撤销编号: undoRecord.id };
    return { name: "修改小手机设置", success: true, data: JSON.stringify(sanitizePhoneManagementValue(data), null, 2), userNotice: `已修改 ${resolved.displayName} 的${scope === "chat" ? "聊天" : "通话"}设置，可撤销` };
}

export async function undoPhoneManagementSettings(
    request: PhoneSettingsUndoRequest,
    context: PhoneManagementContext,
    suppliedDeps?: PhoneManagementWriteDeps,
): Promise<PhoneManagementToolResult> {
    const deps = suppliedDeps || await createDefaultWriteDeps();
    const { sessions, resolved } = await loadWriteTarget(request, context, deps);
    if (!resolved) return { name: "撤销小手机设置修改", success: false, error: "找不到唯一的目标会话" };
    const history = await deps.readUndoHistory();
    const record = history.find(item => !item.undoneAt && item.sessionId === resolved.session.id && (!request.undoId || item.id === request.undoId));
    if (!record) return { name: "撤销小手机设置修改", success: false, error: "没有找到这个会话可撤销的设置修改" };
    const current = sessions.find(item => item.id === record.sessionId)!;
    const changedAfterwards = record.changedKeys.some(key => !sameSettingValue(readSetting(current, key), record.after[key]));
    if (changedAfterwards) {
        return { name: "撤销小手机设置修改", success: false, error: "这些设置后来又被改过，为避免覆盖新设置，本次没有撤销" };
    }
    const restored = applySettings(current, record.before);
    const nextSessions = sessions.map(item => item.id === record.sessionId ? restored : item);
    const nextHistory = history.map(item => item.id === record.id ? { ...item, undoneAt: deps.now() } : item);
    try {
        await deps.writeChatSessions(nextSessions);
        await deps.writeUndoHistory(nextHistory);
    } catch (error) {
        try { await deps.writeChatSessions(sessions); } catch { /* 同上 */ }
        try { await deps.writeUndoHistory(history); } catch { /* 同上 */ }
        return { name: "撤销小手机设置修改", success: false, error: `撤销保存失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("phone-management-settings-updated", { detail: { sessionId: record.sessionId, changedKeys: record.changedKeys } }));
    return { name: "撤销小手机设置修改", success: true, data: JSON.stringify({ 会话: record.displayName, 已恢复: record.changedKeys }, null, 2), userNotice: `已撤销 ${record.displayName} 的上一次设置修改` };
}

export async function queryPhoneManagementState(
    query: PhoneManagementQuery,
    context: PhoneManagementContext,
    suppliedDeps?: PhoneManagementReadDeps,
): Promise<PhoneManagementToolResult> {
    const scope: PhoneManagementScope = query.scope || "summary";
    if (!["summary", "appearance", "desktop", "chat", "call", "entry"].includes(scope)) {
        return { name: "查看小手机设置", success: false, error: `不支持的查询范围：${String(query.scope)}` };
    }
    const deps = suppliedDeps || await createDefaultDeps();
    const needsSession = scope === "chat" || scope === "call" || scope === "summary";
    const [theme, entry, desktop, sessions, contacts, labels] = await Promise.all([
        scope === "appearance" || scope === "summary" ? deps.readTheme() : null,
        scope === "entry" || scope === "summary" ? deps.readEntry() : null,
        scope === "desktop" || scope === "summary" ? deps.readDesktop() : null,
        needsSession ? deps.readChatSessions() : [],
        needsSession ? deps.readChatContacts() : [],
        needsSession ? deps.readCharacterLabels() : {},
    ]);
    const resolved = needsSession ? resolveSession(sessions, contacts, labels, query, context) : null;
    if ((scope === "chat" || scope === "call") && !resolved) {
        return { name: "查看小手机设置", success: false, error: "找不到对应聊天会话；请指定 sessionName，或从目标角色的聊天中调用" };
    }
    const status = resolved && (scope === "chat" || scope === "summary") ? await deps.readStatusRegion(resolved.session.id) : null;
    let payload: unknown;
    if (scope === "appearance") payload = buildAppearance(theme!);
    else if (scope === "desktop") payload = buildDesktop(desktop!);
    else if (scope === "entry") payload = buildEntry(entry!);
    else if (scope === "chat") payload = buildChat(resolved!, status!);
    else if (scope === "call") payload = buildCall(resolved!);
    else payload = {
        查询范围: "小手机设置摘要",
        全局设置: { 外观: buildAppearance(theme!), 桌面: buildDesktop(desktop!), 开屏: buildEntry(entry!) },
        会话级设置: resolved ? { 聊天: buildChat(resolved, status!), 通话: buildCall(resolved) } : "当前没有可定位的聊天会话",
        角色级设置: {
            当前关联角色: resolved?.characterId ? { 角色ID: resolved.characterId, 角色名称: resolved.displayName } : "未定位",
            内心独白独立开关: "当前不存在；内心独白仍是会话状态区的一部分",
        },
    };
    return {
        name: "查看小手机设置",
        success: true,
        data: JSON.stringify(sanitizePhoneManagementValue(payload), null, 2),
    };
}
