import { expect, test } from "bun:test";
import type { MessageView, PageView } from "../bridge";
import {
  afterSend,
  applyIntents,
  canReact,
  capture,
  deliveredID,
  editDraft,
  emptyDraft,
  historyLimit,
  imageInfo,
  imageProblem,
  loopbackEndpoint,
  mergeLatest,
  mergeOlder,
  redoDraft,
  returnAction,
  safeExternalURL,
  sendOutcome,
  settled,
  undoDraft,
  unreadSince,
} from "../chat";

test("links open only as http, https or mailto, without credentials or hidden characters", () => {
  expect(safeExternalURL("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  expect(safeExternalURL("http://example.com")).toBe("http://example.com/");
  expect(safeExternalURL("mailto:me@example.com")).toBe("mailto:me@example.com");
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vbscript:x",
    "app://open-dot/index.html",
    "https://user:pass@example.com",
    "https://user@example.com",
    "https://exa mple.com",
    "https://example.com/\u0000",
    "https://example.com/\u202e",
    " https://example.com",
    "/relative",
    "mailto:nobody",
    `https://example.com/${"a".repeat(2100)}`,
    42,
  ])
    expect(safeExternalURL(bad)).toBeUndefined();
});

test("the daemon address is only loopback http with a port and a token", () => {
  expect(loopbackEndpoint({ url: "http://127.0.0.1:4100", token: "t" })).toEqual({
    url: "http://127.0.0.1:4100",
    token: "t",
  });
  expect(loopbackEndpoint({ url: "http://[::1]:4100", token: "t" })).toBeDefined();
  for (const url of [
    "http://localhost:4100",
    "https://127.0.0.1:4100",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:70000",
    "http://127.0.0.1:4100/path",
    "http://127.0.0.1:4100?x=1",
    "http://user:pw@127.0.0.1:4100",
    "http://10.0.0.1:4100",
  ])
    expect(loopbackEndpoint({ url, token: "t" })).toBeUndefined();
  expect(loopbackEndpoint({ url: "http://127.0.0.1:4100", token: "" })).toBeUndefined();
  expect(loopbackEndpoint({ url: "http://127.0.0.1:4100", token: "a\nb" })).toBeUndefined();
  expect(loopbackEndpoint(null)).toBeUndefined();
});

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

test("image headers give type and size before decoding, for every type the app takes", () => {
  expect(imageInfo(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 });
  const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x20, 0x01, 0x10, 0x00]);
  expect(imageInfo(gif)).toEqual({ mime: "image/gif", width: 288, height: 16 });
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 0x20, 0, 0x40, 3, 0, 0,
  ]);
  expect(imageInfo(jpeg)).toEqual({ mime: "image/jpeg", width: 64, height: 32 });
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
  webp.set([99, 0, 0, 49, 0, 0], 24);
  expect(imageInfo(webp)).toEqual({ mime: "image/webp", width: 100, height: 50 });
  const tiff = new Uint8Array(8 + 2 + 24);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, 2, true);
  view.setUint16(10, 256, true);
  view.setUint16(12, 3, true);
  view.setUint16(18, 300, true);
  view.setUint16(22, 257, true);
  view.setUint16(24, 3, true);
  view.setUint16(30, 200, true);
  expect(imageInfo(tiff)).toEqual({ mime: "image/tiff", width: 300, height: 200 });
  expect(imageInfo(new TextEncoder().encode("<svg></svg>"))).toBeUndefined();
  expect(imageInfo(new Uint8Array([0x89, 0x50]))).toBeUndefined();
});

test("images over the count, byte or pixel limits are refused before decoding", () => {
  expect(imageProblem(png(10, 10), 0)).toBeUndefined();
  expect(imageProblem(png(10, 10), 5)).toBe("Attach at most five images.");
  expect(imageProblem(png(8000, 5001), 0)).toBe("That image has more than 40 million pixels.");
  expect(imageProblem(new Uint8Array(10 * 1024 * 1024 + 1), 0)).toBe(
    "Each image can be at most 10 MiB.",
  );
  expect(imageProblem(new Uint8Array(0), 0)).toBeDefined();
  expect(imageProblem(new TextEncoder().encode("<svg/>"), 0)).toContain("Only PNG");
});

test("each draft keeps its own undo and redo, with a burst of typing as one step", () => {
  let draft = emptyDraft();
  draft = editDraft(draft, "H", 1000);
  draft = editDraft(draft, "He", 1200);
  draft = editDraft(draft, "Hello", 1400);
  draft = editDraft(draft, "Hello there", 5000);
  expect(draft.undo).toEqual(["", "Hello"]);
  draft = undoDraft(draft);
  expect(draft.text).toBe("Hello");
  draft = undoDraft(draft);
  expect(draft.text).toBe("");
  expect(undoDraft(draft)).toBe(draft);
  draft = redoDraft(redoDraft(draft));
  expect(draft.text).toBe("Hello there");
  // A new edit clears what could be redone.
  draft = editDraft(undoDraft(draft), "Hello!", 9000);
  expect(draft.redo).toEqual([]);
});

test("a saved send removes only what it captured, keeping later edits and images", () => {
  const first = { mime: "image/png" as const, name: "a.png", data: png(1, 1), width: 1, height: 1 };
  const later = { ...first, name: "b.png" };
  const draft = {
    ...editDraft(emptyDraft(), "Hi", 1),
    images: [first],
    quote: { id: "msg_a", author: "dot" as const, text: "q" },
  };
  const sent = capture(draft);
  const unchanged = afterSend(draft, sent);
  expect(unchanged).toMatchObject({ text: "", images: [], quote: undefined, undo: [] });
  const edited = afterSend(
    { ...editDraft(draft, "Hi, and more", 5000), images: [first, later] },
    sent,
  );
  expect(edited.text).toBe("Hi, and more");
  expect(edited.images).toEqual([later]);
  expect(edited.undo.length).toBeGreaterThan(0);
});

const key = (fields: Partial<Parameters<typeof returnAction>[0]>) =>
  returnAction({
    key: "Enter",
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    ...fields,
  });

test("Return sends, Shift- and Option-Return add a line, and composition never sends", () => {
  expect(key({})).toBe("send");
  expect(key({ shiftKey: true })).toBe("newline");
  expect(key({ altKey: true })).toBe("newline");
  expect(key({ isComposing: true })).toBe("none");
  expect(key({ keyCode: 229 })).toBe("none");
  expect(key({ key: "a" })).toBe("none");
});

test("only an answer saying what happened settles a send; anything else is unknown, never resent", () => {
  expect(sendOutcome({ ok: true, value: { id: "msg_x" } })).toBe("saved");
  for (const status of [0, 400, 404, 409, 413, 415, 422])
    expect(sendOutcome({ ok: false, error: "", status })).toBe("refused");
  expect(sendOutcome({ ok: false, error: "", lost: true })).toBe("unknown");
  expect(sendOutcome({ ok: false, error: "", status: 401 })).toBe("unknown");
  expect(sendOutcome({ ok: false, error: "", status: 503 })).toBe("unknown");
  expect(sendOutcome({ ok: false, error: "" })).toBe("unknown");
  expect(settled("unknown")).toBe(false);
  for (const status of ["sending", "confirming", "sent", "delivered", "held", "cancelled"] as const)
    expect(settled(status)).toBe(true);
});

const message = (id: string, fields: Partial<MessageView> = {}): MessageView => ({
  id,
  sessionID: "ses_a",
  kind: "dot",
  hidden: false,
  text: id,
  tools: [],
  attachments: [],
  time: 0,
  reactions: [],
  ...fields,
});

test("the owner reacts only to the dot's visible messages", () => {
  expect(canReact(message("a"))).toBe(true);
  expect(canReact(message("a", { text: "", tools: ["dot_remind"] }))).toBe(true);
  expect(canReact(message("a", { text: "", tools: ["bash"] }))).toBe(false);
  expect(canReact(message("a", { hidden: true }))).toBe(false);
  for (const kind of ["owner", "peer", "notice"] as const)
    expect(canReact(message("a", { kind }))).toBe(false);
});

test("a stale read can't undo a change until a read for the same session shows it", () => {
  const intents = new Map([["a", { sessionID: "ses_a", emoji: "👍", hidden: true }]]);
  const stale = applyIntents([message("a")], intents);
  expect(stale.messages[0]).toMatchObject({
    hidden: true,
    reactions: [{ actor: "owner", emoji: "👍" }],
  });
  expect(stale.waiting.size).toBe(1);
  const fresh = applyIntents(
    [message("a", { hidden: true, reactions: [{ actor: "owner", emoji: "👍", updatedAt: 1 }] })],
    intents,
  );
  expect(fresh.waiting.size).toBe(0);
  // An intent from another session never paints this one.
  const other = applyIntents([message("a", { sessionID: "ses_b" })], intents);
  expect(other.messages[0]?.hidden).toBe(false);
  // A message outside this page keeps its intent for a later page.
  expect(applyIntents([], intents).waiting.size).toBe(1);
});

const page = (ids: string[], fields: Partial<PageView> = {}): PageView => ({
  messages: ids.map((id) => message(id)),
  sessionID: "ses_a",
  next: "cursor",
  pending: [],
  recentEmojis: [],
  ...fields,
});

test("latest pages keep loaded history, a new session starts over, and older pages past the limit detach", () => {
  const start = mergeLatest(undefined, page(["b", "c"]));
  const older = mergeOlder(start, page(["a"], { next: null }));
  expect(older.messages.map((item) => item.id)).toEqual(["a", "b", "c"]);
  const polled = mergeLatest(older, page(["c", "d"]));
  expect(polled.messages.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  expect(polled.next).toBeNull();
  const moved = mergeLatest(polled, page(["x"], { sessionID: "ses_b" }));
  expect(moved.messages.map((item) => item.id)).toEqual(["x"]);
  const many = Array.from({ length: historyLimit }, (_, index) => `m${index}`);
  const full = mergeLatest(undefined, page(many));
  const detached = mergeOlder(full, page(["older"]));
  expect(detached.detached).toBe(true);
  expect(detached.messages).toHaveLength(historyLimit);
  expect(detached.messages[0]?.id).toBe("older");
  // Back to latest: a detached view takes the next latest page whole.
  expect(mergeLatest(detached, page(["new"])).messages.map((item) => item.id)).toEqual(["new"]);
});

test("Delivered marks only a trailing owner message with nothing pending, and unread waits for a baseline", () => {
  const owner = message("o", { kind: "owner" });
  expect(deliveredID([message("a"), owner], [])).toBe("o");
  expect(deliveredID([owner, message("a")], [])).toBeUndefined();
  expect(deliveredID([owner], [{ id: "p", status: "sending", delivery: "auto" }])).toBeUndefined();
  const messages = [
    message("a"),
    owner,
    message("b"),
    message("c", { hidden: true }),
    message("d", { kind: "notice" }),
  ];
  expect(unreadSince(messages, undefined)).toBe(0);
  expect(unreadSince(messages, "a")).toBe(2);
  expect(unreadSince(messages, "d")).toBe(0);
});
