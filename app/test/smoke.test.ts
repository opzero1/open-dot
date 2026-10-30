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
  files: number;
}

const worker = (id: number, state: string, needs: string[] = []) => ({
  id,
  state,
  outcome: null,
  task: `Task ${id}`,
  needs,
  waiting: [],
  answered: null,
});

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
          avatar: null,
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
      };
      this.log.posts.push(post);
      const hook = this.onPost?.(post);
      if (hook) return hook;
      const id =
        this.capable && !this.mismatch ? body.messageID : `msg_server${this.log.posts.length}`;
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
    return Response.json({ error: "Not found" }, { status: 404 });
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
const launch = async (name: string, setup: (fake: FakeDaemon) => void) => {
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
  return { fake, js, until, state, press, menu, found, close, temporary, shown };
};

type App = Awaited<ReturnType<typeof launch>>;

/** Runs a scenario and always closes the app; nothing may show or focus its window. */
const scenario = async (
  name: string,
  setup: (fake: FakeDaemon) => void,
  run: (app: App) => Promise<void>,
) => {
  const app = await launch(name, setup);
  try {
    await run(app);
    const { recorded, violations } = await app.state();
    expect(recorded.show).toBe(0);
    expect(recorded.focus).toBe(0);
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

test("Copy and Share are all or nothing, and pending, attachment and worker rows match the notch", async () => {
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

      // Pending rows offer Send now and Cancel as the notch does.
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
