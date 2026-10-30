// The app's plain logic, kept apart from Electron and the DOM so it can be tested: the daemon
// address, the link policy, image checks, drafts, send outcomes and the chat's view of messages.
import type {
  DraftImage,
  MessageView,
  PageView,
  PendingView,
  QuoteView,
  ReceiptStatus,
  Result,
} from "./bridge";

/** The daemon's address and token from api.json, only as the daemon writes them. */
export interface Endpoint {
  url: string;
  token: string;
}

/**
 * Plain http to 127.0.0.1 or [::1] with a port and nothing else, like the notch's `API.loopback`,
 * so the token never leaves this Mac's daemon.
 */
export const loopbackEndpoint = (input: unknown): Endpoint | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const { url, token } = input as { url?: unknown; token?: unknown };
  if (typeof url !== "string" || typeof token !== "string" || !token || /[\s\0]/.test(token))
    return undefined;
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(url);
  const port = Number(match?.[2]);
  if (!match || !(port >= 1 && port <= 65535)) return undefined;
  return { url, token };
};

/** Controls, spaces, and invisible or direction-changing marks a link could hide behind. */
const hidden = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
};

const hasHidden = (text: string) => {
  for (const character of text) if (hidden(character)) return true;
  return false;
};

/**
 * The only links the app opens, in the default browser after an explicit click: http, https and
 * mailto, with no credentials, controls or spaces. Anything else stays plain text.
 */
export const safeExternalURL = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || raw.length > 2048 || hasHidden(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "mailto:") return url.pathname.includes("@") ? url.href : undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || !url.hostname) return undefined;
  return url.href;
};

export const imageLimits = { count: 5, bytes: 10 * 1024 * 1024, pixels: 40_000_000 } as const;

export type ImageType = DraftImage["mime"] | "image/tiff";

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Reads the type and size from an image's header, before anything decodes it. */
export const imageInfo = (
  bytes: Uint8Array,
): { mime: ImageType; width: number; height: number } | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (mime: ImageType, width: number, height: number) =>
    width > 0 && height > 0 ? { mime, width, height } : undefined;
  try {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      return ascii(bytes, 12, 4) === "IHDR"
        ? size("image/png", view.getUint32(16), view.getUint32(20))
        : undefined;
    if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
      return size("image/gif", view.getUint16(6, true), view.getUint16(8, true));
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
      const chunk = ascii(bytes, 12, 4);
      const triple = (at: number) => {
        if (at + 3 > bytes.length) throw new RangeError("short");
        return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
      };
      if (chunk === "VP8X") return size("image/webp", 1 + triple(24), 1 + triple(27));
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return size("image/webp", 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
      }
      if (chunk === "VP8 ")
        return size(
          "image/webp",
          view.getUint16(26, true) & 0x3fff,
          view.getUint16(28, true) & 0x3fff,
        );
      return undefined;
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1] ?? 0;
        // Start-of-frame markers carry the size; DHT, JPG and DAC don't.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return size("image/jpeg", view.getUint16(offset + 7), view.getUint16(offset + 5));
        offset += 2 + view.getUint16(offset + 2);
      }
      return undefined;
    }
    const little = ascii(bytes, 0, 4) === "II*\0";
    if (little || ascii(bytes, 0, 4) === "MM\0*") {
      const ifd = view.getUint32(4, little);
      const count = view.getUint16(ifd, little);
      let width = 0;
      let height = 0;
      for (let index = 0; index < count && index < 512; index++) {
        const at = ifd + 2 + index * 12;
        const tag = view.getUint16(at, little);
        const type = view.getUint16(at + 2, little);
        const value = type === 3 ? view.getUint16(at + 8, little) : view.getUint32(at + 8, little);
        if (tag === 256) width = value;
        if (tag === 257) height = value;
      }
      return size("image/tiff", width, height);
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/** Why an image can't be attached, or nothing when it can, checked before any decoding. */
export const imageProblem = (bytes: Uint8Array, attached: number): string | undefined => {
  if (attached >= imageLimits.count) return "Attach at most five images.";
  if (bytes.byteLength === 0) return "That file is empty or isn't a regular file.";
  if (bytes.byteLength > imageLimits.bytes) return "Each image can be at most 10 MiB.";
  const info = imageInfo(bytes);
  if (!info) return "Only PNG, JPEG, GIF, WebP and pasted TIFF images can be attached.";
  if (info.width * info.height > imageLimits.pixels)
    return "That image has more than 40 million pixels.";
  return undefined;
};

export const displayName = (name: string, mime: string) => {
  let clean = "";
  for (const character of name)
    if (character === " " || (!hidden(character) && !"/\\:".includes(character)))
      clean += character;
  clean = clean.slice(0, 255);
  return clean || `image.${mime.split("/")[1] ?? "png"}`;
};

// Drafts: kept per dot in memory, with their own undo and redo.

export interface Draft {
  text: string;
  quote?: QuoteView | undefined;
  images: DraftImage[];
  undo: string[];
  redo: string[];
  // When the last edit was saved to undo, so a burst of typing is one step.
  editedAt: number;
}

export const emptyDraft = (): Draft => ({ text: "", images: [], undo: [], redo: [], editedAt: 0 });

const undoLimit = 200;

/** Records a text change. Typing within a second extends the last undo step. */
export const editDraft = (draft: Draft, text: string, now: number): Draft => {
  if (text === draft.text) return draft;
  const burst = now - draft.editedAt < 1000 && draft.undo.length > 0;
  return {
    ...draft,
    text,
    undo: burst ? draft.undo : [...draft.undo, draft.text].slice(-undoLimit),
    redo: [],
    editedAt: now,
  };
};

export const undoDraft = (draft: Draft): Draft => {
  const previous = draft.undo.at(-1);
  if (previous === undefined) return draft;
  return {
    ...draft,
    text: previous,
    undo: draft.undo.slice(0, -1),
    redo: [...draft.redo, draft.text],
    editedAt: 0,
  };
};

export const redoDraft = (draft: Draft): Draft => {
  const next = draft.redo.at(-1);
  if (next === undefined) return draft;
  return {
    ...draft,
    text: next,
    undo: [...draft.undo, draft.text],
    redo: draft.redo.slice(0, -1),
    editedAt: 0,
  };
};

export interface Captured {
  text: string;
  quote?: QuoteView | undefined;
  images: DraftImage[];
}

export const capture = (draft: Draft): Captured => ({
  text: draft.text,
  quote: draft.quote,
  images: draft.images,
});

/**
 * After a send the daemon saved, removes only what was sent: text and quote unless the owner
 * changed them since, and the sent images, keeping any added meanwhile.
 */
export const afterSend = (draft: Draft, sent: Captured): Draft => ({
  ...draft,
  text: draft.text === sent.text ? "" : draft.text,
  quote: draft.quote?.id === sent.quote?.id ? undefined : draft.quote,
  images: draft.images.filter((image) => !sent.images.includes(image)),
  undo: draft.text === sent.text ? [] : draft.undo,
  redo: draft.text === sent.text ? [] : draft.redo,
});

/** Return sends; Shift- or Option-Return adds a line; nothing happens mid-composition. */
export const returnAction = (event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): "send" | "newline" | "none" => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return "none";
  if (event.shiftKey || event.altKey) return "newline";
  if (event.metaKey || event.ctrlKey) return "none";
  return "send";
};

// Sending: the app saves the ID before it posts, and never sends a message again on its own.

/**
 * What a POST's result means for the saved attempt: `saved` (the daemon has the row), `refused`
 * (the daemon answered that it saved nothing) or `unknown` (the request may have arrived).
 */
export const sendOutcome = (result: Result<unknown>): "saved" | "refused" | "unknown" => {
  if (result.ok) return "saved";
  // Status 0: the app refused it, or the daemon couldn't be reached, before anything went out.
  if (result.status === 0 && !result.lost) return "refused";
  if (result.lost || result.status === undefined) return "unknown";
  // A 401 means the daemon restarted with a new token; the old one may still have saved it.
  if (result.status === 401 || result.status >= 500) return "unknown";
  return "refused";
};

/** A receipt settles an attempt only when the daemon has its row; `unknown` stays unresolved. */
export const settled = (status: ReceiptStatus) => status !== "unknown";

// The chat's view of a dot's messages.

export const tapbacks = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;

/** The owner reacts only to the dot's own messages that the daemon already shows. */
export const canReact = (message: MessageView) =>
  message.kind === "dot" &&
  !message.hidden &&
  (message.text.trim() !== "" || message.tools.some((tool) => tool.startsWith("dot_")));

export const reactionOf = (message: MessageView, actor: "owner" | "dot") =>
  message.reactions.find((reaction) => reaction.actor === actor)?.emoji ?? null;

/**
 * A change the owner made to one message, a reaction or whether it's hidden, shown over what reads
 * return until a read settles it. `settledAt` is when its call returned; until then, and whenever
 * its outcome is unknown, it blocks any other change to that message.
 */
export interface Intent {
  sessionID: string;
  emoji?: string | null;
  hidden?: boolean;
  settledAt?: number;
}

const showsIntent = (message: MessageView, intent: Intent) =>
  (intent.emoji === undefined || reactionOf(message, "owner") === intent.emoji) &&
  (intent.hidden === undefined || message.hidden === intent.hidden);

/** Shows each intended change over the messages as reads returned them. */
export const applyIntents = (
  messages: MessageView[],
  intents: ReadonlyMap<string, Intent>,
): MessageView[] =>
  messages.map((message) => {
    const intent = intents.get(message.id);
    if (!intent || intent.sessionID !== message.sessionID || showsIntent(message, intent))
      return message;
    return {
      ...message,
      hidden: intent.hidden ?? message.hidden,
      reactions:
        intent.emoji === undefined
          ? message.reactions
          : [
              ...message.reactions.filter((reaction) => reaction.actor !== "owner"),
              { actor: "owner" as const, emoji: intent.emoji, updatedAt: intent.settledAt ?? 0 },
            ],
    };
  });

/**
 * The intents a read settles: its call has returned, and the read either started after that or
 * already shows the change. A read that started earlier can't flicker the change back, and a read
 * that started later is the daemon's word, even when the change didn't take.
 */
export const settledBy = (
  messages: readonly MessageView[],
  intents: ReadonlyMap<string, Intent>,
  startedAt: number,
): string[] =>
  messages.flatMap((message) => {
    const intent = intents.get(message.id);
    return intent?.settledAt !== undefined &&
      intent.sessionID === message.sessionID &&
      (startedAt >= intent.settledAt || showsIntent(message, intent))
      ? [message.id]
      : [];
  });

export const historyLimit = 600;

export interface Conversation {
  sessionID: string;
  // Which discovered daemon the cursor came from; another one can't read it.
  generation: number;
  // What's loaded, oldest first: the latest page and any older pages above it.
  messages: MessageView[];
  // The latest page alone, for unread counts and Delivered, even while reading older messages.
  latest: MessageView[];
  pending: PendingView[];
  // The cursor for older messages, or null at the start or once a daemon restart voided it.
  next: string | null;
  // True once older pages pushed the newest messages out: polls refresh what's loaded in place,
  // and Back to latest returns.
  detached: boolean;
}

const fresh = (page: PageView): Conversation => ({
  sessionID: page.sessionID,
  generation: page.generation,
  messages: page.messages,
  latest: page.messages,
  pending: page.pending,
  next: page.next,
  detached: false,
});

/** Index of the first or last message in `keep`, such as those a selection spans. */
const kept = (messages: readonly MessageView[], keep: ReadonlySet<string>, last: boolean) =>
  last
    ? messages.findLastIndex((message) => keep.has(message.id))
    : messages.findIndex((message) => keep.has(message.id));

/**
 * Merges the latest page into what's shown. A new session, or a restarted daemon whose cursors the
 * old ones can't continue, starts over unless the owner is reading older messages; a page from a
 * daemon older than what's shown is ignored. Past the history limit the oldest messages go, except
 * any in `keep`.
 */
export const mergeLatest = (
  current: Conversation | undefined,
  page: PageView,
  keep: ReadonlySet<string> = new Set(),
): Conversation => {
  if (!current || current.sessionID !== page.sessionID) return fresh(page);
  if (page.generation < current.generation) return current;
  if (current.detached) {
    const read = new Map(page.messages.map((message) => [message.id, message]));
    return {
      ...current,
      generation: page.generation,
      messages: current.messages.map((message) => read.get(message.id) ?? message),
      latest: page.messages,
      pending: page.pending,
      next: page.generation === current.generation ? current.next : null,
    };
  }
  if (page.generation !== current.generation) return fresh(page);
  const first = page.messages[0];
  const cut = first ? current.messages.findIndex((message) => message.id === first.id) : -1;
  // A page that doesn't overlap what's shown starts over, so no gap is hidden.
  if (cut < 0) return fresh(page);
  const messages = [...current.messages.slice(0, cut), ...page.messages];
  const keepFrom = kept(messages, keep, false);
  const start = Math.max(
    0,
    Math.min(messages.length - historyLimit, keepFrom < 0 ? Infinity : keepFrom),
  );
  return {
    ...current,
    messages: messages.slice(start),
    latest: page.messages,
    pending: page.pending,
    next: start > 0 ? page.next : current.next,
  };
};

/**
 * Prepends an older page from the same session and daemon. Past the limit the newest messages go,
 * except any in `keep`, and polls then wait for Back to latest.
 */
export const mergeOlder = (
  current: Conversation,
  page: PageView,
  keep: ReadonlySet<string> = new Set(),
): Conversation => {
  if (page.sessionID !== current.sessionID || page.generation !== current.generation)
    return current;
  const known = new Set(current.messages.map((message) => message.id));
  const messages = [
    ...page.messages.filter((message) => !known.has(message.id)),
    ...current.messages,
  ];
  const end = Math.max(historyLimit, kept(messages, keep, true) + 1);
  return {
    ...current,
    messages: messages.slice(0, end),
    next: page.next,
    detached: current.detached || end < messages.length,
  };
};

/** Puts a message as a pinned read returned it wherever it's loaded, in the same session. */
export const replaceMessage = (current: Conversation, message: MessageView): Conversation => {
  if (message.sessionID !== current.sessionID) return current;
  const swap = (list: MessageView[]) =>
    list.some((item) => item.id === message.id)
      ? list.map((item) => (item.id === message.id ? message : item))
      : list;
  return { ...current, messages: swap(current.messages), latest: swap(current.latest) };
};

// Sends the app made, with what they captured, kept only while a row still shows them.

export interface Sent {
  dot: string;
  sessionID: string;
  captured: Captured;
  at: number;
  // `unknown` while its outcome is unknown, `pending` once the daemon has it.
  state: "unknown" | "pending";
  // Whether a read listed it as pending, so its leaving means it was delivered or cancelled.
  listed: boolean;
}

export const sentLimit = 20;

/**
 * Drops sends a page shows are done: delivered into the history, gone from pending after being
 * listed, from an old session, or never listed within a minute. Unknown sends wait for their
 * receipt. At most `sentLimit` are kept, newest first.
 */
export const keepSent = (
  sent: ReadonlyMap<string, Sent>,
  dot: string,
  page: Pick<PageView, "sessionID" | "messages" | "pending">,
  now: number,
): Map<string, Sent> => {
  const pending = new Set(page.pending.map((item) => item.id));
  const delivered = new Set(page.messages.map((item) => item.id));
  const next = new Map<string, Sent>();
  for (const [id, item] of sent) {
    if (item.dot !== dot || item.state === "unknown") next.set(id, item);
    else if (item.sessionID !== page.sessionID || delivered.has(id)) continue;
    else if (pending.has(id)) next.set(id, item.listed ? item : { ...item, listed: true });
    else if (!item.listed && now - item.at < 60_000) next.set(id, item);
  }
  return new Map([...next].toSorted(([, a], [, b]) => b.at - a.at).slice(0, sentLimit));
};

/** Send now and Cancel, as the notch offers them: nothing while open-dot confirms a send. */
export const pendingActions = (pending: PendingView) => ({
  sendNow:
    pending.status === "sending" || (pending.status === "sent" && pending.delivery === "queue"),
  cancel: pending.status === "sending" || pending.status === "sent",
});

/** A worker opens once its session exists, and stops (or tries again) until it's done. */
export const workerActions = (state: string) => ({
  open: state !== "creating",
  stop: state !== "done",
});

/** Attachments the app shows as images; anything else is listed by name. */
export const isImageType = (mime: string) =>
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    mime.split(";")[0]?.trim().toLowerCase() ?? "",
  );

export const fallbackTapbacks = ["🧐", "✋", "👀", "🧠", "🔥"] as const;

/** The menu's second row, always five: recent choices, then fallbacks not already shown. */
export const recentTapbacks = (recent: readonly string[]) => {
  const used = recent.slice(0, 5);
  return [...used, ...fallbackTapbacks.filter((emoji) => !used.includes(emoji))].slice(0, 5);
};

/** The owner's current reaction when neither row shows it, listed on its own so it can go. */
export const unlistedTapback = (selected: string | null, row: readonly string[]) =>
  selected && !(tapbacks as readonly string[]).includes(selected) && !row.includes(selected)
    ? selected
    : undefined;

export const pendingLabel = { sending: "Sending…", confirming: "Confirming…", sent: "Sent" };

/**
 * "Delivered" under the owner's last message when it's the newest message and nothing of theirs
 * is still pending: it's in the dot's history. Nothing says the dot has read it.
 */
export const deliveredID = (messages: MessageView[], pending: PendingView[]) => {
  const last = messages.findLast((message) => !message.hidden);
  return last?.kind === "owner" && pending.length === 0 ? last.id : undefined;
};

/**
 * Messages that arrived since the owner last looked, counted only after the first successful
 * read set a baseline, never the owner's own.
 */
export const unreadSince = (messages: MessageView[], seen: string | undefined) => {
  if (seen === undefined) return 0;
  const index = messages.findIndex((message) => message.id === seen);
  const after = index < 0 ? messages : messages.slice(index + 1);
  return after.filter((message) => message.kind !== "owner" && !message.hidden).length;
};

/** Seconds before the next read after this many failures in a row. */
export const backoff = (failures: number) => Math.min(30, 2 ** Math.max(0, failures - 1));

/** A fenced block shown as a diff: a diff or patch language, or text that reads as one. */
export const isDiff = (language: string | undefined, code: string) =>
  language === "diff" ||
  language === "patch" ||
  (!language && /^(diff --git |--- \S.*\n\+\+\+ \S.*\n@@ )/m.test(code));
