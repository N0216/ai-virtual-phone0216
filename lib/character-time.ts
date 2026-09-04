export type CharacterTimeContext = {
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime: string;
  characterWeekday: string;
  characterTimeZone: string;
  timeContext: string;
  hasDifference: boolean;
};

export type GroupTimeMember = {
  name: string;
  timeZone?: string | null;
};

export type TemporalMessage = {
  role: string;
  createdAt?: string | null;
};

export const TEMPORAL_AWARENESS_TAG = "temporal_awareness";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

type TemporalAnchor = {
  role: "user" | "assistant";
  createdAt: string;
  date: Date;
};

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getSystemTimeZone(): string {
  return readTimeZone();
}

export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Partial<DateParts> = {};
  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = part.value;
    }
  }
  return {
    year: values.year || "0000",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
}

function getDateKey(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDayPart(date: Date, timeZone: string): string {
  const hour = Number(getDateParts(date, timeZone).hour);
  if (hour < 5) return "凌晨";
  if (hour < 8) return "清晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 22) return "晚上";
  return "深夜";
}

function formatElapsed(from: Date, to: Date): string {
  const elapsedSeconds = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  if (elapsedSeconds < 45) return "刚刚";
  if (elapsedSeconds < 60 * 60) return `${Math.max(1, Math.round(elapsedSeconds / 60))}分钟前`;
  if (elapsedSeconds < 24 * 60 * 60) {
    const hours = Math.floor(elapsedSeconds / (60 * 60));
    const minutes = Math.floor((elapsedSeconds % (60 * 60)) / 60);
    return minutes >= 10 ? `${hours}小时${minutes}分钟前` : `${hours}小时前`;
  }
  const days = Math.floor(elapsedSeconds / (24 * 60 * 60));
  const hours = Math.floor((elapsedSeconds % (24 * 60 * 60)) / (60 * 60));
  return hours >= 2 ? `${days}天${hours}小时前` : `${days}天前`;
}

function readTemporalAnchors(messages?: TemporalMessage[]): TemporalAnchor[] {
  if (!messages?.length) return [];
  return messages.flatMap(message => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (!message.createdAt) return [];
    const date = new Date(message.createdAt);
    if (!Number.isFinite(date.getTime())) return [];
    return [{ role: message.role, createdAt: date.toISOString(), date } as TemporalAnchor];
  }).sort((a, b) => a.date.getTime() - b.date.getTime());
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTemporalAwarenessBlock(params: {
  now: Date;
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime?: string;
  characterWeekday?: string;
  characterTimeZone?: string;
  messages?: TemporalMessage[];
  groupRows?: string[];
  groupMembers?: GroupTimeMember[];
}): string {
  const anchors = readTemporalAnchors(params.messages);
  const latest = anchors.at(-1);
  const previous = anchors.at(-2);
  const lastUser = [...anchors].reverse().find(anchor => anchor.role === "user");
  const lastAssistant = [...anchors].reverse().find(anchor => anchor.role === "assistant");
  const preferredTimeZone = params.characterTimeZone || params.systemTimeZone;
  const attributes = [
    `system_time_zone="${escapeXmlAttribute(params.systemTimeZone)}"`,
    `character_time_zone="${escapeXmlAttribute(preferredTimeZone)}"`,
    params.groupMembers?.length
      ? `group_time_zones="${escapeXmlAttribute(encodeURIComponent(JSON.stringify(params.groupMembers)))}"`
      : "",
    lastUser ? `last_user_at="${lastUser.createdAt}"` : "",
    lastAssistant ? `last_assistant_at="${lastAssistant.createdAt}"` : "",
    latest ? `latest_at="${latest.createdAt}"` : "",
    previous ? `previous_at="${previous.createdAt}"` : "",
  ].filter(Boolean).join(" ");

  const rows = [
    `当前系统时间：${params.systemTime} ${params.systemTimeZone}，${params.systemWeekday}（${getDayPart(params.now, params.systemTimeZone)}）`,
  ];
  if (params.characterTime && params.characterTimeZone) {
    rows.push(`角色本地时间：${params.characterTime} ${params.characterTimeZone}，${params.characterWeekday}（${getDayPart(params.now, params.characterTimeZone)}）`);
    rows.push("判断角色作息、问候、深夜/清晨/工作时间时，优先使用角色本地时间。");
  }
  if (params.groupRows?.length) {
    rows.push("群成员本地时间：", ...params.groupRows);
    rows.push("判断每个角色作息、问候、深夜/清晨/工作时间时，优先使用该角色自己的本地时间。");
  }
  if (lastUser) rows.push(`用户最近一条消息：${formatElapsed(lastUser.date, params.now)}`);
  if (lastAssistant) rows.push(`你最近一条回复：${formatElapsed(lastAssistant.date, params.now)}`);
  if (latest) rows.push(`最近一次真实聊天活动：${formatElapsed(latest.date, params.now)}`);
  if (latest && previous) {
    const gapMs = latest.date.getTime() - previous.date.getTime();
    if (gapMs >= 30 * 60 * 1000) {
      rows.push(`最近两次真实聊天活动相隔：${formatElapsed(previous.date, latest.date)}`);
    }
    if (getDateKey(previous.date, preferredTimeZone) !== getDateKey(latest.date, preferredTimeZone)) {
      rows.push("最近两次真实聊天活动已经跨日，不要把之前那次误称为“刚刚”。");
    }
  }
  if (latest && getDateKey(latest.date, preferredTimeZone) !== getDateKey(params.now, preferredTimeZone)) {
    rows.push("最近一次真实聊天活动与现在不在同一天，请正确使用“昨天/前天/几天前”等措辞。");
  }
  rows.push("这些是系统计算好的时间事实。请自然体现在作息、问候、等待感和“刚刚/昨天”等措辞中；除非对话自然需要，不要机械报时或复述本段。自动发消息时也必须依据真实间隔，不要假装用户刚刚发过消息。");
  return `<${TEMPORAL_AWARENESS_TAG} ${attributes}>\n${rows.join("\n")}\n</${TEMPORAL_AWARENESS_TAG}>`;
}

export function formatZonedPromptTimestamp(date: Date, timeZone: string, includeTimeZone = false): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${includeTimeZone ? ` ${timeZone}` : ""}`;
}

export function formatZonedChineseDateTime(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日${parts.hour}:${parts.minute}`;
}

export function getZonedWeekday(date: Date, timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
    return label || WEEKDAYS[0];
  } catch {
    return WEEKDAYS[date.getDay()];
  }
}

export function hasTimeZoneDifference(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): boolean {
  const systemParts = getDateParts(date, systemTimeZone);
  const characterParts = getDateParts(date, characterTimeZone);
  return systemParts.year !== characterParts.year
    || systemParts.month !== characterParts.month
    || systemParts.day !== characterParts.day
    || systemParts.hour !== characterParts.hour
    || systemParts.minute !== characterParts.minute;
}

export function buildCharacterTimeContext(
  timeZone?: string | null,
  now = new Date(),
  messages?: TemporalMessage[],
): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const hasDifference = normalizedTimeZone ? hasTimeZoneDifference(now, normalizedTimeZone, systemTimeZone) : false;

  if (!normalizedTimeZone || !hasDifference) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: buildTemporalAwarenessBlock({
        now,
        systemTime,
        systemWeekday,
        systemTimeZone,
        messages,
      }),
      hasDifference: false,
    };
  }

  const characterTime = formatZonedChineseDateTime(now, normalizedTimeZone);
  const characterWeekday = getZonedWeekday(now, normalizedTimeZone);
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime,
    characterWeekday,
    characterTimeZone: normalizedTimeZone,
    timeContext: buildTemporalAwarenessBlock({
      now,
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime,
      characterWeekday,
      characterTimeZone: normalizedTimeZone,
      messages,
    }),
    hasDifference: true,
  };
}

export function buildGroupTimeContext(
  members: GroupTimeMember[],
  now = new Date(),
  messages?: TemporalMessage[],
): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const rows = members
    .map(member => {
      const timeZone = normalizeTimeZone(member.timeZone);
      if (!timeZone || !hasTimeZoneDifference(now, timeZone, systemTimeZone)) return null;
      return `${member.name}：${formatZonedChineseDateTime(now, timeZone)} ${timeZone}，${getZonedWeekday(now, timeZone)}`;
    })
    .filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: buildTemporalAwarenessBlock({
        now,
        systemTime,
        systemWeekday,
        systemTimeZone,
        messages,
      }),
      hasDifference: false,
    };
  }

  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime: "",
    characterWeekday: "",
    characterTimeZone: "",
    timeContext: buildTemporalAwarenessBlock({
      now,
      systemTime,
      systemWeekday,
      systemTimeZone,
      messages,
      groupRows: rows,
      groupMembers: members,
    }),
    hasDifference: true,
  };
}
