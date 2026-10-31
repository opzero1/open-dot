// The plain logic behind the app's Feed, Memory and Instructions, apart from React and
// Electron so it can be tested. Each piece holds only view state; the daemon owns every value.
import type {
  Attempt,
  FeedItem,
  Grant,
  Instructions,
  MemoryResponsibility,
  NoteSourceRead,
  OwnerMemory,
  OwnerAnswer,
  OwnerMutation,
  ReceiptStatus,
  RequestCard,
  Reply,
  RequestAudit,
  RunView,
  Schedule,
  Supervision,
} from "./bridge";

// The feed.

/** The most unread items shown at once, as one Clear all request can name. */
export const feedLimit = 1000;

export interface FeedPoll {
  number: number;
  at: number;
  settled: ReadonlySet<number>;
}

/**
 * The unread feed as shown: oldest first, at most 1,000, with dismissals hidden while they're
 * sent. A dismissal that fails comes back with its error and survives polls that began before
 * it failed. A poll that a newer one overtook is dropped.
 */
export class FeedState {
  private all: FeedItem[] = [];
  errors = new Map<number, string>();
  private hiding = new Set<number>();
  private done = new Set<number>();
  private restored = new Map<number, { item: FeedItem; at: number }>();
  private events = 0;
  private polls = 0;

  get items() {
    return this.all.slice(0, feedLimit);
  }

  get overflow() {
    return Math.max(0, this.all.length - feedLimit);
  }

  /** Hides these items and clears their errors while their dismissal is sent. */
  dismiss(ids: readonly number[]) {
    for (const id of ids) {
      this.hiding.add(id);
      this.errors.delete(id);
      this.restored.delete(id);
    }
    this.all = this.all.filter((item) => !ids.includes(item.id));
  }

  /** What the daemon answered: the IDs it dismissed. Every other one comes back with its error. */
  finish(sent: readonly FeedItem[], dismissed: ReadonlySet<number>, error: (id: number) => string) {
    this.events++;
    for (const item of sent) {
      if (dismissed.has(item.id)) {
        this.done.add(item.id);
        continue;
      }
      this.hiding.delete(item.id);
      this.restored.set(item.id, { item, at: this.events });
      this.errors.set(item.id, error(item.id));
      if (!this.all.some((known) => known.id === item.id)) this.all.push(item);
    }
    this.all.sort((a, b) => a.time - b.time);
  }

  startPoll(): FeedPoll {
    this.polls++;
    return { number: this.polls, at: this.events, settled: new Set(this.done) };
  }

  isCurrent(poll: FeedPoll) {
    return poll.number === this.polls;
  }

  /** Shows a poll's unread items. False when a newer poll has started, so this one is dropped. */
  apply(poll: FeedPoll, listed: readonly FeedItem[]) {
    if (!this.isCurrent(poll)) return false;
    for (const id of poll.settled) {
      this.hiding.delete(id);
      this.done.delete(id);
    }
    for (const [id, entry] of this.restored) if (entry.at <= poll.at) this.restored.delete(id);
    const next = listed.filter((item) => !this.hiding.has(item.id));
    for (const [id, entry] of this.restored)
      if (!this.hiding.has(id) && !next.some((item) => item.id === id)) next.push(entry.item);
    this.all = next.toSorted((a, b) => a.time - b.time);
    return true;
  }
}

export const feedPrompts = {
  start:
    "Take this on. Work out what it needs and get it done, delegating a worker or tracking it as a responsibility if it's more than a quick answer. Tell me what you decide.",
  context: "Keep this in mind as context. Tell me briefly what it means for what we're working on.",
} as const;

/** What a feed reply did for one dot. Unknown sends are tracked by ID and never sent again. */
export type ReplyOutcome = "saved" | "unknown" | "refused";

export interface ReplyResult {
  outcome: ReplyOutcome;
  error?: string;
  /** An unknown send's IDs, to reconcile by; never its text or images. */
  attempt?: Attempt;
}

export interface FeedReply<Image> {
  item: FeedItem;
  dots: string[];
  text: string;
  images: Image[];
  sending: boolean;
  /** What each dot's send from this reply came to, kept across sends. */
  results: Map<string, ReplyResult>;
  /** Counts the owner's changes to the text and images. */
  revision: number;
  /** The revision the last Send captured; a later change keeps the reply when that send ends. */
  sent?: number;
}

/** Statuses a send's receipt has once the daemon holds it. */
const held: readonly ReceiptStatus[] = ["sending", "confirming", "sent", "delivered", "held"];

/**
 * The feed's reply drafts, by item, kept while the window lives: leaving the Feed, Escape and a
 * refresh that moves the item to Handed off keep each one's dots, text, images and what each dot's
 * send came to. A dot whose send was saved, or is unknown and reconciling by its ID, is never sent
 * the reply again; the text and images stay until every dot's send is known to be saved.
 */
export class FeedReplies<Image> {
  readonly boxes = new Map<number, FeedReply<Image>>();

  /** Opens an item's reply, or goes back to the one kept for it. */
  open(item: FeedItem, dot: string | undefined) {
    const known = this.boxes.get(item.id);
    if (known) return known;
    const box: FeedReply<Image> = {
      item,
      dots: dot ? [dot] : [],
      text: "",
      images: [],
      sending: false,
      results: new Map(),
      revision: 0,
    };
    this.boxes.set(item.id, box);
    return box;
  }

  /** The owner's change to a reply's dots, text or images, refused while it sends. */
  change(
    id: number,
    change: (box: FeedReply<Image>) => Partial<Pick<FeedReply<Image>, "dots" | "text" | "images">>,
  ) {
    const box = this.boxes.get(id);
    if (!box || box.sending) return false;
    const next = change(box);
    if (
      (next.text !== undefined && next.text !== box.text) ||
      (next.images !== undefined && next.images !== box.images)
    )
      box.revision++;
    Object.assign(box, next);
    box.dots = box.dots.filter((dot) => this.canPick(id, dot));
    return true;
  }

  /** Only a dot this reply hasn't reached, or that refused it, can be picked. */
  canPick(id: number, dot: string) {
    const result = this.boxes.get(id)?.results.get(dot);
    return !result || result.outcome === "refused";
  }

  /** What one Send sends, captured once; undefined while one is out or nothing can go. */
  begin(id: number) {
    const box = this.boxes.get(id);
    if (!box || box.sending) return undefined;
    const text = box.text.trim();
    const dots = box.dots.filter((dot) => this.canPick(id, dot));
    if (!text || !dots.length) return undefined;
    box.sending = true;
    box.sent = box.revision;
    return { item: id, text, images: [...box.images], dots };
  }

  record(id: number, dot: string, result: ReplyResult) {
    this.boxes.get(id)?.results.set(dot, result);
  }

  /**
   * A Send's end: dots that refused stay picked to try again. The reply ends only when every dot
   * it went to saved it; otherwise its text and images stay.
   */
  end(id: number, sent: readonly string[]) {
    const box = this.boxes.get(id);
    if (!box) return "gone" as const;
    box.sending = false;
    box.dots = sent.filter((dot) => box.results.get(dot)?.outcome === "refused");
    return this.finished(id) ? ("done" as const) : ("kept" as const);
  }

  /** An unknown send's receipt, as the daemon has it now. */
  settle(id: number, dot: string, status: ReceiptStatus) {
    const result = this.boxes.get(id)?.results.get(dot);
    if (result?.outcome !== "unknown") return false;
    if (held.includes(status)) this.record(id, dot, { outcome: "saved" });
    else if (status === "cancelled")
      this.record(id, dot, { outcome: "refused", error: "It was cancelled before it was sent." });
    else return false;
    this.finished(id);
    return true;
  }

  /** The owner discards a reply; never while it sends. */
  cancel(id: number) {
    if (this.boxes.get(id)?.sending) return false;
    return this.boxes.delete(id);
  }

  /** Every unknown send to reconcile by its ID. */
  unknown() {
    return [...this.boxes.values()].flatMap((box) =>
      [...box.results].flatMap(([dot, result]) =>
        result.outcome === "unknown" && result.attempt
          ? [{ id: box.item.id, dot, attempt: result.attempt }]
          : [],
      ),
    );
  }

  // Ends a reply only when every dot saved it and it's still the text and images last sent: one
  // the owner changed after that Send keeps its newer, unsent content.
  private finished(id: number) {
    const box = this.boxes.get(id);
    if (!box || box.sending || box.dots.length || !box.results.size) return false;
    if (box.sent !== box.revision) return false;
    if (![...box.results.values()].every((result) => result.outcome === "saved")) return false;
    this.boxes.delete(id);
    return true;
  }
}

export const sourceNames: Record<string, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
};

export const shortAgo = (time: number, now = Date.now()) => {
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

// Memory.

/** The GitHub reasons a trigger filters on, in the words the feed and the daemon use. */
export const triggerReasons = [
  "Review requested",
  "Mentioned",
  "Team mentioned",
  "Assigned",
  "Comment",
  "Author",
] as const;

export const ago = (time: number, now = Date.now()) => {
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

/** "Updated 5m ago by jojo", "by you" or "by its schedule". */
export const memoryChange = (updatedAt: number, actor: string, dot: string, now = Date.now()) => {
  const who =
    actor === "owner"
      ? "you"
      : actor === "scheduler"
        ? "its schedule"
        : actor === "dot"
          ? dot
          : actor;
  return `Updated ${ago(updatedAt, now)} by ${who}`;
};

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const sourceSummary = (read: NoteSourceRead, dot: string) => {
  const edited = read.edited
    ? " The note was edited since, so this is only where it was first saved, not where its current text came from."
    : "";
  switch (read.state) {
    case "found": {
      const who = read.message?.role === "assistant" ? `${dot}'s message` : "a message";
      const at = read.message ? when(read.message.time) : "at an unknown time";
      return `Saved by ${who}, ${at}, in its current conversation: the message whose dot_note saved this note, not proof that the note is true.${edited}`;
    }
    case "unknown":
      return "Source unknown: saved before sources were kept, by you, or from a message open-dot couldn't confirm.";
    case "gone":
      return `Source gone: ${read.reason ?? "OpenCode no longer has that message."}${edited}`;
    default:
      return `Source unavailable: ${read.reason ?? "open-dot can't read it."}${edited}`;
  }
};

export const supervisionTimes = (binding: Supervision, now = Date.now()) => {
  if (binding.state !== "active") return `Requested ${ago(binding.createdAt, now)}`;
  const created = `Created ${ago(binding.createdAt, now)}`;
  if (binding.activatedAt === null || binding.activatedAt === binding.createdAt) return created;
  return `${created}, approved ${ago(binding.activatedAt, now)}`;
};

export const grantRemaining = (grant: Grant, now = Date.now()) => {
  const minutes = Math.floor((grant.expiresAt - now) / 60_000);
  if (minutes < 1) return "Ends now";
  if (minutes < 120) return `Ends in ${minutes}m`;
  if (minutes < 48 * 60) return `Ends in ${Math.floor(minutes / 60)}h`;
  return `Ends in ${Math.floor(minutes / 1440)}d`;
};

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const scheduleSummary = (schedule: Schedule) => {
  if (schedule.kind === "interval" && schedule.everyMinutes) {
    const minutes = schedule.everyMinutes;
    return minutes % 1440 === 0
      ? `Every ${minutes / 1440 === 1 ? "day" : `${minutes / 1440} days`}`
      : minutes % 60 === 0
        ? `Every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} hours`}`
        : `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
  }
  if (schedule.kind === "daily") return `Daily at ${schedule.time ?? "?"}`;
  if (schedule.kind === "weekly")
    return `Weekly on ${(schedule.days ?? []).map((day) => dayNames[day] ?? String(day)).join(", ")} at ${schedule.time ?? "?"}`;
  return "On a schedule";
};

/** Next run, only for an active responsibility the daemon says is armed. */
export const nextRunLine = (row: MemoryResponsibility, now = Date.now()) => {
  if (!row.schedule) return undefined;
  const summary = scheduleSummary(row.schedule);
  if (row.status !== "active") return `${summary} · paused while ${row.status}`;
  if (row.nextRunAt === null) return `${summary} · next run unknown`;
  return `${summary} · next run ${row.nextRunAt <= now ? "due now" : when(row.nextRunAt)}`;
};

/** A run's state in words that never say a finished turn met the goal. */
export const runTitle = (run: Pick<RunView, "state" | "delivery" | "turn">) => {
  switch (run.state) {
    case "queued":
      return run.delivery === "sending" ? "sending, not confirmed" : "queued";
    case "admitted":
      return "admitted, not started";
    case "needs-you":
      return "needs you";
    case "finished-turn":
      return "turn finished, goal not checked";
    case "failed":
      return run.turn?.outcome === "interrupted" ? "interrupted" : "failed";
    case "unknown":
      return "outcome unknown";
    default:
      return run.state;
  }
};

/** Still waiting on something, or never to be known. */
export const runUnresolved = (run: Pick<RunView, "state">) =>
  run.state !== "finished-turn" && run.state !== "failed";

/** Why a turn that ended shows no reply as this run's result. */
export const runAttribution = (run: Pick<RunView, "attribution">) =>
  run.attribution === "shared"
    ? "Its turn also handled other messages, so no reply is attributed to this run."
    : run.attribution === "unknown"
      ? "History didn't show what else its turn handled, so no reply is attributed to this run."
      : undefined;

export const runWorkerLine = (worker: RunView["workers"][number]) => {
  const status = worker.needs?.length
    ? `needs you: ${worker.needs.join(", ")}`
    : worker.state === "done"
      ? `finished (${worker.outcome ?? "unknown"})`
      : worker.state;
  return `Worker #${worker.id}: ${worker.task} · ${status}`;
};

/** How far a run's delegated workers are the run's own, and why some aren't shown. */
export const runWorkersNotes = (run: Pick<RunView, "workers" | "withheldWorkers">) => {
  const notes: string[] = [];
  if (run.workers.length)
    notes.push(
      run.workers.some((worker) => worker.provisional)
        ? "Delegated while this run's turn held only its prompt. The turn hasn't ended, so later input may still make these not the run's. A worker's report is evidence, not acceptance."
        : "Delegated in this run's own turn. A worker's report is evidence, not acceptance.",
    );
  const withheld = run.withheldWorkers ?? 0;
  if (withheld > 0)
    notes.push(
      `${withheld} worker${withheld === 1 ? "" : "s"} delegated in this turn ${withheld === 1 ? "isn't" : "aren't"} shown as the run's, because the turn also handled other input or its history was incomplete.`,
    );
  return notes;
};

/** A worker request's state in the audit, in the owner's words. */
export const requestTitle = (request: Pick<RequestAudit, "state" | "goneAt">) => {
  switch (request.state) {
    case "open":
      return request.goneAt ? "gone unanswered" : "dot handling";
    case "queued":
      return "answer queued";
    case "answering":
      return "sending";
    case "answered":
      return "confirmed";
    case "unknown":
      return "outcome unknown";
    case "stale":
      return "not sent";
    case "escalated":
      return "escalated to you";
    default:
      return request.state;
  }
};

/** "#3 permission from worker #1 · escalated to you · Approved once (not sent)". */
export const requestLine = (
  request: Pick<RequestAudit, "id" | "kind" | "source" | "worker" | "state" | "goneAt" | "summary">,
) => {
  const from =
    request.source === "worker"
      ? `worker #${request.worker ?? 0}`
      : request.source === "dot"
        ? "the dot's own session"
        : "Threads";
  return `#${request.id} ${request.kind} from ${from} · ${requestTitle(request)}${request.summary ? ` · ${request.summary}` : ""}`;
};

/**
 * Each answer chosen for a request, oldest first, and who chose it: "By you · confirmed", or
 * "By the dot · not sent (refused)". An answer whose outcome is unknown stays so.
 */
export const requestAttempts = (request: Pick<RequestAudit, "attempts">) =>
  (request.attempts ?? []).map((attempt) => {
    const state =
      {
        queued: "queued",
        sending: "sending",
        confirmed: "confirmed",
        unknown: "outcome unknown",
        refused: "not sent",
        stale: "not sent",
      }[attempt.state] ?? attempt.state;
    return `${attempt.actor === "owner" ? "By you" : "By the dot"} · ${state}${attempt.error ? ` (${attempt.error})` : ""} · ${when(attempt.queuedAt)}`;
  });

/** What the worker asked, in its own words, which are the worker's data. */
export const requestAsked = (request: Pick<RequestAudit, "detail">) => {
  const detail = request.detail;
  if (!detail) return "";
  if (detail.kind === "permission")
    return `${detail.action ?? "?"}: ${(detail.resources ?? []).join(", ")}`;
  const fields = (detail.fields ?? []).map(
    (field) => field.title ?? field.description ?? field.key,
  );
  return [detail.title ?? "", ...fields].filter((part) => part !== "").join(" · ");
};

/** When a request was seen, answered and by which dot session, sent, confirmed and escalated. */
export const requestTimes = (
  request: Pick<
    RequestAudit,
    | "sessionID"
    | "createdAt"
    | "queuedAt"
    | "actorSession"
    | "attemptedAt"
    | "confirmedAt"
    | "escalatedAt"
  >,
) => {
  const parts = [request.sessionID, `seen ${when(request.createdAt)}`];
  if (typeof request.queuedAt === "number")
    parts.push(
      `answered ${when(request.queuedAt)}${request.actorSession ? ` by ${request.actorSession}` : ""}`,
    );
  if (typeof request.attemptedAt === "number") parts.push(`sent ${when(request.attemptedAt)}`);
  if (typeof request.confirmedAt === "number") parts.push(`confirmed ${when(request.confirmedAt)}`);
  if (typeof request.escalatedAt === "number") parts.push(`escalated ${when(request.escalatedAt)}`);
  return parts.join(" · ");
};

/**
 * The fields an edit changes, compared with the version the owner started from: only those are
 * sent, so a field the dot changed meanwhile isn't overwritten with the stale value.
 */
export const changedFields = <T extends Record<string, unknown>>(original: T, edited: T) => {
  const change: Partial<T> = {};
  for (const key of Object.keys(edited) as (keyof T)[])
    if (edited[key] !== original[key]) change[key] = edited[key];
  return change;
};

export interface Draft<T> {
  /** The version the edit started from: every save of this draft names it. */
  version: number;
  /** The values when the edit started, so only what the owner changed is sent. */
  original: T;
  edited: T;
  /** What a save in flight sent; while set, the draft takes no typing. */
  sending?: T;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The owner's unsaved memory edits, by row. An edit keeps the version and values it started from
 * through polls, pane changes and failures, so a save never names a newer version the owner didn't
 * see. Only a confirmed save, or a conflict that shows the rejected text beside the value now, ends
 * it; a refused or unconfirmed save keeps it for the owner to try again.
 */
export class Drafts<T> {
  readonly rows = new Map<string, Draft<T>>();

  /** Starts editing a row; one already being edited keeps its draft and version. */
  start(row: string, version: number, original: T) {
    const known = this.rows.get(row);
    if (known) return known;
    const draft = { version, original, edited: original };
    this.rows.set(row, draft);
    return draft;
  }

  get(row: string) {
    return this.rows.get(row);
  }

  /** The owner's typing, refused while a save of this draft is out. */
  edit(row: string, edited: T) {
    const draft = this.rows.get(row);
    if (!draft || draft.sending !== undefined) return false;
    draft.edited = edited;
    return true;
  }

  cancel(row: string) {
    const draft = this.rows.get(row);
    if (draft?.sending !== undefined) return false;
    return this.rows.delete(row);
  }

  /** What to send, once: undefined while a save of this draft is already out. */
  begin(row: string) {
    const draft = this.rows.get(row);
    if (!draft || draft.sending !== undefined) return undefined;
    draft.sending = draft.edited;
    return { version: draft.version, original: draft.original, edited: draft.edited };
  }

  /**
   * A save's answer. `saved` ends the draft; `conflict` ends it too, for the caller to show the
   * rejected text beside the value now; `kept` leaves it, with its version, to try again.
   */
  finish(
    row: string,
    result: Reply<unknown>,
    conflictShown: boolean,
  ): "saved" | "conflict" | "kept" {
    const draft = this.rows.get(row);
    const sent = draft?.sending;
    if (draft) delete draft.sending;
    if (result.ok) {
      if (draft && same(draft.edited, sent)) this.rows.delete(row);
      return "saved";
    }
    if (result.status === 409 && conflictShown) {
      this.rows.delete(row);
      return "conflict";
    }
    return "kept";
  }
}

/** What a memory change's answer means for the owner. Nothing is ever retried on its own. */
export const memoryFailure = (result: Extract<Reply<unknown>, { ok: false }>) => {
  if (result.lost)
    return "Couldn't confirm this change. It may have been saved; check after the next refresh. Nothing was retried.";
  if (result.status === 409)
    return "Not done: this was changed since you loaded it, so this is its current value. Nothing was retried.";
  if (result.status === 404)
    return "Nothing was changed: that item is gone, maybe deleted by the dot.";
  return result.error;
};

/**
 * Reads of a dot's memory that may show: each read takes the generation when it began, and any
 * change the owner makes advances it, so a read begun before or during a change is dropped.
 */
export class Fence {
  private generations = new Map<string, number>();

  current(key: string) {
    return this.generations.get(key) ?? 0;
  }

  advance(key: string) {
    this.generations.set(key, this.current(key) + 1);
  }

  holds(key: string, generation: number) {
    return this.current(key) === generation;
  }
}

const nextOf = (value: unknown) =>
  typeof value === "object" && value !== null && "next" in value && typeof value.next === "number"
    ? value.next
    : undefined;

export interface SearchTicket {
  number: number;
  changes: number;
  query: string;
  offset: number;
}

/**
 * One memory search box: only the newest search shows, a search begun before or during a change
 * the owner makes is dropped, and the change's end runs the shown search again. Clearing drops any
 * search out. A page of more results counts only while the results still end where it began.
 */
export class Searches<T> {
  shown: { query: string; value: T } | undefined;
  error: string | undefined;
  searching = false;
  private submitted: string | undefined;
  private number = 0;
  private changes = 0;

  start(raw: string): SearchTicket | undefined {
    const query = raw.trim();
    if (!query) {
      this.clear();
      return undefined;
    }
    this.submitted = query;
    this.searching = true;
    this.error = undefined;
    return { number: ++this.number, changes: this.changes, query, offset: 0 };
  }

  /** The next page of the shown results. */
  more(): SearchTicket | undefined {
    const next = nextOf(this.shown?.value);
    if (!this.shown || next === undefined) return undefined;
    this.searching = true;
    return { number: ++this.number, changes: this.changes, query: this.shown.query, offset: next };
  }

  /** A change began or ended: every search out now is dropped. */
  changed() {
    this.changes++;
  }

  /** The search the owner last submitted, again, once a change settled. */
  rerun() {
    return this.submitted === undefined ? undefined : this.start(this.submitted);
  }

  clear() {
    this.number++;
    this.submitted = undefined;
    this.shown = undefined;
    this.error = undefined;
    this.searching = false;
  }

  /** False when a newer search, a clear or a change overtook this one. */
  finish(ticket: SearchTicket, result: Reply<T>, append?: (shown: T, page: T) => T) {
    if (ticket.number !== this.number || ticket.changes !== this.changes) return false;
    this.searching = false;
    if (!result.ok) {
      this.error = result.error;
      if (!ticket.offset) this.shown = undefined;
      return true;
    }
    this.error = undefined;
    if (!ticket.offset) this.shown = { query: ticket.query, value: result.value };
    else if (this.shown && nextOf(this.shown.value) === ticket.offset && append)
      this.shown = { query: ticket.query, value: append(this.shown.value, result.value) };
    return true;
  }
}

// Instructions.

export const instructionsLimit = 64 * 1024;

export const instructionsTiming =
  "OpenCode watches this file. After it reloads (normally shortly after saving), edits apply to the next model request, including during a running turn. No restart is needed.";

export type InstructionsBusy =
  | { kind: "loading" }
  | { kind: "saving"; sent: string }
  | { kind: "reverting" };

/**
 * One dot's AGENTS.md editor. One request runs at a time, and only `edit` changes the draft, never
 * while a request runs, so an answer always matches what was sent. Nothing retries on its own.
 */
export class InstructionsState {
  base: Instructions | undefined;
  draft = "";
  busy: InstructionsBusy | undefined;
  conflict: Instructions | undefined;
  conflictFromRevert = false;
  error: string | undefined;
  notice: string | undefined;

  get dirty() {
    return this.base !== undefined && this.draft !== this.base.content;
  }

  get bytes() {
    return new TextEncoder().encode(this.draft).length;
  }

  get tooLarge() {
    return this.bytes > instructionsLimit;
  }

  get canSave() {
    return this.base !== undefined && !this.busy && !this.conflict && this.dirty && !this.tooLarge;
  }

  get canRevert() {
    return this.base?.canRevert === true && !this.busy && !this.conflict;
  }

  get canOverwrite() {
    return !!this.conflict && !this.conflictFromRevert && !this.busy && !this.tooLarge;
  }

  /** The owner's typing, kept only once a file is loaded and while no request runs. */
  edit(text: string) {
    if (!this.base || this.busy) return false;
    this.draft = text;
    return true;
  }

  beginRead(discarding: boolean) {
    if (this.busy || (!discarding && this.dirty)) return false;
    this.busy = { kind: "loading" };
    this.error = undefined;
    this.notice = undefined;
    return true;
  }

  finishRead(result: Reply<Instructions>) {
    this.busy = undefined;
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    this.base = result.value;
    this.draft = result.value.content;
    this.conflict = undefined;
    this.conflictFromRevert = false;
  }

  /** What to send: the draft and the revision it replaces, the conflict's for Overwrite. */
  beginSave(overwrite: boolean) {
    if (!this.base || this.busy) return undefined;
    if (this.draft.includes("\0")) {
      this.error = "Instructions can't contain NUL characters.";
      return undefined;
    }
    if (this.tooLarge) {
      this.error = "Instructions must be at most 64 KiB of UTF-8 text.";
      return undefined;
    }
    let revision: string;
    if (overwrite) {
      if (!this.canOverwrite || !this.conflict) return undefined;
      revision = this.conflict.revision;
    } else {
      if (this.conflict || !this.dirty) return undefined;
      revision = this.base.revision;
    }
    this.busy = { kind: "saving", sent: this.draft };
    this.error = undefined;
    this.notice = undefined;
    return { content: this.draft, revision };
  }

  beginRevert() {
    if (!this.canRevert || !this.base) return undefined;
    this.busy = { kind: "reverting" };
    this.error = undefined;
    this.notice = undefined;
    return this.base.revision;
  }

  /**
   * A save's or revert's answer. A lost one keeps the draft for a manual retry, which the revision
   * check refuses if the first one landed.
   */
  finish(result: Reply<Instructions>) {
    const request = this.busy;
    this.busy = undefined;
    if (result.ok) {
      this.base = result.value;
      this.draft = result.value.content;
      this.conflict = undefined;
      this.conflictFromRevert = false;
      this.notice = request?.kind === "reverting" ? "Reverted to the previous version." : "Saved.";
      return;
    }
    const current = result.status === 409 ? asInstructions(result.current) : undefined;
    if (!current) {
      this.error = result.lost
        ? "Couldn't confirm whether that was saved. Your text is still here; Reload shows the file as it is now. Nothing was retried."
        : result.error;
      return;
    }
    if (request?.kind === "saving" && current.content === request.sent) {
      // An earlier save whose answer was lost had landed.
      this.base = current;
      this.conflict = undefined;
      this.conflictFromRevert = false;
      this.notice = "The file already has your text.";
      return;
    }
    this.conflict = current;
    this.conflictFromRevert = request?.kind === "reverting";
    this.error =
      request?.kind === "reverting"
        ? "AGENTS.md changed since you loaded it, so nothing was reverted."
        : "AGENTS.md changed since you loaded it, so nothing was saved. Your text is still in the editor.";
  }

  /** Cancel: the draft goes back to the file it started from. */
  discard() {
    if (this.busy || !this.base) return;
    this.draft = this.base.content;
    this.error = undefined;
  }
}

const asInstructions = (value: unknown): Instructions | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("content" in value) || !("revision" in value)) return undefined;
  const { content, revision } = value;
  const canRevert = "canRevert" in value && value.canRevert === true;
  return typeof content === "string" && typeof revision === "string"
    ? { content, revision, canRevert }
    : undefined;
};

// Avatars.

/**
 * Which avatar each dot shows. Each listed revision loads once. A replaced file keeps the old image
 * until the new one loads, and a load for a revision no longer listed is dropped. A deleted file
 * clears at once. Bytes that don't decode wait for a new revision, while a failed request is
 * abandoned so the next dots poll asks again.
 */
export class AvatarState<Image> {
  readonly images = new Map<string, Image>();
  private listed = new Map<string, string>();
  private done = new Map<string, string>();
  private loading = new Map<string, string>();

  /** Takes the dots poll's list and answers the loads to start. */
  update(dots: readonly { name: string; avatar: { revision: string } | null }[]) {
    const names = new Set(dots.map((dot) => dot.name));
    for (const name of [...this.listed.keys(), ...this.images.keys()])
      if (!names.has(name)) this.forget(name);
    const loads: { name: string; revision: string }[] = [];
    for (const { name, avatar } of dots) {
      if (!avatar) {
        this.forget(name);
        continue;
      }
      const { revision } = avatar;
      this.listed.set(name, revision);
      if (this.done.get(name) === revision || this.loading.get(name) === revision) continue;
      this.loading.set(name, revision);
      loads.push({ name, revision });
    }
    return loads;
  }

  /** A load's result, `undefined` for bytes that don't decode; false when it's no longer wanted. */
  finish(name: string, revision: string, image: Image | undefined) {
    if (this.listed.get(name) !== revision || this.loading.get(name) !== revision) return false;
    this.loading.delete(name);
    this.done.set(name, revision);
    if (image === undefined) this.images.delete(name);
    else this.images.set(name, image);
    return true;
  }

  /** A request that failed: the next poll asks for the same revision again. */
  abandon(name: string, revision: string) {
    if (this.loading.get(name) === revision) this.loading.delete(name);
  }

  private forget(name: string) {
    this.listed.delete(name);
    this.done.delete(name);
    this.loading.delete(name);
    this.images.delete(name);
  }
}

/**
 * What became of an owner fact change whose answer was lost, from a read of the fact by its ID: it
 * landed only when the fact's latest change is this one. Otherwise, whether the fact is missing,
 * unchanged or changed by something newer, its outcome stays unknown and it's never sent again.
 */
export const ownerOutcome = (
  mutation: OwnerMutation,
  read: Reply<{ fact: { lastMutationID: string | null } }>,
): "landed" | "unknown" =>
  read.ok && read.value.fact.lastMutationID === mutation.mutationID ? "landed" : "unknown";

/** A refused or unconfirmed owner fact change, in words: the daemon's own, unless it was lost. */
export const ownerFailure = (result: Extract<Reply<unknown>, { ok: false }>) =>
  result.lost
    ? "Couldn't confirm this change. It may have been saved; the app checks it by its ID and never sends it again."
    : result.error;

/**
 * Owner fact rows holding the owner's unsaved text whose fact the last read no longer lists as
 * pending or approved, with what it is now: rejected or deleted, or `missing` when the read has no
 * such fact. Their text stays shown apart from the lists until the owner discards it.
 */
export const ownerOrphans = (memory: OwnerMemory | undefined, rows: Iterable<string>) => {
  const listed = new Set(
    [...(memory?.pending ?? []), ...(memory?.approved ?? [])].map((f) => f.id),
  );
  const removed = new Map<string, "rejected" | "deleted">();
  for (const fact of memory?.removed ?? [])
    if (fact.state === "rejected" || fact.state === "deleted") removed.set(fact.id, fact.state);
  return [...new Set(rows)]
    .filter((row) => row.startsWith("owner:") && row !== "owner:new")
    .map((row) => ({ row, factID: row.slice("owner:".length) }))
    .filter(({ factID }) => !listed.has(factID))
    .toSorted((a, b) => (a.row < b.row ? -1 : a.row > b.row ? 1 : 0))
    .map(({ row, factID }) => ({
      row,
      factID,
      state: removed.get(factID) ?? ("missing" as const),
    }));
};

/** How a change is described while its outcome is unknown. */
export const ownerActionWords: Record<OwnerMutation["action"], string> = {
  create: "Adding a fact",
  approve: "Approving a suggestion",
  edit: "Editing a fact",
  reject: "Rejecting a suggestion",
  delete: "Deleting a fact",
};

// Request cards: the daemon's pending requests, read as untrusted data. Anything the app can't
// render exactly falls back to Open in terminal rather than a guessed answer.

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

interface FieldBase {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
  hidden: boolean;
  when: { key: string; op: "eq" | "neq"; value: string | number | boolean }[];
}

export type FormField = FieldBase &
  (
    | {
        type: "string";
        options?: FormOption[];
        custom: boolean;
        minLength?: number;
        maxLength?: number;
        placeholder?: string;
        default?: string;
      }
    | { type: "number"; minimum?: number; maximum?: number; default?: number }
    | { type: "integer"; minimum?: number; maximum?: number; default?: number }
    | { type: "boolean"; default?: boolean }
    | {
        type: "multiselect";
        options: FormOption[];
        custom: boolean;
        minItems?: number;
        maxItems?: number;
        default?: string[];
      }
  );

export type CardDetail =
  | {
      kind: "permission";
      action: string;
      resources: string[];
      message?: string;
      save: string[];
    }
  | { kind: "question"; title: string; fields: FormField[] }
  | { kind: "unsupported" };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === undefined || finite(value);

const options = (value: unknown): FormOption[] | undefined =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      record(item) &&
      typeof item.value === "string" &&
      typeof item.label === "string" &&
      optionalString(item.description),
  )
    ? value.map((item: Record<string, string>) => ({
        value: item.value ?? "",
        label: item.label ?? "",
        ...(item.description === undefined ? {} : { description: item.description }),
      }))
    : undefined;

const whenCondition = (item: unknown): FieldBase["when"][number] | undefined =>
  record(item) &&
  typeof item.key === "string" &&
  (item.op === "eq" || item.op === "neq") &&
  (typeof item.value === "string" || finite(item.value) || typeof item.value === "boolean")
    ? { key: item.key, op: item.op, value: item.value }
    : undefined;

const field = (value: unknown): FormField | undefined => {
  if (!record(value) || typeof value.key !== "string" || !value.key) return undefined;
  if (!optionalString(value.title) || !optionalString(value.description)) return undefined;
  const conditions: unknown = value.when ?? [];
  if (!Array.isArray(conditions)) return undefined;
  const parsed = conditions.map(whenCondition);
  if (!parsed.every((item) => item !== undefined)) return undefined;
  const base: FieldBase = {
    key: value.key,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    required: value.required === true,
    hidden: value.hidden === true,
    when: parsed,
  };
  if (value.type === "string") {
    const listed = value.options === undefined ? undefined : options(value.options);
    if (value.options !== undefined && !listed) return undefined;
    if (
      !optionalNumber(value.minLength) ||
      !optionalNumber(value.maxLength) ||
      !optionalString(value.placeholder) ||
      !optionalString(value.default) ||
      // A pattern or format the app can't check exactly goes to the terminal.
      value.pattern !== undefined ||
      value.format !== undefined
    )
      return undefined;
    return {
      ...base,
      type: "string",
      ...(listed ? { options: listed } : {}),
      custom: value.custom === true,
      ...(finite(value.minLength) ? { minLength: value.minLength } : {}),
      ...(finite(value.maxLength) ? { maxLength: value.maxLength } : {}),
      ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}),
      ...(typeof value.default === "string" ? { default: value.default } : {}),
    };
  }
  if (value.type === "number" || value.type === "integer") {
    if (
      !optionalNumber(value.minimum) ||
      !optionalNumber(value.maximum) ||
      !optionalNumber(value.default)
    )
      return undefined;
    const limits = {
      ...(finite(value.minimum) ? { minimum: value.minimum } : {}),
      ...(finite(value.maximum) ? { maximum: value.maximum } : {}),
      ...(finite(value.default) ? { default: value.default } : {}),
    };
    return value.type === "number"
      ? { ...base, type: "number", ...limits }
      : { ...base, type: "integer", ...limits };
  }
  if (value.type === "boolean") {
    if (value.default !== undefined && typeof value.default !== "boolean") return undefined;
    return {
      ...base,
      type: "boolean",
      ...(typeof value.default === "boolean" ? { default: value.default } : {}),
    };
  }
  if (value.type === "multiselect") {
    const listed = options(value.options);
    if (
      !listed ||
      !optionalNumber(value.minItems) ||
      !optionalNumber(value.maxItems) ||
      (value.default !== undefined && !strings(value.default))
    )
      return undefined;
    return {
      ...base,
      type: "multiselect",
      options: listed,
      custom: value.custom === true,
      ...(finite(value.minItems) ? { minItems: value.minItems } : {}),
      ...(finite(value.maxItems) ? { maxItems: value.maxItems } : {}),
      ...(strings(value.default) ? { default: value.default } : {}),
    };
  }
  return undefined;
};

/** What a card shows, checked field by field; anything else is unsupported. */
export const cardDetail = (card: RequestCard): CardDetail => {
  const detail: unknown = card.detail;
  if (card.sensitive || !record(detail)) return { kind: "unsupported" };
  if (card.kind === "permission" && detail.kind === "permission") {
    if (
      typeof detail.action !== "string" ||
      !strings(detail.resources) ||
      !optionalString(detail.message) ||
      (detail.save !== undefined && !strings(detail.save))
    )
      return { kind: "unsupported" };
    return {
      kind: "permission",
      action: detail.action,
      resources: detail.resources,
      ...(typeof detail.message === "string" ? { message: detail.message } : {}),
      save: strings(detail.save) ? detail.save : [],
    };
  }
  if (card.kind === "question" && detail.kind === "question") {
    if (typeof detail.title !== "string" || !Array.isArray(detail.fields) || !detail.fields.length)
      return { kind: "unsupported" };
    const fields = detail.fields.map(field);
    if (!fields.every((item) => item !== undefined)) return { kind: "unsupported" };
    const keys = new Set(fields.map((item) => item.key));
    if (keys.size !== fields.length) return { kind: "unsupported" };
    return { kind: "question", title: detail.title, fields };
  }
  return { kind: "unsupported" };
};

export type FormValue = string | number | boolean | string[];
export type FormValues = Record<string, FormValue | undefined>;

/** The form's starting values: each field's default. */
export const initialValues = (fields: readonly FormField[]): FormValues =>
  Object.fromEntries(
    fields.flatMap((item) => (item.default === undefined ? [] : [[item.key, item.default]])),
  );

/** A field applies while every `when` condition holds against the values now. */
export const fieldActive = (item: FormField, values: FormValues) =>
  item.when.every((condition) => {
    const value = values[condition.key];
    const equal = !Array.isArray(value) && value === condition.value;
    return condition.op === "eq" ? equal : !equal;
  });

/** Fields the owner sees: active and not hidden. */
export const shownFields = (fields: readonly FormField[], values: FormValues) =>
  fields.filter((item) => !item.hidden && fieldActive(item, values));

/**
 * The whole form's answer, keyed by field: active fields' values, hidden ones by their default,
 * blanks left out, or why it can't be sent yet.
 */
export const formAnswer = (
  fields: readonly FormField[],
  values: FormValues,
): { answer: Record<string, FormValue> } | { error: string } => {
  const answer: Record<string, FormValue> = {};
  for (const item of fields) {
    if (!fieldActive(item, values)) continue;
    const value = item.hidden ? item.default : values[item.key];
    const name = item.title ?? item.key;
    const blank =
      value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (blank) {
      if (item.required) return { error: `${name} needs an answer.` };
      continue;
    }
    if (item.type === "string") {
      if (typeof value !== "string") return { error: `${name} needs text.` };
      if (item.options && !item.custom && !item.options.some((option) => option.value === value))
        return { error: `${name} must be one of its options.` };
      if (
        (item.minLength !== undefined && value.length < item.minLength) ||
        (item.maxLength !== undefined && value.length > item.maxLength)
      )
        return { error: `${name} has the wrong length.` };
    } else if (item.type === "number" || item.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value))
        return { error: `${name} needs a number.` };
      if (item.type === "integer" && !Number.isInteger(value))
        return { error: `${name} needs a whole number.` };
      if (
        (item.minimum !== undefined && value < item.minimum) ||
        (item.maximum !== undefined && value > item.maximum)
      )
        return { error: `${name} is out of range.` };
    } else if (item.type === "boolean") {
      if (typeof value !== "boolean") return { error: `${name} needs yes or no.` };
    } else if (item.type === "multiselect") {
      if (!Array.isArray(value)) return { error: `${name} needs choices.` };
      if (!item.custom && !value.every((choice) => item.options.some((o) => o.value === choice)))
        return { error: `${name} must use its options.` };
      if (
        (item.minItems !== undefined && value.length < item.minItems) ||
        (item.maxItems !== undefined && value.length > item.maxItems)
      )
        return { error: `${name} has the wrong number of choices.` };
    } else return { error: `${name} can't be answered here.` };
    answer[item.key] = value;
  }
  return { answer };
};

/** Where a request came from, in a few words. */
export const cardOrigin = (card: RequestCard) =>
  card.source === "dot"
    ? `${card.dot} itself`
    : card.source === "worker"
      ? `${card.dot}'s worker #${card.worker ?? "?"}`
      : `${card.dot}'s Threads worker`;

/** What the card says about an answer already on its way or lost. */
export const cardStatus = (card: RequestCard): string | null => {
  if (card.sensitive)
    return "It may ask for a secret, so open-dot kept none of its words. Answer it in its terminal.";
  if (card.state === "unknown")
    return "open-dot sent an answer but OpenCode didn't confirm it, so it won't be sent again. Check it in its terminal.";
  if (card.state === "queued" || card.state === "answering") return "Sending your answer…";
  if (card.attempt?.actor === "owner" && card.attempt.state === "refused" && card.reason)
    return `Not sent: ${card.reason}`;
  return null;
};

/**
 * The cards to show from successive reads: a read started before a later one that already
 * landed is dropped, so a slow poll never brings back a card a newer read removed.
 */
export const cardsFence = () => {
  let started = 0;
  let landed = 0;
  return {
    begin: () => ++started,
    land: (generation: number) => {
      if (generation <= landed) return false;
      landed = generation;
      return true;
    },
  };
};

/** The answer the owner chose on a card, as main posts it. */
export type CardAnswer = { answer: OwnerAnswer; confirmedAlways: boolean };
