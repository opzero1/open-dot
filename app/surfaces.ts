// The plain logic behind the app's Feed, Memory and Instructions, apart from React and
// Electron so it can be tested. Each piece holds only view state; the daemon owns every value.
import type {
  FeedItem,
  Grant,
  Instructions,
  MemoryResponsibility,
  NoteSourceRead,
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

/**
 * The dots still to send to after a reply: those whose send didn't land. A saved or unknown one is
 * never sent again from the same reply.
 */
export const unsentRecipients = (
  recipients: readonly string[],
  outcomes: ReadonlyMap<string, ReplyOutcome>,
) => recipients.filter((dot) => outcomes.get(dot) === "refused" || !outcomes.has(dot));

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
