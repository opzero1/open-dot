// Launches the built app with hidden windows against a fake daemon in a temporary OPEN_DOT_HOME,
// then restarts that daemon mid-send: the app must reconnect and reconcile, never send again.
import { afterAll, beforeAll, expect, test } from "bun:test";
import electron from "electron";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let home: string;

beforeAll(() => {
  const build = Bun.spawnSync(["bun", join(root, "build.ts")], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  home = mkdtempSync(join(tmpdir(), "open-dot-app-smoke-"));
}, 180_000);

afterAll(() => rmSync(home, { recursive: true, force: true }));

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

const message = (id: string, kind: string, text: string, extra: object = {}) => ({
  id,
  sessionID: "ses_jojo",
  kind,
  hidden: false,
  text,
  tools: [],
  attachments: [],
  time: 1_700_000_000_000,
  reactions: [],
  ...extra,
});

const page = {
  sessionID: "ses_jojo",
  next: null,
  pending: [],
  recentEmojis: ["🧐", "✋", "👀", "🧠", "🔥"],
  clientMessageIDs: true,
  messages: [
    message("msg_owner", "owner", "Plan it"),
    message("msg_dot", "dot", sample),
    message("msg_peer", "peer", "From the other dot", { peer: "polnareff" }),
    message("msg_notice", "notice", "Reminder: stand-up"),
  ],
};

const dots = [
  {
    name: "jojo",
    purpose: "Second brain.",
    busy: true,
    avatar: null,
    workers: [
      {
        id: 7,
        state: "running",
        outcome: null,
        task: "Build it",
        needs: ["permission"],
        waiting: [],
        answered: null,
      },
    ],
    sessions: [],
  },
];

interface Seen {
  posts: { server: number; messageID: string; text: string }[];
  receipts: number;
  unauthorized: number;
}

/** A fake daemon: its own token, the saved send IDs it shares with its successor, and a hook. */
const daemon = (
  index: number,
  token: string,
  saved: Set<string>,
  seen: Seen,
  onPost: (body: { messageID: string; text: string }) => Response | Promise<Response>,
) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        seen.unauthorized++;
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/dots") return Response.json(dots);
      if (url.pathname === "/dots/jojo/messages" && request.method === "GET")
        return Response.json(page);
      if (url.pathname === "/dots/jojo/messages" && request.method === "POST") {
        const body = (await request.json()) as { messageID: string; text: string };
        seen.posts.push({ server: index, messageID: body.messageID, text: body.text });
        saved.add(body.messageID);
        return onPost(body);
      }
      const receipt = /^\/dots\/jojo\/pending\/([^/]+)$/.exec(url.pathname);
      if (receipt?.[1] && request.method === "GET") {
        seen.receipts++;
        const status = saved.has(receipt[1]) ? "sent" : "unknown";
        return Response.json({ id: receipt[1], sessionID: "ses_jojo", status });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

test("the hidden app renders safely, sends with its own ID and survives a daemon restart without resending", async () => {
  const opendot = join(home, "opendot");
  mkdirSync(opendot, { recursive: true });
  const saved = new Set<string>();
  const seen: Seen = { posts: [], receipts: 0, unauthorized: 0 };
  const publish = (port: number, token: string) =>
    writeFileSync(
      join(opendot, "api.json"),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, token }),
      {
        mode: 0o600,
      },
    );
  let second: ReturnType<typeof Bun.serve> | undefined;
  const first = daemon(1, "first-token", saved, seen, ({ messageID }) => {
    if (seen.posts.length === 1) return Response.json({ id: messageID }, { status: 202 });
    // The daemon saves the second send, then dies before answering, and comes back on a new port
    // with a new token.
    setTimeout(() => {
      void first.stop(true);
      setTimeout(() => {
        second = daemon(2, "second-token", saved, seen, ({ messageID: id }) =>
          Response.json({ id }, { status: 202 }),
        );
        publish(Number(second.port), "second-token");
      }, 1500);
    }, 50);
    return new Promise<Response>(() => {});
  });
  publish(Number(first.port), "first-token");

  const app = Bun.spawn([electron as unknown as string, join(root, "build")], {
    env: {
      ...process.env,
      HOME: home,
      OPEN_DOT_HOME: opendot,
      OPEN_DOT_APP_DATA: join(home, "app-data"),
      OPEN_DOT_APP_SMOKE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => app.kill(), 90_000);
  const output = await new Response(app.stdout).text();
  clearTimeout(killer);
  await app.exited;
  void second?.stop(true);
  const line = output.split("\n").find((text) => text.startsWith("SMOKE "));
  expect(line).toBeDefined();
  const report = JSON.parse(line?.slice("SMOKE ".length) ?? "{}") as Record<string, unknown>;

  if (report.error) console.error(JSON.stringify(report, null, 2));
  expect(report.error).toBeUndefined();
  expect(report.render).toEqual({
    table: true,
    task: true,
    math: true,
    code: true,
    diff: true,
    script: false,
    remoteImage: false,
    javascriptLink: false,
    workerRow: true,
    busy: true,
  });
  expect(report.violations).toEqual([]);
  // Nothing showed or focused a window, and the link click went to the default-browser policy.
  expect(report.recorded).toMatchObject({
    show: 0,
    focus: 0,
    openExternal: ["https://example.com/"],
  });
  // The lost send kept its draft, was reconciled by ID on the new daemon, and never sent again.
  expect(report.keptDraft).toBe("Second");
  expect(report.attempts).toEqual([]);
  expect(seen.posts.map((post) => post.text)).toEqual(["Hello", "Second"]);
  expect(seen.posts.every((post) => /^msg_[0-9A-Za-z]{26}$/.test(post.messageID))).toBe(true);
  expect(seen.posts.filter((post) => post.server === 2)).toEqual([]);
  expect(seen.receipts).toBeGreaterThan(0);
}, 150_000);
