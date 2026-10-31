// Behavior the retired notch's mac/Tests covered, as app logic: avatars, responsibility runs and
// schedules, the request audit, grants, watch bindings and the Slack view's words and links.
import { expect, test } from "bun:test";
import type { MemoryResponsibility, RunView, SlackSetup, Supervision } from "../bridge";
import {
  canAttach,
  dmCheckLine,
  installLine,
  isSlackAppPage,
  linkWarning,
  slackLinks,
  tokenMatches,
} from "../slack";
import {
  AvatarState,
  grantRemaining,
  nextRunLine,
  requestAsked,
  requestAttempts,
  requestLine,
  requestTimes,
  requestTitle,
  runAttribution,
  runTitle,
  runUnresolved,
  runWorkerLine,
  runWorkersNotes,
  scheduleSummary,
  supervisionTimes,
} from "../surfaces";

const listed = (revisions: Record<string, string | null>) =>
  Object.entries(revisions).map(([name, revision]) => ({
    name,
    avatar: revision === null ? null : { revision },
  }));

test("each avatar revision loads once, and a dot without one shows none", () => {
  const state = new AvatarState<string>();
  expect(state.update(listed({ jotaro: "a", jolyne: null }))).toEqual([
    { name: "jotaro", revision: "a" },
  ]);
  expect(state.update(listed({ jotaro: "a", jolyne: null }))).toEqual([]);
  expect(state.finish("jotaro", "a", "image-a")).toBe(true);
  expect(state.images.get("jotaro")).toBe("image-a");
  expect(state.images.has("jolyne")).toBe(false);
  expect(state.update(listed({ jotaro: "a" }))).toEqual([]);
});

test("a replaced avatar keeps the old image until the new one loads, and a stale load is dropped", () => {
  const state = new AvatarState<string>();
  state.update(listed({ jotaro: "a" }));
  state.finish("jotaro", "a", "old");
  state.update(listed({ jotaro: "b" }));
  expect(state.images.get("jotaro")).toBe("old");
  state.update(listed({ jotaro: "c" }));
  expect(state.finish("jotaro", "b", "stale")).toBe(false);
  expect(state.images.get("jotaro")).toBe("old");
  expect(state.finish("jotaro", "c", "new")).toBe(true);
  expect(state.images.get("jotaro")).toBe("new");
});

test("a deleted avatar clears at once, and a late load can't bring it back", () => {
  const state = new AvatarState<string>();
  state.update(listed({ jotaro: "a" }));
  state.finish("jotaro", "a", "image");
  state.update(listed({ jotaro: "b" }));
  state.update(listed({ jotaro: null }));
  expect(state.images.has("jotaro")).toBe(false);
  expect(state.finish("jotaro", "b", "late")).toBe(false);
  expect(state.images.has("jotaro")).toBe(false);
  expect(state.update(listed({ jotaro: "a" }))).toEqual([{ name: "jotaro", revision: "a" }]);
  // A dot gone from the list loses its image too.
  state.finish("jotaro", "a", "back");
  state.update([]);
  expect(state.images.size).toBe(0);
});

test("bytes that don't decode wait for a new revision, while a failed request is asked for again", () => {
  const state = new AvatarState<string>();
  state.update(listed({ jotaro: "a" }));
  expect(state.finish("jotaro", "a", undefined)).toBe(true);
  expect(state.images.has("jotaro")).toBe(false);
  expect(state.update(listed({ jotaro: "a" }))).toEqual([]);
  expect(state.update(listed({ jotaro: "b" }))).toEqual([{ name: "jotaro", revision: "b" }]);
  state.abandon("jotaro", "b");
  expect(state.update(listed({ jotaro: "b" }))).toEqual([{ name: "jotaro", revision: "b" }]);
  expect(state.finish("jotaro", "b", "image")).toBe(true);
  expect(state.images.get("jotaro")).toBe("image");
});

const run = (state: string, extra: Partial<RunView> = {}): RunView => ({
  id: 1,
  responsibility: 3,
  dueAt: 0,
  claimedAt: 0,
  snapshot: { goal: "Inbox zero", nextAction: "Triage" },
  sessionID: "ses_jojo",
  messageID: "msg_1",
  state,
  delivery: "admitted",
  workers: [],
  ...extra,
});

test("a finished turn never says the goal was met, and unresolved runs stay unresolved", () => {
  const finished = run("finished-turn", { attribution: "exclusive" });
  expect(runTitle(finished)).toBe("turn finished, goal not checked");
  expect(runUnresolved(finished)).toBe(false);
  expect(runAttribution(finished)).toBeUndefined();
  for (const [state, title] of [
    ["queued", "queued"],
    ["admitted", "admitted, not started"],
    ["running", "running"],
    ["needs-you", "needs you"],
    ["unknown", "outcome unknown"],
  ]) {
    expect(runTitle(run(state ?? ""))).toBe(title ?? "");
    expect(runUnresolved(run(state ?? ""))).toBe(true);
  }
  expect(runTitle(run("queued", { delivery: "sending" }))).toBe("sending, not confirmed");
});

test("a failed or shared turn says why it has no result, and workers say what they need", () => {
  const interrupted = run("failed", { turn: { outcome: "interrupted" }, attribution: "shared" });
  expect(runTitle(interrupted)).toBe("interrupted");
  expect(runAttribution(interrupted)).toBe(
    "Its turn also handled other messages, so no reply is attributed to this run.",
  );
  expect(runAttribution(run("failed", { attribution: "unknown" }))).toContain("History didn't");
  expect(runTitle(run("failed", { turn: { outcome: "failed" } }))).toBe("failed");
  expect(
    runWorkerLine({ id: 7, state: "running", task: "Sort", needs: ["permission"] }) +
      " | " +
      runWorkerLine({ id: 8, state: "done", task: "Tag", outcome: "failed", needs: [] }),
  ).toBe("Worker #7: Sort · needs you: permission | Worker #8: Tag · finished (failed)");
  const provisional = run("running", {
    workers: [{ id: 7, state: "running", task: "Sort", provisional: true }],
    withheldWorkers: 2,
  });
  expect(runWorkersNotes(provisional)).toEqual([
    expect.stringContaining("may still make these not the run's"),
    "2 workers delegated in this turn aren't shown as the run's, because the turn also handled other input or its history was incomplete.",
  ]);
  expect(runWorkersNotes(run("finished-turn"))).toEqual([]);
});

test("the request audit says what became of each answer", () => {
  expect(requestTitle({ state: "open", goneAt: null })).toBe("dot handling");
  expect(requestTitle({ state: "open", goneAt: 5 })).toBe("gone unanswered");
  expect(requestTitle({ state: "stale" })).toBe("not sent");
  expect(requestTitle({ state: "unknown" })).toBe("outcome unknown");
  expect(requestTitle({ state: "escalated" })).toBe("escalated to you");
});

test("the audit names each request's source, what it asked, and who answered when", () => {
  const escalated = {
    id: 3,
    source: "worker",
    worker: 1,
    kind: "permission",
    state: "escalated",
    summary: "Approved once (not sent)",
    detail: { kind: "permission", action: "shell", resources: ["git push --force"] },
    sessionID: "ses_w",
    createdAt: 1000,
    actorSession: "ses_jojo",
    queuedAt: 2000,
    attemptedAt: null,
    confirmedAt: null,
    escalatedAt: 3000,
  };
  const answered = {
    id: 4,
    source: "threads",
    worker: null,
    kind: "question",
    state: "answered",
    summary: "Answered branch: dev",
    detail: { kind: "question", title: "Which?", fields: [{ key: "branch", title: "Branch" }] },
    sessionID: "ses_t",
    createdAt: 1000,
    actorSession: "ses_jojo",
    queuedAt: 2000,
    attemptedAt: 2100,
    confirmedAt: 2200,
    escalatedAt: null,
  };
  expect([escalated, answered].map(requestLine)).toEqual([
    "#3 permission from worker #1 · escalated to you · Approved once (not sent)",
    "#4 question from Threads · confirmed · Answered branch: dev",
  ]);
  expect([escalated, answered].map(requestAsked)).toEqual([
    "shell: git push --force",
    "Which? · Branch",
  ]);
  const times = requestTimes(answered);
  expect(times).toStartWith("ses_t · seen ");
  expect(times).toContain("by ses_jojo");
  expect(times).toContain(" · sent ");
  expect(times).toContain(" · confirmed ");
  expect(times).not.toContain("escalated");
  expect(requestTimes(escalated)).toContain(" · escalated ");
  expect(requestTimes(escalated)).not.toContain("confirmed");
  // A request nobody answered yet shows only when it was seen.
  expect(requestTimes({ sessionID: "s", createdAt: 1 }).split(" · ")).toHaveLength(2);
});

const responsibility = (
  status: string,
  schedule: MemoryResponsibility["schedule"],
  nextRunAt: number | null,
): MemoryResponsibility => ({
  id: 1,
  goal: "Inbox zero",
  nextAction: "Triage",
  status,
  schedule,
  nextRunAt,
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: "owner",
});

test("schedules read as the owner set them, and only an armed active one has a next run", () => {
  expect(scheduleSummary({ kind: "interval", everyMinutes: 10 })).toBe("Every 10 minutes");
  expect(scheduleSummary({ kind: "interval", everyMinutes: 120 })).toBe("Every 2 hours");
  expect(scheduleSummary({ kind: "daily", time: "09:30" })).toBe("Daily at 09:30");
  expect(scheduleSummary({ kind: "weekly", days: [1, 3, 5], time: "08:00" })).toBe(
    "Weekly on Mon, Wed, Fri at 08:00",
  );
  expect(nextRunLine(responsibility("active", null, null))).toBeUndefined();
  const daily = { kind: "daily", time: "09:30" };
  expect(nextRunLine(responsibility("done", daily, null))).toBe(
    "Daily at 09:30 · paused while done",
  );
  expect(nextRunLine(responsibility("dropped", daily, null))).toBe(
    "Daily at 09:30 · paused while dropped",
  );
  expect(nextRunLine(responsibility("active", daily, null))).toBe(
    "Daily at 09:30 · next run unknown",
  );
  expect(nextRunLine(responsibility("active", daily, 1_000), 2_000)).toBe(
    "Daily at 09:30 · next run due now",
  );
});

test("a grant says how long it has left, and a watch binding when it was asked for and approved", () => {
  const now = 10 * 86_400_000;
  const grant = (minutes: number) => ({
    id: 1,
    operation: "dot_message",
    summary: "",
    createdAt: 0,
    expiresAt: now + minutes * 60_000,
  });
  expect(grantRemaining(grant(0.5), now)).toBe("Ends now");
  expect(grantRemaining(grant(45), now)).toBe("Ends in 45m");
  expect(grantRemaining(grant(180), now)).toBe("Ends in 3h");
  expect(grantRemaining(grant(3 * 1440), now)).toBe("Ends in 3d");
  const binding = (state: string, activatedAt: number | null): Supervision => ({
    id: 1,
    sessionID: "ses_x",
    directory: "/w",
    mode: "watch",
    state,
    busyMinutes: 30,
    createdAt: now - 3 * 3_600_000,
    activatedAt,
  });
  expect(supervisionTimes(binding("requested", null), now)).toBe("Requested 3h ago");
  expect(supervisionTimes(binding("active", now - 3 * 3_600_000), now)).toBe("Created 3h ago");
  expect(supervisionTimes(binding("active", now - 60_000), now)).toBe(
    "Created 3h ago, approved 1m ago",
  );
});

const app = (
  state: string,
  appID: string | null = "A0123456789",
): NonNullable<SlackSetup["app"]> => ({
  state,
  appID,
  botUser: null,
  problem: null,
  install: null,
  manifestOutdated: false,
  updateState: null,
  updateNote: null,
  icon: null,
});

test("the Slack view opens only Slack's pages for an app ID of Slack's form", () => {
  expect(slackLinks("A0123456789")?.install).toBe(
    "https://api.slack.com/apps/A0123456789/install-on-team",
  );
  for (const bad of [null, undefined, "a0123", "A01/../x", "A0123456789?x=1"])
    expect(slackLinks(bad)).toBeUndefined();
  expect(isSlackAppPage("https://api.slack.com/apps/A0123456789/oauth")).toBe(true);
  for (const bad of [
    "http://api.slack.com/apps",
    "https://evil.example/apps",
    "https://user:pass@api.slack.com/apps",
    "https://api.slack.com/apis",
    "not a url",
  ])
    expect(isSlackAppPage(bad)).toBe(false);
});

test("Attach is offered without an app or after an unclear create, and the link warns of a duplicate", () => {
  expect(canAttach(undefined)).toBe(true);
  expect(canAttach("unknown")).toBe(true);
  expect(canAttach("active")).toBe(false);
  expect(canAttach("creating")).toBe(false);
  expect(linkWarning(app("active"), "jotaro")).toContain(
    "binding it replaces A0123456789 only once you confirm",
  );
  expect(linkWarning(app("unknown", null), "jotaro")).toContain("look there first");
  expect(linkWarning(null, "jotaro")).toBe(
    "The prefilled link makes a new app in Slack each time you use it.",
  );
});

test("the DM check is pending until Slack confirmed a reply, and approval is the owner's to ask", () => {
  expect(dmCheckLine(null, "jotaro")).toContain("Nothing is sent for you.");
  expect(dmCheckLine({ state: "pending", since: 0, dmAt: null }, "jotaro")).toContain(
    "DM check: pending since",
  );
  expect(dmCheckLine({ state: "replied", since: 0, dmAt: null }, "jotaro")).toContain("pending");
  expect(dmCheckLine({ state: "replied", since: 0, dmAt: 5 }, "jotaro")).toContain("replied");
  expect(installLine({ phase: "approval", code: "app_approval_request_eligible" })).toContain(
    "open-dot hasn't asked for it",
  );
  expect(installLine({ phase: "saved" })).toContain("Saved isn't connected");
});

test("an app-level token must name the dot's own app, and a bot token waits for its pair's form", () => {
  const appToken = "xapp-1-A0123456789-123-abcdefghijklmnopqrstuvwxyz";
  expect(tokenMatches("app", appToken, "A0123456789")).toBe(true);
  expect(tokenMatches("app", appToken, "A9999999999")).toBe(false);
  expect(tokenMatches("linkApp", appToken, undefined)).toBe(true);
  expect(tokenMatches("app", ` ${appToken}`, "A0123456789")).toBe(false);
  expect(tokenMatches("bot", appToken, undefined)).toBe(false);
});

test("the audit names the dot's own session and who chose each answer", () => {
  expect(
    requestLine({
      id: 5,
      source: "dot",
      worker: null,
      kind: "permission",
      state: "answered",
      summary: "Approved always",
    }),
  ).toBe("#5 permission from the dot's own session · confirmed · Approved always");
  const lines = requestAttempts({
    attempts: [
      {
        id: "a",
        actor: "dot",
        state: "refused",
        error: "refused",
        queuedAt: 1000,
        attemptedAt: null,
        confirmedAt: null,
      },
      {
        id: "b",
        actor: "owner",
        state: "confirmed",
        error: null,
        queuedAt: 2000,
        attemptedAt: 2100,
        confirmedAt: 2200,
      },
    ],
  });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("By the dot · not sent (refused) · ");
  expect(lines[1]).toStartWith("By you · confirmed · ");
  expect(requestAttempts({})).toEqual([]);
});
