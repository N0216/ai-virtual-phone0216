"use client";

import type { CSSProperties, FormEvent, PointerEvent, ReactNode } from "react";
import { splitBilingualText } from "@/lib/bilingual-text";

type NoirCallState = "CONNECTING" | "IDLE" | "USER_SPEAKING" | "PROCESSING" | "AI_SPEAKING" | "ENDED";

type NoirSubtitle = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

type NoirVoiceCallViewProps = {
    callState: NoirCallState;
    initiator: "user" | "character";
    characterName: string;
    modelName: string;
    displayName: string;
    captionFont: "serif" | "system" | "rounded";
    orbTone: "mist" | "lilac" | "blue" | "rose";
    duration: string;
    backgroundImage: string | null;
    keyboardOffsetStyle?: CSSProperties;
    subtitles: NoirSubtitle[];
    interimText: string;
    voiceLevel: number;
    captionRevealMs: number;
    isMuted: boolean;
    inputMode: "voice" | "text";
    typedText: string;
    canUseVoice: boolean;
    canSendText: boolean;
    warning?: ReactNode;
    onTypedTextChange: (value: string) => void;
    onSubmitText: () => void;
    onToggleInput: () => void;
    onToggleMute: () => void;
    onHangup: () => void;
    onAccept: () => void;
    onDecline: () => void;
    onCancel: () => void;
    holdToTalk?: boolean;
    holdButtonProps?: Record<string, unknown>;
};

function PhoneIcon({ off = false }: { off?: boolean }) {
    return off ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272M22 2 2 22M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473" /></svg>
    ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" /></svg>
    );
}

function MicIcon({ muted = false }: { muted?: boolean }) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19v3M19 10v2a7 7 0 0 1-14 0v-2" />
            <rect x="9" y="2" width="6" height="13" rx="3" />
            {muted && <path d="M3 3l18 18" />}
        </svg>
    );
}

function TextIcon() {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /></svg>;
}

export function NoirVoiceCallView(props: NoirVoiceCallViewProps) {
    const {
        callState, initiator, characterName, modelName, displayName, captionFont, orbTone, duration, backgroundImage, keyboardOffsetStyle,
        subtitles, interimText, voiceLevel, captionRevealMs, isMuted, inputMode,
        typedText, canUseVoice, canSendText, warning, onTypedTextChange, onSubmitText,
        onToggleInput, onToggleMute, onHangup, onAccept, onDecline, onCancel,
        holdToTalk, holdButtonProps,
    } = props;
    const connected = callState !== "CONNECTING" && callState !== "ENDED";
    const incoming = callState === "CONNECTING" && initiator === "character";
    const latest = subtitles[subtitles.length - 1];
    const split = latest ? splitBilingualText(latest.text) : null;
    const primaryCaption = interimText || split?.original || latest?.text || (incoming ? `${characterName} calling` : "entering the signal");
    const translatedCaption = interimText
        ? "正在聆听"
        : split?.translated || (!latest ? (incoming ? "雾里有人正在靠近" : "正在进入他的声音") : "");
    const showComposer = connected && inputMode === "text";
    const surfaceStyle = {
        ...keyboardOffsetStyle,
        ...(backgroundImage ? { backgroundImage: `linear-gradient(rgba(244,246,250,.68), rgba(236,239,245,.72)), url(${backgroundImage})` } : {}),
        "--noir-voice-level": String(voiceLevel),
        "--noir-orb-scale": String(0.87 + voiceLevel * 0.25),
        "--noir-caption-ms": `${captionRevealMs}ms`,
        "--noir-caption-family": captionFont === "system"
            ? '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
            : captionFont === "rounded"
                ? '"Huiwen", "PingFang SC", sans-serif'
                : '"Times New Roman", Georgia, "Songti SC", serif',
    } as CSSProperties;

    const submitText = (event: FormEvent) => {
        event.preventDefault();
        onSubmitText();
    };

    const exitTextModeFromBlank = (event: PointerEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget || !showComposer || !canUseVoice) return;
        onToggleInput();
    };

    return (
        <div className="noir-call-root call-keyboard-shift" style={surfaceStyle} data-tone={orbTone} data-state={incoming ? "incoming" : connected ? "connected" : "connecting"} data-speaking={callState === "AI_SPEAKING" ? "true" : "false"} onPointerDown={exitTextModeFromBlank}>
            <div className="noir-call-wash" aria-hidden="true" />

            <header className="noir-call-heading">
                <div className="noir-call-kicker">{incoming ? `INCOMING VOICE · ${displayName}` : connected ? "VOICE CONNECTED" : `ENTERING VOICE · ${displayName}`}</div>
                {connected ? <div className="noir-call-duration">{duration}</div> : <><div className="noir-call-name">{characterName}</div><div className="noir-call-status">{incoming ? "语音来电" : "正在接通"}</div></>}
            </header>

            <main className="noir-call-stage">
                <div className="noir-call-orb" aria-hidden="true" />
                <section className="noir-call-caption" key={latest?.id || callState} aria-live="polite">
                    <p className="noir-call-caption-main">{primaryCaption}</p>
                    {translatedCaption && <p className="noir-call-caption-cn">{translatedCaption}</p>}
                    {connected && <div className="noir-call-credit"><span>{characterName}</span><span>{modelName}</span></div>}
                </section>
            </main>

            <footer className="noir-call-footer">
                {incoming ? (
                    <div className="noir-call-incoming-actions">
                        <button type="button" className="noir-call-action" onClick={onDecline} aria-label="拒绝来电"><PhoneIcon off /></button>
                        <button type="button" className="noir-call-action" onClick={onAccept} aria-label="接听来电"><PhoneIcon /></button>
                    </div>
                ) : callState === "CONNECTING" ? (
                    <button type="button" className="noir-call-action" onClick={onCancel} aria-label="取消呼叫"><PhoneIcon off /></button>
                ) : connected && !showComposer ? (
                    <div className="noir-call-control-pill">
                        <button type="button" className="noir-call-action noir-call-action-small" onClick={onToggleMute} aria-label={isMuted ? "取消静音" : "静音"}><MicIcon muted={isMuted} /></button>
                        <button type="button" className="noir-call-action noir-call-action-small" onClick={onToggleInput} aria-label="文字输入" {...(holdToTalk ? holdButtonProps : {})}><TextIcon /></button>
                        <button type="button" className="noir-call-action noir-call-action-small" onClick={onHangup} aria-label="挂断"><PhoneIcon off /></button>
                    </div>
                ) : null}

                {showComposer && (
                    <form className="noir-call-compose" onSubmit={submitText}>
                        <input
                            value={typedText}
                            onChange={event => onTypedTextChange(event.target.value)}
                            enterKeyHint="send"
                            autoFocus
                            placeholder={canSendText ? "输入你想说的话…" : "稍等对方说完…"}
                            disabled={!canSendText}
                        />
                        <button type="submit" disabled={!typedText.trim() || !canSendText} aria-label="发送文字">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                        </button>
                    </form>
                )}
            </footer>
            {warning}
        </div>
    );
}
