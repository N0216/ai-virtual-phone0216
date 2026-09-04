const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function padTwo(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

export type ChatTimeFormat = "smart" | "clock" | "period" | "full";

export function formatChatUiTime(dateStr: string, format: ChatTimeFormat = "smart"): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const hhmm = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
    if (format === "clock") return hhmm;
    if (format === "period") {
        const hour = date.getHours();
        const period = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
        return `${period}${hour % 12 || 12}:${padTwo(date.getMinutes())}`;
    }
    if (format === "full") return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    if (date.getTime() >= todayStart.getTime()) {
        return hhmm;
    }
    if (date.getTime() >= yesterdayStart.getTime()) {
        return `昨天 ${hhmm}`;
    }

    const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 86400000);
    if (date.getTime() >= sevenDaysAgo.getTime()) {
        return `${WEEKDAY_NAMES[date.getDay()]} ${hhmm}`;
    }

    if (date.getFullYear() === now.getFullYear()) {
        return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
    }

    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
