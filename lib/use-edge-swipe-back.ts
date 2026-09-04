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
type ActiveGesture = {
    x: number;
    y: number;
    lastX: number;
    lastTime: number;
    owner: Registration;
    surface: HTMLElement | null;
    width: number;
    axis: "pending" | "x" | "y";
};

let gesture: ActiveGesture | null = null;
let settleTimer: number | null = null;
let settlingSurface: HTMLElement | null = null;

function hasHorizontalGestureOwner(element: Element | null): boolean {
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
        if (current instanceof HTMLElement) {
            const style = window.getComputedStyle(current);
            const scrollableX = /^(auto|scroll)$/.test(style.overflowX)
                && current.scrollWidth > current.clientWidth + 2;
            // A horizontal scroller only owns the gesture while it can still
            // move towards its start. At its left edge, let the app-level back
            // gesture take over, just like native iOS navigation.
            if (scrollableX && current.scrollLeft > 2) return true;
        }
        current = current.parentElement;
    }
    return false;
}

function resolveSurface(owner: Registration, element: Element | null): HTMLElement | null {
    const registeredRoot = owner.root();
    if (registeredRoot) return registeredRoot;
    if (!(element instanceof HTMLElement)) return null;
    return element.closest<HTMLElement>(".chat-app, .phone-app-pane, .page-shell");
}

function clearSettleTimer(): void {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = null;
    settlingSurface?.classList.remove("edge-swipe-back-surface", "edge-swipe-back-settling");
    settlingSurface?.style.removeProperty("--edge-swipe-back-x");
    settlingSurface = null;
}

function setSurfaceOffset(surface: HTMLElement | null, offset: number): void {
    if (!surface) return;
    surface.classList.add("edge-swipe-back-surface");
    surface.style.setProperty("--edge-swipe-back-x", `${Math.max(0, Math.round(offset))}px`);
}

function finishSurface(surface: HTMLElement | null, commit: boolean, onDone?: () => void): void {
    clearSettleTimer();
    if (!surface) {
        onDone?.();
        return;
    }
    surface.classList.add("edge-swipe-back-settling");
    settlingSurface = surface;
    const destination = commit ? Math.max(96, Math.round(surface.getBoundingClientRect().width * 0.28)) : 0;
    setSurfaceOffset(surface, destination);
    settleTimer = window.setTimeout(() => {
        surface.classList.remove("edge-swipe-back-surface", "edge-swipe-back-settling");
        surface.style.removeProperty("--edge-swipe-back-x");
        settleTimer = null;
        settlingSurface = null;
        onDone?.();
    }, commit ? 130 : 170);
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
    const stopTrackingMove = () => {
        document.removeEventListener("touchmove", handleTouchMove, true);
    };
    const handleTouchMove = (event: TouchEvent) => {
        if (!gesture || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const dx = touch.clientX - gesture.x;
        const dy = touch.clientY - gesture.y;

        if (gesture.axis === "pending" && Math.hypot(dx, dy) >= 8) {
            gesture.axis = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.12 ? "x" : "y";
            if (gesture.axis === "y") stopTrackingMove();
        }
        if (gesture.axis !== "x") return;

        event.preventDefault();
        const width = gesture.width;
        const clamped = Math.min(Math.max(0, dx), width);
        const offset = clamped <= width * 0.35
            ? clamped * 0.72
            : width * 0.252 + (clamped - width * 0.35) * 0.18;
        setSurfaceOffset(gesture.surface, offset);
        gesture.lastX = touch.clientX;
        gesture.lastTime = performance.now();
    };
    document.addEventListener("touchstart", event => {
        stopTrackingMove();
        gesture = null;
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (touch.clientX > 32) return;
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
        if (owner) {
            clearSettleTimer();
            const surface = resolveSurface(owner, element);
            gesture = {
                x: touch.clientX,
                y: touch.clientY,
                lastX: touch.clientX,
                lastTime: performance.now(),
                owner,
                surface,
                width: surface?.clientWidth || window.innerWidth,
                axis: "pending",
            };
            // A non-passive document-wide touchmove listener makes every scroll
            // wait for JavaScript. Only install it while a real left-edge gesture
            // is active so ordinary app scrolling stays compositor-driven.
            document.addEventListener("touchmove", handleTouchMove, { passive: false, capture: true });
        }
    }, { passive: true, capture: true });
    document.addEventListener("touchend", event => {
        if (!gesture || event.changedTouches.length === 0) return;
        const current = gesture;
        gesture = null;
        stopTrackingMove();
        const touch = event.changedTouches[0];
        const dx = touch.clientX - current.x;
        const dy = Math.abs(touch.clientY - current.y);
        const elapsed = Math.max(1, performance.now() - current.lastTime);
        const velocity = (touch.clientX - current.lastX) / elapsed;
        const commit = current.axis === "x"
            && dx > dy * 1.2
            && (dx >= 68 || (dx >= 30 && velocity >= 0.45))
            && current.owner.enabled();
        finishSurface(current.surface, commit, commit ? () => current.owner.onBack() : undefined);
    }, { passive: true, capture: true });
    document.addEventListener("touchcancel", () => {
        const current = gesture;
        gesture = null;
        stopTrackingMove();
        finishSurface(current?.surface ?? null, false);
    }, { passive: true, capture: true });
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
