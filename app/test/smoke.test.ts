// Launches the built app with hidden windows against a fake daemon in a temporary OPEN_DOT_HOME and
// drives it through main's smoke driver: no window is shown or focused, clipboard and share are
// recorded instead of used, and every daemon is a fake on loopback with a throwaway token.
import { afterAll, beforeAll, expect, test } from "bun:test";
import electron from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let scratch: string;

beforeAll(() => {
  const build = Bun.spawnSync(["bun", join(root, "build.ts")], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  scratch = mkdtempSync(join(tmpdir(), "open-dot-app-smoke-"));
}, 180_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A real, playable 16×16 VP8 WebM of two frames, made with ffmpeg's lavfi color source.
const webm = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIkEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggIO7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAeQAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WI2k8EuBUmJq+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WI2k8EuBUmJq9nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnXY54EAo7yBAACAsAIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gCDP0oAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjlYEAyACxAQABEBAAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAbHwgQM=",
  "base64",
);
// A 20-second, 16×16 VP8 WebM at two frames a second: long enough to play through several polls.
const longWebm = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAe8EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggcA7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhA04gAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIaClW9VU9IZucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIaClW9VU9IZtnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MjAuMDAwMDAwMDAwAB9DtnVBeOeBAKO9gQAAgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgQH0ALEBAAEQEAAYABhYL/QACAAAo5WBA+gAsQEAARAQABgAGFgv9AAIAACjlYEF3ACxAQABEBAAGAAYWC/0AAgAAKO9gQfQgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgQnEALEBAAEQEAAYABhYL/QACAAAo5WBC7gAsQEAARAQABgAGFgv9AAIAACjlYENrACxAQABEBAAGAAYWC/0AAgAAKO9gQ+ggPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgRGUALEBAAEQEAAYABhYL/QACAAAo5WBE4gAsQEAARAQABgAGFgv9AAIAAAfQ7Z1QXnnghV8o5WBAAAAsQEAARAQABgAGFgv9AAIAACjvYEB9IDwAgCdASoQABAAAEcIhYWIhYSIAgICdaoD+AP6Ag1NGAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQCjlYED6ACxAQABEBAAGAAYWC/0AAgAAKOVgQXcALEBAAEQEAAYABhYL/QACAAAo5WBB9AAsQEAARAQABgAGFgv9AAIAACjvYEJxIDwAgCdASoQABAAAEcIhYWIhYSIAgICdaoD+AP6Ag1NGAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQCjlYELuACxAQABEBAAGAAYWC/0AAgAAKOVgQ2sALEBAAEQEAAYABhYL/QACAAAo5WBD6AAsQEAARAQABgAGFgv9AAIAACjvYERlIDwAgCdASoQABAAAEcIhYWIhYSIAgICdaoD+AP6Ag1NGAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQCjlYETiACxAQABEBAAGAAYWC/0AAgAAB9DtnVBeeeCKvijlYEAAACxAQABEBAAGAAYWC/0AAgAAKOVgQH0ALEBAAEQEAAYABhYL/QACAAAo72BA+iA8AIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gD+gINTRgA/v1u8//jmTcwxP+Obf/xYTwOKMj/8VEAo5WBBdwAsQEAARAQABgAGFgv9AAIAACjlYEH0ACxAQABEBAAGAAYWC/0AAgAAKOVgQnEALEBAAEQEAAYABhYL/QACAAAo72BC7iA8AIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gD+gINTRgA/v1u8//jmTcwxP+Obf/xYTwOKMj/8VEAo5WBDawAsQEAARAQABgAGFgv9AAIAACjlYEPoACxAQABEBAAGAAYWC/0AAgAAKOVgRGUALEBAAEQEAAYABhYL/QACAAAo72BE4iA8AIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gD+gINTRgA/v1u8//jmTcwxP+Obf/xYTwOKMj/8VEAH0O2dUDN54JAdKOVgQAAALEBAAEQEAAYABhYL/QACAAAo5WBAfQAsQEAARAQABgAGFgv9AAIAACjlYED6ACxAQABEBAAGAAYWC/0AAgAAKO9gQXcgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgQfQALEBAAEQEAAYABhYL/QACAAAo5WBCcQAsQEAARAQABgAGFgv9AAIAACjlYELuACxAQABEBAAGAAYWC/0AAgAABxTu2tAtruPs4EAt4r3gQHxggGx8IEDu5CzggfQt4r3gQHxggGx8IGHu5Gzgg+gt4v3gQHxggGx8IIBC7uQs4IXcLeK94EB8YIDL/CBG7uQs4IfQLeK94EB8YIDL/CBn7uRs4InELeL94EB8YIDL/CCASO7kLOCLuC3iveBAfGCBK7wgTK7kLOCNrC3iveBAfGCBK7wgba7kbOCPoC3i/eBAfGCBK7wggE6u5CzgkZQt4r3gQHxggYt8IFJ",
  "base64",
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface FakeMessage {
  id: string;
  kind: "owner" | "dot" | "peer" | "notice";
  text: string;
  attachments?: { mime: string; name: string | null }[];
  extra?: object;
}

interface Post {
  server: number;
  messageID: string;
  text: string;
  replyTo?: string;
  feed?: number;
  files: number;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const now = Date.now();
const versioned = (id: number, version = 1) => ({
  id,
  version,
  createdAt: now - 3_600_000,
  updatedAt: now - 60_000,
  updatedBy: "dot",
});
const feedItem = (id: number, title: string) => ({
  id,
  source: "github",
  reason: "Mentioned",
  title,
  context: "acme/app",
  url: null,
  time: now - id * 1000,
  handedTo: null as string[] | null,
});

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** The daemon's other surfaces: feed, memory, instructions, Library, health, Slack and fresh. */
const surfaces = () => ({
  feed: [feedItem(1, "Fix the build"), feedItem(2, "Review the docs"), feedItem(3, "Ship it")],
  // Items a saved reply handed off, as the daemon moves them.
  handedOff: [] as ReturnType<typeof feedItem>[],
  // While set, each memory change waits for it.
  memoryHold: undefined as Promise<void> | undefined,
  // The owner's facts, shared by every dot: one pending suggestion from jojo to start with.
  owner: {
    facts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        text: "Prefers <b>tea</b> [link](https://evil.example)",
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        origin: { dot: "jojo", sessionID: "ses_jojo", messageID: "msg_suggest" },
        lastMutationID: null as string | null,
      },
    ],
    // While set, each owner fact change waits for it.
    hold: undefined as Promise<void> | undefined,
    // The next change is saved but answered with a body that isn't a fact.
    garbleOnce: false,
  },
  // The next instructions save answers 200 with a body that isn't instructions.
  malformedOnce: false,
  memory: {
    notes: [{ ...versioned(1), text: "Likes tea", source: null }],
    responsibilities: [
      {
        ...versioned(2, 3),
        goal: "Ship v1",
        nextAction: "Write docs",
        status: "active",
        schedule: { kind: "interval", everyMinutes: 60 },
        nextRunAt: now + 3_600_000,
      },
    ],
    reminders: [
      {
        ...versioned(3),
        text: "Stand up",
        dueAt: now + 86_400_000,
        everyMinutes: null,
        state: "pending",
      },
    ],
    observations: [
      {
        ...versioned(4),
        kind: "fact",
        topic: "tea",
        text: "Prefers green tea",
        priority: 1,
        sessionID: "ses_jojo",
        sources: [
          {
            messageID: "msg_a",
            sessionID: "ses_jojo",
            from: "owner",
            date: "2026-10-01",
            excerpt: "I like green tea",
          },
        ],
      },
    ],
    observationsNext: null,
    supervisions: [
      {
        id: 5,
        sessionID: "ses_w",
        directory: "/tmp/w",
        mode: "watch",
        state: "requested",
        busyMinutes: 30,
        createdAt: now - 60_000,
        activatedAt: null,
      },
    ],
    grants: [
      {
        id: 6,
        operation: "merge",
        summary: "merge acme/app",
        expiresAt: now + 7_200_000,
        createdAt: now,
      },
    ],
    triggers: [
      {
        id: 7,
        responsibility: 2,
        sessionID: "ses_jojo",
        repository: "acme/app",
        reasons: ["Mentioned"],
        task: "Look at it",
        revision: "a".repeat(64),
        state: "draft",
        createdAt: now,
        confirmedAt: null,
        baselineAt: null,
        lastWake: null,
        baselined: 0,
        skippedCount: 0,
        skipped: [],
      },
    ],
  },
  instructions: { content: "# jojo\n", revision: "1".repeat(64), canRevert: false },
  // A save of this content is refused once, as if the file changed meanwhile.
  instructionsConflict: {
    content: "# jojo\nFrom disk.\n",
    revision: "2".repeat(64),
    canRevert: true,
  },
  conflictOnce: true,
  noteConflictOnce: true,
  freshBusyOnce: true,
  slack: {
    config: { state: "ready", problem: null, saved: true },
    login: { state: "ready", team: "Acme" },
    manifestLink: "https://api.slack.com/apps?new_app=1",
    app: {
      state: "created",
      appID: "AJOJO01",
      botUser: null,
      problem: null,
      install: null,
      manifestOutdated: false,
      updateState: null,
      updateNote: null,
      icon: null,
    },
  },
  library: [
    {
      id: 9,
      name: "report.md",
      mime: "text/markdown",
      size: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      createdAt: now,
      worker: 1,
      status: "present",
    },
  ],
  calls: [] as Call[],
  // Request cards waiting for the owner, and the answers the app posted.
  requests: [] as ReturnType<typeof requestCard>[],
  answers: [] as { id: number; body: unknown }[],
  opened: [] as number[],
});

const requestCard = (id: number, change: Record<string, unknown> = {}) => ({
  id,
  dot: "jojo",
  boundSessionID: "ses_jojo",
  source: "dot",
  worker: null as number | null,
  sessionID: "ses_jojo",
  title: "jojo",
  directory: "/dots/jojo",
  kind: "permission",
  requestID: `per_${id}`,
  detail: {
    kind: "permission",
    action: "bash",
    resources: ["<b>rm -rf build</b>"],
    save: ["rm *"],
  } as Record<string, unknown>,
  sensitive: false,
  state: "escalated",
  reason: null,
  needsYou: true,
  revision: `rev_${id}`,
  actionable: true,
  attempt: null,
  createdAt: now,
  escalatedAt: now,
  ...change,
});

const worker = (id: number, state: string, needs: string[] = []) => ({
  id,
  state,
  outcome: null,
  task: `Task ${id}`,
  needs,
  waiting: [],
  answered: null,
});

const sign = (token: string, body: string) =>
  createHmac("sha256", token).update(body).digest("base64url");
const signedMore = "<signed>";
/** A work cursor in the daemon's form: its scope and position, signed with the server's token. */
const signWork = (token: string, sessionID: string, upstream: string) => {
  const position = JSON.stringify({ q: [], c: upstream, p: false });
  const body = Buffer.from(JSON.stringify(["jojo", sessionID, `work:${position}`])).toString(
    "base64url",
  );
  return `${body}.${sign(token, body)}`;
};

/**
 * A fake daemon with the API the app uses. Restarting it serves the same state on a new port with
 * a new token, and its cursors name the server that signed them, so an old one is refused.
 */
class FakeDaemon {
  messages: FakeMessage[] = [];
  sessionID = "ses_jojo";
  hidden = new Set<string>();
  reactions = new Map<string, string>();
  pending: { id: string; status: string; delivery: string | null }[] = [];
  receipts = new Map<string, string>();
  failing = new Set<string>();
  workers: object[] = [];
  busy = false;
  // The work log the latest page carries, the activity it reports and each call's detail.
  work: object[] = [];
  activity: object | null = null;
  details = new Map<string, object>();
  // A work log whose `more` is this placeholder gets a cursor signed like the daemon's, naming
  // `continuation`; a work read with it answers `earlier`.
  continuation = "";
  earlier: object | null = null;
  // Each listed media's bytes, by its ID.
  media = new Map<string, Uint8Array>();
  // jojo's avatar: its listed revision, and how many reads of it fail before one answers.
  avatar: { revision: string; failures: number } | null = null;
  avatarReads = 0;
  capable = true;
  mismatch = false;
  pageDelay = 0;
  olderDelay = 0;
  failOlder = false;
  failReceipts = false;
  emptyPages = 0;
  stallNext = false;
  stalled = 0;
  stalledDone = 0;
  // Answers the stalled read, with the state it had when it arrived.
  release: (() => void) | undefined;
  // While set, every other message read waits for it.
  hold: Promise<void> | undefined;
  // While set, every receipt read waits for it.
  receiptHold: Promise<void> | undefined;
  // While set, each latest-page read waits for its own release, in `gated`.
  gate = false;
  gated: (() => void)[] = [];
  // While set, every read of one message waits for it; `pinnedOut` counts those out now.
  pinnedHold: Promise<void> | undefined;
  pinnedOut = 0;
  maxPinnedOut = 0;
  // Other dots, listed after jojo, whose latest page waits for their own hold.
  others = new Map<
    string,
    { messages: FakeMessage[]; hold: Promise<void> | undefined; reads: number }
  >();
  onPost: ((body: Post) => Response | Promise<Response> | undefined) | undefined;
  onPut: ((id: string, part: string) => Response | Promise<Response> | undefined) | undefined;
  index = 0;
  server: ReturnType<typeof Bun.serve> | undefined;
  log = {
    posts: [] as Post[],
    puts: [] as { id: string; part: string; body: Record<string, unknown> }[],
    stops: [] as number[],
    staleCursors: 0,
    olderReads: 0,
    latestReads: 0,
    receipts: 0,
    dotReads: 0,
    activityReads: 0,
    toolReads: [] as string[],
    // The length of each work cursor read.
    workReads: [] as number[],
    mediaReads: [] as string[],
    // Requests each server instance got, by its number.
    requests: [] as number[],
  };

  constructor(readonly home: string) {}

  start() {
    const index = ++this.index;
    const token = `token-${index}-${crypto.randomUUID()}`;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request, index, token),
    });
    writeFileSync(
      join(this.home, "api.json"),
      JSON.stringify({ url: `http://127.0.0.1:${this.server.port}`, token }),
      { mode: 0o600 },
    );
  }

  stop() {
    void this.server?.stop(true);
  }

  restart() {
    this.stop();
    this.start();
  }

  deliver(id: string, text: string) {
    this.pending = this.pending.filter((item) => item.id !== id);
    this.messages.push({ id, kind: "owner", text });
    this.receipts.set(id, "delivered");
  }

  view(message: FakeMessage, index: number) {
    const emoji = this.reactions.get(message.id);
    return {
      id: message.id,
      sessionID: this.sessionID,
      kind: message.kind,
      hidden: this.hidden.has(message.id),
      text: message.text,
      tools: [],
      attachments: (message.attachments ?? []).map((item, at) => ({ index: at, ...item })),
      time: 1_700_000_000_000 + index * 60_000,
      reactions: emoji ? [{ actor: "owner", emoji, updatedAt: 1 }] : [],
      ...message.extra,
    };
  }

  async handle(request: Request, index: number, token: string): Promise<Response> {
    this.log.requests[index] = (this.log.requests[index] ?? 0) + 1;
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (path === "/dots") {
      this.log.dotReads++;
      return Response.json([
        {
          name: "jojo",
          purpose: "Second brain.",
          busy: this.busy,
          avatar: this.avatar ? { revision: this.avatar.revision } : null,
          workers: this.workers,
          sessions: [],
        },
        ...[...this.others.keys()].map((name) => ({
          name,
          purpose: "Another dot.",
          busy: false,
          avatar: null,
          workers: [],
          sessions: [],
        })),
      ]);
    }
    if (path === "/dots/jojo/avatar") {
      this.avatarReads++;
      if (!this.avatar) return json({ error: "No avatar." }, 404);
      if (this.avatar.failures > 0) {
        this.avatar.failures--;
        return json({ error: "Try again." }, 500);
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    const other = /^\/dots\/([^/]+)\/messages$/.exec(path)?.[1];
    const dot = other ? this.others.get(other) : undefined;
    if (dot && method === "GET") {
      dot.reads++;
      await dot.hold;
      return Response.json({
        messages: dot.messages.map((item, at) => ({
          ...this.view(item, at),
          sessionID: `ses_${other}`,
        })),
        sessionID: `ses_${other}`,
        next: null,
        pending: [],
        recentEmojis: [],
        clientMessageIDs: true,
      });
    }
    if (path === "/dots/jojo/messages" && method === "GET") {
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      let end = this.messages.length;
      // Pages before the latest that a run of tool calls left without a visible message.
      let empty = this.emptyPages;
      if (before !== null) {
        const cursor = /^c\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(before);
        if (!cursor || Number(cursor[1]) !== index) {
          if (cursor) this.log.staleCursors++;
          return Response.json({ error: "Invalid conversation cursor. Refresh." }, { status: 400 });
        }
        end = Number(cursor[2]);
        empty = Number(cursor[3] ?? 0);
        this.log.olderReads++;
        // Whether it fails is decided when it arrives, and answered after the delay.
        const failing = this.failOlder;
        await delay(this.olderDelay);
        if (failing)
          return Response.json({ error: "Invalid conversation cursor. Refresh." }, { status: 400 });
      }
      if (empty > 0)
        return Response.json({
          messages: [],
          sessionID: this.sessionID,
          next: `c.${index}.${end}.${empty - 1}`,
          pending: [...this.pending],
          recentEmojis: [],
          clientMessageIDs: true,
        });
      const start = Math.max(0, end - limit);
      const page = {
        messages: this.messages.slice(start, end).map((item, at) => this.view(item, start + at)),
        sessionID: this.sessionID,
        next: start > 0 ? `c.${index}.${start}` : null,
        pending: [...this.pending],
        recentEmojis: [],
        ...(this.capable ? { clientMessageIDs: true } : {}),
        ...(before === null
          ? {
              work: this.work.map((log) =>
                "more" in log && log.more === signedMore
                  ? { ...log, more: signWork(token, this.sessionID, this.continuation) }
                  : log,
              ),
            }
          : {}),
      };
      if (before === null && this.stallNext) {
        // A read that started before the owner's change answers after it, with the old state.
        this.stallNext = false;
        this.stalled++;
        await new Promise<void>((done) => {
          this.release = done;
        });
        this.stalledDone++;
      } else if (before === null) {
        this.log.latestReads++;
        if (this.gate) await new Promise<void>((done) => this.gated.push(done));
        await this.hold;
        await delay(this.pageDelay);
      }
      return Response.json(page);
    }
    if (path === "/dots/jojo/messages" && method === "POST") {
      const body = (await request.json()) as Post & { files?: unknown[] };
      const post = {
        server: index,
        messageID: body.messageID,
        text: body.text,
        files: body.files?.length ?? 0,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.feed ? { feed: body.feed } : {}),
      };
      this.log.posts.push(post);
      const hook = this.onPost?.(post);
      if (hook) return hook;
      const id =
        this.capable && !this.mismatch ? body.messageID : `msg_server${this.log.posts.length}`;
      // As the daemon does: a saved reply hands its feed item off to the dot.
      const item = post.feed ? this.data.feed.find((row) => row.id === post.feed) : undefined;
      if (item) {
        this.data.feed = this.data.feed.filter((row) => row !== item);
        this.data.handedOff.push({ ...item, handedTo: ["jojo"] });
      }
      this.receipts.set(id, "sent");
      this.pending.push({ id, status: "sent", delivery: "queue" });
      return Response.json({ id }, { status: 202 });
    }
    const receipt = /^\/dots\/jojo\/pending\/([^/]+)$/.exec(path);
    if (receipt?.[1] && method === "GET" && this.capable) {
      this.log.receipts++;
      await this.receiptHold;
      if (this.failReceipts) return Response.json({ error: "Not now." }, { status: 503 });
      const status = this.receipts.get(receipt[1]) ?? "unknown";
      return Response.json({ id: receipt[1], sessionID: this.sessionID, status });
    }
    if (receipt?.[1] && (method === "PATCH" || method === "DELETE"))
      return Response.json({ pending: null });
    if (path === "/dots/jojo/activity" && method === "GET") {
      this.log.activityReads++;
      return this.activity
        ? Response.json({ ...this.activity, sessionID: url.searchParams.get("sessionID") })
        : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (path === "/dots/jojo/work" && method === "GET") {
      const cursor = url.searchParams.get("cursor") ?? "";
      this.log.workReads.push(cursor.length);
      const [body = "", signature] = cursor.split(".");
      return signature === sign(token, body) && this.earlier
        ? Response.json(this.earlier)
        : Response.json({ error: "Invalid work cursor. Refresh." }, { status: 400 });
    }
    const remote = /^\/dots\/jojo\/messages\/([^/]+)\/media\/([^/]+)$/.exec(path);
    if (remote && method === "GET") {
      this.log.mediaReads.push(`${remote[1]}/${remote[2]}`);
      const bytes = this.media.get(remote[2] ?? "");
      return bytes
        ? new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/octet-stream" },
          })
        : Response.json({ error: "No." }, { status: 404 });
    }
    const tool = /^\/dots\/jojo\/messages\/([^/]+)\/tools\/([^/]+)$/.exec(path);
    if (tool && method === "GET") {
      this.log.toolReads.push(`${tool[1]}/${tool[2]}`);
      const detail = this.details.get(`${tool[1]}/${tool[2]}`);
      return detail ? Response.json(detail) : Response.json({ error: "No." }, { status: 404 });
    }
    const single =
      /^\/dots\/jojo\/messages\/([^/]+)(?:\/(reaction|hidden|attachments\/(\d+)))?$/.exec(path);
    const id = single?.[1];
    const at = id ? this.messages.findIndex((item) => item.id === id) : -1;
    const found = this.messages[at];
    if (id && !found) return Response.json({ error: "No such message." }, { status: 404 });
    if (id && found && !single?.[2] && method === "GET") {
      if (this.pinnedHold) {
        this.maxPinnedOut = Math.max(this.maxPinnedOut, ++this.pinnedOut);
        await this.pinnedHold;
        this.pinnedOut--;
      }
      await this.hold;
      return Response.json(this.view(found, at));
    }
    if (id && single?.[2] && method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      this.log.puts.push({ id, part: single[2], body });
      const hook = this.onPut?.(id, single[2]);
      if (hook) return hook;
      if (single[2] === "reaction") {
        if (typeof body.emoji === "string") this.reactions.set(id, body.emoji);
        else this.reactions.delete(id);
      } else if (body.hidden === true) this.hidden.add(id);
      else this.hidden.delete(id);
      return Response.json({ ok: true });
    }
    if (id && single?.[3] !== undefined && method === "GET") {
      if (this.failing.has(`${id}:${single[3]}`))
        return Response.json({ error: "Gone." }, { status: 500 });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    const workerStop = /^\/workers\/(\d+)\/stop$/.exec(path);
    if (workerStop?.[1] && method === "POST") {
      this.log.stops.push(Number(workerStop[1]));
      return Response.json({ ok: true });
    }
    if (/^\/workers\/\d+\/open$/.test(path)) return Response.json({ opened: true });
    return this.surface(method, path, url, request);
  }

  data = surfaces();

  async surface(method: string, path: string, url: URL, request: Request): Promise<Response> {
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : null;
    const call = { method, path: path + url.search, body };
    const d = this.data;
    const memory = d.memory;
    const mutation = method !== "GET";
    if (mutation) d.calls.push(call);
    const owner = d.owner;
    if (path === "/owner/memory")
      return json({
        pending: owner.facts.filter((fact) => fact.state === "pending"),
        approved: owner.facts.filter((fact) => fact.state === "approved"),
        removed: owner.facts.filter(
          (fact) => fact.state === "rejected" || fact.state === "deleted",
        ),
        entryBytes: 120,
        entryLimit: 8192,
      });
    const factID = /^\/owner\/facts\/([0-9a-f-]{36})$/.exec(path)?.[1];
    if (factID) {
      if (mutation) await owner.hold;
      const fact = owner.facts.find((known) => known.id === factID);
      if (method === "GET")
        return fact ? json({ fact }) : json({ error: "There's no such fact." }, 404);
      const given = (body ?? {}) as {
        version?: number;
        text?: string;
        action?: string;
        mutationID?: string;
      };
      const version = method === "DELETE" ? Number(url.searchParams.get("version")) : given.version;
      const mutationID =
        method === "DELETE" ? url.searchParams.get("mutationID") : (given.mutationID ?? null);
      let saved: (typeof owner.facts)[number];
      if (method === "PUT") {
        if (fact) return json({ error: "Exists.", current: fact }, 409);
        saved = {
          id: factID,
          state: "approved",
          text: given.text ?? "",
          version: 1,
          createdAt: 2,
          updatedAt: 2,
          origin: null as never,
          lastMutationID: mutationID,
        };
        owner.facts.push(saved);
      } else {
        if (!fact) return json({ error: "There's no such fact." }, 404);
        if (fact.version !== version)
          return json({ error: "This fact changed since you loaded it.", current: fact }, 409);
        const action = method === "DELETE" ? "delete" : given.action;
        Object.assign(fact, {
          state: action === "reject" ? "rejected" : action === "delete" ? "deleted" : "approved",
          text: action === "reject" || action === "delete" ? null : (given.text ?? fact.text),
          version: fact.version + 1,
          lastMutationID: mutationID,
        });
        saved = fact;
      }
      if (owner.garbleOnce) {
        owner.garbleOnce = false;
        return json({ ok: true });
      }
      return json({ fact: saved });
    }
    if (path === "/requests/pending")
      return json({
        requests: d.requests.filter(
          (card) => !url.searchParams.get("dot") || card.dot === url.searchParams.get("dot"),
        ),
        next: null,
      });
    const opening = /^\/requests\/(\d+)\/open$/.exec(path)?.[1];
    if (opening && method === "POST") {
      d.opened.push(Number(opening));
      return json({ opened: true });
    }
    const answering = /^\/dots\/\w+\/requests\/(\d+)\/answer$/.exec(path)?.[1];
    if (answering && method === "POST") {
      // As the daemon does: the answer is queued, and the card leaves the owner's list.
      const card = d.requests.find((item) => item.id === Number(answering));
      if (!card) return json({ error: "There's no such request." }, 404);
      d.answers.push({ id: card.id, body });
      d.requests = d.requests.filter((item) => item !== card);
      const attemptID = (body as { attemptID: string }).attemptID;
      return json(
        {
          attemptID,
          request: { ...card, state: "queued", actionable: false },
          attempts: [{ id: attemptID, actor: "owner", state: "queued", queuedAt: now }],
        },
        202,
      );
    }
    if (path === "/feed") return json({ items: d.feed, remaining: 0, handedOff: d.handedOff });
    if (path === "/feed/dismiss") {
      const ids = (body as { ids: number[] }).ids;
      d.feed = d.feed.filter((item) => !ids.includes(item.id));
      return json({ dismissed: ids, missing: [] });
    }
    const dismissed = /^\/feed\/(\d+)\/dismiss$/.exec(path)?.[1];
    if (dismissed) {
      d.feed = d.feed.filter((item) => item.id !== Number(dismissed));
      return json({ ok: true });
    }
    if (path === "/health")
      return json({
        schemaVersion: 1,
        checkedAt: now,
        checks: [{ id: "daemon", status: "healthy", summary: "Running." }],
      });
    if (path === "/dots/jojo/usage")
      return json({
        days: [
          {
            day: new Date(now).setHours(0, 0, 0, 0),
            steps: 4,
            input: 40,
            output: 900,
            reasoning: 0,
            cacheRead: 146_400,
            cacheWrite: 440_000,
            hitPercent: 25,
          },
        ],
        counting: true,
        streak: 3,
        alarm: true,
      });
    if (path === "/dots/jojo/memory") return json(memory);
    if (path === "/dots/jojo/memory/archive" && method === "GET")
      return json({
        archive: true,
        observerStatus: {
          budget: 1,
          spentToday: 0,
          stoppedToday: false,
          budgetNote: "Daily budget note.",
        },
      });
    if (path === "/dots/jojo/memory/recall")
      return json({
        query: url.searchParams.get("q"),
        archive: true,
        results: [
          {
            kind: "message",
            message: "msg_a",
            sessionID: "ses_jojo",
            from: "owner",
            date: "2026-10-01",
            snippet: "I like green tea",
          },
        ],
        next: null,
      });
    if (mutation && path.startsWith("/dots/jojo/memory/")) await d.memoryHold;
    if (path === "/dots/jojo/memory/search")
      return json({
        query: url.searchParams.get("q"),
        results: memory.notes
          .filter((note) => note.text.toLowerCase().includes(url.searchParams.get("q") ?? ""))
          .map(({ text: noteText, ...note }) => ({ ...note, snippet: noteText })),
        more: false,
      });
    if (path === "/dots/jojo/memory/notes/1" && method === "PATCH") {
      // A version other than the note's now is refused with the note as it is.
      const note = memory.notes[0];
      if (note && (body as { version: number }).version !== note.version)
        return json({ error: "Changed since you loaded it.", current: note }, 409);
      if (d.noteConflictOnce) {
        d.noteConflictOnce = false;
        const current = { ...memory.notes[0], version: 2, text: "Likes coffee" };
        memory.notes = [current as (typeof memory.notes)[number]];
        return json({ error: "Changed since you loaded it.", current }, 409);
      }
      const saved = {
        ...note,
        version: (note?.version ?? 0) + 1,
        text: (body as { text: string }).text,
      };
      memory.notes = [saved as (typeof memory.notes)[number]];
      return json(saved);
    }
    if (path === "/dots/jojo/requests")
      return json(
        url.searchParams.get("before")
          ? {
              requests: [
                {
                  id: 1,
                  source: "worker",
                  worker: 1,
                  sessionID: "s",
                  title: "Older ask",
                  kind: "permission",
                  requestID: "r1",
                  detailText: "detail",
                  answerText: null,
                  state: "answered",
                  needsYou: false,
                  createdAt: now,
                },
              ],
              next: null,
            }
          : {
              requests: [
                {
                  id: 2,
                  source: "worker",
                  worker: 1,
                  sessionID: "s",
                  title: "Newer ask",
                  kind: "question",
                  requestID: "r2",
                  detailText: "detail",
                  answerText: "yes",
                  state: "answered",
                  needsYou: false,
                  createdAt: now,
                },
              ],
              next: 2,
            },
      );
    if (path.startsWith("/dots/jojo/memory/") && mutation) return json({ ok: true });
    if (path === "/dots/jojo/instructions" && method === "GET") return json(d.instructions);
    if (path === "/dots/jojo/instructions" && method === "PUT") {
      const { content, revision } = body as { content: string; revision: string };
      if (d.malformedOnce) {
        d.malformedOnce = false;
        return json({});
      }
      if (d.conflictOnce) {
        d.conflictOnce = false;
        d.instructions = d.instructionsConflict;
        return json({ error: "Changed.", current: d.instructions }, 409);
      }
      if (revision !== d.instructions.revision)
        return json({ error: "Changed.", current: d.instructions }, 409);
      d.instructions = {
        content,
        revision: String(d.calls.length + 3).repeat(64),
        canRevert: true,
      };
      return json(d.instructions);
    }
    if (path === "/dots/jojo/library") return json({ artifacts: d.library, next: null });
    if (/^\/dots\/jojo\/library\/9\/content$/.test(path))
      return new Response("hello", { headers: { "content-type": "text/markdown" } });
    if (path === "/dots/jojo/slack" && method === "GET") return json(d.slack);
    if (path.startsWith("/dots/jojo/slack/") || path.startsWith("/slack/")) return json(d.slack);
    if (path === "/dots/jojo/fresh") {
      if (d.freshBusyOnce && !(body as { force?: boolean }).force) {
        d.freshBusyOnce = false;
        return json({ error: "jojo is in the middle of a turn." }, 409);
      }
      this.sessionID = "ses_fresh";
      this.messages = [];
      return json({ name: "jojo", sessionID: "ses_fresh", previousSessionID: "ses_jojo" }, 201);
    }
    return json({ error: "Not found" }, 404);
  }
}

// Helpers the tests call in the page, as `t.<name>`.
const prelude = `window.t = {
  list: () => document.querySelector("[data-messages]"),
  msg: (id) => document.querySelector('[data-message="' + id + '"]'),
  count: () => Number(document.querySelector("[data-messages]")?.dataset.count ?? 0),
  box: () => document.querySelector("textarea"),
  type(text) {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(t.box(), text);
    t.box().dispatchEvent(new Event("input", { bubbles: true }));
  },
  enter() {
    t.box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  },
  button(text, scope = document) {
    return [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  },
  click(text, scope = document) {
    const button = t.button(text, scope);
    if (!button) throw new Error("No button " + text);
    button.click();
    return true;
  },
  menu(id) {
    const more = t.msg(id).querySelector("button.more");
    more.focus();
    more.click();
    return true;
  },
  key(key) {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  },
  cmd(key) {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true }));
  },
  fill(selector, text) {
    const field = document.querySelector(selector);
    if (!field) throw new Error("No field " + selector);
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  scroll(top) {
    t.list().scrollTop = top;
    t.list().dispatchEvent(new Event("scroll"));
  },
  top(id) {
    return t.msg(id).getBoundingClientRect().top - t.list().getBoundingClientRect().top;
  },
  paste(name) {
    const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type: "image/png" }));
    t.box().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  },
};
true`;

interface Recorded {
  show: number;
  focus: number;
  remote: string[];
  local: number;
  emojiPanel: number;
  openExternal: string[];
  clipboard: { text?: string; images?: number }[];
  shares: { texts: number; files: number; directory: string }[];
}

interface State {
  recorded: Recorded;
  // The send records on disk, and those still open to reconcile.
  attempts: { messageID: string }[];
  open: { messageID: string }[];
  violations: string[];
  errors: string[];
}

/** Starts the hidden app against a fake daemon, with temporary HOME, TMPDIR and app data. */
const launch = async (
  name: string,
  setup: (fake: FakeDaemon) => void,
  env: Record<string, string> = {},
) => {
  const home = join(scratch, name);
  const opendot = join(home, "opendot");
  const temporary = join(home, "tmp");
  mkdirSync(opendot, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  const fake = new FakeDaemon(opendot);
  setup(fake);
  fake.start();
  const app = Bun.spawn([electron as unknown as string, join(root, "build")], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temporary,
      OPEN_DOT_HOME: opendot,
      OPEN_DOT_APP_DATA: join(home, "app-data"),
      OPEN_DOT_APP_SMOKE: "1",
      // Never the owner's OpenCode: main runs only an absolute fake a test names here.
      OPEN_DOT_OPENCODE: "",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiting = new Map<
    number,
    (answer: { ok: boolean; value?: unknown; error?: string }) => void
  >();
  const { promise: started, resolve: ready } = Promise.withResolvers<void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of app.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.startsWith("SMOKE ")) continue;
        const answer = JSON.parse(line.slice(6)) as { id?: number; ready?: boolean; ok: boolean };
        if (answer.ready) ready();
        else if (answer.id !== undefined) waiting.get(answer.id)?.(answer);
      }
    }
  })();
  let next = 0;
  const call = (command: object) =>
    new Promise<unknown>((done, fail) => {
      const id = ++next;
      waiting.set(id, (answer) =>
        answer.ok
          ? done(answer.value)
          : fail(
              new Error(`${answer.error ?? "failed"} in ${JSON.stringify(command).slice(0, 300)}`),
            ),
      );
      void app.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      void app.stdin.flush();
    });
  const killer = setTimeout(() => app.kill(), 170_000);
  await Promise.race([
    started,
    delay(30_000).then(() => {
      throw new Error("The app didn't start.");
    }),
  ]);
  const js = (code: string) => call({ eval: code });
  await js(prelude);
  const until = async (code: string, label: string, seconds = 20) => {
    for (let tick = 0; tick < seconds * 10; tick++) {
      if ((await js(code).catch(() => false)) === true) return;
      await delay(100);
    }
    const page = await js(`document.body.innerText.slice(0, 800)`).catch(String);
    throw new Error(`Timed out waiting for ${label}. Page: ${String(page)}`);
  };
  const state = () => call({}) as Promise<State>;
  /** Clicks the button labelled `label` inside `scope` once it renders. */
  const press = async (scope: string, label: string) => {
    const find = `t.button(${JSON.stringify(label)}, document.querySelector(${JSON.stringify(scope)}) ?? document.createElement("div"))`;
    await until(`!!${find} && !${find}.disabled`, `${label} in ${scope}`);
    await js(`${find}.click(), true`);
  };
  /** Opens a message's actions menu from its button, and picks `label` if given. */
  const menu = async (id: string, label?: string) => {
    await until(`!document.querySelector("[role=menu]")`, "the last menu to close");
    await js(`t.menu(${JSON.stringify(id)})`);
    await until(`!!document.querySelector("[role=menu]")`, `the menu of ${id}`);
    if (label) await press("[role=menu]", label);
  };
  /** Waits until the fake's current server answered something, so the app found it. */
  const found = async () => {
    for (let tick = 0; tick < 100 && !fake.log.requests[fake.index]; tick++) await delay(100);
  };
  const close = async () => {
    void call({ quit: true }).catch(() => {});
    await Promise.race([app.exited, delay(10_000)]);
    app.kill();
    clearTimeout(killer);
    fake.stop();
  };
  /** Tells the page its window was shown, as the tray and shortcut do, without showing it. */
  const shown = () => call({ emit: "shown" });
  /** A copy to main's fake clipboard, never the owner's. */
  const clipboard = (text: string) => call({ clipboard: text });
  return {
    fake,
    js,
    until,
    state,
    press,
    menu,
    found,
    close,
    temporary,
    shown,
    clipboard,
    command: call,
  };
};

type App = Awaited<ReturnType<typeof launch>>;

/** Runs a scenario and always closes the app; nothing may show or focus its window. */
const scenario = async (
  name: string,
  setup: (fake: FakeDaemon) => void,
  run: (app: App) => Promise<void>,
  env: Record<string, string> = {},
) => {
  const app = await launch(name, setup, env);
  try {
    await run(app);
    const { recorded, violations } = await app.state();
    expect(recorded.show).toBe(0);
    expect(recorded.focus).toBe(0);
    // The page never asks the network for anything: remote media come only as blobs from main.
    expect(recorded.remote).toEqual([]);
    expect(recorded.local).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  } finally {
    await app.close();
  }
  return app;
};

const sample = [
  "# Plan",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "- [x] done",
  "- [ ] next",
  "",
  "Inline $x^2$ and a [site](https://example.com) and [bad](javascript:alert(1)).",
  "",
  "$$",
  "\\int_0^1 x\\,dx",
  "$$",
  "",
  "![remote](https://example.com/tracker.png)",
  "",
  "<script>alert(1)</script><iframe src=x></iframe>",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
  "```diff",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "```",
].join("\n");

const toolCall = (
  callID: string,
  name: string,
  label: string,
  status: string,
  files: object[] = [],
) => ({
  messageID: "msg_work",
  callID,
  name,
  status,
  startedAt: 1,
  endedAt: status === "running" ? null : 2,
  label,
  files,
});

test("a busy dot shows what it is doing, and its turn's calls fold under its reply", async () => {
  await scenario(
    "work",
    (fake) => {
      fake.busy = true;
      fake.messages = [
        { id: "msg_owner", kind: "owner", text: "Fix it" },
        {
          id: "msg_reply",
          kind: "dot",
          text: "first line\nsecond line\n\n> [!WARNING]\n> Careful\n\n![chart](https://media.example/chart.png)\n\nhttps://media.example/clip.webm\n\nhttps://media.example/broken.mp4",
          extra: {
            media: [
              { id: "aaaaaaaaaaaaaaaa", url: "https://media.example/chart.png", kind: "image" },
              { id: "bbbbbbbbbbbbbbbb", url: "https://media.example/clip.webm", kind: "video" },
              { id: "cccccccccccccccc", url: "https://media.example/broken.mp4", kind: "video" },
            ],
          },
        },
      ];
      fake.work = [
        {
          anchor: "msg_reply",
          calls: [
            toolCall("c1", "bash", "bun test", "done"),
            toolCall("c2", "edit", "src/a.ts", "done", [
              { path: "src/a.ts", additions: 2, deletions: 1 },
            ]),
            toolCall("c3", "bash", "false", "error"),
          ],
          counts: { commands: 2, edits: 1, edited: 1, failed: 1, total: 3 },
          complete: true,
          open: false,
          more: null,
        },
      ];
      fake.media.set("aaaaaaaaaaaaaaaa", png);
      fake.media.set("bbbbbbbbbbbbbbbb", webm);
      // Passes the type check by its header, but no browser can play it.
      fake.media.set(
        "cccccccccccccccc",
        new Uint8Array([
          0,
          0,
          0,
          24,
          ...new TextEncoder().encode("ftypisom"),
          ...new Uint8Array(12),
        ]),
      );
      fake.activity = {
        state: "tool",
        tool: "bash",
        label: "bun run check",
        running: 1,
        since: Date.now() - 65_000,
        observedAt: Date.now(),
      };
      fake.details.set("msg_work/c2", {
        ...toolCall("c2", "edit", "src/a.ts", "done", [
          { path: "src/a.ts", additions: 2, deletions: 1 },
        ]),
        input: '{ "path": "src/a.ts" }',
        output: Array.from({ length: 30 }, (_, index) => `out ${index}`).join("\n"),
        error: null,
        patches: [
          {
            path: "src/a.ts",
            additions: 2,
            deletions: 1,
            patch:
              "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n",
          },
        ],
        truncated: false,
      });
    },
    async ({ fake, js, until }) => {
      await until(`!!document.querySelector("[data-work-log='msg_reply']")`, "the work log");
      await until(
        `(document.querySelector("[data-activity]")?.textContent ?? "").includes("bun run check")`,
        "the activity line",
      );
      expect(
        await js(`(() => {
          const log = document.querySelector("[data-work-log='msg_reply']");
          const activity = document.querySelector("[data-activity]");
          const reply = t.msg("msg_reply");
          return {
            summary: log.querySelector(".work-summary").textContent,
            collapsed: !log.querySelector("[data-tool-call]"),
            underReply: reply.contains(log),
            activity: activity.textContent,
            breaks: !!reply.querySelector(".markdown p br"),
            alert: !!reply.querySelector("blockquote.markdown-alert-warning .markdown-alert-title"),
          };
        })()`),
      ).toEqual({
        summary: "▸ Ran 2 commands, edited 1 file, 1 failed",
        collapsed: true,
        underReply: true,
        activity: expect.stringMatching(/^jojo is running bash: bun run check · 1:0\d$/),
        breaks: true,
        alert: true,
      });
      await js(`document.querySelector("[data-work-log='msg_reply'] .work-summary").click(), true`);
      await until(`document.querySelectorAll("[data-tool-call]").length === 3`, "the calls");
      expect(
        await js(
          `[...document.querySelectorAll("[data-tool-call]")].map((row) => row.querySelector(".tool-call-head").textContent)`,
        ),
      ).toEqual(["$bashbun testDone", "✎editsrc/a.tssrc/a.ts +2 −1Done", "$bashfalseError"]);
      await js(`document.querySelector("[data-tool-call='c2'] .tool-call-head").click(), true`);
      await until(
        `!!document.querySelector("[data-tool-call='c2'] .diff .diff-add")`,
        "the edit's diff",
      );
      expect(
        await js(`(() => {
          const row = document.querySelector("[data-tool-call='c2']");
          return {
            output: row.querySelectorAll(".tool-text pre")[1].textContent.split("\\n").length,
            more: [...row.querySelectorAll(".link-button")].map((b) => b.textContent),
          };
        })()`),
      ).toEqual({ output: 20, more: ["Show more (10 more lines)"] });
      expect(fake.log.toolReads).toEqual(["msg_work/c2"]);
      // The reply's listed image and video load as blobs through main; the image opens the viewer.
      await until(
        `!!document.querySelector("[data-message='msg_reply'] .remote-image img[src^='blob:']") && !!document.querySelector("[data-message='msg_reply'] video[data-media='bbbbbbbbbbbbbbbb']")`,
        "the reply's media",
      );
      // The real video decodes; the one only its header passed falls back to its link.
      await until(
        `document.querySelector("video[data-media='bbbbbbbbbbbbbbbb']").readyState >= 1`,
        "the video's metadata",
      );
      expect(
        await js(`(() => {
          const video = document.querySelector("video[data-media='bbbbbbbbbbbbbbbb']");
          return [video.videoWidth, video.videoHeight];
        })()`),
      ).toEqual([16, 16]);
      await until(
        `!!document.querySelector("[data-media='cccccccccccccccc'][data-failed] a[href='https://media.example/broken.mp4']")`,
        "the broken video's link",
      );
      expect(
        await js(`(() => {
          const video = document.querySelector("[data-message='msg_reply'] video");
          return {
            controls: video.controls,
            muted: video.muted,
            autoplay: video.autoplay || video.hasAttribute("autoplay"),
            preload: video.getAttribute("preload"),
            label: document.querySelector(".remote-image").getAttribute("aria-label"),
          };
        })()`),
      ).toEqual({
        controls: true,
        muted: true,
        autoplay: false,
        preload: "metadata",
        label: "Open image: chart",
      });
      await js(`document.querySelector(".remote-image").click(), true`);
      await until(`!!document.querySelector(".viewer img[src^='blob:']")`, "the image viewer");
      expect(fake.log.mediaReads.toSorted()).toEqual([
        "msg_reply/aaaaaaaaaaaaaaaa",
        "msg_reply/bbbbbbbbbbbbbbbb",
        "msg_reply/cccccccccccccccc",
      ]);
      expect(fake.log.activityReads).toBeGreaterThan(0);
    },
  );
}, 60_000);

test("an inline video keeps its element, blob and playback through unchanged polls, read once", async () => {
  await scenario(
    "video-polls",
    (fake) => {
      fake.messages = [
        { id: "msg_owner", kind: "owner", text: "Show me" },
        {
          id: "msg_reply",
          kind: "dot",
          text: "Here:\n\nhttps://media.example/long.webm",
          extra: {
            media: [
              { id: "dddddddddddddddd", url: "https://media.example/long.webm", kind: "video" },
            ],
          },
        },
      ];
      fake.media.set("dddddddddddddddd", longWebm);
    },
    async ({ fake, js, until }) => {
      const video = `document.querySelector("video[data-media='dddddddddddddddd']")`;
      await until(`${video}?.readyState >= 1`, "the video's metadata");
      expect(await js(`${video}.duration`)).toBeGreaterThan(15);
      // Marks this element, then plays it; the poll keeps replacing the message objects.
      await js(`(${video}.dataset.marked = "yes", ${video}.play().then(() => true))`);
      const source = await js(`${video}.src`);
      const reads = fake.log.latestReads;
      await until(`${video}.currentTime > 0`, "playback to start");
      const started = (await js(`${video}.currentTime`)) as number;
      // Several unchanged polls of the latest page, each with newly decoded message objects.
      for (const deadline = Date.now() + 15_000; fake.log.latestReads - reads < 3;) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for three polls.");
        await delay(100);
      }
      expect(
        await js(`(() => {
          const video = ${video};
          return {
            marked: video.dataset.marked,
            source: video.src,
            paused: video.paused,
            count: document.querySelectorAll("video").length,
          };
        })()`),
      ).toEqual({ marked: "yes", source, paused: false, count: 1 });
      expect(await js(`${video}.currentTime`)).toBeGreaterThan(started + 2);
      expect(fake.log.mediaReads).toEqual(["msg_reply/dddddddddddddddd"]);
    },
  );
}, 60_000);

test("a work cursor longer than 8,192 characters loads earlier calls; one past 12,000 never leaves main", async () => {
  await scenario(
    "work-cursor",
    (fake) => {
      fake.messages = [
        { id: "msg_owner", kind: "owner", text: "Do a lot" },
        { id: "msg_reply", kind: "dot", text: "Done." },
      ];
      fake.continuation = "u".repeat(7_000);
      fake.work = [
        {
          anchor: "msg_reply",
          calls: [toolCall("c9", "bash", "bun test", "done")],
          counts: { commands: 1, edits: 0, edited: 0, failed: 0, total: 1 },
          complete: false,
          open: false,
          more: signedMore,
        },
      ];
      fake.earlier = {
        calls: [toolCall("c1", "bash", "bun install", "done")],
        counts: { commands: 1, edits: 0, edited: 0, failed: 0, total: 1 },
        complete: true,
        more: null,
      };
    },
    async ({ fake, js, until }) => {
      await until(`!!document.querySelector("[data-work-log='msg_reply']")`, "the work log");
      await js(`document.querySelector("[data-work-log='msg_reply'] .work-summary").click(), true`);
      await js(
        `[...document.querySelectorAll("[data-work-log='msg_reply'] .link-button")].find((b) => b.textContent === "Load earlier calls").click(), true`,
      );
      await until(`document.querySelectorAll("[data-tool-call]").length === 2`, "the earlier call");
      const [signed = 0] = fake.log.workReads;
      expect(fake.log.workReads).toHaveLength(1);
      expect(signed).toBeGreaterThan(8_192);
      expect(signed).toBeLessThanOrEqual(12_000);
      // The shared limit: main sends a cursor of 12,000 characters, and refuses one longer.
      expect(
        await js(`window.openDot.call("work", "jojo", "ses_jojo", "a.".padEnd(12_001, "b"))`),
      ).toEqual({ ok: false, error: "That request isn't valid." });
      expect(fake.log.workReads).toHaveLength(1);
      expect(
        await js(`window.openDot.call("work", "jojo", "ses_jojo", "a.".padEnd(12_000, "b"))`),
      ).toMatchObject({ ok: false });
      expect(fake.log.workReads).toEqual([signed, 12_000]);
    },
  );
}, 60_000);

test("renders safely, sends with its own ID, and settles a lost send from its receipt without resending", async () => {
  await scenario(
    "send",
    (fake) => {
      fake.busy = true;
      fake.workers = [worker(7, "running", ["permission"])];
      fake.messages = [
        { id: "msg_owner", kind: "owner", text: "Plan it" },
        { id: "msg_dot", kind: "dot", text: sample },
        { id: "msg_peer", kind: "peer", text: "From the other dot", extra: { peer: "polnareff" } },
        { id: "msg_notice", kind: "notice", text: "Reminder: stand-up" },
      ];
    },
    async ({ fake, js, until, state }) => {
      await until(
        `!!document.querySelector(".katex") && !!document.querySelector(".diff")`,
        "rendering",
      );
      expect(
        await js(`(() => {
          const list = t.list();
          return {
            table: !!list.querySelector("table"),
            task: !!list.querySelector("input[type=checkbox][disabled]"),
            code: !!list.querySelector(".code-block button"),
            diff: !!list.querySelector(".diff .diff-add") && !!list.querySelector(".diff .diff-del"),
            script: !!list.querySelector("script, iframe, object, embed, style"),
            remoteImage: !!list.querySelector("img:not([src^='blob:'])"),
            unsafeLink: [...list.querySelectorAll("a")].some((a) => !/^(https?|mailto):/.test(a.getAttribute("href") ?? "")),
            peer: !!t.msg("msg_peer").textContent.includes("From polnareff"),
            workerRow: !!document.querySelector("[data-worker] [data-needs]"),
            busy: !!document.querySelector("[data-dot][data-busy]"),
          };
        })()`),
      ).toEqual({
        table: true,
        task: true,
        code: true,
        diff: true,
        script: false,
        remoteImage: false,
        unsafeLink: false,
        peer: true,
        workerRow: true,
        busy: true,
      });
      await js(`t.list().querySelector("a[href^='https:']").click(), true`);

      // A saved send leaves the box, shows as pending with what it captured, and its capture is
      // released once the dot has it.
      await js(`t.type("Hello"), t.enter(), true`);
      await until(`t.box().value === ""`, "the first send to clear");
      await until(
        `[...document.querySelectorAll("[data-pending] .plain")].some((e) => e.textContent === "Hello")`,
        "the pending preview",
      );
      const first = fake.log.posts[0];
      if (!first) throw new Error("No first post.");
      expect(first.messageID).toMatch(/^msg_[0-9A-Za-z]{26}$/);
      fake.deliver(first.messageID, "Hello");
      await until(
        `document.querySelector(".app").dataset.sent === "0"`,
        "the delivered capture to go",
      );
      await until(`!document.querySelector("[data-pending]")`, "the pending row to go");

      // The daemon saves the second send and dies before answering, then comes back with a new
      // token on a new port.
      fake.onPost = (post) => {
        if (post.text !== "Second") return undefined;
        fake.receipts.set(post.messageID, "sent");
        fake.pending.push({ id: post.messageID, status: "sent", delivery: "queue" });
        setTimeout(() => {
          fake.stop();
          setTimeout(() => fake.start(), 1500);
        }, 50);
        return new Promise<Response>(() => {});
      };
      await js(`t.type("Second"), t.enter(), true`);
      await until(
        `!!document.querySelector("[data-attempt-unknown]")`,
        "the lost send to be unknown",
      );
      expect(await js(`t.box().value`)).toBe("Second");
      // Enter again while it's unknown warns instead of sending.
      await js(`t.enter(), true`);
      await until(
        `!!document.querySelector("[data-composer-error]")?.textContent.includes("Send anyway")`,
        "the unknown-send warning",
      );
      // The receipt from the restarted daemon says it was sent: the box clears, nothing resends.
      await until(
        `!document.querySelector("[data-attempt-unknown]")`,
        "the lost send to reconcile",
        30,
      );
      await until(`t.box().value === ""`, "the reconciled draft to clear");
      expect((await state()).attempts).toEqual([]);
      await js(`t.enter(), true`);
      await js(`t.type("Third"), t.enter(), true`);
      await until(`t.box().value === ""`, "the third send to clear");
      expect(fake.log.posts.map((post) => [post.server, post.text])).toEqual([
        [1, "Hello"],
        [1, "Second"],
        [2, "Third"],
      ]);
      expect(fake.log.receipts).toBeGreaterThan(0);
      expect((await state()).recorded.openExternal).toEqual(["https://example.com/"]);
    },
  );
}, 170_000);

test("sends only to a daemon verified since discovery, and stops when one ignores the app's ID", async () => {
  await scenario(
    "capability",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hi" }];
    },
    async ({ fake, js, until, found }) => {
      await until(`!!t.msg("m1")`, "the first page");
      // The daemon restarts as an older one that ignores client IDs, slow to answer pages: a send
      // right after rediscovery must not rely on what the old daemon said.
      fake.capable = false;
      fake.pageDelay = 2500;
      fake.restart();
      await found();
      await js(`t.type("Old daemon"), t.enter(), true`);
      await until(
        `!!document.querySelector("[data-composer-error]")?.textContent.includes("can't confirm")`,
        "the send to be refused",
      );
      expect(fake.log.posts).toEqual([]);
      expect(await js(`t.box().value`)).toBe("Old daemon");

      // A daemon that says it takes client IDs but answers with another ID: the message is saved
      // under that ID, nothing is left to reconcile, and the app sends nothing more to it.
      fake.capable = true;
      fake.mismatch = true;
      fake.pageDelay = 0;
      fake.restart();
      await until(`!document.querySelector(".stale")`, "the new daemon", 30);
      await js(`t.enter(), true`);
      await until(`t.box().value === ""`, "the mismatched send to clear");
      await until(
        `!!document.querySelector("[data-composer-error]")?.textContent.includes("without the app's ID")`,
        "the mismatch warning",
      );
      await js(`t.type("Again"), t.enter(), true`);
      await until(
        `!!document.querySelector("[data-composer-error]")?.textContent.includes("can't confirm")`,
        "later sends to be refused",
      );
      expect(fake.log.posts.map((post) => post.text)).toEqual(["Old daemon"]);
    },
  );
}, 170_000);

const many = (count: number): FakeMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    kind: index % 7 === 3 ? "owner" : "dot",
    // Varied heights, so anchoring can't rely on estimates.
    text: `Message ${index}${"\n\nmore".repeat(index % 4)}`,
  }));

test("long history: anchored prepend, selection across messages, a detached window and cursors after a restart", async () => {
  await scenario(
    "history",
    (fake) => {
      fake.messages = many(700);
      fake.olderDelay = 400;
    },
    async ({ fake, js, until }) => {
      await until(`t.count() === 50 && !!t.msg("m699")`, "the latest page");
      // Prepending an older page keeps the message being read where it was.
      await js(`t.scroll(400), true`);
      await delay(300);
      const anchor = String(
        await js(
          `[...document.querySelectorAll("[data-message]")].find((e) => e.getBoundingClientRect().top > t.list().getBoundingClientRect().top)?.dataset.message`,
        ),
      );
      const before = Number(await js(`(t.scroll(250), t.top(${JSON.stringify(anchor)}))`));
      await until(`t.count() === 100`, "an older page");
      await delay(500);
      const after = Number(await js(`t.top(${JSON.stringify(anchor)})`));
      expect(Math.abs(after - before)).toBeLessThan(4);

      // A selection across messages survives scrolling them out of view and polls.
      await js(`(() => {
        t.scroll(t.list().scrollHeight);
        return true;
      })()`);
      await until(`!!t.msg("m690") && !!t.msg("m695")`, "the newest rows");
      await js(`(() => {
        const range = document.createRange();
        range.setStart(t.msg("m690").querySelector(".bubble").firstChild, 0);
        const end = t.msg("m695").querySelector(".bubble");
        range.setEnd(end, end.childNodes.length);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()`);
      await delay(200);
      // Load every older page while the selection holds: the selected messages stay loaded, and
      // the newer ones past the limit go.
      for (let round = 0; round < 20 && (await js(`t.list().dataset.first`)) !== "m0"; round++) {
        const first = String(await js(`t.list().dataset.first`));
        await js(`t.scroll(0), true`);
        await until(`t.list().dataset.first !== ${JSON.stringify(first)}`, "an older page", 10);
      }
      expect(await js(`t.count()`)).toBe(696);
      expect(await js(`!!document.querySelector("[data-detached]")`)).toBe(true);
      expect(await js(`t.list().dataset.first`)).toBe("m0");
      await delay(2500);
      const kept = (await js(`({
        first: t.list().dataset.first,
        count: t.count(),
        rendered: !!t.msg("m690") && !!t.msg("m695"),
        text: document.getSelection().toString(),
      })`)) as { first: string; count: number; rendered: boolean; text: string };
      // Polls kept the detached window, and the selection still spans both messages.
      expect(kept.first).toBe("m0");
      expect(kept.count).toBe(696);
      expect(kept.rendered).toBe(true);
      expect(kept.text).toContain("Message 690");
      expect(kept.text).toContain("Message 695");
      await js(`document.getSelection().removeAllRanges(), true`);

      // Back to latest returns to the latest page.
      await until(`!!document.querySelector("[data-latest]")`, "Back to latest");
      await js(`document.querySelector("[data-latest]").click(), true`);
      await until(
        `t.count() === 50 && !document.querySelector("[data-detached]")`,
        "the latest page again",
      );

      // After loading older pages, the daemon restarts with a new token: the app starts from the
      // new daemon's latest page and never sends it the old daemon's cursor.
      fake.olderDelay = 0;
      await js(`t.scroll(0), true`);
      await until(`t.count() === 100`, "an older page before the restart");
      await js(`t.scroll(t.list().scrollHeight), true`);
      fake.restart();
      await until(`t.count() === 50`, "the restarted daemon's latest page", 30);
      await js(`t.scroll(0), true`);
      await until(`t.count() === 100`, "an older page from the new daemon");
      expect(fake.log.staleCursors).toBe(0);

      // An older page the daemon refuses says so, and Back to latest recovers.
      fake.failOlder = true;
      await js(`t.scroll(0), true`);
      await until(`!!document.querySelector("[data-older-error]")`, "the older-page error");
      fake.failOlder = false;
      await js(`t.click("Back to latest", document.querySelector("[data-older-error]"))`);
      await until(`t.count() === 50 && !document.querySelector("[data-older-error]")`, "recovery");
    },
  );
}, 170_000);

test("history past empty pages loads without scrolling: on its own up to a bound, then by Load older", async () => {
  await scenario(
    "empty-pages",
    (fake) => {
      // The latest page and the eleven before it hold only tool calls; the message is older.
      fake.emptyPages = 12;
      fake.messages = [{ id: "m0", kind: "dot", text: "Before the tool calls" }];
    },
    async ({ fake, js, until }) => {
      // Ten older pages load on their own, then Load older is offered; nothing scrolled.
      await until(`!!document.querySelector("[data-load-older]")`, "Load older", 30);
      await delay(1500);
      expect(fake.log.olderReads).toBe(10);
      expect(await js(`!!t.msg("m0")`)).toBe(false);
      await js(`document.querySelector("[data-load-older]").click(), true`);
      await until(`!!t.msg("m0")`, "the older message");
      expect(fake.log.olderReads).toBe(12);
      // Polls of the unchanged empty latest page keep it, and nothing more is read.
      await delay(2500);
      expect(
        await js(`({ shown: !!t.msg("m0"), more: !!document.querySelector("[data-load-older]") })`),
      ).toEqual({ shown: true, more: false });
      expect(fake.log.olderReads).toBe(12);
    },
  );
}, 170_000);

test("changes to older messages settle by their own reads, stale reads can't undo them, and focus holds through polls", async () => {
  await scenario(
    "mutations",
    (fake) => {
      fake.messages = many(100).map((item) => ({ ...item, kind: "dot" as const }));
    },
    async ({ fake, js, until, menu, press }) => {
      await until(`t.count() === 50`, "the latest page");
      await js(`t.scroll(0), true`);
      await until(`t.count() === 100`, "the older page");
      await js(`t.scroll(0), true`);
      await until(`!!t.msg("m5")`, "an older message");

      // Delete an older message, then restore it from Show deleted.
      await menu("m5", "Delete");
      await press(".modal", "Delete");
      await until(`!t.msg("m5")`, "the delete");
      expect(fake.hidden.has("m5")).toBe(true);
      await js(`document.querySelector(".chat-tools input[type=checkbox]").click(), true`);
      await until(
        `!!t.msg("m5") && !t.button("Restore", t.msg("m5")).disabled`,
        "Restore to be ready",
      );
      await js(`t.click("Restore", t.msg("m5"))`);
      await until(`!t.msg("m5")?.classList.contains("hidden")`, "the restore");
      expect(fake.log.puts.filter((put) => put.id === "m5").map((put) => put.body.hidden)).toEqual([
        true,
        false,
      ]);

      // React to an older message twice: the second isn't blocked by the first.
      await menu("m6", "❤️");
      await until(
        `!!t.msg("m6").querySelector(".reaction.owner") && !t.msg("m6").dataset.blocked`,
        "the reaction",
      );
      await menu("m6", "❤️");
      await until(
        `!t.msg("m6").querySelector(".reaction.owner") && !t.msg("m6").dataset.blocked`,
        "its removal",
      );
      expect(fake.log.puts.filter((put) => put.id === "m6").map((put) => put.body.emoji)).toEqual([
        "❤️",
        null,
      ]);

      // A latest-page read that started before a reaction and a delete answers after both are
      // confirmed, with the old state. Every later read is held meanwhile, so none can hide an
      // overwrite.
      await js(`t.scroll(t.list().scrollHeight), true`);
      await until(`!!t.msg("m95") && !!t.msg("m94")`, "recent messages");
      fake.stallNext = true;
      for (let tick = 0; tick < 50 && fake.stalled === 0; tick++) await delay(100);
      expect(fake.stalled).toBe(1);
      await menu("m95", "👍");
      await until(
        `t.msg("m95").querySelector(".reaction.owner")?.textContent === "👍" && !t.msg("m95").dataset.blocked`,
        "the confirmed reaction",
      );
      await menu("m94", "Delete");
      await press(".modal", "Delete");
      // Show deleted is still on, so the deleted message stays listed, marked hidden.
      await until(
        `!!t.msg("m94")?.classList.contains("hidden") && !t.msg("m94").dataset.blocked`,
        "the confirmed delete",
      );
      const { promise: held, resolve: unhold } = Promise.withResolvers<void>();
      fake.hold = held;
      fake.release?.();
      for (let tick = 0; tick < 50 && fake.stalledDone === 0; tick++) await delay(100);
      expect(fake.stalledDone).toBe(1);
      await delay(1000);
      expect(
        await js(`({
          reaction: t.msg("m95").querySelector(".reaction.owner")?.textContent ?? null,
          deleted: t.msg("m94")?.classList.contains("hidden") ?? null,
        })`),
      ).toEqual({ reaction: "👍", deleted: true });
      fake.hold = undefined;
      unhold();
      await delay(1500);
      expect(await js(`t.msg("m95").querySelector(".reaction.owner")?.textContent`)).toBe("👍");

      // The menu keeps keyboard focus and its checked state through polls.
      await menu("m95");
      expect(await js(`document.activeElement.getAttribute("role")`)).toBe("menuitemradio");
      expect(
        await js(`document.querySelector("[role=menu] [aria-checked=true]")?.textContent`),
      ).toBe("👍");
      await js(`t.key("ArrowDown"), t.key("ArrowDown"), t.key("ArrowDown"), true`);
      const focused = await js(`document.activeElement.getAttribute("aria-label")`);
      expect(focused).toBe("Ha Ha Tapback");
      await delay(2500);
      expect(await js(`document.activeElement.getAttribute("aria-label")`)).toBe(focused);
      await js(`t.key("Escape"), true`);
      await until(`!document.querySelector("[role=menu]")`, "the menu to close");
      expect(await js(`document.activeElement.classList.contains("more")`)).toBe(true);

      // A reaction neither row shows is listed, checked, so it can be removed.
      fake.reactions.set("m95", "🦄");
      await until(
        `t.msg("m95").querySelector(".reaction.owner")?.textContent === "🦄"`,
        "the new reaction",
      );
      await menu("m95");
      expect(
        await js(`document.querySelector("[data-unlisted-tapback]")?.getAttribute("aria-checked")`),
      ).toBe("true");
      await js(`t.key("Escape"), true`);

      // The message box keeps focus while polls update the chat.
      await js(`t.box().focus(), true`);
      await delay(2500);
      expect(await js(`document.activeElement === t.box()`)).toBe(true);
    },
  );
}, 170_000);

test("a send whose receipt the daemon has before its POST answers settles when that answer is lost, and nothing resends", async () => {
  await scenario(
    "receipt-first",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hi" }];
    },
    async ({ fake, js, until, state }) => {
      await until(`!!t.msg("m1")`, "the first page");
      // The daemon commits the send at once, so its receipt is known, but holds the POST's answer.
      fake.onPost = (post) => {
        if (post.text !== "Lost") return undefined;
        fake.receipts.set(post.messageID, "sent");
        fake.pending.push({ id: post.messageID, status: "sent", delivery: "queue" });
        return new Promise<Response>(() => {});
      };
      await js(`t.type("Lost"), t.enter(), true`);
      for (let tick = 0; tick < 50 && !fake.log.posts.length; tick++) await delay(100);
      const id = fake.log.posts[0]?.messageID;
      if (!id) throw new Error("No post.");
      // Past several of the app's receipt checks: the record stays while its POST is out.
      await delay(4500);
      expect((await state()).attempts.map((attempt) => attempt.messageID)).toEqual([id]);
      expect(fake.log.receipts).toBe(0);
      // The daemon restarts, dropping the POST's connection: the receipt settles the draft.
      fake.restart();
      await until(`t.box().value === ""`, "the draft to settle", 30);
      expect((await state()).attempts).toEqual([]);
      expect(fake.log.receipts).toBeGreaterThan(0);
      expect(
        await js(`!!document.querySelector("[data-attempt-unknown]") ||
          !!document.querySelector("[data-composer-error]")?.textContent.includes("Send anyway")`),
      ).toBe(false);
      // Return on the empty box sends nothing; the next message sends once.
      await js(`t.enter(), true`);
      await js(`t.type("Next"), t.enter(), true`);
      await until(`t.box().value === ""`, "the next send");
      expect(fake.log.posts.map((post) => post.text)).toEqual(["Lost", "Next"]);
    },
  );
}, 170_000);

test("a send the daemon admitted stands when its record can't be removed, and nothing resends", async () => {
  const data = join(scratch, "admitted", "app-data");
  try {
    await scenario(
      "admitted",
      (fake) => {
        fake.messages = [{ id: "m1", kind: "dot", text: "Hi" }];
      },
      async ({ fake, js, until, state }) => {
        await until(`!!t.msg("m1")`, "the first page");
        // The daemon admits the send but holds its answer until the app's data can't be written.
        const { promise: answer, resolve: release } = Promise.withResolvers<void>();
        fake.onPost = (post) => {
          if (post.text !== "Admitted") return undefined;
          fake.receipts.set(post.messageID, "sent");
          fake.pending.push({ id: post.messageID, status: "sent", delivery: "queue" });
          return answer.then(() => Response.json({ id: post.messageID }, { status: 202 }));
        };
        await js(`t.type("Admitted"), t.enter(), true`);
        for (let tick = 0; tick < 50 && !fake.log.posts.length; tick++) await delay(100);
        const id = fake.log.posts[0]?.messageID;
        if (!id) throw new Error("No post.");
        chmodSync(data, 0o500);
        release();
        // The send is saved: the box clears and the composer is free, though the record stays.
        await until(
          `t.box().value === "" && t.button("Send")?.textContent === "Send"`,
          "the admitted send to clear",
        );
        await delay(2500);
        let current = await state();
        expect(current.attempts.map((attempt) => attempt.messageID)).toEqual([id]);
        expect(current.open).toEqual([]);
        expect(
          await js(`!!document.querySelector("[data-attempt-unknown]") ||
            !!document.querySelector("[data-composer-error]")`),
        ).toBe(false);
        // While the record can't be written, the next send is refused before any POST.
        await js(`t.type("Later"), t.enter(), true`);
        await until(
          `!!document.querySelector("[data-composer-error]")?.textContent.includes("nothing was sent")`,
          "the refused send",
        );
        expect(fake.log.posts).toHaveLength(1);
        // Once it can, the next send goes once and the old record is cleaned up, never resent.
        chmodSync(data, 0o700);
        await js(`t.enter(), true`);
        await until(`t.box().value === ""`, "the later send");
        await delay(1000);
        current = await state();
        expect(current.attempts).toEqual([]);
        expect(fake.log.posts.map((post) => post.text)).toEqual(["Admitted", "Later"]);
      },
    );
  } finally {
    if (existsSync(data)) chmodSync(data, 0o700);
  }
}, 170_000);

test("a send saved behind an unreadable answer stays to reconcile by its ID, and nothing resends unguarded", async () => {
  await scenario(
    "malformed",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hi" }];
    },
    async ({ fake, js, until, state }) => {
      await until(`!!t.msg("m1")`, "the first page");
      // The daemon commits each send, then answers 202 with a body that isn't JSON.
      const commit = (post: Post, body: string) => {
        fake.receipts.set(post.messageID, "sent");
        fake.pending.push({ id: post.messageID, status: "sent", delivery: "queue" });
        return new Response(body, { status: 202, headers: { "content-type": "application/json" } });
      };
      fake.onPost = (post) =>
        post.text === "Empty"
          ? commit(post, "")
          : post.text === "Garbled"
            ? commit(post, '{"id":')
            : undefined;
      // An empty answer: the receipt asked for at once settles it.
      await js(`t.type("Empty"), t.enter(), true`);
      await until(`t.box().value === ""`, "the empty answer to settle");
      expect((await state()).attempts).toEqual([]);

      // A garbled answer while receipts are down: the record and the draft stay, and Return warns.
      fake.failReceipts = true;
      await js(`t.type("Garbled"), t.enter(), true`);
      await until(
        `!!document.querySelector("[data-attempt-unknown]")`,
        "the garbled send to be unknown",
      );
      const id = fake.log.posts[1]?.messageID;
      if (!id) throw new Error("No second post.");
      expect((await state()).open.map((attempt) => attempt.messageID)).toEqual([id]);
      expect(await js(`t.box().value`)).toBe("Garbled");
      await js(`t.enter(), true`);
      await until(
        `!!document.querySelector("[data-composer-error]")?.textContent.includes("Send anyway")`,
        "the unknown-send warning",
      );
      await delay(1500);
      expect(fake.log.posts).toHaveLength(2);

      // Receipts come back: the same ID settles it, and the next message goes once.
      fake.failReceipts = false;
      await until(`!document.querySelector("[data-attempt-unknown]")`, "the send to reconcile", 30);
      await until(`t.box().value === ""`, "the reconciled draft to clear");
      expect((await state()).attempts).toEqual([]);
      await js(`t.enter(), true`);
      await js(`t.type("Next"), t.enter(), true`);
      await until(`t.box().value === ""`, "the next send");
      expect(fake.log.posts.map((post) => post.text)).toEqual(["Empty", "Garbled", "Next"]);
      expect(new Set(fake.log.posts.map((post) => post.messageID)).size).toBe(3);
    },
  );
}, 170_000);

test("a slow background chat or receipt holds up only itself: the selected chat and the dots keep refreshing", async () => {
  const { promise: heldB, resolve: releaseB } = Promise.withResolvers<void>();
  await scenario(
    "independent",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hi" }];
      fake.others.set("kiki", {
        messages: [{ id: "k1", kind: "dot", text: "From kiki" }],
        hold: heldB,
        reads: 0,
      });
    },
    async ({ fake, js, until, state }) => {
      const kiki = fake.others.get("kiki");
      if (!kiki) throw new Error("No kiki.");
      await until(`!!t.msg("m1")`, "jojo's first page");
      for (let tick = 0; tick < 50 && !kiki.reads; tick++) await delay(100);
      expect(kiki.reads).toBeGreaterThan(0);
      const busy = `!!document.querySelector('[data-dot="jojo"]')?.hasAttribute("data-busy")`;

      // kiki's read is held: jojo's chat and the dot list still refresh on their own clocks, well
      // before main gives up on kiki after ten seconds.
      fake.messages.push({ id: "m2", kind: "dot", text: "Still here" });
      fake.busy = true;
      const dotReads = fake.log.dotReads;
      await until(`!!t.msg("m2")`, "jojo's change while kiki is held", 4);
      await until(busy, "the sidebar's busy badge while kiki is held", 4);
      expect(fake.log.dotReads).toBeGreaterThan(dotReads);

      // A send whose receipt read is held: it blocks neither, and isn't asked about twice at once.
      fake.failReceipts = true;
      fake.onPost = (post) => {
        if (post.text !== "Garbled") return undefined;
        fake.receipts.set(post.messageID, "sent");
        fake.pending.push({ id: post.messageID, status: "sent", delivery: "queue" });
        return new Response('{"id":', {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      };
      await js(`t.type("Garbled"), t.enter(), true`);
      await until(`!!document.querySelector("[data-attempt-unknown]")`, "the unknown send");
      const { promise: heldReceipt, resolve: releaseReceipt } = Promise.withResolvers<void>();
      fake.receiptHold = heldReceipt;
      fake.failReceipts = false;
      const asked = fake.log.receipts;
      for (let tick = 0; tick < 200 && fake.log.receipts === asked; tick++) await delay(100);
      expect(fake.log.receipts).toBe(asked + 1);
      fake.messages.push({ id: "m3", kind: "dot", text: "And here" });
      fake.busy = false;
      await until(`!!t.msg("m3")`, "jojo's change while its receipt is held", 4);
      await until(`!(${busy})`, "the sidebar while the receipt is held", 4);
      expect(fake.log.receipts).toBe(asked + 1);

      // Released, each settles: the send by its ID, never resent, and kiki's chat opens.
      fake.receiptHold = undefined;
      releaseReceipt();
      await until(
        `!document.querySelector("[data-attempt-unknown]")`,
        "the held receipt to settle",
        30,
      );
      await until(`t.box().value === ""`, "the settled draft to clear");
      expect((await state()).attempts).toEqual([]);
      expect(fake.log.posts.map((post) => post.text)).toEqual(["Garbled"]);
      kiki.hold = undefined;
      releaseB();
      await js(`document.querySelector('[data-dot="kiki"]').click(), true`);
      await until(`!!t.msg("k1")`, "kiki's chat once released", 30);
    },
  );
  releaseB();
}, 170_000);

test("an older page or error read for a window that's gone is dropped, so history never skips", async () => {
  await scenario(
    "older-race",
    (fake) => {
      fake.messages = many(100);
      fake.olderDelay = 3000;
    },
    async ({ fake, js, until }) => {
      await until(`t.count() === 50 && !!t.msg("m99")`, "the latest page");
      // A slow older read for m0–m49 is out when the latest page moves past everything shown.
      await js(`t.scroll(0), true`);
      for (let tick = 0; tick < 50 && fake.log.olderReads === 0; tick++) await delay(100);
      expect(fake.log.olderReads).toBe(1);
      fake.messages.push(...many(160).slice(100));
      await until(`t.list().dataset.first === "m110"`, "the latest page to start over");
      await delay(3500);
      // The late page joined nothing: whatever is shown runs without a gap up to m159.
      const contiguous = `t.list().dataset.first === "m" + (160 - t.count())`;
      expect(await js(contiguous)).toBe(true);
      expect(await js(`t.count() <= 100`)).toBe(true);
      await js(`t.scroll(0), true`);
      await until(`t.list().dataset.first === "m60" && t.count() === 100`, "m60–m109", 15);
      expect(await js(contiguous)).toBe(true);

      // An older read whose error arrives after Back to latest shows nothing.
      fake.olderDelay = 0;
      fake.failOlder = true;
      await js(`t.scroll(0), true`);
      await until(`!!document.querySelector("[data-older-error]")`, "the older-page error");
      fake.olderDelay = 3000;
      const reads = fake.log.olderReads;
      await js(`t.click("Try again", document.querySelector("[data-older-error]"))`);
      for (let tick = 0; tick < 50 && fake.log.olderReads === reads; tick++) await delay(100);
      await js(`t.click("Back to latest", document.querySelector("[data-older-error]"))`);
      fake.failOlder = false;
      await until(
        `t.count() === 50 && !document.querySelector("[data-older-error]")`,
        "the latest page again",
      );
      await delay(3500);
      expect(await js(`!!document.querySelector("[data-older-error]")`)).toBe(false);
      expect(await js(contiguous)).toBe(true);
    },
  );
}, 170_000);

test("Undo clicked before its delete settles waits for it, then restores the message once", async () => {
  await scenario(
    "undo",
    (fake) => {
      fake.messages = many(10).map((item) => ({ ...item, kind: "dot" as const }));
    },
    async ({ fake, js, until, menu, press }) => {
      await until(`!!t.msg("m5")`, "the latest page");
      const puts = () =>
        fake.log.puts.filter((put) => put.id === "m5").map((put) => put.body.hidden);
      // Every read waits, so no read can show the delete saved before Undo is clicked.
      const { promise: held, resolve: unhold } = Promise.withResolvers<void>();
      fake.hold = held;
      await menu("m5", "Delete");
      await press(".modal", "Delete");
      await press(".toast", "Undo");
      await until(
        `!!document.querySelector(".toast")?.textContent.includes("Undoing once")`,
        "the waiting Undo",
      );
      await delay(1500);
      expect(puts()).toEqual([true]);
      expect(await js(`!!t.msg("m5")`)).toBe(false);
      // The reads answer: the delete settles, then the one restore goes and the message is back.
      fake.hold = undefined;
      unhold();
      await until(
        `!!t.msg("m5") && !t.msg("m5").classList.contains("hidden") && !t.msg("m5").dataset.blocked`,
        "the restored message",
      );
      await delay(2500);
      expect(puts()).toEqual([true, false]);
      expect(fake.hidden.has("m5")).toBe(false);
      expect(await js(`!!t.msg("m5") && !t.msg("m5").classList.contains("hidden")`)).toBe(true);
    },
  );
}, 170_000);

test("Back to latest keeps a same-session quote, and drops it when the dot rebinds meanwhile, keeping the draft", async () => {
  await scenario(
    "rebind",
    (fake) => {
      fake.messages = many(100);
    },
    async ({ fake, js, until, menu }) => {
      await until(`!!t.msg("m95")`, "the latest page");
      await menu("m95", "Reply");
      await until(`!!document.querySelector(".quote-bar")`, "the quote");
      await js(`t.type("Draft text"), t.paste("shot.png"), true`);
      await until(`document.querySelectorAll(".draft-thumb").length === 1`, "the image");
      const olderError = async () => {
        fake.failOlder = true;
        await js(`t.scroll(0), true`);
        await until(`!!document.querySelector("[data-older-error]")`, "the older-page error");
        fake.failOlder = false;
      };

      // Back to latest in the same conversation keeps the quote.
      await olderError();
      await js(`t.click("Back to latest", document.querySelector("[data-older-error]"))`);
      await until(
        `t.count() === 50 && !document.querySelector("[data-older-error]")`,
        "the latest page again",
      );
      expect(await js(`!!document.querySelector(".quote-bar")`)).toBe(true);

      // The dot moves to a new session while Back to latest waits for its page.
      await olderError();
      const { promise: held, resolve: unhold } = Promise.withResolvers<void>();
      fake.hold = held;
      await delay(1500);
      fake.sessionID = "ses_next";
      fake.messages = [{ id: "n1", kind: "dot", text: "A new conversation" }];
      await js(`t.click("Back to latest", document.querySelector("[data-older-error]"))`);
      fake.hold = undefined;
      unhold();
      await until(`!!t.msg("n1") && t.count() === 1`, "the new session's page");
      expect(
        await js(`({
          quote: !!document.querySelector(".quote-bar"),
          text: t.box().value,
          images: document.querySelectorAll(".draft-thumb").length,
        })`),
      ).toEqual({ quote: false, text: "Draft text", images: 1 });
      await js(`t.enter(), true`);
      await until(`t.box().value === ""`, "the send");
      expect(fake.log.posts).toEqual([expect.objectContaining({ text: "Draft text", files: 1 })]);
      expect(fake.log.posts[0]?.replyTo).toBeUndefined();
    },
  );
}, 170_000);

test("a refresh asked for while a chat's read is out runs once after it: a held page can't rebuild a cleared window, and a held pinned read isn't joined by another task", async () => {
  await scenario(
    "one-task",
    (fake) => {
      fake.messages = many(100);
      fake.others.set("kiki", {
        messages: [{ id: "k1", kind: "dot", text: "From kiki" }],
        hold: undefined,
        reads: 0,
      });
    },
    async ({ fake, js, until, menu, shown }) => {
      const waitFor = async (done: () => boolean, label: string) => {
        for (let tick = 0; tick < 100 && !done(); tick++) await delay(100);
        if (!done()) throw new Error(`Timed out waiting for ${label}.`);
      };
      await until(`t.count() === 50 && t.list().dataset.first === "m50"`, "the latest page");
      fake.failOlder = true;
      await js(`t.scroll(0), true`);
      await until(`!!document.querySelector("[data-older-error]")`, "the older-page error");
      fake.failOlder = false;

      // A latest read of m50–m99 is held; the daemon moves on, so later reads answer m60–m109.
      fake.gate = true;
      await waitFor(() => fake.gated.length === 1, "a held latest read");
      fake.messages.push(...many(110).slice(100));
      await js(`t.click("Back to latest", document.querySelector("[data-older-error]"))`);
      // Several scheduler ticks pass while it's held: nothing reads beside it.
      await delay(1500);
      expect(fake.gated.length).toBe(1);
      // Released, it answers for the window that's gone. The one follow-up read waits in turn, and
      // across more ticks the cleared window stays empty rather than showing the old page.
      fake.gated.shift()?.();
      await waitFor(() => fake.gated.length === 1, "the follow-up latest read");
      await delay(1500);
      expect(fake.gated.length).toBe(1);
      expect(await js(`t.count() === 0 && t.list()?.dataset.first !== "m50"`)).toBe(true);
      fake.gate = false;
      for (const done of fake.gated.splice(0)) done();
      await until(
        `t.list().dataset.first === "m60" && t.count() === 50`,
        "the daemon's latest page",
      );

      // A reaction to an older message, off the latest page, settles only by reads of that
      // message: its own and the scheduled task's are held. Selecting the chat again and showing
      // the window ask for reads, but no task starts beside the one still out.
      await js(`t.scroll(0), true`);
      await until(`t.count() === 100`, "the older page");
      await js(`t.scroll(0), true`);
      await until(`!!t.msg("m12")`, "an older message");
      const { promise: held, resolve: unhold } = Promise.withResolvers<void>();
      fake.pinnedHold = held;
      await menu("m12", "❤️");
      await waitFor(() => fake.pinnedOut === 2, "the reaction's held reads");
      const latest = fake.log.latestReads;
      await js(`document.querySelector('[data-dot="kiki"]').click(), true`);
      await until(`!!t.msg("k1")`, "kiki's chat");
      await js(`document.querySelector('[data-dot="jojo"]').click(), true`);
      await shown();
      await delay(2500);
      expect(fake.log.latestReads).toBe(latest);
      expect(fake.maxPinnedOut).toBe(2);
      fake.pinnedHold = undefined;
      unhold();
      // Released, the asked-for read runs once, after the held task, and nothing is sent again.
      await waitFor(() => fake.log.latestReads > latest && fake.pinnedOut === 0, "the follow-up");
      expect(fake.log.puts.filter((put) => put.id === "m12").map((put) => put.body.emoji)).toEqual([
        "❤️",
      ]);
    },
  );
}, 170_000);

test("a change whose answer was lost stays blocked until a read shows it, and Try again asks for the same change", async () => {
  await scenario(
    "uncertain",
    (fake) => {
      fake.messages = many(100).map((item) => ({ ...item, kind: "dot" as const }));
    },
    async ({ fake, js, until, menu, press }) => {
      await until(`!!t.msg("m95") && !!t.msg("m96")`, "the latest page");
      // The daemon takes the first PUT to each message and dies before answering; it hasn't
      // applied it yet when it comes back.
      const lost = new Set<string>();
      fake.onPut = (id) => {
        if (lost.has(id)) return undefined;
        lost.add(id);
        setTimeout(() => fake.restart(), 50);
        return new Promise<Response>(() => {});
      };
      await menu("m95", "👍");
      await until(`!!t.msg("m95")?.querySelector("[data-unconfirmed]")`, "the unconfirmed change");
      // Pinned reads of the old state settle nothing, and no other change can be made.
      await delay(4000);
      expect(
        await js(`({
          blocked: t.msg("m95").dataset.blocked === "",
          shown: t.msg("m95").querySelector(".reaction.owner")?.textContent ?? null,
          actions: t.msg("m95").querySelector("button.more").disabled,
        })`),
      ).toEqual({ blocked: true, shown: "👍", actions: true });
      // The original PUT lands late: a read shows it, and the message is free again.
      fake.reactions.set("m95", "👍");
      await until(
        `!t.msg("m95").dataset.blocked && !t.msg("m95").querySelector("[data-unconfirmed]")`,
        "the late change to settle",
      );
      expect(fake.log.puts.filter((put) => put.id === "m95").map((put) => put.body.emoji)).toEqual([
        "👍",
      ]);

      // Another lost change, asked again by the owner: the same value, once more, never another.
      await menu("m96", "❤️");
      await until(`!!t.msg("m96")?.querySelector("[data-unconfirmed]")`, "the second unconfirmed");
      await delay(1500);
      await press('[data-message="m96"] [data-unconfirmed]', "Try again");
      await until(
        `!t.msg("m96").dataset.blocked && t.msg("m96").querySelector(".reaction.owner")?.textContent === "❤️"`,
        "the retried change to settle",
      );
      expect(fake.log.puts.filter((put) => put.id === "m96").map((put) => put.body.emoji)).toEqual([
        "❤️",
        "❤️",
      ]);
    },
  );
}, 170_000);

test("Copy and Share are all or nothing, and pending, attachment and worker rows follow their state", async () => {
  const app = await scenario(
    "parity",
    (fake) => {
      const image = { mime: "image/png", name: "photo.png" };
      fake.messages = [
        { id: "m1", kind: "dot", text: "", attachments: [image, image] },
        {
          id: "m2",
          kind: "dot",
          text: "The report",
          attachments: [{ mime: "application/pdf", name: "/tmp/report.pdf" }],
        },
        {
          id: "m3",
          kind: "dot",
          text: "Seven",
          attachments: Array.from({ length: 7 }, () => ({ ...image })),
        },
      ];
      fake.failing.add("m1:1");
      fake.pending = [
        { id: "msg_p1", status: "sending", delivery: "auto" },
        { id: "msg_p2", status: "sent", delivery: "queue" },
        { id: "msg_p3", status: "sent", delivery: "steer" },
        { id: "msg_p4", status: "confirming", delivery: "queue" },
      ];
      fake.workers = [
        worker(1, "creating"),
        worker(2, "running"),
        worker(3, "stopping"),
        worker(4, "done"),
      ];
    },
    async ({ fake, js, until, state, menu, press }) => {
      await until(`!!t.msg("m3") && !!document.querySelector("[data-pending]")`, "the chat");
      // A file that isn't an image is listed by name; an image that fails says so.
      await until(`!!t.msg("m1").querySelector("[data-failed]")`, "the failed image");
      expect(await js(`t.msg("m2").querySelector(".attachment-chip").textContent`)).toContain(
        "report.pdf",
      );

      // One image of two fails: nothing is copied or shared.
      await menu("m1", "Copy");
      await until(
        `!!document.querySelector(".toast")?.textContent.includes("Nothing was copied")`,
        "the copy refusal",
      );
      await menu("m1", "Share…");
      await until(
        `!!document.querySelector(".toast")?.textContent.includes("nothing was shared")`,
        "the share refusal",
      );
      let recorded = (await state()).recorded;
      expect(recorded.clipboard).toEqual([]);
      expect(recorded.shares).toEqual([]);

      // Once both load, both are copied and shared; a message with seven shares all seven.
      fake.failing.clear();
      await js(`t.msg("m1").querySelector("[data-failed]").click(), true`);
      await until(`t.msg("m1").querySelectorAll("button.thumb").length === 2`, "the retried image");
      await menu("m1", "Copy");
      await menu("m1", "Share…");
      await menu("m3", "Share…");
      for (let tick = 0; tick < 50 && (await state()).recorded.shares.length < 2; tick++)
        await delay(100);
      recorded = (await state()).recorded;
      expect(recorded.clipboard).toEqual([{ images: 2 }]);
      expect(recorded.shares.map(({ texts, files }) => ({ texts, files }))).toEqual([
        { texts: 0, files: 2 },
        { texts: 1, files: 7 },
      ]);

      // Pending rows offer Send now and Cancel.
      const actions = await js(
        `Object.fromEntries([...document.querySelectorAll("[data-pending]")].map((row) => [row.dataset.id, [...row.querySelectorAll("button")].map((b) => b.textContent)]))`,
      );
      expect(actions).toEqual({
        msg_p1: ["Send now", "Cancel"],
        msg_p2: ["Send now", "Cancel"],
        msg_p3: ["Cancel"],
        msg_p4: [],
      });

      // A reply with an image shows its quote and thumbnail while pending, and copies its text.
      await menu("m2", "Reply");
      await js(`t.paste("dot.png"), true`);
      await until(`!!document.querySelector(".draft-thumb img")`, "the attached image");
      await js(`t.type("With image"), t.enter(), true`);
      await until(`t.box().value === "" && !document.querySelector(".draft-thumb")`, "the send");
      const post = fake.log.posts[0];
      expect(post).toMatchObject({ text: "With image", replyTo: "m2", files: 1 });
      const row = `document.querySelector('[data-id="${post?.messageID}"]')`;
      await until(`!!${row}`, "the pending row");
      expect(
        await js(
          `({ quote: ${row}.querySelector(".quote")?.textContent, thumb: !!${row}.querySelector(".pending-thumb img"), share: !!t.button("Share…", ${row}) })`,
        ),
      ).toEqual({ quote: "jojo: The report", thumb: true, share: false });
      await js(`t.click("Copy", ${row})`);

      // Workers open once created and stop until done; a creating one can be stopped.
      const workers = await js(
        `Object.fromEntries([...document.querySelectorAll("[data-worker]")].map((row) => [row.dataset.worker, [...row.querySelectorAll("button")].map((b) => b.textContent)]))`,
      );
      expect(workers).toEqual({
        1: ["Stop"],
        2: ["Open", "Stop"],
        3: ["Open", "Stop again"],
        4: ["Open"],
      });
      await press('[data-worker="1"]', "Stop");
      await press(".modal", "Stop");
      for (let tick = 0; tick < 50 && !fake.log.stops.length; tick++) await delay(100);
      expect(fake.log.stops).toEqual([1]);
      recorded = (await state()).recorded;
      expect(recorded.clipboard.at(-1)).toEqual({ text: "With image" });
      expect(recorded.emojiPanel).toBe(0);
    },
  );
  // Shared images lived only in the app's temporary directory, and quitting removed them.
  expect(readdirSync(app.temporary).filter((name) => name.startsWith("open-dot-share-"))).toEqual(
    [],
  );
}, 170_000);

/** Opens a pane of jojo's from its dot menu. */
const openPane = async (app: App, label: string) => {
  await app.until(`!!document.querySelector('[data-dot-menu="jojo"]')`, "jojo's menu button");
  await app.js(`document.querySelector('[data-dot-menu="jojo"]').click(), true`);
  await app.press("[role=menu]", label);
};

const mutations = (fake: FakeDaemon, prefix: string) =>
  fake.data.calls.filter((call) => call.path.startsWith(prefix));

/** Pastes a PNG into the reply box of feed item `id`, as the owner's paste would. */
const pasteReply = (id: number, name: string) => `(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "image/png" }));
  document.querySelector('[data-reply="${id}"] textarea').dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
})()`;

const replyState = (id: number) => `(() => {
  const box = document.querySelector('[data-reply="${id}"]');
  if (!box) return null;
  return {
    handedOff: !!box.closest("[data-handed-off]"),
    text: box.querySelector("textarea").value,
    images: box.querySelectorAll(".draft-thumb img").length,
    picks: [...box.querySelectorAll(".reply-dots input")].map((input) => [input.checked, input.disabled]),
    results: Object.fromEntries([...box.querySelectorAll("[data-reply-result]")].map((row) => [row.dataset.replyResult, row.dataset.outcome])),
  };
})()`;

test("Feed: dismiss and Clear all; a reply to two dots keeps the refused dot's text and images through the hand-off, Escape and an unknown send", async () => {
  await scenario(
    "feed",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.others.set("dio", { messages: [], hold: undefined, reads: 0 });
    },
    async ({ fake, js, until, press, state }) => {
      await until(`!!document.querySelector("[data-open-feed]")`, "the Feed button");
      await js(`document.querySelector("[data-open-feed]").click(), true`);
      await until(`document.querySelectorAll("[data-feed-item]").length === 3`, "three feed items");
      await press('[data-feed-item="1"]', "Dismiss");
      await until(`!document.querySelector('[data-feed-item="1"]')`, "the dismissed item to go");
      await press('[data-feed-item="2"]', "Reply");
      await until(`!!document.querySelector('[data-reply="2"]')`, "the reply box");
      // jojo is picked; pick dio too, and attach an image.
      await js(
        `[...document.querySelectorAll('[data-reply="2"] .reply-dots label')].find((l) => l.textContent.includes("dio")).querySelector("input").click(), true`,
      );
      await press('[data-reply="2"]', "Start on it");
      await js(pasteReply(2, "shot.png"));
      await until(
        `document.querySelectorAll('[data-reply="2"] .draft-thumb img').length === 1`,
        "the image thumbnail",
      );
      await press('[data-reply="2"]', "Send");
      // jojo saved it, so the daemon handed the item off; dio has no conversation and refused.
      await until(
        `document.querySelector('[data-reply-result="dio"]')?.dataset.outcome === "refused" && !!document.querySelector('[data-handed-off="2"] [data-reply="2"]')`,
        "dio's refusal under Handed off",
      );
      expect(fake.log.posts).toHaveLength(1);
      expect(fake.log.posts[0]).toMatchObject({ feed: 2, files: 1 });
      expect(fake.log.posts[0]?.text).toStartWith("Take this on");
      const kept = {
        handedOff: true,
        text: fake.log.posts[0]?.text,
        images: 1,
        // jojo, which has it, can't be picked again; dio stays picked to try again.
        picks: [
          [false, true],
          [true, false],
        ],
        results: { jojo: "saved", dio: "refused" },
      };
      expect(await js(replyState(2))).toEqual(kept);
      // Escape goes back to the chat; the Feed reopens with the reply as it was.
      await js(
        `document.querySelector('[data-reply="2"] textarea').focus(), t.key("Escape"), true`,
      );
      await until(`!document.querySelector('[data-pane="feed"]') && !!t.box()`, "the chat");
      await js(`document.querySelector("[data-open-feed]").click(), true`);
      await until(`!!document.querySelector('[data-reply="2"]')`, "the kept reply");
      expect(await js(replyState(2))).toEqual(kept);
      // Sending again goes only to dio, which refuses again: jojo never gets it twice.
      await press('[data-reply="2"]', "Send");
      await until(
        `!!t.button("Send", document.querySelector('[data-reply="2"]'))`,
        "the second send",
      );
      await delay(300);
      expect(fake.log.posts).toHaveLength(1);
      expect(await js(replyState(2))).toEqual(kept);
      // A send whose answer is lost is unknown: never sent again, and its text and image stay.
      fake.onPost = () => json({ error: "Upstream hiccup." }, 503);
      await press('[data-feed-item="3"]', "Reply");
      await until(`!!document.querySelector('[data-reply="3"]')`, "the second reply box");
      await js(`t.fill('[data-reply="3"] textarea', "Look at this")`);
      await js(pasteReply(3, "two.png"));
      await until(
        `document.querySelectorAll('[data-reply="3"] .draft-thumb img').length === 1`,
        "the second thumbnail",
      );
      await press('[data-reply="3"]', "Send");
      await until(
        `document.querySelector('[data-reply="3"] [data-reply-result="jojo"]')?.dataset.outcome === "unknown"`,
        "the unknown outcome",
      );
      fake.onPost = undefined;
      expect(fake.log.posts).toHaveLength(2);
      expect(await js(replyState(3))).toMatchObject({
        handedOff: false,
        text: "Look at this",
        images: 1,
        picks: [
          [false, true],
          [false, false],
        ],
      });
      await press(".feed .pane-head", "Clear all");
      await until(`!document.querySelector("[data-feed-item]")`, "an empty feed");
      expect(mutations(fake, "/feed/dismiss").map((call) => call.body)).toEqual([{ ids: [3] }]);
      // The item left the feed, and its reply stays.
      await until(
        `!!document.querySelector('[data-feed-reply-only="3"] [data-reply="3"]')`,
        "the kept reply",
      );
      // The feed open over jojo's chat never marked it read.
      expect((await state()).recorded.show).toBe(0);
    },
  );
}, 170_000);

test("Feed: a receipt the chat's poll settles while the Feed is closed still settles its reply, keeping what was changed since, with one POST each", async () => {
  await scenario(
    "feed-receipts",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async ({ fake, js, until, press, state }) => {
      const openFeed = async () => {
        await js(`document.querySelector("[data-open-feed]").click(), true`);
        await until(`!!document.querySelector('[data-pane="feed"]')`, "the Feed");
      };
      const leaveFeed = async (id: number) => {
        await js(
          `document.querySelector('[data-reply="${id}"] textarea').focus(), t.key("Escape"), true`,
        );
        await until(`!document.querySelector('[data-pane="feed"]') && !!t.box()`, "the chat");
      };
      /** Sends feed item `id`'s reply to jojo with its answer lost, so its outcome is unknown. */
      const lostSend = async (id: number, text: string) => {
        await press(`[data-feed-item="${id}"]`, "Reply");
        await js(`t.fill('[data-reply="${id}"] textarea', ${JSON.stringify(text)})`);
        await js(pasteReply(id, `${id}.png`));
        await until(
          `document.querySelectorAll('[data-reply="${id}"] .draft-thumb img').length === 1`,
          "the thumbnail",
        );
        fake.onPost = () => json({ error: "Upstream hiccup." }, 503);
        await press(`[data-reply="${id}"]`, "Send");
        await until(
          `document.querySelector('[data-reply="${id}"] [data-reply-result="jojo"]')?.dataset.outcome === "unknown"`,
          "the unknown outcome",
        );
        fake.onPost = undefined;
        return fake.log.posts.at(-1)?.messageID ?? "";
      };
      /** Waits until the chat's own receipt poll retired the record, with the Feed closed. */
      const retired = async (messageID: string) => {
        for (let tick = 0; tick < 200; tick++) {
          if (!(await state()).open.some((attempt) => attempt.messageID === messageID)) return;
          await delay(100);
        }
        throw new Error("The receipt poll never settled the send.");
      };

      await until(`!!document.querySelector("[data-open-feed]")`, "the Feed button");
      await openFeed();
      await until(`document.querySelectorAll("[data-feed-item]").length === 3`, "three feed items");
      // Saved: between the unknown answer and its receipt the owner changes the text and adds an
      // image. The late receipt marks jojo saved and keeps that newer, unsent content.
      const saved = await lostSend(2, "Look at this");
      await js(`t.fill('[data-reply="2"] textarea', "Look again")`);
      await js(pasteReply(2, "more.png"));
      await until(
        `document.querySelectorAll('[data-reply="2"] .draft-thumb img').length === 2`,
        "the second thumbnail",
      );
      await leaveFeed(2);
      fake.receipts.set(saved, "sent");
      await retired(saved);
      await openFeed();
      await until(
        `document.querySelector('[data-reply="2"] [data-reply-result="jojo"]')?.dataset.outcome === "saved"`,
        "jojo saved",
      );
      expect(await js(replyState(2))).toMatchObject({
        text: "Look again",
        images: 2,
        picks: [[false, true]],
        results: { jojo: "saved" },
      });
      // Cancelled: the reply stays whole and jojo may be picked to send it again.
      const cancelled = await lostSend(3, "And this");
      await leaveFeed(3);
      fake.receipts.set(cancelled, "cancelled");
      await retired(cancelled);
      await openFeed();
      await until(
        `document.querySelector('[data-reply="3"] [data-reply-result="jojo"]')?.dataset.outcome === "refused"`,
        "jojo's cancelled send",
      );
      expect(await js(replyState(3))).toMatchObject({
        text: "And this",
        images: 1,
        picks: [[false, false]],
        results: { jojo: "refused" },
      });
      await delay(500);
      expect(fake.log.posts.map((post) => post.messageID)).toEqual([saved, cancelled]);
      // The chat doesn't claim a feed reply's text is in its own message box.
      expect(await js(`document.body.innerText.includes("It's still in the message box")`)).toBe(
        false,
      );
    },
  );
}, 170_000);

test("Memory: a new note, observation and feed trigger survive Escape, the Feed and another dot, and go only by Add or Cancel", async () => {
  await scenario(
    "memory-new",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.others.set("dio", { messages: [], hold: undefined, reads: 0 });
    },
    async (app) => {
      const { fake, js, until, press } = app;
      const drafts = `(() => ({
        note: document.querySelector('[aria-label="New note"]')?.value,
        observation: document.querySelector('[aria-label="New observation"]')?.value,
        instruction: document.querySelector('[aria-label="Instruction"]')?.value,
        repository: document.querySelector('[aria-label="Repository"]')?.value,
      }))()`;
      const typed = {
        note: "Buy tea",
        observation: "Prefers mornings",
        instruction: "Look at it",
        repository: "acme/app",
      };
      const reopen = async () => {
        await js(`t.cmd("2"), true`);
        await until(`!!document.querySelector('[aria-label="New note"]')`, "jojo's memory");
        expect(await js(drafts)).toEqual(typed);
      };
      await openPane(app, "Memory");
      await until(`!!document.querySelector('[aria-label="New note"]')`, "the memory");
      await js(`t.fill('[aria-label="New note"]', "Buy tea")`);
      await js(`t.fill('[aria-label="New observation"]', "Prefers mornings")`);
      await press('[data-section="triggers"]', "New feed trigger…");
      await js(`t.fill('[aria-label="Repository"]', "acme/app")`);
      await js(`t.fill('[aria-label="Instruction"]', "Look at it")`);
      expect(await js(drafts)).toEqual(typed);
      // Escape goes back to the chat.
      await js(`document.querySelector('[aria-label="New note"]').focus(), t.key("Escape"), true`);
      await until(`!document.querySelector('[data-pane="memory"]') && !!t.box()`, "the chat");
      await reopen();
      // The Feed.
      await js(`document.querySelector("[data-open-feed]").click(), true`);
      await until(`!!document.querySelector('[data-pane="feed"]')`, "the Feed");
      await reopen();
      // Another dot, then back.
      await js(`document.querySelector('[data-dot="dio"]').click(), true`);
      await until(
        `!document.querySelector('[aria-label="New note"]')?.value`,
        "dio's pane without jojo's drafts",
      );
      await js(`document.querySelector('[data-dot="jojo"]').click(), true`);
      await reopen();
      expect(mutations(fake, "/dots/jojo/memory")).toEqual([]);
      // Add sends the note once and clears it; Cancel discards the trigger; the observation stays.
      await press('[data-section="notes"]', "Add");
      await until(
        `document.querySelector('[aria-label="New note"]').value === ""`,
        "the sent note",
      );
      await press('[data-section="triggers"]', "Cancel");
      await until(`!document.querySelector('[aria-label="Instruction"]')`, "the discarded trigger");
      expect(mutations(fake, "/dots/jojo/memory").map((call) => [call.method, call.body])).toEqual([
        ["POST", { text: "Buy tea" }],
      ]);
      await js(`t.cmd("1"), true`);
      await until(`!document.querySelector('[data-pane="memory"]')`, "the chat");
      await js(`t.cmd("2"), true`);
      await until(`!!document.querySelector('[aria-label="New note"]')`, "jojo's memory");
      expect(await js(drafts)).toEqual({
        note: "",
        observation: "Prefers mornings",
        instruction: undefined,
        repository: undefined,
      });
    },
  );
}, 170_000);

test("Memory: a new note, observation or feed trigger held out goes once, though Memory is left and opened again, and the newer draft stays", async () => {
  await scenario(
    "memory-held",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press } = app;
      const posts = () =>
        mutations(fake, "/dots/jojo/memory")
          .filter((call) => call.method === "POST")
          .map((call) => [call.path, call.body]);
      const drafts = `(() => ({
        note: document.querySelector('[aria-label="New note"]')?.value,
        observation: document.querySelector('[aria-label="New observation"]')?.value,
        instruction: document.querySelector('[aria-label="Instruction"]')?.value,
      }))()`;
      const buttons = `[["notes", "Add"], ["observed", "Add"], ["triggers", "Save draft"]].map(([section, label]) => t.button(label, document.querySelector('[data-section="' + section + '"]')))`;
      await openPane(app, "Memory");
      await until(`!!document.querySelector('[aria-label="New note"]')`, "the memory");
      await js(`t.fill('[aria-label="New note"]', "Buy tea")`);
      await js(`t.fill('[aria-label="New observation"]', "Prefers mornings")`);
      await press('[data-section="triggers"]', "New feed trigger…");
      await js(`(() => {
        const select = document.querySelector('[aria-label="Responsibility"]');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "2");
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await js(`t.fill('[aria-label="Repository"]', "acme/app")`);
      await js(
        `[...document.querySelectorAll('[data-section="triggers"] fieldset label')].find((l) => l.textContent.includes("Mentioned")).querySelector("input").click(), true`,
      );
      await js(`t.fill('[aria-label="Instruction"]', "Look at it")`);
      // The daemon holds each create's answer.
      const hold = Promise.withResolvers<void>();
      fake.data.memoryHold = hold.promise;
      await press('[data-section="notes"]', "Add");
      await press('[data-section="observed"]', "Add");
      await press('[data-section="triggers"]', "Save draft");
      for (let tick = 0; tick < 50 && posts().length < 3; tick++) await delay(100);
      const sent = [
        ["/dots/jojo/memory/notes", { text: "Buy tea" }],
        ["/dots/jojo/memory/observations", { text: "Prefers mornings" }],
        [
          "/dots/jojo/memory/triggers",
          { responsibility: 2, repository: "acme/app", reasons: ["Mentioned"], task: "Look at it" },
        ],
      ];
      expect(posts()).toEqual(sent);
      // Leave Memory and open it again while they're out, and type on.
      await js(`t.cmd("1"), true`);
      await until(`!document.querySelector('[data-pane="memory"]')`, "the chat");
      await js(`t.cmd("2"), true`);
      await until(`!!document.querySelector('[aria-label="Instruction"]')`, "the reopened memory");
      await js(`t.fill('[aria-label="New note"]', "Buy tea and milk")`);
      await js(`t.fill('[aria-label="New observation"]', "Prefers early mornings")`);
      await js(`t.fill('[aria-label="Instruction"]', "Look at it closely")`);
      // Each is still sending: its button stays off, and submitting its form or pressing again
      // sends nothing.
      expect(await js(`${buttons}.map((button) => button.disabled)`)).toEqual([true, true, true]);
      await js(`(() => {
        for (const label of ["New note", "New observation"]) {
          const form = document.querySelector('[aria-label="' + label + '"]').form;
          form.requestSubmit();
          form.requestSubmit();
        }
        for (const button of ${buttons}) button.click();
        return true;
      })()`);
      await delay(500);
      expect(posts()).toEqual(sent);
      // Once answered, the newer drafts stay unsent and the buttons come back.
      hold.resolve();
      fake.data.memoryHold = undefined;
      await until(
        `${buttons}.every((button) => !button.disabled)`,
        "the answered creates in the reopened pane",
      );
      expect(await js(drafts)).toEqual({
        note: "Buy tea and milk",
        observation: "Prefers early mornings",
        instruction: "Look at it closely",
      });
      await delay(500);
      expect(posts()).toEqual(sent);
    },
  );
}, 170_000);

test("Memory: a refused edit shows beside the value now, edits send only changed fields, and confirmations gate every change", async () => {
  await scenario(
    "memory",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press } = app;
      await openPane(app, "Memory");
      await until(`!!document.querySelector('[data-note="1"]')`, "the note");
      await until(`document.body.innerText.includes("Daily budget note.")`, "the budget note");
      // A note edit refused with 409 keeps the owner's text beside the current one, unretried.
      await press('[data-note="1"]', "Edit");
      await js(`t.fill('[data-note="1"] textarea', "Likes green tea")`);
      await press('[data-note="1"]', "Save");
      await until(`!!document.querySelector('[data-rejected="note:1"]')`, "the rejected edit");
      const rejected = await js(`document.querySelector('[data-rejected="note:1"]').innerText`);
      expect(rejected).toContain("Your rejected edit (not saved)");
      expect(rejected).toContain("Likes green tea");
      expect(rejected).toContain("Likes coffee");
      expect(mutations(fake, "/dots/jojo/memory/notes/1")).toEqual([
        {
          method: "PATCH",
          path: "/dots/jojo/memory/notes/1",
          body: { version: 1, text: "Likes green tea" },
        },
      ]);
      await press('[data-rejected="note:1"]', "Discard rejected edit");
      // A responsibility edit sends only the field the owner changed, with its version.
      await press('[data-responsibility="2"]', "Edit");
      await js(`t.fill('[data-responsibility="2"] textarea', "Publish docs")`);
      await press('[data-responsibility="2"]', "Save");
      for (
        let tick = 0;
        tick < 50 && !mutations(fake, "/dots/jojo/memory/responsibilities/2").length;
        tick++
      )
        await delay(100);
      expect(mutations(fake, "/dots/jojo/memory/responsibilities/2")[0]?.body).toEqual({
        version: 3,
        nextAction: "Publish docs",
      });
      // Forget asks first; Forget and Delete Sources deletes from the archive too.
      await press('[data-observation="4"]', "Forget…");
      await until(
        `document.querySelector("[role=alertdialog]")?.innerText.includes("Forget this observation?")`,
        "the forget dialog",
      );
      await press("[role=alertdialog]", "Cancel");
      expect(mutations(fake, "/dots/jojo/memory/observations")).toEqual([]);
      await press('[data-observation="4"]', "Forget…");
      await press("[role=alertdialog]", "Forget and Delete Sources");
      for (
        let tick = 0;
        tick < 50 && !mutations(fake, "/dots/jojo/memory/observations").length;
        tick++
      )
        await delay(100);
      expect(
        mutations(fake, "/dots/jojo/memory/observations").map((call) => [call.method, call.path]),
      ).toEqual([["DELETE", "/dots/jojo/memory/observations/4?version=1&sources=true"]]);
      // Watch approval, grant revoke and trigger enable each wait for their confirmation.
      await press('[data-supervision="5"]', "Approve…");
      await press("[role=alertdialog]", "Approve");
      await press('[data-grant="6"]', "Revoke…");
      await press("[role=alertdialog]", "Revoke");
      await press('[data-trigger="7"]', "Enable…");
      await until(
        `document.querySelector("[role=alertdialog]")?.innerText.includes("sent unchanged")`,
        "the trigger text",
      );
      await press("[role=alertdialog]", "Enable");
      for (
        let tick = 0;
        tick < 50 && mutations(fake, "/dots/jojo/memory/triggers").length < 1;
        tick++
      )
        await delay(100);
      expect(fake.data.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "PATCH /dots/jojo/memory/notes/1",
        "PATCH /dots/jojo/memory/responsibilities/2",
        "DELETE /dots/jojo/memory/observations/4?version=1&sources=true",
        "POST /dots/jojo/memory/supervisions/5/approve",
        "DELETE /dots/jojo/memory/grants/6",
        "POST /dots/jojo/memory/triggers/7/enable",
      ]);
      expect(fake.data.calls.at(-1)?.body).toEqual({ revision: "a".repeat(64) });
      // Requests load older by their cursor; recall finds an archived message to delete.
      await press('[data-section="requests"]', "Show requests");
      await press('[data-section="requests"]', "Load older");
      await until(`document.querySelectorAll("[data-request]").length === 2`, "both requests");
      await js(`t.fill('[aria-label="Recall"] input', "tea")`);
      await press('[aria-label="Recall"]', "Recall");
      await press('[data-recall="message"]', "Delete from Archive…");
      await press("[role=alertdialog]", "Delete");
      for (let tick = 0; tick < 50 && !mutations(fake, "/dots/jojo/memory/archive").length; tick++)
        await delay(100);
      expect(mutations(fake, "/dots/jojo/memory/archive")).toEqual([
        { method: "DELETE", path: "/dots/jojo/memory/archive/msg_a", body: null },
      ]);
      // A reminder's repeat changes alone, keeping its time and the version it started from.
      await press('[data-reminder="3"]', "Change time");
      await js(`t.fill('[data-reminder="3"] input[inputmode=numeric]', "90")`);
      await press('[data-reminder="3"]', "Save");
      for (
        let tick = 0;
        tick < 50 && !mutations(fake, "/dots/jojo/memory/reminders/3").length;
        tick++
      )
        await delay(100);
      expect(mutations(fake, "/dots/jojo/memory/reminders/3")).toEqual([
        {
          method: "PATCH",
          path: "/dots/jojo/memory/reminders/3",
          body: { version: 1, everyMinutes: 90 },
        },
      ]);
    },
  );
}, 170_000);

test("Memory: an edit begun at v1 conflicts after a read shows v2, an unanswered save keeps its draft, and a save in flight takes no typing", async () => {
  await scenario(
    "memory-drafts",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.data.noteConflictOnce = false;
    },
    async (app) => {
      const { fake, js, until, press } = app;
      await openPane(app, "Memory");
      await until(`!!document.querySelector('[data-note="1"]')`, "the note");
      await press('[data-note="1"]', "Edit");
      await js(`t.fill('[data-note="1"] textarea', "Likes oolong")`);
      // Another client changes the note; leaving and reopening Memory reads version 2.
      const memory = fake.data.memory;
      memory.notes = [
        { ...memory.notes[0], version: 2, text: "Likes coffee" } as (typeof memory.notes)[number],
      ];
      await js(`t.cmd("1"), true`);
      await until(`!document.querySelector('[data-pane="memory"]')`, "the chat");
      await js(`t.cmd("2"), true`);
      await until(
        `document.querySelector('[data-note="1"] .item-text')?.textContent === "Likes coffee"`,
        "version 2",
      );
      expect(await js(`document.querySelector('[data-note="1"] textarea').value`)).toBe(
        "Likes oolong",
      );
      // Save names the version the edit began from, so the daemon refuses it.
      await press('[data-note="1"]', "Save");
      await until(`!!document.querySelector('[data-rejected="note:1"]')`, "the conflict");
      expect(mutations(fake, "/dots/jojo/memory/notes/1").map((call) => call.body)).toEqual([
        { version: 1, text: "Likes oolong" },
      ]);
      expect(memory.notes[0]?.text).toBe("Likes coffee");
      // A responsibility save the daemon never answers keeps the draft and its version.
      await press('[data-responsibility="2"]', "Edit");
      await js(`t.fill('[data-responsibility="2"] textarea', "Publish docs")`);
      fake.stop();
      await press('[data-responsibility="2"]', "Save");
      await until(`!!document.querySelector('[data-row-error="responsibility:2"]')`, "the failure");
      await until(`!t.button("Saving…")`, "the save to end");
      expect(await js(`document.querySelector('[data-responsibility="2"] textarea')?.value`)).toBe(
        "Publish docs",
      );
      fake.start();
      await app.found();
      // Held: the editor takes no typing, and the save sends what it held.
      const hold = Promise.withResolvers<void>();
      fake.data.memoryHold = hold.promise;
      await press('[data-responsibility="2"]', "Save");
      await until(
        `document.querySelector('[data-responsibility="2"] textarea')?.readOnly === true`,
        "the frozen editor",
      );
      await js(`t.fill('[data-responsibility="2"] textarea', "Typed while saving")`);
      await delay(200);
      expect(await js(`document.querySelector('[data-responsibility="2"] textarea').value`)).toBe(
        "Publish docs",
      );
      fake.data.memoryHold = undefined;
      hold.resolve();
      await until(`!document.querySelector('[data-responsibility="2"] textarea')`, "the save");
      expect(
        mutations(fake, "/dots/jojo/memory/responsibilities/2").map((call) => call.body),
      ).toEqual([{ version: 3, nextAction: "Publish docs" }]);
      // Search notes searches the notes alone, beside Recall.
      await js(`t.fill('[aria-label="Search jojo\\'s notes"]', "coffee")`);
      await press('[aria-label="Search notes"]', "Search notes");
      await until(`!!document.querySelector('[data-note-match="1"]')`, "the matching note");
      // A new trigger names its reasons in the daemon's words.
      await press('[data-section="triggers"]', "New feed trigger…");
      await js(`(() => {
        const select = document.querySelector('[aria-label="Responsibility"]');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "2");
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await js(`t.fill('[aria-label="Repository"]', "acme/app")`);
      await js(
        `[...document.querySelectorAll('[data-section="triggers"] fieldset label')].find((l) => l.textContent.includes("Mentioned")).querySelector("input").click(), true`,
      );
      await js(`t.fill('[aria-label="Instruction"]', "Look at it")`);
      await press('[data-section="triggers"]', "Save draft");
      for (let tick = 0; tick < 50 && !mutations(fake, "/dots/jojo/memory/triggers").length; tick++)
        await delay(100);
      expect(mutations(fake, "/dots/jojo/memory/triggers")).toEqual([
        {
          method: "POST",
          path: "/dots/jojo/memory/triggers",
          body: {
            responsibility: 2,
            repository: "acme/app",
            reasons: ["Mentioned"],
            task: "Look at it",
          },
        },
      ]);
    },
  );
}, 170_000);

test("Instructions: the draft survives panes and Escape, a conflict keeps it, and Overwrite uses the conflict's revision", async () => {
  await scenario(
    "instructions",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press } = app;
      await until(`!!t.box()`, "the chat");
      await js(`t.box().focus(), t.cmd("3"), true`);
      await until(`!!document.querySelector(".instructions-editor")`, "the editor");
      await js(`t.fill(".instructions-editor", "# jojo\\nBe brief.\\n")`);
      await until(`!!document.querySelector("[data-unsaved]")`, "Unsaved changes");
      await js(`document.querySelector(".instructions-editor").focus(), t.key("Escape"), true`);
      await until(`!document.querySelector(".instructions-editor") && !!t.box()`, "the chat again");
      await js(`t.box().focus(), t.cmd("3"), true`);
      await until(
        `document.querySelector(".instructions-editor")?.value === "# jojo\\nBe brief.\\n"`,
        "the kept draft",
      );
      await press(".instructions .pane-head", "Save");
      await until(`!!document.querySelector(".conflict")`, "the conflict");
      expect(await js(`document.querySelector(".instructions-editor").value`)).toBe(
        "# jojo\nBe brief.\n",
      );
      await press(".conflict", "Overwrite");
      await until(
        `!document.querySelector(".conflict") && !document.querySelector("[data-unsaved]")`,
        "the save",
      );
      expect(mutations(fake, "/dots/jojo/instructions").map((call) => call.body)).toEqual([
        { content: "# jojo\nBe brief.\n", revision: "1".repeat(64) },
        { content: "# jojo\nBe brief.\n", revision: "2".repeat(64) },
      ]);
      // A save answered with something that isn't instructions is unknown: the draft stays.
      fake.data.malformedOnce = true;
      await js(`t.fill(".instructions-editor", "# jojo\\nBe briefer.\\n")`);
      await press(".instructions .pane-head", "Save");
      await until(
        `document.querySelector(".instructions")?.innerText.includes("Couldn't confirm whether that was saved")`,
        "the unknown save",
      );
      expect(await js(`document.querySelector(".instructions-editor").value`)).toBe(
        "# jojo\nBe briefer.\n",
      );
      expect(await js(`!!document.querySelector("[data-unsaved]")`)).toBe(true);
    },
  );
}, 170_000);

test("Library exports through the save dialog only, Health reads, and Start Fresh forces only after a second answer", async () => {
  await scenario(
    "library",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press, state } = app;
      await openPane(app, "Library");
      await press('[data-artifact="9"]', "Export…");
      await until(
        `document.querySelector('[data-artifact="9"]').innerText.includes("It wasn't opened.")`,
        "the export",
      );
      const recorded = (await state()).recorded as Recorded & {
        saves: { name: string; bytes: number }[];
      };
      expect(recorded.saves).toEqual([{ name: "report.md", bytes: 5 }]);
      expect(recorded.openExternal).toEqual([]);
      await openPane(app, "Health");
      await until(`!!document.querySelector('[data-health="daemon"]')`, "the health check");
      await until(
        `document.querySelector('[data-section="cache"]')?.innerText.includes("25% from cache") && !!document.querySelector("[data-cache-alarm]")`,
        "the dot's prompt cache use and alarm",
      );
      await openPane(app, "Start Fresh…");
      await press("[role=alertdialog]", "Start Fresh");
      await until(
        `document.querySelector("[role=alertdialog]")?.innerText.includes("in the middle of a turn")`,
        "the busy refusal",
      );
      expect(mutations(fake, "/dots/jojo/fresh").map((call) => call.body)).toEqual([{}]);
      await press("[role=alertdialog]", "Start Fresh Anyway");
      for (let tick = 0; tick < 50 && mutations(fake, "/dots/jojo/fresh").length < 2; tick++)
        await delay(100);
      expect(mutations(fake, "/dots/jojo/fresh").map((call) => call.body)).toEqual([
        {},
        { force: true },
      ]);
      await js(`t.cmd("1"), true`);
      await until(
        `!!t.box() && !document.querySelector('[data-message="m1"]')`,
        "the fresh session",
      );
    },
  );
}, 170_000);

test("OpenCode server: Health shows its status, Start runs the binary, and Stop runs only once the owner confirms", async () => {
  const directory = mkdtempSync(join(scratch, "opencode-fake-"));
  const log = join(directory, "log");
  const serverState = join(directory, "state");
  writeFileSync(serverState, "stopped");
  const binary = join(directory, "opencode2");
  writeFileSync(
    binary,
    `#!/bin/sh
echo "$*" >> '${log}'
case "$2" in
  status) if [ "$(cat '${serverState}')" = running ]; then echo "running http://127.0.0.1:4999"; else echo stopped; fi ;;
  start) echo running > '${serverState}'; echo "http://127.0.0.1:4999" ;;
  stop) echo stopped > '${serverState}' ;;
esac
`,
  );
  chmodSync(binary, 0o755);
  const calls = () => (existsSync(log) ? Bun.file(log).text() : Promise.resolve(""));
  await scenario(
    "opencode",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { until, press, state, command } = app;
      const server = '[data-section="opencode"]';
      await openPane(app, "Health");
      await until(`!!document.querySelector('[data-opencode-state="stopped"]')`, "stopped");
      await press(server, "Start");
      await until(
        `document.querySelector('${server}').innerText.includes("Running at http://127.0.0.1:4999")`,
        "running after Start",
      );
      await until(
        `!!document.querySelector('[data-opencode-last="ok"]')?.innerText.includes("http://127.0.0.1:4999")`,
        "Start's output",
      );
      // Stop asks first; a Cancel runs nothing.
      await press(server, "Stop…");
      const asked = async () =>
        ((await state()).recorded as Recorded & { confirms: string[] }).confirms;
      for (let tick = 0; tick < 50 && (await asked()).length < 1; tick++) await delay(100);
      expect(await asked()).toEqual(["stop"]);
      await delay(300);
      expect((await calls()).includes("service stop")).toBe(false);
      await command({ confirm: true });
      await press(server, "Stop…");
      await until(`!!document.querySelector('[data-opencode-state="stopped"]')`, "stopped again");
      expect(await asked()).toEqual(["stop", "stop"]);
      const ran = (await calls()).split("\n").filter(Boolean);
      expect(ran.filter((line) => line !== "service status")).toEqual([
        "service start",
        "service stop",
      ]);
      expect(ran.every((line) => /^service (status|start|stop)$/.test(line))).toBe(true);
    },
    { OPEN_DOT_OPENCODE: binary },
  );
}, 170_000);

test("Slack: a typed token goes once and is cleared, and pickup takes only a matching copy made after arming", async () => {
  const bot = ["xoxb", "1111111111", "2222222222222", "a".repeat(24)].join("-");
  const typed = ["xoxb", "3333333333", "4444444444444", "c".repeat(24)].join("-");
  await scenario(
    "slack",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press, state } = app;
      await openPane(app, "Slack");
      await until(`!!document.querySelector('[data-secret="bot"]')`, "the bot token field");
      await js(`t.fill('[data-secret="bot"]', ${JSON.stringify(typed)})`);
      await js(
        `t.button("Save", document.querySelector('[data-secret="bot"]').parentElement).click(), true`,
      );
      for (let tick = 0; tick < 50 && !mutations(fake, "/dots/jojo/slack/tokens").length; tick++)
        await delay(100);
      expect(mutations(fake, "/dots/jojo/slack/tokens")).toEqual([
        { method: "POST", path: "/dots/jojo/slack/tokens", body: { kind: "bot", token: typed } },
      ]);
      expect(await js(`document.querySelector('[data-secret="bot"]').value`)).toBe("");
      // A copy made before arming isn't taken; after arming, a wrong copy is ignored and the bot
      // token is taken once and cleared.
      await app.clipboard("before");
      await press('[data-pane="slack"]', "Pick up bot token");
      await until(`!!document.querySelector("[data-pickup-status]")`, "the armed pickup");
      await app.clipboard("not a token");
      await until(
        `document.querySelector("[data-pickup-status]")?.innerText.includes("wasn't one")`,
        "the ignored copy",
      );
      await app.clipboard(bot);
      for (let tick = 0; tick < 80 && mutations(fake, "/dots/jojo/slack/tokens").length < 2; tick++)
        await delay(100);
      expect(mutations(fake, "/dots/jojo/slack/tokens").at(-1)?.body).toEqual({
        kind: "bot",
        token: bot,
      });
      const clipboard = (
        (await state()) as State & { clipboard: { clears: number; text?: string } }
      ).clipboard;
      expect(clipboard.clears).toBe(1);
      expect(mutations(fake, "/dots/jojo/slack/tokens").length).toBe(2);
      // No token reached the page.
      expect(await js(`document.documentElement.outerHTML.includes(${JSON.stringify(bot)})`)).toBe(
        false,
      );
    },
  );
  // Nothing the app wrote holds a token.
  const written = Bun.spawnSync(["grep", "-rl", "xoxb-", join(scratch, "slack", "app-data")]);
  expect(written.stdout.toString()).toBe("");
}, 170_000);

test("Slack: leaving the view while a copy is read, or Stop while it's cleared, sends nothing", async () => {
  const bot = ["xoxb", "1111111111", "2222222222222", "a".repeat(24)].join("-");
  await scenario(
    "slack-cancel",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press, state, command } = app;
      const clipboard = async () =>
        ((await state()) as State & { clipboard: { held: number; clears: number } }).clipboard;
      const waitHeld = async (count: number) => {
        for (let tick = 0; tick < 100 && (await clipboard()).held < count; tick++) await delay(50);
        expect((await clipboard()).held).toBe(count);
      };
      await openPane(app, "Slack");
      // The copy's read is held; the owner leaves the Slack view before it returns.
      await press('[data-pane="slack"]', "Pick up bot token");
      await until(`!!document.querySelector("[data-pickup-status]")`, "the armed pickup");
      await command({ clipboardHold: "text" });
      await app.clipboard(bot);
      await waitHeld(1);
      await js(`t.cmd("1"), true`);
      await until(`!document.querySelector('[data-pane="slack"]')`, "the chat");
      await command({ clipboardRelease: true });
      await delay(1_000);
      expect(mutations(fake, "/dots/jojo/slack/tokens")).toEqual([]);
      expect((await clipboard()).clears).toBe(0);
      // The copy's clear is held; the owner stops the pickup before it returns.
      await openPane(app, "Slack");
      await press('[data-pane="slack"]', "Pick up bot token");
      await until(`!!t.button("Stop pickup")`, "the armed pickup again");
      await command({ clipboardHold: "clear" });
      await app.clipboard(bot);
      await waitHeld(2);
      await press('[data-pane="slack"]', "Stop pickup");
      await command({ clipboardRelease: true });
      await delay(1_000);
      expect(mutations(fake, "/dots/jojo/slack/tokens")).toEqual([]);
      expect(await js(`document.documentElement.outerHTML.includes(${JSON.stringify(bot)})`)).toBe(
        false,
      );
    },
  );
}, 170_000);

test("Slack: tokens for another app wait in their fields while asked, and go once only on a timely Replace it", async () => {
  const bot = ["xoxb", "5555555555", "6666666666666", "d".repeat(24)].join("-");
  const other = ["xapp", "1", "AOTHER01", "7777777777", "e".repeat(64)].join("-");
  await scenario(
    "slack-replace",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press } = app;
      const links = () => mutations(fake, "/dots/jojo/slack/link");
      const cleared = `document.querySelector('[data-secret="linkBot"]').value === "" && document.querySelector('[data-secret="linkApp"]').value === ""`;
      const enter = async () => {
        await js(`t.fill('[data-secret="linkBot"]', ${JSON.stringify(bot)})`);
        await js(`t.fill('[data-secret="linkApp"]', ${JSON.stringify(other)})`);
        await press('[data-pane="slack"]', "Connect this app");
        await until(`!!document.querySelector("[role=alertdialog]")`, "the replace question");
      };
      await openPane(app, "Slack");
      await until(`!!document.querySelector('[data-secret="linkBot"]')`, "the link fields");
      // Cancel drops both tokens.
      await enter();
      await press("[role=alertdialog]", "Cancel");
      await until(cleared, "both fields cleared by Cancel");
      // Replace it more than 2 minutes after asking sends nothing and drops both.
      await enter();
      await js(`(() => {
        const real = Date.now;
        window.realNow = real;
        Date.now = () => real() + 121_000;
        return true;
      })()`);
      await press("[role=alertdialog]", "Replace it");
      await js(`(Date.now = window.realNow), true`);
      await until(cleared, "both fields cleared after 2 minutes");
      await until(`document.body.innerText.includes("Nothing was sent")`, "the late answer");
      // Replace it with the field now naming the bound app's own token sends nothing too.
      await enter();
      await js(
        `t.fill('[data-secret="linkApp"]', ${JSON.stringify(other.replace("AOTHER01", "AJOJO01"))})`,
      );
      await press("[role=alertdialog]", "Replace it");
      await until(cleared, "both fields cleared after the token changed");
      await delay(500);
      expect(links()).toEqual([]);
      // A timely answer sends both once, naming the app replaced.
      await enter();
      await press("[role=alertdialog]", "Replace it");
      for (let tick = 0; tick < 50 && !links().length; tick++) await delay(100);
      expect(links()).toEqual([
        {
          method: "POST",
          path: "/dots/jojo/slack/link",
          body: { bot, app: other, replaceAppID: "AJOJO01" },
        },
      ]);
      expect(await js(cleared)).toBe(true);
      expect(
        await js(
          `[${JSON.stringify(bot)}, ${JSON.stringify(other)}].some((token) => document.documentElement.outerHTML.includes(token))`,
        ),
      ).toBe(false);
    },
  );
  const written = Bun.spawnSync([
    "grep",
    "-rlE",
    "xoxb-|xapp-",
    join(scratch, "slack-replace", "app-data"),
  ]);
  expect(written.stdout.toString()).toBe("");
}, 170_000);

test("Slack: a pickup ends and sends nothing once the dot's app changes, armed, holding or asked to replace", async () => {
  const bot = ["xoxb", "8888888888", "9999999999999", "f".repeat(24)].join("-");
  const other = ["xapp", "1", "AOTHER01", "7777777777", "e".repeat(64)].join("-");
  await scenario(
    "slack-app-change",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
    },
    async (app) => {
      const { fake, js, until, press } = app;
      const secrets = () =>
        fake.data.calls.filter(
          (call) =>
            call.method === "POST" &&
            (call.path.startsWith("/dots/jojo/slack/link") ||
              call.path.startsWith("/dots/jojo/slack/tokens") ||
              call.path.startsWith("/slack/config")),
        );
      const arm = async (step: string) => {
        await until(
          `!document.querySelector('[data-pickup="${step}"]')?.disabled`,
          `the ${step} pickup`,
        );
        await js(`document.querySelector('[data-pickup="${step}"]').click(), true`);
        await until(`!!document.querySelector("[data-pickup-status]")`, `the armed ${step}`);
      };
      const notice = (text: string, label: string) =>
        until(
          `!!document.querySelector("[data-slack-notice]")?.innerText.includes(${JSON.stringify(text)})`,
          label,
        );
      // The daemon binds the dot to another app; the view finds it on its next refresh.
      const rebind = async (appID: string) => {
        const slack = fake.data.slack as { app: { appID: string } };
        slack.app.appID = appID;
        await notice("The dot's app changed", `the pickup stopped for ${appID}`);
      };
      const nothingSent = async () => {
        await delay(1_000);
        expect(secrets()).toEqual([]);
        expect(
          await js(
            `[${JSON.stringify(bot)}, ${JSON.stringify(other)}].some((token) => document.documentElement.outerHTML.includes(token))`,
          ),
        ).toBe(false);
      };
      await openPane(app, "Slack");
      await until(`!!document.querySelector('[data-pickup="linkBot"]')`, "the link pickup");

      // Armed for the bot token, which names no app: a new app stops it, and a later copy is left.
      await arm("linkBot");
      await rebind("AB2APP01");
      expect(await js(`!!document.querySelector("[data-pickup-status]")`)).toBe(false);
      await app.clipboard(bot);
      await nothingSent();
      expect(await js(`document.body.innerText.includes("Bot token held in memory only")`)).toBe(
        false,
      );

      // Holding the bot token: a new app drops it, so the app-level token can't follow it.
      await arm("linkBot");
      await app.clipboard(bot);
      await until(
        `document.body.innerText.includes("Bot token held in memory only")`,
        "the held bot token",
      );
      await rebind("AB3APP01");
      expect(await js(`document.body.innerText.includes("Bot token held in memory only")`)).toBe(
        false,
      );
      expect(
        await js(`window.openDot.pickup("jojo", "linkApp", null).then((state) => state.step)`),
      ).toBeNull();
      await app.clipboard(other);
      await nothingSent();

      // Asked whether the app-level token replaces the app: a new app ends it, and Replace it
      // sends nothing.
      await arm("linkBot");
      await app.clipboard(bot);
      await until(
        `document.body.innerText.includes("Bot token held in memory only")`,
        "the held bot token again",
      );
      await arm("linkApp");
      await app.clipboard(other);
      await until(`!!document.querySelector("[role=alertdialog]")`, "the replace question");
      await rebind("AB4APP01");
      if (await js(`!!document.querySelector("[role=alertdialog]")`))
        await press("[role=alertdialog]", "Replace it");
      await nothingSent();

      // The daemon's app changing before the view shows it ends the pickup at the pair's check.
      await arm("linkBot");
      await app.clipboard(bot);
      await until(
        `document.body.innerText.includes("Bot token held in memory only")`,
        "the held bot token once more",
      );
      await arm("linkApp");
      (fake.data.slack as { app: { appID: string } }).app.appID = "AB5APP01";
      await app.clipboard(other);
      await notice("The dot's app changed", "the pickup stopped at the pair's check");
      if (await js(`!!document.querySelector("[role=alertdialog]")`))
        await press("[role=alertdialog]", "Replace it");
      await nothingSent();
    },
  );
  const written = Bun.spawnSync([
    "grep",
    "-rlE",
    "xoxb-|xapp-",
    join(scratch, "slack-app-change", "app-data"),
  ]);
  expect(written.stdout.toString()).toBe("");
}, 170_000);

test("avatars: a failed read is asked for again, a deleted one clears, and Command-2 and Escape keep the draft", async () => {
  await scenario(
    "avatar",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.avatar = { revision: "a", failures: 1 };
    },
    async (app) => {
      const { fake, js, until } = app;
      const shown = `!!document.querySelector('[data-dot="jojo"] img.avatar')`;
      await until(shown, "the avatar after a failed read");
      expect(fake.avatarReads).toBe(2);
      fake.avatar = null;
      await until(`!${shown}`, "the deleted avatar cleared");
      fake.avatar = { revision: "b", failures: 0 };
      await until(shown, "the new avatar");
      // Memory opens over the chat and Escape goes back with the draft as it was.
      await until(`!!t.box()`, "the chat");
      await js(`t.fill("textarea", "half a thought"), true`);
      await js(`t.box().focus(), t.cmd("2"), true`);
      await until(`!!document.querySelector('[data-pane="memory"]')`, "Memory");
      await js(`t.key("Escape"), true`);
      await until(`!document.querySelector('[data-pane="memory"]') && !!t.box()`, "the chat again");
      expect(await js(`t.box().value`)).toBe("half a thought");
    },
  );
}, 120_000);

test("About you: suggestions show as plain untrusted text, one change goes at a time across dots, and a lost answer settles by the fact's ID without resending", async () => {
  await scenario(
    "owner-facts",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.others.set("dio", { messages: [], hold: undefined, reads: 0 });
    },
    async (app) => {
      const { fake, js, until, press } = app;
      const pending = '[data-owner-pending="11111111-1111-4111-8111-111111111111"]';
      await openPane(app, "Memory");
      await until(`!!document.querySelector(${JSON.stringify(pending)})`, "the suggestion");
      // Plain text, labelled as an untrusted suggestion with where it came from; no markup or links.
      expect(
        await js(`(() => {
          const row = document.querySelector(${JSON.stringify(pending)});
          return {
            text: row.querySelector(".item-text").textContent,
            label: row.querySelector(".note").textContent,
            markup: !!row.querySelector("b, a"),
          };
        })()`),
      ).toEqual({
        text: "Prefers <b>tea</b> [link](https://evil.example)",
        label:
          "Untrusted suggestion, not evidence it's true. Suggested by jojo, in session ses_jojo, message msg_suggest.",
        markup: false,
      });
      // An edit-and-approve draft is global: it survives showing another dot's memory.
      await press(pending, "Edit and approve");
      await js(
        `t.fill('[aria-label="Edit the suggestion before approving"]', "Prefers green tea.")`,
      );
      const held = Promise.withResolvers<void>();
      fake.data.owner.hold = held.promise;
      await press(pending, "Approve this text for every dot");
      await js(`document.querySelector('[data-dot="dio"]').click(), true`);
      await js(`t.cmd("2"), true`);
      await until(
        `document.querySelector('[aria-label="Edit the suggestion before approving"]')?.value === "Prefers green tea."`,
        "the same draft in dio's memory",
      );
      // While it's out, no other change to the owner's facts can start, from any dot.
      expect(
        await js(
          `[...document.querySelector('[data-section="owner"]').querySelectorAll("button")].filter((b) => /Approve|Reject|Add for every dot/.test(b.textContent) && !b.disabled).length`,
        ),
      ).toBe(0);
      held.resolve();
      fake.data.owner.hold = undefined;
      await until(`!!document.querySelector("[data-owner-approved]")`, "the approved fact");
      // A delete whose answer is lost: read by the fact's ID, found landed, and never resent.
      fake.data.owner.garbleOnce = true;
      await press("[data-owner-approved]", "Delete");
      await press('[role="alertdialog"]', "Delete");
      await until(`!document.querySelector("[data-owner-approved]")`, "the deleted fact");
      await until(`!document.querySelector("[data-owner-unknown]")`, "the settled change");
      expect(
        mutations(fake, "/owner/facts").map((call) => [
          call.method,
          (call.body as { action?: string } | null)?.action ?? null,
        ]),
      ).toEqual([
        ["PATCH", "approve"],
        ["DELETE", null],
      ]);
      expect(mutations(fake, "/owner/facts")[0]?.body).toMatchObject({
        version: 1,
        text: "Prefers green tea.",
      });
    },
  );
}, 170_000);

/** An owner fact's row, pending or approved. */
const factRow = (id: string) => `[data-owner-pending="${id}"], [data-owner-approved="${id}"]`;

test("About you: text typed for a fact rejected or deleted before or during its save stays shown across refreshes and dots until discarded, and nothing is sent again", async () => {
  const [p1, p2, a1, a2] = ["1", "2", "3", "4"].map(
    (digit) =>
      `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
  ) as [string, string, string, string];
  await scenario(
    "owner-orphans",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.others.set("dio", { messages: [], hold: undefined, reads: 0 });
      const [base] = fake.data.owner.facts;
      if (!base) throw new Error("No suggestion to start from.");
      fake.data.owner.facts.push(
        { ...base, id: p2, text: "Works late", origin: { ...base.origin, messageID: "msg_late" } },
        { ...base, id: a1, state: "approved", text: "Lives in KL", origin: null as never },
        { ...base, id: a2, state: "approved", text: "Drinks coffee", origin: null as never },
      );
    },
    async (app) => {
      const { fake, js, until, press } = app;
      // What the owner's CLI or API does meanwhile: the fact moves on and its text is cleared.
      const elsewhere = (id: string, state: "rejected" | "deleted") => {
        const fact = fake.data.owner.facts.find((known) => known.id === id);
        if (!fact) throw new Error(`No fact ${id}.`);
        Object.assign(fact, { state, text: null, version: fact.version + 1, lastMutationID: null });
      };
      const draft = async (id: string, label: string, text: string) => {
        await press(factRow(id), label);
        await js(
          `t.fill(${JSON.stringify(`[data-editing="owner:${id}"] textarea`)}, ${JSON.stringify(text)})`,
        );
      };
      const orphans = `[...document.querySelectorAll("[data-owner-orphan]")].map((li) => [li.dataset.ownerOrphan, li.dataset.state, [...li.querySelectorAll("[data-owner-orphan-text]")].map((pre) => pre.textContent)])`;
      const showDot = async (dot: string) => {
        await js(`document.querySelector('[data-dot="${dot}"]').click(), true`);
        await js(`t.cmd("2"), true`);
        await until(`!!document.querySelector('[data-section="owner"]')`, `${dot}'s memory`);
      };
      await openPane(app, "Memory");
      await until(`!!document.querySelector(${JSON.stringify(factRow(a2))})`, "the facts");
      await draft(p1, "Edit and approve", "Prefers green tea.");
      await draft(p2, "Edit and approve", "Works early.");
      await draft(a1, "Edit", "Lives in Penang.");
      await draft(a2, "Edit", "Drinks decaf.");

      // Deleted before Save, saved before the next read: refused, and the text stays shown.
      elsewhere(a2, "deleted");
      await press(factRow(a2), "Save for every dot");
      await until(
        `document.querySelector('[data-owner-orphan="${a2}"]')?.dataset.state === "deleted"`,
        "the text of the deleted fact",
      );
      // Rejected and deleted while their saves are out.
      for (const [id, label, state] of [
        [p1, "Approve this text for every dot", "rejected"],
        [a1, "Save for every dot", "deleted"],
      ] as const) {
        const held = Promise.withResolvers<void>();
        fake.data.owner.hold = held.promise;
        const before = mutations(fake, "/owner/facts").length;
        await press(factRow(id), label);
        for (let tick = 0; tick < 100 && mutations(fake, "/owner/facts").length === before; tick++)
          await Bun.sleep(50);
        elsewhere(id, state);
        held.resolve();
        fake.data.owner.hold = undefined;
        await until(
          `document.querySelector('[data-owner-orphan="${id}"]')?.dataset.state === ${JSON.stringify(state)}`,
          `the text of the ${state} fact`,
        );
      }
      // Rejected before Save: the next read, here from showing another dot, keeps the draft's text.
      elsewhere(p2, "rejected");
      await showDot("dio");
      await until(`!!document.querySelector('[data-owner-orphan="${p2}"]')`, "the rejected draft");
      expect(await js(`!!document.querySelector('[data-editing="owner:${p2}"]')`)).toBe(false);
      const shown = [
        [p1, "rejected", ["Prefers green tea."]],
        [p2, "rejected", ["Works early."]],
        [a1, "deleted", ["Lives in Penang."]],
        [a2, "deleted", ["Drinks decaf."]],
      ];
      expect(await js(orphans)).toEqual(shown);
      await showDot("jojo");
      await until(`${orphans}.length === 4`, "the texts in jojo's memory");
      expect(await js(orphans)).toEqual(shown);
      // Each save went once, at the version its edit started from; nothing was sent again.
      expect(
        mutations(fake, "/owner/facts").map((call) => [
          call.method,
          call.path,
          (call.body as { action?: string; version?: number }).action,
          (call.body as { version?: number }).version,
        ]),
      ).toEqual([
        ["PATCH", `/owner/facts/${a2}`, "edit", 1],
        ["PATCH", `/owner/facts/${p1}`, "approve", 1],
        ["PATCH", `/owner/facts/${a1}`, "edit", 1],
      ]);
      // Only the owner ends one: Discard drops it, and Put in Add a fact fills the field unsent.
      await press(`[data-owner-orphan="${a2}"]`, "Discard your text");
      await press(`[data-owner-orphan="${p1}"]`, "Put in Add a fact");
      await until(
        `document.querySelector('[aria-label="New fact about you, shared with every dot"]').value === "Prefers green tea." && !document.querySelector('[data-owner-orphan="${a2}"]')`,
        "the discarded text and the filled field",
      );
      expect(await js(`${orphans}.length`)).toBe(3);
      expect(mutations(fake, "/owner/facts")).toHaveLength(3);
    },
  );
}, 170_000);

test("request cards: answered from the chat and Needs you, Always only after its confirmation, and a sensitive one only in its terminal", async () => {
  await scenario(
    "requests",
    (fake) => {
      fake.messages = [{ id: "m1", kind: "dot", text: "Hello" }];
      fake.data.requests = [
        requestCard(1),
        requestCard(2, {
          source: "worker",
          worker: 3,
          sessionID: "ses_w3",
          title: "Fix the build",
          kind: "question",
          requestID: "que_2",
          detail: {
            kind: "question",
            title: "Which branch?",
            fields: [
              {
                key: "branch",
                type: "string",
                required: true,
                options: [
                  { value: "main", label: "Main" },
                  { value: "dev", label: "Dev" },
                ],
              },
              { key: "note", type: "string" },
            ],
          },
        }),
        requestCard(3, {
          kind: "question",
          requestID: "que_3",
          sensitive: true,
          detail: { kind: "question", title: "", fields: [] },
        }),
        requestCard(4),
        // Another question with a field of the same key, whose choices stay its own.
        requestCard(5, {
          kind: "question",
          requestID: "que_5",
          detail: {
            kind: "question",
            title: "Which branch to tag?",
            fields: [
              {
                key: "branch",
                type: "string",
                options: [
                  { value: "main", label: "Main" },
                  { value: "dev", label: "Dev" },
                ],
              },
            ],
          },
        }),
      ];
    },
    async ({ fake, js, until, press }) => {
      // The chat shows jojo's cards under its header, with untrusted text as text.
      await until(`document.querySelectorAll("[data-request]").length === 5`, "five cards");
      expect(await js(`!!document.querySelector('[data-request="1"] code b')`)).toBe(false);
      expect(await js(`document.querySelector('[data-request="1"] code').textContent`)).toBe(
        "<b>rm -rf build</b>",
      );
      expect(await js(`document.querySelector("[data-open-needs]").textContent`)).toBe(
        "Needs you (5)",
      );
      // A sensitive card offers only its terminal.
      expect(
        await js(
          `[...document.querySelectorAll('[data-request="3"] button')].map((b) => b.textContent)`,
        ),
      ).toEqual(["Open in terminal"]);
      await press('[data-request="3"]', "Open in terminal");
      for (let tick = 0; tick < 50 && !fake.data.opened.length; tick++) await delay(100);
      expect(fake.data.opened).toEqual([3]);
      // Allow once sends one answer, even clicked twice.
      await js(
        `(() => { const b = t.button("Allow once", document.querySelector('[data-request="1"]')); b.click(); b.click(); return true; })()`,
      );
      await until(`!document.querySelector('[data-request="1"]')`, "the answered card to go");
      expect(fake.data.answers).toHaveLength(1);
      expect(fake.data.answers[0]).toMatchObject({
        id: 1,
        body: { boundSessionID: "ses_jojo", revision: "rev_1", answer: { decision: "once" } },
      });
      // Always asks first, with Cancel first: Cancel sends nothing, then Always allow sends.
      await press('[data-request="4"]', "Always…");
      await until(
        `document.querySelector("[role=alertdialog]")?.innerText.includes("rm *")`,
        "the Always confirmation",
      );
      expect(
        await js(
          `[...document.querySelectorAll("[role=alertdialog] button")].map((b) => b.textContent)`,
        ),
      ).toEqual(["Cancel", "Always allow"]);
      await press("[role=alertdialog]", "Cancel");
      await delay(300);
      expect(fake.data.answers).toHaveLength(1);
      await press('[data-request="4"]', "Always…");
      await press("[role=alertdialog]", "Always allow");
      await until(`!document.querySelector('[data-request="4"]')`, "the Always card to go");
      expect(fake.data.answers[1]).toMatchObject({
        id: 4,
        body: { revision: "rev_4", answer: { decision: "always" }, confirmedAlways: true },
      });
      // Needs you lists the worker's question; Submit sends the whole form once it's complete.
      await js(`document.querySelector("[data-open-needs]").click(), true`);
      await until(`!!document.querySelector('[data-needs-pane] [data-request="2"]')`, "Needs you");
      await press('[data-request="2"]', "Submit");
      await until(
        `document.querySelector('[data-request="2"] [role=alert]')?.textContent === "branch needs an answer."`,
        "the required field's note",
      );
      expect(fake.data.answers).toHaveLength(2);
      const choose = (card: number, label: string) =>
        js(
          `[...document.querySelectorAll('[data-request="${card}"] label')].find((l) => l.textContent.trim() === "${label}").querySelector("input").click(), true`,
        );
      const chosen = (card: number) =>
        js(
          `[...document.querySelectorAll('[data-request="${card}"] label')].filter((l) => l.querySelector("input")?.checked).map((l) => l.textContent.trim())`,
        );
      await choose(2, "Dev");
      await choose(5, "Main");
      // Choosing on one card leaves the other card's choice as it was.
      await until(
        `[...document.querySelectorAll('[data-request="5"] input[type=radio]')].some((i) => i.checked)`,
        "the second card's choice",
      );
      expect(await chosen(2)).toEqual(["Dev"]);
      expect(await chosen(5)).toEqual(["Main"]);
      await press('[data-request="2"]', "Submit");
      await until(`!document.querySelector('[data-request="2"]')`, "the answered question to go");
      expect(fake.data.answers[2]).toMatchObject({
        id: 2,
        body: { answer: { decision: "reply", answer: { branch: "dev" } } },
      });
      // Escape goes back to the chat.
      await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true`);
      await until(`!document.querySelector("[data-needs-pane]") && !!t.box()`, "the chat");
    },
  );
});
