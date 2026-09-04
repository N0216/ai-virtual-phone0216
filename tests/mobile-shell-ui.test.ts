// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("installed mobile shells use the full large viewport while browser mode keeps dvh", () => {
  const css = read("styles/phone-shell.css");
  assert.match(css, /--phone-screen-height:\s*100dvh/);
  assert.match(css, /@media \(display-mode: standalone\), \(display-mode: fullscreen\)[\s\S]*--phone-screen-height:\s*100lvh/);
  assert.match(css, /@media \(display-mode: standalone\), \(display-mode: fullscreen\)[\s\S]*\.app-root\.splash-root[\s\S]*height:\s*100lvh/);
});

test("chat composer follows the WeChat voice-input-emoji-more layout", () => {
  const source = read("components/chat/chat-room.tsx");
  const start = source.indexOf('<div className="chat-composer-row">');
  const end = source.indexOf("{showPlusMenu && (", start);
  const composer = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(composer.indexOf('aria-label="语音输入"') < composer.indexOf('className="chat-input-textarea"'));
  assert.ok(composer.indexOf('className="chat-input-textarea"') < composer.indexOf('aria-label="表情"'));
  assert.ok(composer.indexOf('aria-label="表情"') < composer.indexOf('aria-label="更多功能"'));
  assert.doesNotMatch(composer, /chat-offline-toggle/);
});

test("unread badges use live chat counters and WeChat positions", () => {
  const app = read("components/chat/phone-chat-app.tsx");
  const room = read("components/chat/chat-room.tsx");
  const css = read("styles/chat.css");
  assert.match(app, /getTotalChatUnreadCount\(\)/);
  assert.match(app, /chat-unread-updated/);
  assert.match(app, /chat-tab-unread-badge/);
  assert.match(room, /chat-back-unread-badge/);
  assert.match(css, /\.chat-tab-unread-badge\s*\{[\s\S]*top:\s*-8px;[\s\S]*left:\s*13px;/);
  assert.match(css, /\.chat-back-unread-badge\s*\{[\s\S]*position:\s*absolute;[\s\S]*left:\s*calc\(100% - 1px\);/);
});

test("edge back is global, finger tracking and velocity aware", () => {
  const hook = read("lib/use-edge-swipe-back.ts");
  const shell = read("components/desktop-shell.tsx");
  assert.match(shell, /useEdgeSwipeBack\(\(\) => setActiveApp\(null\), activeApp !== null/);
  assert.match(hook, /addEventListener\("touchmove"/);
  assert.match(hook, /passive:\s*false/);
  assert.match(hook, /--edge-swipe-back-x/);
  assert.match(hook, /velocity\s*>=\s*0\.45/);
});
