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

/** A change the owner made that a read hasn't shown yet: a reaction or whether it's hidden. */
export interface Intent {
  sessionID: string;
  emoji?: string | null;
  hidden?: boolean;
}

/**
 * Shows each intended change over a page until a read for the same session shows it, so a read
 * that started before the change can't flicker it back. Returns the messages and the intents
 * still waiting.
 */
export const applyIntents = (
  messages: MessageView[],
  intents: ReadonlyMap<string, Intent>,
): { messages: MessageView[]; waiting: Map<string, Intent> } => {
  const waiting = new Map<string, Intent>();
  const shown = messages.map((message) => {
    const intent = intents.get(message.id);
    if (!intent || intent.sessionID !== message.sessionID) return message;
    const emojiShown = intent.emoji === undefined || reactionOf(message, "owner") === intent.emoji;
    const hiddenShown = intent.hidden === undefined || message.hidden === intent.hidden;
    if (emojiShown && hiddenShown) return message;
    waiting.set(message.id, intent);
    return {
      ...message,
      hidden: intent.hidden ?? message.hidden,
      reactions:
        intent.emoji === undefined
          ? message.reactions
          : [
              ...message.reactions.filter((reaction) => reaction.actor !== "owner"),
              { actor: "owner" as const, emoji: intent.emoji, updatedAt: Date.now() },
            ],
    };
  });
  // Intents for messages outside this page wait for a page that has them.
  for (const [id, intent] of intents)
    if (!messages.some((message) => message.id === id)) waiting.set(id, intent);
  return { messages: shown, waiting };
};

export const historyLimit = 600;

export interface Conversation {
  sessionID: string;
  messages: MessageView[];
  pending: PendingView[];
  // The cursor for older messages, or null at the start of the conversation.
  next: string | null;
  // True once older pages pushed the latest messages out: polls then wait for Back to latest.
  detached: boolean;
}

/**
 * Merges the latest page into what's shown. A new session replaces everything; otherwise older
 * messages already loaded stay above the page, up to the history limit.
 */
export const mergeLatest = (current: Conversation | undefined, page: PageView): Conversation => {
  if (!current || current.sessionID !== page.sessionID || current.detached)
    return {
      sessionID: page.sessionID,
      messages: page.messages,
      pending: page.pending,
      next: page.next,
      detached: false,
    };
  const first = page.messages[0];
  const cut = first ? current.messages.findIndex((message) => message.id === first.id) : -1;
  // A page that doesn't overlap what's shown starts over, so no gap is hidden.
  if (cut < 0)
    return { ...current, messages: page.messages, pending: page.pending, next: page.next };
  const messages = [...current.messages.slice(0, cut), ...page.messages];
  return {
    ...current,
    messages: messages.slice(-historyLimit),
    pending: page.pending,
    next: messages.length > historyLimit ? page.next : current.next,
  };
};

/** Prepends an older page; past the limit the newest messages go and polls wait for Latest. */
export const mergeOlder = (current: Conversation, page: PageView): Conversation => {
  if (page.sessionID !== current.sessionID) return current;
  const known = new Set(current.messages.map((message) => message.id));
  const messages = [
    ...page.messages.filter((message) => !known.has(message.id)),
    ...current.messages,
  ];
  const detached = current.detached || messages.length > historyLimit;
  return { ...current, messages: messages.slice(0, historyLimit), next: page.next, detached };
};

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
