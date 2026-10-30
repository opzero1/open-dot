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
  fencePage,
  historyLimit,
  imageInfo,
  isImageType,
  keepSent,
  imageProblem,
  loopbackEndpoint,
  mergeLatest,
  mergeOlder,
  pendingActions,
  recentTapbacks,
  redoDraft,
  replaceMessage,
  returnAction,
  safeExternalURL,
  type Sent,
  sendOutcome,
  sentLimit,
  settled,
  settledBy,
  undoDraft,
  unlistedTapback,
  unreadSince,
  workerActions,
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
  // A success the app couldn't read: the daemon may have saved it.
  expect(sendOutcome({ ok: false, error: "", status: 202, lost: true })).toBe("unknown");
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

test("a change stays shown over stale reads until a read that started after its call settles it", () => {
  const pendingIntent = { sessionID: "ses_a", emoji: "👍", hidden: true };
  const shown = applyIntents([message("a")], new Map([["a", pendingIntent]]));
  expect(shown[0]).toMatchObject({ hidden: true, reactions: [{ actor: "owner", emoji: "👍" }] });
  // While its call is out, nothing settles it, even a read that already shows it.
  const showing = message("a", {
    hidden: true,
    reactions: [{ actor: "owner", emoji: "👍", updatedAt: 1 }],
  });
  expect(settledBy([showing], new Map([["a", pendingIntent]]), 100)).toEqual([]);
  const returned = new Map([["a", { ...pendingIntent, settledAt: 50 }]]);
  // A read that started before the call returned and shows the old state can't settle it...
  expect(settledBy([message("a")], returned, 40)).toEqual([]);
  // ...but one that shows the change, or that started after the daemon answered, does: the second
  // is the daemon's word even when the change didn't take.
  expect(settledBy([showing], returned, 40)).toEqual(["a"]);
  expect(settledBy([message("a")], returned, 50)).toEqual(["a"]);
  // An intent from another session never paints or settles this one.
  const other = message("a", { sessionID: "ses_b" });
  expect(applyIntents([other], returned)[0]?.hidden).toBe(false);
  expect(settledBy([other], returned, 99)).toEqual([]);
});

test("a change whose answer was lost waits for a read that shows it, however late", () => {
  const lost = new Map([
    ["a", { sessionID: "ses_a", emoji: "👍", settledAt: 50, uncertain: true }],
  ]);
  // The PUT may still be on its way: reads after the timeout that show the old state settle nothing.
  expect(settledBy([message("a")], lost, 60)).toEqual([]);
  expect(settledBy([message("a")], lost, 10_000)).toEqual([]);
  expect(applyIntents([message("a")], lost)[0]?.reactions).toMatchObject([
    { actor: "owner", emoji: "👍" },
  ]);
  // Once a read shows it landed, even one that began before, it settles.
  const landed = message("a", { reactions: [{ actor: "owner", emoji: "👍", updatedAt: 70 }] });
  expect(settledBy([landed], lost, 10_000)).toEqual(["a"]);
  const restore = new Map([
    ["a", { sessionID: "ses_a", hidden: false, settledAt: 50, uncertain: true }],
  ]);
  expect(settledBy([message("a", { hidden: true })], restore, 99)).toEqual([]);
  expect(settledBy([message("a")], restore, 99)).toEqual(["a"]);
});

test("a latest page can't replace a message with a state from before its change was confirmed", () => {
  const current = mergeLatest(undefined, page(["a", "b"]));
  const confirmed = replaceMessage(
    current,
    message("a", { hidden: true, reactions: [{ actor: "owner", emoji: "👍", updatedAt: 1 }] }),
  );
  const fences = new Map([["a", 100]]);
  // A page that began before the change was confirmed keeps the confirmed message, and only it.
  const stale = page(["a", "b"]);
  stale.messages[1] = message("b", { text: "edited" });
  const kept = fencePage(stale, confirmed, fences, 99);
  expect(kept.messages[0]).toBe(confirmed.messages[0]);
  expect(kept.messages[1]?.text).toBe("edited");
  expect(mergeLatest(confirmed, kept).messages[0]).toMatchObject({ hidden: true });
  // One that began after it is the daemon's word.
  const later = fencePage(stale, confirmed, fences, 100);
  expect(later.messages[0]).toBe(stale.messages[0]);
  // Another session's page starts over untouched.
  const moved = page(["a"], { sessionID: "ses_b" });
  expect(fencePage(moved, confirmed, fences, 0)).toBe(moved);
});

const page = (ids: string[], fields: Partial<PageView> = {}): PageView => ({
  messages: ids.map((id) => message(id)),
  sessionID: "ses_a",
  next: "cursor",
  pending: [],
  recentEmojis: [],
  generation: 1,
  startedAt: 0,
  ...fields,
});

const ids = (conversation: { messages: MessageView[] }) =>
  conversation.messages.map((item) => item.id);

test("latest pages keep loaded history, a new session starts over, and a detached view survives polls", () => {
  const start = mergeLatest(undefined, page(["b", "c"]));
  const older = mergeOlder(start, page(["a"], { next: null }));
  expect(ids(older)).toEqual(["a", "b", "c"]);
  const polled = mergeLatest(older, page(["c", "d"]));
  expect(ids(polled)).toEqual(["a", "b", "c", "d"]);
  expect(polled.next).toBeNull();
  expect(ids(mergeLatest(polled, page(["x"], { sessionID: "ses_b" })))).toEqual(["x"]);
  const many = Array.from({ length: historyLimit }, (_, index) => `m${index}`);
  const full = mergeLatest(undefined, page(many));
  const detached = mergeOlder(full, page(["older"], { next: "older-cursor" }));
  expect(detached.detached).toBe(true);
  expect(detached.messages).toHaveLength(historyLimit);
  expect(detached.messages[0]?.id).toBe("older");
  // Polls keep the reading window, refresh what it shows, and track the latest page apart.
  const hidden = page(["m0", "new"]);
  hidden.messages[0] = message("m0", { hidden: true });
  const kept = mergeLatest(detached, hidden);
  expect(ids(kept)).toEqual(ids(detached));
  expect(kept.messages[1]).toMatchObject({ id: "m0", hidden: true });
  expect(kept.latest.map((item) => item.id)).toEqual(["m0", "new"]);
  expect(kept.next).toBe("older-cursor");
  // Pushing past the limit keeps selected messages instead of cutting them.
  const selected = new Set([`m${historyLimit - 1}`]);
  const wide = mergeOlder(full, page(["older"]), selected);
  expect(wide.messages).toHaveLength(historyLimit + 1);
  expect(wide.detached).toBe(false);
});

test("an empty latest page with a continuation keeps older pages until its cursor moves", () => {
  const empty = page([], { next: "head" });
  const older = mergeOlder(mergeLatest(undefined, empty), page(["a"], { next: "older" }));
  expect(ids(older)).toEqual(["a"]);
  const polled = mergeLatest(older, empty);
  expect(ids(polled)).toEqual(["a"]);
  expect(polled.next).toBe("older");
  // New mechanics moved the head: what's loaded may hide a gap, so it starts over.
  const moved = mergeLatest(polled, page([], { next: "moved" }));
  expect(ids(moved)).toEqual([]);
  expect(moved.next).toBe("moved");
});

test("a restarted daemon voids old cursors, and older pages from another daemon are ignored", () => {
  const start = mergeOlder(mergeLatest(undefined, page(["b", "c"])), page(["a"]));
  // Same session, new daemon: the old cursor can't be read, so the view starts from its latest page.
  const restarted = mergeLatest(start, page(["c", "d"], { generation: 2, next: "new-cursor" }));
  expect(ids(restarted)).toEqual(["c", "d"]);
  expect(restarted).toMatchObject({ generation: 2, next: "new-cursor" });
  // A late page from the old daemon changes nothing.
  expect(mergeLatest(restarted, page(["z"], { generation: 1 }))).toBe(restarted);
  expect(mergeOlder(restarted, page(["y"], { generation: 1 }))).toBe(restarted);
  // While reading older messages, the window stays but the dead cursor goes.
  const detached = { ...start, detached: true };
  const kept = mergeLatest(detached, page(["c", "d"], { generation: 2 }));
  expect(ids(kept)).toEqual(["a", "b", "c"]);
  expect(kept.next).toBeNull();
});

test("a pinned read replaces an older loaded message, in its own session only", () => {
  const start = mergeOlder(mergeLatest(undefined, page(["b"])), page(["a"]));
  const updated = replaceMessage(start, message("a", { hidden: true }));
  expect(updated.messages[0]?.hidden).toBe(true);
  expect(replaceMessage(start, message("a", { sessionID: "ses_b", hidden: true }))).toBe(start);
});

const captured = { text: "hi", images: [] };
const sentItem = (fields: Partial<Sent> = {}): Sent => ({
  dot: "jojo",
  sessionID: "ses_a",
  captured,
  at: 1000,
  state: "pending",
  listed: false,
  ...fields,
});

const listed = (pending: string[], messages: string[] = [], sessionID = "ses_a") => ({
  sessionID,
  messages: messages.map((id) => message(id)),
  pending: pending.map((id) => ({ id, status: "sent" as const, delivery: "queue" })),
});

test("a send's capture goes once it's delivered, cancelled, from an old session or never listed", () => {
  let sent = new Map([
    ["p", sentItem()],
    ["u", sentItem({ state: "unknown" })],
    ["other", sentItem({ dot: "polnareff" })],
  ]);
  sent = keepSent(sent, "jojo", listed(["p"]), 2000);
  expect(sent.get("p")?.listed).toBe(true);
  // Gone from pending after being listed: delivered or cancelled.
  expect([...keepSent(sent, "jojo", listed([]), 2000).keys()].toSorted()).toEqual(["other", "u"]);
  // Not listed yet: a read may have started before the send; it waits a minute.
  const fresh = new Map([["n", sentItem()]]);
  expect(keepSent(fresh, "jojo", listed([]), 30_000).has("n")).toBe(true);
  expect(keepSent(fresh, "jojo", listed([]), 70_000).has("n")).toBe(false);
  expect(keepSent(fresh, "jojo", listed([], ["n"]), 2000).has("n")).toBe(false);
  expect(keepSent(fresh, "jojo", listed(["n"], [], "ses_b"), 2000).has("n")).toBe(false);
  const many = new Map(
    Array.from({ length: sentLimit + 5 }, (_, index) => [`s${index}`, sentItem({ at: index })]),
  );
  const bounded = keepSent(many, "polnareff", listed([]), 0);
  expect(bounded.size).toBe(sentLimit);
  expect(bounded.has(`s${sentLimit + 4}`)).toBe(true);
});

const actions = (status: "sending" | "confirming" | "sent", delivery: string | null) =>
  pendingActions({ id: "p", status, delivery });

test("pending, worker and attachment actions match the notch", () => {
  expect(actions("sending", "auto")).toEqual({ sendNow: true, cancel: true });
  expect(actions("sent", "queue")).toEqual({ sendNow: true, cancel: true });
  expect(actions("sent", "steer")).toEqual({ sendNow: false, cancel: true });
  expect(actions("confirming", "queue")).toEqual({ sendNow: false, cancel: false });
  expect(workerActions("creating")).toEqual({ open: false, stop: true });
  expect(workerActions("running")).toEqual({ open: true, stop: true });
  expect(workerActions("stopping")).toEqual({ open: true, stop: true });
  expect(workerActions("done")).toEqual({ open: true, stop: false });
  expect(isImageType("image/PNG; charset=binary")).toBe(true);
  expect(isImageType("image/svg+xml")).toBe(false);
  expect(isImageType("application/pdf")).toBe(false);
});

test("the second Tapback row fills to five, and a reaction neither row shows is listed", () => {
  expect(recentTapbacks([])).toEqual(["🧐", "✋", "👀", "🧠", "🔥"]);
  expect(recentTapbacks(["🎉", "👀"])).toEqual(["🎉", "👀", "🧐", "✋", "🧠"]);
  const row = recentTapbacks(["🎉"]);
  expect(unlistedTapback("🦄", row)).toBe("🦄");
  expect(unlistedTapback("🎉", row)).toBeUndefined();
  expect(unlistedTapback("❤️", row)).toBeUndefined();
  expect(unlistedTapback(null, row)).toBeUndefined();
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
