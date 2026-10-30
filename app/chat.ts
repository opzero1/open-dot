// The app's plain logic, kept apart from Electron and the DOM so it can be tested: the daemon
// address, the link policy, image checks, drafts, send outcomes and the chat's view of messages.
import type {
  ActivityView,
  DraftImage,
  MessageView,
  PageView,
  PendingView,
  QuoteView,
  ReceiptStatus,
  Result,
  WorkCounts,
  WorkLogView,
} from "./bridge";
import { fits, workLogShape } from "./decode";

/** The daemon's address and token from api.json, only as the daemon writes them. */
export interface Endpoint {
  url: string;
  token: string;
}

/**
 * Plain http to 127.0.0.1 or [::1] with a port and nothing else,
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

/** A remote image or video a dot's reply links to, fetched only through the daemon. */
export interface MediaView {
  id: string;
  url: string;
  kind: "image" | "video";
}

export const mediaLimit = 32 * 1024 * 1024;

const mp4Brands = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash"]);

/** The type remote media bytes really are: the raster images and MP4 or WebM, never SVG or HTML. */
export const mediaType = (bytes: Uint8Array) => {
  const image = imageInfo(bytes);
  if (image && image.mime !== "image/tiff") return image.mime;
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (mp4Brands.has(brand)) return "video/mp4";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && ascii(bytes, 0, 64).includes("webm"))
    return "video/webm";
  return undefined;
};

/** The URL as the daemon lists it: parsed, without its fragment. */
export const mediaKey = (raw: unknown) => {
  if (typeof raw !== "string" || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

const isMedia = (entry: unknown): entry is MediaView =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  "url" in entry &&
  "kind" in entry &&
  typeof entry.id === "string" &&
  /^[\da-f]{16}$/.test(entry.id) &&
  safeExternalURL(entry.url) !== undefined &&
  (entry.kind === "image" || entry.kind === "video");

/** The media a message lists, keeping only well-formed entries. */
export const messageMedia = (message: { media?: unknown }): MediaView[] =>
  Array.isArray(message.media) ? message.media.filter(isMedia).slice(0, 8) : [];

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
 * return until a read settles it, and blocking any other change to that message meanwhile.
 * `settledAt` is when its call returned. `uncertain` means a call's answer was lost, so the change
 * may still land at any time: only a read that shows it settles it.
 */
export interface Intent {
  sessionID: string;
  emoji?: string | null;
  hidden?: boolean;
  settledAt?: number | undefined;
  uncertain?: boolean;
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
 * The intents a read settles: its call has returned, and the read already shows the change or, for
 * a change the daemon answered, started after that answer. A read that started earlier can't
 * flicker the change back; a later one is the daemon's word, even when the change didn't take. A
 * change whose answer was lost waits for a read that shows it, since it may still land.
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
      (showsIntent(message, intent) || (!intent.uncertain && startedAt >= intent.settledAt))
      ? [message.id]
      : [];
  });

/**
 * When each settled change was confirmed, by message ID: a read that started before then may
 * carry the old state, so it never replaces that message.
 */
export type Fences = ReadonlyMap<string, number>;

export const fenced = (fences: Fences | undefined, id: string, startedAt: number) =>
  startedAt < (fences?.get(id) ?? -Infinity);

/** A latest page with every message a fence covers kept as it's already loaded. */
export const fencePage = (
  page: PageView,
  current: Conversation | undefined,
  fences: Fences | undefined,
  startedAt: number,
): PageView => {
  if (!current || current.sessionID !== page.sessionID || !fences?.size) return page;
  const loaded = new Map([...current.latest, ...current.messages].map((item) => [item.id, item]));
  return {
    ...page,
    messages: page.messages.map((message) =>
      fenced(fences, message.id, startedAt) ? (loaded.get(message.id) ?? message) : message,
    ),
  };
};

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
  // The latest page's own cursor: an empty latest page with the same one means nothing new came.
  latestNext: string | null;
  // True once older pages pushed the newest messages out: polls refresh what's loaded in place,
  // and Back to latest returns.
  detached: boolean;
  // Which run of contiguous history this is: every start-over gets a new one, so an older page
  // read for a window that's gone can't be joined to the new one.
  revision: number;
}

let revisions = 0;

const fresh = (page: PageView): Conversation => ({
  revision: ++revisions,
  sessionID: page.sessionID,
  generation: page.generation,
  messages: page.messages,
  latest: page.messages,
  pending: page.pending,
  next: page.next,
  latestNext: page.next,
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
      latestNext: page.next,
    };
  }
  if (page.generation !== current.generation) return fresh(page);
  const first = page.messages[0];
  // A latest page with nothing to show, whose cursor hasn't moved, keeps the older pages loaded
  // beneath it: nothing arrived in between.
  if (!first && page.next !== null && page.next === current.latestNext)
    return { ...current, latest: [], pending: page.pending };
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
    latestNext: page.next,
  };
};

/** An older-page read: the window it continues and the cursor it was read from. */
export interface OlderRead {
  revision: number;
  cursor: string;
}

export const olderRead = (current: Conversation): OlderRead | undefined =>
  current.next === null ? undefined : { revision: current.revision, cursor: current.next };

/**
 * Whether an older read still continues what's shown: a start-over, Back to latest or any other
 * cursor change since it began voids its answer, success or error.
 */
export const continues = (current: Conversation | undefined, read: OlderRead) =>
  current?.revision === read.revision && current.next === read.cursor;

/**
 * Prepends an older page read from `read`, if it still continues what's shown, from the same session
 * and daemon. Past the limit the newest messages go, except any in `keep`, and polls then wait for
 * Back to latest.
 */
export const mergeOlder = (
  current: Conversation,
  page: PageView,
  read: OlderRead,
  keep: ReadonlySet<string> = new Set(),
): Conversation => {
  if (
    !continues(current, read) ||
    page.sessionID !== current.sessionID ||
    page.generation !== current.generation
  )
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

/** Send now and Cancel: nothing while open-dot confirms a send. */
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

// The work log: each turn's tool calls under its last reply, kept per dot beside its messages.

export interface WorkState {
  sessionID: string;
  /** Logs by the message they go beneath. */
  logs: Map<string, WorkLogView>;
  /** The latest page's running turn that has no message to go beneath yet. */
  open: WorkLogView | undefined;
}

/** The page's well-formed logs; a daemon without the work log sends none. */
export const pageWork = (page: Pick<PageView, "work">): WorkLogView[] =>
  Array.isArray(page.work) ? page.work.filter((log) => fits(log, workLogShape)) : [];

/**
 * Takes a page's logs into what's kept: a newer read of a turn replaces the older one, a latest
 * page sets the running turn, and only logs under loaded messages stay, so memory stays bounded.
 */
export const mergeWork = (
  current: WorkState | undefined,
  page: Pick<PageView, "work" | "sessionID">,
  latest: boolean,
  loaded: ReadonlySet<string>,
): WorkState => {
  const base =
    current?.sessionID === page.sessionID
      ? current
      : { sessionID: page.sessionID, logs: new Map<string, WorkLogView>(), open: undefined };
  const logs = new Map([...base.logs].filter(([anchor]) => loaded.has(anchor)));
  let open = latest ? undefined : base.open;
  for (const log of pageWork(page)) {
    if (log.anchor === null) open = latest ? log : open;
    else if (loaded.has(log.anchor)) logs.set(log.anchor, log);
  }
  return { sessionID: page.sessionID, logs, open };
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The one-line summary of a log, such as "Ran 4 commands, edited 2 files". */
export const workSummary = (counts: WorkCounts, complete: boolean) => {
  const other = counts.total - counts.commands - counts.edits;
  const parts = [
    counts.commands ? `ran ${plural(counts.commands, "command")}` : "",
    counts.edited ? `edited ${plural(counts.edited, "file")}` : "",
    counts.edits && !counts.edited ? `tried ${plural(counts.edits, "edit")}` : "",
    other > 0 ? `made ${plural(other, "other call")}` : "",
    counts.failed ? `${counts.failed} failed` : "",
  ].filter(Boolean);
  const text = parts.join(", ") || `made ${plural(counts.total, "call")}`;
  return `${complete ? "" : "At least: "}${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

/** Long output starts at this many lines, behind Show more. */
export const outputLines = 20;

/** The first `lines` lines of a text, and how many more it has. */
export const firstLines = (text: string, lines = outputLines) => {
  const all = text.split("\n");
  return { shown: all.slice(0, lines).join("\n"), hidden: Math.max(0, all.length - lines) };
};

/** Whole seconds since `from` as m:ss or h:mm:ss. */
export const elapsed = (from: number, now: number) => {
  const total = Math.max(0, Math.floor((now - from) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
};

/** An activity read older than this is stale: its timer stops and says so. */
export const staleAfter = 5_000;

/** What a busy dot's live line says, from its last activity read. */
export const activityLine = (
  dot: string,
  activity: Pick<ActivityView, "state" | "tool" | "label" | "running"> | undefined,
) => {
  if (!activity || activity.state === "idle") return `${dot} is working`;
  if (activity.state === "thinking") return `${dot} is thinking`;
  const what = activity.label
    ? `${activity.tool ?? "a tool"}: ${activity.label}`
    : (activity.tool ?? "a tool");
  return `${dot} is running ${what}${activity.running > 1 ? ` (+${activity.running - 1} more)` : ""}`;
};
