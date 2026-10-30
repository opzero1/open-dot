// The typed surface the preload exposes to the renderer, and the daemon's answers as the app reads
// them. Shared by main, preload and renderer; it holds types and channel names only.

export interface Avatar {
  revision: string;
}

/** A request kind a worker or session waits on: a permission or a question. */
export type RequestKind = "permission" | "question";

export interface WorkerView {
  id: number;
  state: string;
  outcome: string | null;
  task: string;
  needs: RequestKind[];
  waiting: RequestKind[];
  answered: string | null;
}

export interface SessionView {
  request: number;
  source: string;
  worker: number | null;
  sessionID: string;
  title: string | null;
  directory: string | null;
  needs: RequestKind[];
  waiting: RequestKind[];
  answered: string | null;
}

export interface DotView {
  name: string;
  purpose: string | null;
  busy: boolean;
  avatar: Avatar | null;
  workers: WorkerView[];
  sessions: SessionView[];
}

export interface AttachmentView {
  index: number;
  mime: string;
  name: string | null;
}

export interface ReactionView {
  actor: "owner" | "dot";
  emoji: string | null;
  updatedAt: number;
}

export interface QuoteView {
  id: string;
  author: "owner" | "dot";
  text: string;
}

export type MessageKind = "owner" | "dot" | "peer" | "notice";

export interface MessageView {
  id: string;
  sessionID: string;
  kind: MessageKind;
  hidden: boolean;
  text: string;
  tools: string[];
  attachments: AttachmentView[];
  time: number;
  reactions: ReactionView[];
  quote?: QuoteView;
  peer?: string | null;
  feed?: { title: string; url: string | null; source: string };
}

export type PendingStatus = "sending" | "confirming" | "sent";

export interface PendingView {
  id: string;
  status: PendingStatus;
  delivery: string | null;
}

export interface PageView {
  messages: MessageView[];
  sessionID: string;
  next: string | null;
  pending: PendingView[];
  recentEmojis: string[];
  clientMessageIDs?: boolean;
  refreshError?: string;
  /** Added by main: which discovered daemon answered. A new one can't read the old one's cursors. */
  generation: number;
}

/** Where a send the app made stands, by the daemon's receipt; `unknown` means no row there. */
export type ReceiptStatus =
  | "sending"
  | "confirming"
  | "sent"
  | "delivered"
  | "held"
  | "cancelled"
  | "unknown";

/** A send whose answer the app lost: only its IDs are kept, never its text or images. */
export interface Attempt {
  dot: string;
  sessionID: string;
  messageID: string;
  createdAt: number;
}

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      status?: number;
      // The request may have reached the daemon: the outcome is unknown, not a failure.
      lost?: boolean;
    };

/**
 * What became of a send: `saved` (the daemon has it, under `id`), `unknown` (it may have arrived;
 * the app tracks `id` and never sends it again) or `refused` (nothing was saved).
 */
export type SendResult =
  | { outcome: "saved"; id: string; warning?: string }
  | { outcome: "unknown"; id: string; error: string }
  | { outcome: "refused"; error: string };

export interface ImageInput {
  name: string;
  data: Uint8Array;
}

/** An image main validated: one of the four types the daemon takes, at most 10 MiB. */
export interface DraftImage {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name: string;
  data: Uint8Array;
  width: number;
  height: number;
}

export interface SendInput {
  dot: string;
  sessionID: string;
  text: string;
  replyTo?: string;
  images: DraftImage[];
}

export interface Bytes {
  mime: string;
  data: Uint8Array;
}

export interface TrayState {
  busy: boolean;
  unread: number;
}

export interface WorkerOpen {
  opened: boolean;
  copied?: boolean;
  command?: string;
  error?: string;
}

/** Everything the renderer can ask of main. Each call is validated again in main. */
export interface Bridge {
  dots(): Promise<Result<DotView[]>>;
  messages(dot: string, before?: string, generation?: number): Promise<Result<PageView>>;
  /** One message as the daemon has it now, in the session the app saw it in. */
  message(dot: string, id: string, sessionID: string): Promise<Result<MessageView>>;
  send(input: SendInput): Promise<SendResult>;
  attempts(): Promise<Attempt[]>;
  reconcile(attempt: Attempt): Promise<Result<ReceiptStatus>>;
  forget(messageID: string): Promise<void>;
  react(dot: string, id: string, sessionID: string, emoji: string | null): Promise<Result<true>>;
  hide(dot: string, id: string, sessionID: string, hidden: boolean): Promise<Result<true>>;
  pending(dot: string, id: string, change: "steer" | "cancel"): Promise<Result<true>>;
  image(dot: string, id: string, sessionID: string, index: number): Promise<Result<Bytes>>;
  avatar(dot: string): Promise<Result<Bytes>>;
  ingest(input: ImageInput): Promise<Result<DraftImage>>;
  openLink(url: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  shareText(text: string): Promise<boolean>;
  copyMessage(dot: string, id: string, sessionID: string): Promise<Result<true>>;
  shareMessage(dot: string, id: string, sessionID: string): Promise<Result<true>>;
  emojiPanel(): Promise<void>;
  openWorker(id: number): Promise<Result<WorkerOpen>>;
  stopWorker(id: number): Promise<Result<true>>;
  openRequest(id: number): Promise<Result<WorkerOpen>>;
  setTray(state: TrayState): Promise<void>;
  /** Called when main shows the window or the shortcut failed; returns an unsubscribe. */
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export type AppEvent = { kind: "shown" } | { kind: "shortcut"; registered: boolean };

export const channels = [
  "dots",
  "messages",
  "message",
  "send",
  "attempts",
  "reconcile",
  "forget",
  "react",
  "hide",
  "pending",
  "image",
  "avatar",
  "ingest",
  "openLink",
  "copyText",
  "shareText",
  "copyMessage",
  "shareMessage",
  "emojiPanel",
  "openWorker",
  "stopWorker",
  "openRequest",
  "setTray",
] as const satisfies readonly Exclude<keyof Bridge, "onEvent">[];

export type Channel = (typeof channels)[number];

export const eventChannel = "open-dot:event";

declare global {
  // Set by the preload in the app's window; absent anywhere else, such as tests.
  var openDot: Bridge | undefined;
}
