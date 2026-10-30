// Launches the built app with hidden windows against a fake daemon in a temporary OPEN_DOT_HOME and
// drives it through main's smoke driver: no window is shown or focused, clipboard and share are
// recorded instead of used, and every daemon is a fake on loopback with a throwaway token.
import { afterAll, beforeAll, expect, test } from "bun:test";
import electron from "electron";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const sessionID = "ses_jojo";
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
  stallNext = false;
  stalled = 0;
  stalledDone = 0;
  // Answers the stalled read, with the state it had when it arrived.
  release: (() => void) | undefined;
  // While set, every other message read waits for it.
  hold: Promise<void> | undefined;
  onPost: ((body: Post) => Response | Promise<Response> | undefined) | undefined;
  onPut: ((id: string, part: string) => Response | Promise<Response> | undefined) | undefined;
  index = 0;
  server: ReturnType<typeof Bun.serve> | undefined;
  log = {
    posts: [] as Post[],
    puts: [] as { id: string; part: string; body: Record<string, unknown> }[],
    stops: [] as number[],
    staleCursors: 0,
    receipts: 0,
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
      sessionID,
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
    if (path === "/dots")
      return Response.json([
        {
          name: "jojo",
          purpose: "Second brain.",
          busy: this.busy,
          avatar: null,
          workers: this.workers,
          sessions: [],
        },
      ]);
    if (path === "/dots/jojo/messages" && method === "GET") {
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      let end = this.messages.length;
      if (before !== null) {
        const cursor = /^c\.(\d+)\.(\d+)$/.exec(before);
        if (!cursor || Number(cursor[1]) !== index || this.failOlder) {
          if (cursor && Number(cursor[1]) !== index) this.log.staleCursors++;
          return Response.json({ error: "Invalid conversation cursor. Refresh." }, { status: 400 });
        }
        end = Number(cursor[2]);
        await delay(this.olderDelay);
      }
      const start = Math.max(0, end - limit);
      const page = {
        messages: this.messages.slice(start, end).map((item, at) => this.view(item, start + at)),
        sessionID,
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
      const status = this.receipts.get(receipt[1]) ?? "unknown";
      return Response.json({ id: receipt[1], sessionID, status });
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
  attempts: { messageID: string }[];
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
  return { fake, js, until, state, press, menu, found, close, temporary };
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
