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
  /** Added by main: when the request behind this page began, even for a read that joined it. */
  startedAt: number;
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
  // A feed item this message replies to, as the daemon's own feed has it; never with replyTo.
  feed?: number;
  images: DraftImage[];
}

export interface Bytes {
  mime: string;
  data: Uint8Array;
}

export interface TrayState {
  busy: boolean;
  unread: number;
  // Dots with unsaved instructions: quitting asks before it discards them.
  unsaved?: number;
}

export interface WorkerOpen {
  opened: boolean;
  copied?: boolean;
  command?: string;
  error?: string;
}

// The daemon's other surfaces, as the app reads them. Every text field is data from the daemon,
// and through it from dots, workers, feeds and Slack: the renderer shows it, never acts on it.

export interface FeedItem {
  id: number;
  source: string;
  reason: string;
  title: string;
  context: string;
  url: string | null;
  time: number;
  handedTo: string[] | null;
}

export interface FeedPage {
  items: FeedItem[];
  remaining: number;
  handedOff: FeedItem[];
}

interface Versioned {
  id: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface NoteSource {
  sessionID: string;
  messageID: string;
  edited: boolean;
}

export interface MemoryNote extends Versioned {
  text: string;
  source: NoteSource | null;
}

export interface Schedule {
  kind: string;
  everyMinutes?: number;
  days?: number[];
  time?: string;
}

export interface MemoryResponsibility extends Versioned {
  goal: string;
  nextAction: string;
  status: string;
  schedule: Schedule | null;
  nextRunAt: number | null;
}

export interface MemoryReminder extends Versioned {
  text: string;
  dueAt: number;
  everyMinutes: number | null;
  state: string;
}

export interface ObservationSource {
  messageID: string;
  sessionID: string;
  from?: string;
  date?: string;
  excerpt?: string;
  missing?: true;
}

export interface Observation extends Versioned {
  kind: string;
  topic: string;
  text: string;
  priority: number;
  sessionID: string;
  sources: ObservationSource[];
}

export interface Supervision {
  id: number;
  sessionID: string;
  directory: string;
  mode: string;
  state: string;
  busyMinutes: number;
  createdAt: number;
  activatedAt: number | null;
}

export interface Grant {
  id: number;
  operation: string;
  summary: string;
  expiresAt: number;
  createdAt: number;
}

export interface TriggerEvent {
  sourceID: string;
  reason: string;
  repository: string;
  title: string;
  url: string | null;
  updatedAt: number;
}

export interface FeedTrigger {
  id: number;
  responsibility: number;
  sessionID: string;
  repository: string;
  reasons: string[];
  task: string;
  revision: string;
  state: string;
  createdAt: number;
  confirmedAt: number | null;
  baselineAt: number | null;
  lastWake: { messageID: string; at: number; events: TriggerEvent[]; delivery: string } | null;
  baselined: number;
  skippedCount: number;
  skipped: { at: number; reason: string | null; event: TriggerEvent }[];
}

export interface TriggerPreview {
  total: number;
  matches: { event: TriggerEvent; outcome: string; reason?: string }[];
  wake?: string | null;
}

export interface Memory {
  notes: MemoryNote[];
  responsibilities: MemoryResponsibility[];
  reminders: MemoryReminder[];
  observations?: Observation[];
  observationsNext?: number | null;
  observationsSuperseded?: number;
  supervisions?: Supervision[];
  grants?: Grant[];
  triggers?: FeedTrigger[];
}

export interface ObservationPage {
  observations: Observation[];
  next: number | null;
  superseded?: number;
}

export type RecallResult =
  | { kind: "note"; note: number; updated: string; snippet: string; source: unknown }
  | {
      kind: "message";
      message: string;
      sessionID: string;
      from: string;
      date: string;
      snippet: string;
    }
  | { kind: "observed"; observation: number; type?: string; topic?: string; text?: string };

export interface Recall {
  query: string;
  archive: boolean;
  results: RecallResult[];
  next: number | null;
}

export interface Archived {
  message: string;
  sessionID: string;
  from: string;
  date: string;
  length: number;
  offset: number;
  text: string;
  next: number | null;
}

export interface SourceText {
  message: string;
  sessionID?: string;
  from?: string;
  date?: string;
  text: string;
  truncated?: boolean;
}

export interface NoteSourceRead {
  note: number;
  state: string;
  edited?: boolean;
  reason?: string;
  message?: {
    id: string;
    sessionID: string;
    role: string;
    text: string;
    truncated: boolean;
    tools: string[];
    time: number;
  };
}

export interface RunView {
  id: number;
  responsibility: number;
  dueAt: number;
  claimedAt: number;
  snapshot: { goal: string; nextAction: string };
  sessionID: string;
  messageID: string;
  state: string;
  delivery?: string | null;
  attribution?: string | null;
  result?: { messageID: string; text: string } | null;
  turn?: { outcome?: string | null; error?: string | null; endedAt?: number | null } | null;
  workers: { id: number; state: string; task: string; outcome?: string | null }[];
  withheldWorkers?: number;
}

export interface RunPage {
  runs: RunView[];
  next: number | null;
}

export interface RequestAudit {
  id: number;
  source: string;
  worker: number | null;
  sessionID: string;
  title: string;
  kind: string;
  requestID: string;
  detailText: string;
  answerText: string | null;
  state: string;
  needsYou: boolean;
  reason?: string | null;
  summary?: string | null;
  createdAt: number;
}

export interface RequestPage {
  requests: RequestAudit[];
  next: number | null;
}

export interface ArchiveStatus {
  archive: boolean;
  ledger?: boolean;
  observer?: boolean;
  archived?: number;
  observerStatus?: {
    budget: number;
    spentToday: number;
    stoppedToday: boolean;
    budgetNote: string;
  };
}

export interface Instructions {
  content: string;
  revision: string;
  canRevert: boolean;
}

export interface Artifact {
  id: number;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: number;
  worker: number | null;
  status: string;
}

export interface LibraryPage {
  artifacts: Artifact[];
  next: number | null;
}

export interface HealthCheck {
  id: string;
  status: string;
  summary: string;
  nextStep?: string;
  lastSuccessAt?: number;
  counts?: Record<string, number>;
}

export interface HealthReport {
  schemaVersion: number;
  checkedAt: number;
  sampledAt?: number;
  sampleUnavailable?: string;
  checks: HealthCheck[];
}

export interface SlackSetup {
  config: { state: string; problem: string | null; saved?: boolean };
  ownerFeed?: { items: number; latestAt: number | null };
  dmCheck?: { state: string; since: number; dmAt: number | null } | null;
  login?: {
    state: string;
    team?: string | null;
    user?: string | null;
    problem?: string | null;
    pending?: { attempt: string; expiresAt: number } | null;
  } | null;
  manifestLink?: string | null;
  app: {
    state: string;
    appID: string | null;
    botUser: string | null;
    problem: string | null;
    install: { phase: string; code?: string | null } | null;
    manifestOutdated: boolean;
    updateState: string | null;
    updateNote: string | null;
    icon: { status: string; error: string | null; retryAt: number | null } | null;
  } | null;
}

export interface SlackTicket {
  attempt: string;
  command: string;
  expiresAt: number;
}

export interface FreshResult {
  name: string;
  sessionID: string;
  previousSessionID: string;
  moved?: number;
}

/**
 * The daemon operations the renderer may ask main for, by name, with their arguments and answer.
 * Main builds each request itself from validated arguments: never a path, URL or file.
 */
export interface Operations {
  feed: [[], FeedPage];
  dismiss: [[id: number], true];
  dismissAll: [[ids: number[]], { dismissed: number[]; missing: number[] }];
  memory: [[dot: string], Memory];
  observations: [[dot: string, before: number], ObservationPage];
  observationSource: [[dot: string, id: number, message: string], SourceText];
  noteSource: [[dot: string, id: number], NoteSourceRead];
  recall: [[dot: string, query: string, offset: number], Recall];
  archived: [[dot: string, message: string, offset: number], Archived];
  archiveStatus: [[dot: string], ArchiveStatus];
  runs: [[dot: string, responsibility: number, before: number | null], RunPage];
  requests: [[dot: string, before: number | null], RequestPage];
  addNote: [[dot: string, text: string], unknown];
  editNote: [[dot: string, id: number, version: number, text: string], unknown];
  deleteNote: [[dot: string, id: number, version: number], true];
  editResponsibility: [
    [dot: string, id: number, version: number, change: Record<string, string>],
    unknown,
  ];
  editReminder: [
    [dot: string, id: number, version: number, change: Record<string, number | null>],
    unknown,
  ];
  cancelReminder: [[dot: string, id: number, version: number], true];
  addObservation: [[dot: string, text: string], unknown];
  editObservation: [[dot: string, id: number, version: number, text: string], unknown];
  forgetObservation: [[dot: string, id: number, version: number, sources: boolean], true];
  deleteArchived: [[dot: string, message: string], true];
  approveWatch: [[dot: string, id: number], unknown];
  endWatch: [[dot: string, id: number], unknown];
  revokeGrant: [[dot: string, id: number], unknown];
  createTrigger: [
    [
      dot: string,
      draft: { responsibility: number; repository: string; reasons: string[]; task: string },
    ],
    unknown,
  ];
  previewTrigger: [[dot: string, id: number], TriggerPreview];
  enableTrigger: [[dot: string, id: number, revision: string], unknown];
  pauseTrigger: [[dot: string, id: number], unknown];
  revokeTrigger: [[dot: string, id: number], unknown];
  instructions: [[dot: string], Instructions];
  saveInstructions: [[dot: string, content: string, revision: string], Instructions];
  revertInstructions: [[dot: string, revision: string], Instructions];
  library: [[dot: string, before: number | null], LibraryPage];
  health: [[], HealthReport];
  slack: [[dot: string], SlackSetup];
  slackConnect: [[dot: string, retry: boolean], SlackSetup];
  slackAttach: [[dot: string, appID: string], SlackSetup];
  slackInstall: [[dot: string], SlackSetup];
  slackUpdate: [[dot: string, approve: string[] | null], { said: string; confirm?: string[] }];
  slackIcon: [[dot: string], SlackSetup];
  slackDMCheck: [[dot: string], SlackSetup];
  slackLogin: [[], SlackTicket];
  fresh: [[dot: string, force: boolean], FreshResult];
}

export type Operation = keyof Operations;

/** A daemon answer: a 409's `current` is the value now, which nothing was saved over. */
export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status?: number; lost?: boolean; current?: unknown };

/**
 * A secret the owner typed: main sends it once to the daemon and keeps nothing. Answers name what
 * happened in fixed words, never the secret.
 */
export type Secret =
  | { kind: "slackToken"; dot: string; token: "bot" | "app"; value: string }
  | { kind: "slackConfig"; token: string; refreshToken: string }
  | { kind: "slackLink"; dot: string; bot: string; app: string; replaceAppID?: string }
  | { kind: "slackChallenge"; dot: string; attempt: string; challenge: string };

export type PickupStep = "access" | "refresh" | "bot" | "app" | "linkBot" | "linkApp";

/** Where clipboard pickup stands, as main tells the renderer: never the token itself. */
export interface PickupState {
  dot: string | null;
  step: PickupStep | null;
  holding: "access" | "linkBot" | null;
  mismatched: boolean;
  notice: string | null;
  // A link whose app-level token names another app than the dot's: main asks before it replaces.
  replace?: string | null;
  available: boolean;
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
  /** One daemon operation by name; main builds the request from the checked arguments. */
  call<K extends Operation>(op: K, ...args: Operations[K][0]): Promise<Reply<Operations[K][1]>>;
  /** Sends a typed secret once; the answer is the dot's Slack setup or what went wrong. */
  secret(input: Secret): Promise<Reply<unknown>>;
  /** Clipboard pickup for one step of the dot's Slack setup, or `null` to stop it. */
  pickup(dot: string, step: PickupStep | null, appID: string | null): Promise<PickupState>;
  /** Tells main which dot's Slack view is open, or none: leaving it ends any pickup. */
  slackShown(dot: string | null, appID: string | null): Promise<void>;
  /** Confirms or refuses a link that replaces the dot's app, after main asked. */
  confirmReplace(dot: string, appID: string, replace: boolean): Promise<PickupState>;
  /** Downloads a Library file by ID, checks its size and digest, and offers to save it. */
  exportArtifact(dot: string, artifact: Artifact): Promise<Reply<{ saved: boolean }>>;
  /** Called when main shows the window or the shortcut failed; returns an unsubscribe. */
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export type AppEvent =
  | { kind: "shown" }
  | { kind: "shortcut"; registered: boolean }
  | { kind: "pickup"; state: PickupState };

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
  "call",
  "secret",
  "pickup",
  "slackShown",
  "confirmReplace",
  "exportArtifact",
] as const satisfies readonly Exclude<keyof Bridge, "onEvent">[];

export type Channel = (typeof channels)[number];

export const eventChannel = "open-dot:event";

declare global {
  // Set by the preload in the app's window; absent anywhere else, such as tests.
  var openDot: Bridge | undefined;
}
