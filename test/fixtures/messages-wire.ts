import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { OpenCode } from "../../src/opencode";

// The installed client's message pages, tool parts, single message reads and live activity, over
// fake HTTP only, with OpenCode 2.2.0's wire shapes.
const home = process.env.OPEN_DOT_HOME;
assert(home && home.startsWith(join(process.cwd(), ".research/messages-wire-")));
assert.equal(process.env.XDG_STATE_HOME, join(home, "state"));
const sessionID = "ses_wireMessages";
const created = 1_700_000_000_000;
const time = { created };
const model = { id: "fixture-model", providerID: "fixture" };
const otp = "918273";
const tool = (id: string, name: string, state: unknown, done = true) => ({
  type: "tool",
  id,
  name,
  state,
  time: { created, ran: created + 10, ...(done ? { completed: created + 20 } : {}) },
});
const turn = [
  { id: "msg_w01", time, type: "user", text: "Fix it" },
  { id: "msg_w02", time, type: "compaction", status: "completed", reason: "auto", summary: "x" },
  {
    id: "msg_w03",
    time,
    type: "assistant",
    agent: "build",
    model,
    content: [
      { type: "reasoning", text: "private thoughts" },
      tool("call_bash", "bash", {
        status: "completed",
        input: { command: "bun test", otp },
        content: [{ type: "text", text: "12 pass" }],
        metadata: { exit: 0 },
      }),
      tool("call_edit", "edit", {
        status: "completed",
        input: { filePath: "src/a.ts", oldString: "a", newString: "b" },
        content: [{ type: "text", text: "Edited" }],
        metadata: {
          files: [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1 }],
        },
      }),
      tool("call_write", "write", {
        status: "error",
        input: { filePath: "notes.md", content: "x" },
        error: { type: "denied", message: "No" },
      }),
      tool(
        "call_run",
        "bash",
        { status: "running", input: { command: "sleep 9" }, metadata: {} },
        false,
      ),
      tool("call_new", "read", { status: "streaming", input: '{"filePa' }, false),
    ],
  },
];
// Filler, then the turn, then a reply and its idle: 25 items, so pages of 20 run short.
const history = [
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `msg_f${String(i).padStart(2, "0")}`,
    time,
    type: "user",
    text: `Filler ${i}`,
  })),
  ...turn,
  {
    id: "msg_w04",
    time,
    type: "assistant",
    agent: "build",
    model,
    content: [{ type: "text", text: "Done" }],
  },
  { id: "msg_w05", time, type: "idle", outcome: "succeeded" },
];
const requests: string[] = [];
let slow = false;
let huge: "length" | "stream" | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.2.0", pid: process.pid });
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/session/active") {
      if (slow) await Bun.sleep(7_000);
      return Response.json({ data: { [sessionID]: { type: "running" } } });
    }
    const one = /^\/api\/session\/[^/]+\/message\/([^/]+)$/.exec(url.pathname);
    if (one) {
      if (huge === "length")
        return new Response("x".repeat(17 * 1024 * 1024), {
          headers: { "content-type": "application/json" },
        });
      if (huge === "stream") {
        // No length: the bound has to count the bytes as they come.
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent > 20 * 1024 * 1024) return controller.close();
              sent += 1024 * 1024;
              controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const item = history.find((entry) => entry.id === one[1]);
      return item
        ? Response.json({ data: item })
        : Response.json(
            { _tag: "MessageNotFoundError", sessionID, messageID: one[1], message: "Absent" },
            { status: 404 },
          );
    }
    assert.equal(url.pathname, `/api/session/${sessionID}/message`);
    const cursor = url.searchParams.get("cursor");
    assert.equal(url.searchParams.get("order"), cursor ? null : "desc");
    const offset = cursor ? Number(cursor.replace("opaque/", "")) : 0;
    const limit = Number(url.searchParams.get("limit"));
    const data = history.toReversed().slice(offset, offset + limit);
    // Like OpenCode, a page names its next cursor whenever it has items, short or not.
    return Response.json({
      data,
      cursor: { next: data.length ? `opaque/${offset + data.length}` : undefined },
    });
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, server.url.origin, "non-fixture network access forbidden");
    return nativeFetch(input, init);
  },
  nativeFetch,
);
const run = <A>(effect: Effect.Effect<A, unknown, OpenCode>) =>
  Effect.runPromise(effect.pipe(Effect.provide(OpenCode.layer)));
const fails = (effect: Effect.Effect<unknown, unknown, OpenCode>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(OpenCode.layer),
      Effect.match({ onFailure: () => true, onSuccess: () => false }),
    ),
  );

const checks: string[] = [];
try {
  await mkdir(join(home, "state/opencode"), { recursive: true });
  await Bun.write(
    join(home, "state/opencode/service.json"),
    JSON.stringify({ id: "fixture", version: "2.2.0", pid: process.pid, url: server.url.origin }),
  );
  const pages = await run(
    Effect.gen(function* () {
      const code = yield* OpenCode;
      const first = yield* code.messagePage(sessionID, 20);
      const short = yield* code.messagePage(sessionID, 20, first.next);
      const empty = yield* code.messagePage(sessionID, 20, short.next);
      return { first, short, empty };
    }),
  );
  assert.equal(pages.first.next, "opaque/20");
  assert.equal(pages.short.work?.length, 5);
  assert.equal(pages.short.next, "opaque/25");
  assert.deepEqual(pages.empty.work, []);
  assert.equal(pages.empty.next, undefined);
  checks.push("a short page keeps its next cursor; only an empty page ends");

  const work = [...(pages.short.work ?? []), ...(pages.first.work ?? [])];
  assert.deepEqual(
    work.slice(-5).map((item) => item.type),
    ["message", "compaction", "message", "message", "idle"],
  );
  checks.push("compaction and idle items reach the work log");
  const reply = work.find((item) => item.id === "msg_w03");
  assert(reply?.type === "message");
  assert.equal(reply.shown, false);
  assert.deepEqual(
    reply.calls.map((call) => [call.callID, call.name, call.status]),
    [
      ["call_bash", "bash", "done"],
      ["call_edit", "edit", "done"],
      ["call_write", "write", "error"],
      ["call_run", "bash", "running"],
      ["call_new", "read", "preparing"],
    ],
  );
  const [bash, edit, write] = reply.calls;
  assert.equal(bash?.label, "bun test");
  assert.equal(bash?.startedAt, created + 10);
  assert.equal(bash?.endedAt, created + 20);
  assert.deepEqual(edit?.files, [{ path: "src/a.ts", additions: 1, deletions: 1 }]);
  assert.deepEqual(write?.files, [{ path: "notes.md", additions: null, deletions: null }]);
  assert(!JSON.stringify(work).includes("private thoughts"));
  checks.push("2.2.0 tool parts project to statuses, labels, files and times, without reasoning");

  const single = await run(
    Effect.gen(function* () {
      const code = yield* OpenCode;
      const item = yield* code.workItem({ sessionID, messageID: "msg_w03" });
      const gone = yield* code.workItem({ sessionID, messageID: "msg_gone" });
      const detail = yield* code.toolDetail({ sessionID, messageID: "msg_w03" }, "call_bash");
      const diff = yield* code.toolDetail({ sessionID, messageID: "msg_w03" }, "call_edit");
      return { item, gone, detail, diff };
    }),
  );
  assert(single.item?.type === "message");
  assert.equal(single.item.calls.length, 5);
  assert.equal(single.gone, undefined);
  assert.equal(single.detail?.output, "12 pass");
  assert(!single.detail?.input?.includes(otp));
  assert.equal(single.diff?.patches[0]?.patch, "@@ -1 +1 @@\n-a\n+b\n");
  checks.push("one message and one call read by ID, redacted, with the reported diff");

  const now = await run(
    Effect.gen(function* () {
      return yield* (yield* OpenCode).activity(sessionID);
    }),
  );
  assert.equal(now.active, true);
  checks.push("activity reads the running session");

  huge = "length";
  assert(
    await fails(
      Effect.flatMap(OpenCode, (code) => code.workItem({ sessionID, messageID: "msg_w03" })),
    ),
  );
  huge = "stream";
  assert(
    await fails(
      Effect.flatMap(OpenCode, (code) => code.workItem({ sessionID, messageID: "msg_w03" })),
    ),
  );
  huge = undefined;
  checks.push("an answer over the byte bound is refused, with or without its length");

  slow = true;
  const started = Date.now();
  assert(await fails(Effect.flatMap(OpenCode, (code) => code.activity(sessionID))));
  assert(Date.now() - started < 6_500);
  checks.push("a read past its deadline fails");
  console.log(JSON.stringify({ checks }));
} finally {
  await server.stop(true);
}
