// What main checks each daemon answer against before the renderer sees it. Plain data and functions,
// apart from Electron, so a test can hold them against the daemon's real answers.
import type { Operation, OwnerMutation, Reply } from "./bridge";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Each operation's answer is checked against the shape the renderer reads before it goes there. A
// read that doesn't fit is an error; a change whose answer doesn't fit has an unknown outcome, so
// the renderer keeps the owner's draft and never treats it as saved.

/**
 * "s", "n" and "b" are a string, number and boolean, "*" anything; a key ending in "?" may be absent
 * or null. An array holds one shape every item fits; an object lists the fields it must have.
 */
export type Shape = string | readonly [Shape] | { readonly [key: string]: Shape };

export const fits = (value: unknown, shape: Shape): boolean => {
  if (typeof shape === "string") {
    if (shape === "*") return true;
    if (shape === "s") return typeof value === "string";
    if (shape === "n") return typeof value === "number";
    return shape === "b" && typeof value === "boolean";
  }
  if (Array.isArray(shape))
    return Array.isArray(value) && value.every((item) => fits(item, shape[0]));
  if (!isRecord(value)) return false;
  return Object.entries(shape).every(([key, field]) => {
    if (!key.endsWith("?")) return fits(value[key], field);
    const known = value[key.slice(0, -1)];
    return known === undefined || known === null || fits(known, field);
  });
};

const toolFile = { path: "s", "additions?": "n", "deletions?": "n" } as const;
const toolCall = {
  messageID: "s",
  callID: "s",
  name: "s",
  status: "s",
  "startedAt?": "n",
  "endedAt?": "n",
  label: "s",
  files: [toolFile],
} as const;
const workCounts = { commands: "n", edits: "n", edited: "n", failed: "n", total: "n" } as const;

/** A work log as the renderer reads it, whether from a page or on its own. */
export const workLogShape = {
  "anchor?": "s",
  calls: [toolCall],
  counts: workCounts,
  complete: "b",
  open: "b",
  "more?": "s",
} as const;

const versioned = { id: "n", version: "n", updatedAt: "n", updatedBy: "s" } as const;
const feedItem = {
  id: "n",
  source: "s",
  reason: "s",
  title: "s",
  context: "s",
  "url?": "s",
  time: "n",
  "handedTo?": ["s"],
} as const;
const requestCard = {
  id: "n",
  dot: "s",
  "boundSessionID?": "s",
  source: "s",
  "worker?": "n",
  sessionID: "s",
  title: "s",
  directory: "s",
  kind: "s",
  requestID: "s",
  detail: { kind: "s" },
  sensitive: "b",
  state: "s",
  "reason?": "s",
  needsYou: "b",
  revision: "s",
  actionable: "b",
  "attempt?": { id: "s", actor: "s", state: "s", "error?": "s" },
  createdAt: "n",
  "escalatedAt?": "n",
} as const;
const attemptView = {
  id: "s",
  actor: "s",
  state: "s",
  "error?": "s",
  queuedAt: "n",
  "attemptedAt?": "n",
  "confirmedAt?": "n",
} as const;
const observation = {
  ...versioned,
  kind: "s",
  topic: "s",
  text: "s",
  sources: [{ messageID: "s", "excerpt?": "s", "from?": "s", "date?": "s" }],
} as const;
const ownerFact = {
  id: "s",
  state: "s",
  "text?": "s",
  version: "n",
  createdAt: "n",
  updatedAt: "n",
  "origin?": { dot: "s", sessionID: "s", messageID: "s" },
  "lastMutationID?": "s",
} as const;
const instructions = { content: "s", revision: "s", canRevert: "b" } as const;
const slackSetup = { config: { state: "s" }, "app?": { state: "s" } } as const;

export const shapes: Record<Operation, Shape> = {
  feed: { items: [feedItem], remaining: "n", handedOff: [feedItem] },
  dismiss: "*",
  dismissAll: { dismissed: ["n"], missing: ["n"] },
  memory: {
    notes: [{ ...versioned, text: "s" }],
    responsibilities: [
      { ...versioned, goal: "s", nextAction: "s", status: "s", "nextRunAt?": "n" },
    ],
    reminders: [{ ...versioned, text: "s", dueAt: "n", "everyMinutes?": "n", state: "s" }],
    "observations?": [observation],
    "observationsNext?": "n",
    "supervisions?": [
      { id: "n", sessionID: "s", directory: "s", mode: "s", state: "s", busyMinutes: "n" },
    ],
    "grants?": [{ id: "n", operation: "s", summary: "s", expiresAt: "n" }],
    "triggers?": [
      {
        id: "n",
        responsibility: "n",
        repository: "s",
        reasons: ["s"],
        task: "s",
        revision: "s",
        state: "s",
        skipped: [{ at: "n", event: { title: "s" } }],
        "lastWake?": { at: "n", events: ["*"], delivery: "s" },
      },
    ],
  },
  ownerMemory: {
    pending: [ownerFact],
    approved: [ownerFact],
    removed: [ownerFact],
    entryBytes: "n",
    entryLimit: "n",
  },
  ownerFact: { fact: ownerFact },
  pendingRequests: { requests: [requestCard], "next?": "n" },
  requestReceipt: { request: requestCard, attempts: [attemptView] },
  answerRequest: { attemptID: "s", request: requestCard, attempts: [attemptView] },
  answerRecords: "*",
  answerSettle: "*",
  ownerChange: { fact: ownerFact },
  ownerMutations: "*",
  ownerSettle: "*",
  observations: { observations: [observation], "next?": "n" },
  observationSource: { message: "s", text: "s" },
  noteSource: { note: "n", state: "s", "message?": { text: "s", time: "n", role: "s" } },
  recall: {
    query: "s",
    archive: "b",
    results: [{ kind: "s", "snippet?": "s", "text?": "s", "message?": "s" }],
    "next?": "n",
  },
  searchNotes: {
    query: "s",
    results: [{ id: "n", updatedAt: "n", updatedBy: "s", snippet: "s" }],
    more: "b",
  },
  archived: { message: "s", text: "s", "next?": "n" },
  archiveStatus: { archive: "b", "observerStatus?": { budgetNote: "s" } },
  runs: {
    runs: [
      {
        id: "n",
        dueAt: "n",
        claimedAt: "n",
        sessionID: "s",
        messageID: "s",
        state: "s",
        workers: [{ id: "n", state: "s", task: "s" }],
        "result?": { messageID: "s", text: "s" },
      },
    ],
    "next?": "n",
  },
  requests: {
    requests: [
      {
        id: "n",
        source: "s",
        sessionID: "s",
        title: "s",
        kind: "s",
        requestID: "s",
        detailText: "s",
        "answerText?": "s",
        state: "s",
        needsYou: "b",
        createdAt: "n",
      },
    ],
    "next?": "n",
  },
  addNote: "*",
  editNote: "*",
  deleteNote: "*",
  editResponsibility: "*",
  editReminder: "*",
  cancelReminder: "*",
  addObservation: "*",
  editObservation: "*",
  forgetObservation: "*",
  deleteArchived: "*",
  approveWatch: "*",
  endWatch: "*",
  revokeGrant: "*",
  createTrigger: "*",
  previewTrigger: { total: "n", matches: [{ event: { title: "s" }, outcome: "s" }] },
  enableTrigger: "*",
  pauseTrigger: "*",
  revokeTrigger: "*",
  instructions,
  saveInstructions: instructions,
  revertInstructions: instructions,
  library: {
    artifacts: [
      { id: "n", name: "s", mime: "s", size: "n", sha256: "s", createdAt: "n", status: "s" },
    ],
    "next?": "n",
  },
  usage: {
    days: [
      {
        day: "n",
        steps: "n",
        input: "n",
        output: "n",
        reasoning: "n",
        cacheRead: "n",
        cacheWrite: "n",
        "hitPercent?": "n",
      },
    ],
    counting: "b",
    streak: "n",
    alarm: "b",
  },
  health: { checkedAt: "n", checks: [{ id: "s", status: "s", summary: "s" }] },
  slack: slackSetup,
  slackConnect: slackSetup,
  slackAttach: slackSetup,
  slackInstall: slackSetup,
  slackUpdate: { said: "s", "confirm?": ["s"] },
  slackIcon: slackSetup,
  slackDMCheck: slackSetup,
  slackLogin: { attempt: "s", command: "s", expiresAt: "n" },
  fresh: { name: "s", sessionID: "s", previousSessionID: "s" },
  activity: {
    sessionID: "s",
    state: "s",
    "tool?": "s",
    "label?": "s",
    running: "n",
    "since?": "n",
    observedAt: "n",
  },
  work: { calls: [toolCall], counts: workCounts, complete: "b", "more?": "s" },
  toolDetail: {
    ...toolCall,
    "input?": "s",
    "output?": "s",
    "error?": "s",
    patches: [{ ...toolFile, "patch?": "s" }],
    truncated: "b",
  },
};

/** An answer that doesn't fit its operation: a read failed, a change's outcome is unknown. */
export const decoded = (op: Operation, method: string, result: Reply<unknown>): Reply<unknown> => {
  if (!result.ok || fits(result.value, shapes[op])) return result;
  return method === "GET"
    ? { ok: false, error: "The daemon's answer wasn't understood." }
    : {
        ok: false,
        error:
          "The daemon's answer wasn't understood, so this may or may not have been done. Nothing was retried.",
        lost: true,
      };
};

/** The daemon request for a saved owner fact change: its IDs and version, and the text if any. */
export const ownerRequest = (mutation: OwnerMutation, text: string | null) => {
  const { factID, mutationID, action, version } = mutation;
  const path = `/owner/facts/${factID}`;
  if (action === "create") return { method: "PUT", path, body: { version: 0, text, mutationID } };
  if (action === "delete")
    return { method: "DELETE", path: `${path}?version=${version}&mutationID=${mutationID}` };
  return {
    method: "PATCH",
    path,
    body: { action, version, mutationID, ...(text === null ? {} : { text }) },
  };
};
