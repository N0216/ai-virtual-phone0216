"use client";

import { useEffect, useRef, type RefObject } from "react";

type Registration = {
    id: symbol;
    order: number;
    priority: number;
    enabled: () => boolean;
    root: () => HTMLElement | null;
    onBack: () => void;
};

type EdgeSwipeOptions = {
    rootRef?: RefObject<HTMLElement | null>;
    priority?: number;
};

const registrations = new Map<symbol, Registration>();
let nextOrder = 0;
let listenersInstalled = false;
let gesture: { x: number; y: number; owner: Registration } | null = null;

function hasHorizontalGestureOwner(element: Element | null): boolean {
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
        if (current instanceof HTMLElement) {
            const style = window.getComputedStyle(current);
            const scrollableX = /^(auto|scroll)$/.test(style.overflowX)
                && current.scrollWidth > current.clientWidth + 2;
            if (scrollableX || style.touchAction === "pan-x") return true;
        }
        current = current.parentElement;
    }
    return false;
}

function shouldIgnoreGesture(element: Element | null): boolean {
    if (!element) return false;
    // A modal owns the current interaction. Its explicit close/back action must
    // run first; the low-priority desktop fallback must never close the app below it.
    if (element.closest(".modal-overlay, [role='dialog'], [aria-modal='true']")) return true;
    if (element.closest([
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[data-disable-edge-back]",
        "[data-dragging='true']",
        ".ui-swipe-wrap",
        ".diy-widget-resize-handle",
    ].join(", "))) return true;
    return hasHorizontalGestureOwner(element);
}

function installListeners(): void {
    if (listenersInstalled || typeof document === "undefined") return;
    listenersInstalled = true;
    document.addEventListener("touchstart", event => {
        gesture = null;
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (touch.clientX > 28) return;
        const element = event.target instanceof Element ? event.target : null;
        if (shouldIgnoreGesture(element)) return;

        const candidates = [...registrations.values()].filter(item => {
            if (!item.enabled()) return false;
            const root = item.root();
            if (!root) return true;
            return root.contains(element) && root.getClientRects().length > 0;
        });
        candidates.sort((a, b) => b.priority - a.priority || b.order - a.order);
        const owner = candidates[0];
        if (owner) gesture = { x: touch.clientX, y: touch.clientY, owner };
    }, { passive: true, capture: true });
    document.addEventListener("touchend", event => {
        if (!gesture || event.changedTouches.length === 0) return;
        const current = gesture;
        gesture = null;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - current.x;
        const dy = Math.abs(touch.clientY - current.y);
        if (dx >= 72 && dx > dy * 1.35 && current.owner.enabled()) current.owner.onBack();
    }, { passive: true, capture: true });
    document.addEventListener("touchcancel", () => { gesture = null; }, { passive: true, capture: true });
}

/** iPhone 式左缘右滑返回；页面叠加时只触发触点所在的最上层页面。 */
export function useEdgeSwipeBack(onBack: () => void, enabled = true, options: EdgeSwipeOptions = {}): void {
    const onBackRef = useRef(onBack);
    const enabledRef = useRef(enabled);
    onBackRef.current = onBack;
    enabledRef.current = enabled;

    useEffect(() => {
        installListeners();
        const id = Symbol("edge-swipe-back");
        registrations.set(id, {
            id,
            order: ++nextOrder,
            priority: options.priority ?? 0,
            enabled: () => enabledRef.current,
            root: () => options.rootRef?.current ?? null,
            onBack: () => onBackRef.current(),
        });
        return () => {
            registrations.delete(id);
            if (gesture?.owner.id === id) gesture = null;
        };
    }, [options.priority, options.rootRef]);
}
