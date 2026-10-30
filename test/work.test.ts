import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "effect";
import { api, groupWork, workCounts } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import { type ToolCall, toolCall, toolDetail, type WorkItem } from "../src/opencode";
import { dots } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

const token = `ghp_${"a".repeat(36)}`;
const at = (ms: number) => DateTime.makeUnsafe(ms);

type Part = Parameters<typeof toolCall>[1];
const part = (fields: { id?: string; name: string; state: unknown; done?: boolean }): Part =>
  // The installed client's tool part, built as a test fixture from plain JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ({
    type: "tool",
    id: fields.id ?? "call_1",
    name: fields.name,
    state: fields.state,
    time: { created: at(1_000), ran: at(1_500), ...(fields.done ? { completed: at(4_000) } : {}) },
  }) as Part;

test("tool parts project to statuses, short labels and reported line counts", () => {
  const running = toolCall(
    "msg_1",
    part({
      name: "bash",
      state: { status: "running", input: { command: "bun test\nmore" }, metadata: {} },
    }),
  );
  expect(running).toMatchObject({
    callID: "call_1",
    status: "running",
    label: "bun test",
    startedAt: 1_500,
    endedAt: null,
  });
  expect(
    toolCall("msg_1", part({ name: "bash", state: { status: "streaming", input: '{"comm' } })),
  ).toMatchObject({ status: "preparing", label: "" });
  const edit = toolCall(
    "msg_1",
    part({
      name: "edit",
      done: true,
      state: {
        status: "completed",
        input: { path: "src/a.ts", oldString: "a", newString: "b" },
        content: [{ type: "text", text: "Edited" }],
        metadata: {
          files: [{ file: "src/a.ts", patch: "--- a\n+++ b\n", additions: 3, deletions: 1 }],
        },
      },
    }),
  );
  expect(edit).toMatchObject({
    status: "done",
    endedAt: 4_000,
    label: "src/a.ts",
    files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
  });
  // No reported diff: the counts are unknown, never zero.
  const write = toolCall(
    "msg_1",
    part({
      name: "write",
      done: true,
      state: {
        status: "completed",
        input: { path: "notes.md", content: "x" },
        content: [{ type: "text", text: "ok" }],
      },
    }),
  );
  expect(write.files).toEqual([{ path: "notes.md", additions: null, deletions: null }]);
  const failed = toolCall(
    "msg_1",
    part({
      name: "bash",
      state: {
        status: "error",
        input: { command: `curl -H "x: ${token}"` },
        error: { type: "x", message: "no" },
      },
    }),
  );
  expect(failed.status).toBe("error");
  expect(failed.label).not.toContain(token);
  expect(failed.label).toContain("[redacted]");
});

test("tool detail is redacted whole before it is cut, and missing patches stay unavailable", () => {
  // The secret straddles the 64 KiB cut: cutting first would leave part of it behind.
  const output = `${"x".repeat(64 * 1024 - 10)} ${token} tail`;
  const detail = toolDetail(
    "msg_1",
    part({
      name: "bash",
      done: true,
      state: {
        status: "completed",
        input: { command: "env", password: "hunter2" },
        content: [{ type: "text", text: output }],
      },
    }),
  );
  expect(detail.output).not.toContain("ghp_");
  expect(detail.output?.length).toBeLessThanOrEqual(64 * 1024 + 1);
  expect(detail.truncated).toBe(true);
  expect(detail.input).not.toContain("hunter2");
  expect(detail.patches).toEqual([]);
  const structured = toolDetail(
    "msg_1",
    part({
      name: "edit",
      done: true,
      state: {
        status: "error",
        input: { path: "a.ts", oldString: `key ${token}`, newString: "b", api_key: "plain" },
        error: { type: "x", message: `failed with ${token}` },
        metadata: {
          files: [{ file: "a.ts", patch: `+${token}\n`, additions: 1, deletions: 0 }, { file: 7 }],
        },
      },
    }),
  );
  expect(JSON.stringify(structured)).not.toContain("ghp_");
  expect(structured.input).toContain('"api_key": "[redacted]"');
  // A one-time code, a numeric one and everything beneath a credential's key are dropped too.
  const codes = toolDetail(
    "msg_1",
    part({
      name: "login",
      done: true,
      state: {
        status: "completed",
        input: {
          otp: "123456",
          step: { totp: 654321, user: "afif" },
          credentials: { value: "s3cret-value", list: ["hunter2"] },
          headers: [{ name: "x", passcode: "4242" }],
        },
        content: [{ type: "text", text: "ok" }],
      },
    }),
  );
  for (const secret of ["123456", "654321", "s3cret-value", "hunter2", "4242"])
    expect(codes.input).not.toContain(secret);
  expect(codes.input).toContain('"user": "afif"');
  expect(structured.error).toContain("[redacted]");
  // A malformed record is dropped, never guessed.
  expect(structured.patches).toEqual([
    { path: "a.ts", additions: 1, deletions: 0, patch: "+[redacted]\n" },
  ]);
});

const call = (
  messageID: string,
  callID: string,
  name = "bash",
  status: ToolCall["status"] = "done",
  path?: string,
): ToolCall => ({
  messageID,
  callID,
  name,
  status,
  startedAt: null,
  endedAt: null,
  label: path ?? callID,
  files: path ? [{ path, additions: 1, deletions: 0 }] : [],
});
const message = (
  id: string,
  role: "user" | "assistant",
  shown: boolean,
  calls: ToolCall[] = [],
): WorkItem => ({
  type: "message",
  id,
  role,
  shown,
  calls,
});
const idle = (id: string): WorkItem => ({ type: "idle", id });

test("work groups by turn between idles, under the turn's last reply, with shared inputs", () => {
  const items = [
    message("msg_u1", "user", true),
    message("msg_a1", "assistant", false, [
      call("msg_a1", "c1"),
      call("msg_a1", "c2", "edit", "done", "a.ts"),
    ]),
    // A second input steered into the same turn.
    message("msg_u2", "user", true),
    message("msg_a2", "assistant", true, [
      call("msg_a2", "c3", "edit", "done", "a.ts"),
      call("msg_a2", "c4", "edit", "error", "b.ts"),
    ]),
    message("msg_a3", "assistant", true),
    idle("idle_1"),
    message("msg_u3", "user", true),
    message("msg_a4", "assistant", false, [call("msg_a4", "c5", "bash", "running")]),
  ];
  const latest = groupWork(items, { startKnown: true, latest: true });
  expect(latest).toHaveLength(2);
  expect(latest[0]).toMatchObject({
    anchor: "msg_a3",
    complete: true,
    open: false,
    counts: { commands: 1, edits: 3, edited: 1, failed: 1, total: 4 },
  });
  expect(latest[0]?.calls.map((item) => item.callID)).toEqual(["c1", "c2", "c3", "c4"]);
  // The running turn has no reply yet: it goes under the owner's message.
  expect(latest[1]).toMatchObject({ anchor: "msg_u3", open: true, complete: true });
  // An older page leaves the turn its newer neighbor ends to that page.
  expect(groupWork(items, { startKnown: false, latest: false })).toHaveLength(1);
  expect(groupWork(items, { startKnown: false, latest: false })[0]?.complete).toBe(false);
  // The same call twice counts once.
  expect(workCounts([call("m", "x"), call("m", "y")]).total).toBe(2);
  expect(
    groupWork(
      [
        message("m", "assistant", true, [call("m", "x")]),
        message("m", "assistant", true, [call("m", "x")]),
      ],
      {
        startKnown: true,
        latest: true,
      },
    )[0]?.counts.total,
  ).toBe(1);
});

let db: Db;
let home: string;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "open-dot-work-"));
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const get = async (path: string) => {
  const response = await api(
    db,
    "secret",
    fake.layer,
  )(new Request(`http://127.0.0.1${path}`, { headers: { authorization: "Bearer secret" } }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const entry = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  role,
  text,
  tools: [],
  files: [],
  time: 0,
});

test("the conversation carries each turn's log, reading back across pages for a cut turn's start", async () => {
  // Thirty tool-only steps before the reply: the latest page can't hold the turn's start.
  const history = [entry("msg_u0", "user", "earlier"), entry("msg_a0", "assistant", "done before")];
  fake.state.idles.add("msg_a0");
  history.push(entry("msg_u1", "user", "go"));
  for (let index = 0; index < 30; index++) {
    history.push(entry(`msg_t${index}`, "assistant", ""));
    fake.state.calls.set(`msg_t${index}`, [call(`msg_t${index}`, `c${index}`)]);
  }
  history.push(entry("msg_a1", "assistant", "All done"));
  fake.state.idles.add("msg_a1");
  fake.state.history.set("ses_jojo", history);
  const page = await get("/dots/jojo/messages?limit=2");
  expect(page.status).toBe(200);
  const work = page.body.work as {
    anchor: string;
    counts: { total: number };
    complete: boolean;
    more: string | null;
  }[];
  expect(work).toHaveLength(1);
  expect(work[0]).toMatchObject({
    anchor: "msg_a1",
    complete: true,
    more: null,
    counts: { total: 30 },
  });

  // A longer turn than two extra pages: the log says it is partial and continues by cursor.
  for (let index = 30; index < 80; index++) {
    history.splice(3, 0, entry(`msg_t${index}`, "assistant", ""));
    fake.state.calls.set(`msg_t${index}`, [call(`msg_t${index}`, `c${index}`)]);
  }
  const partial = await get("/dots/jojo/messages?limit=2");
  const log = (
    partial.body.work as { complete: boolean; more: string; counts: { total: number } }[]
  )[0];
  expect(log?.complete).toBe(false);
  expect(log?.counts.total).toBeLessThan(80);
  let more: string | null | undefined = log?.more;
  let total = log?.counts.total ?? 0;
  for (let reads = 0; more && reads < 10; reads++) {
    const next = await get(`/dots/jojo/work?sessionID=ses_jojo&cursor=${encodeURIComponent(more)}`);
    expect(next.status).toBe(200);
    total += (next.body.counts as { total: number }).total;
    more = next.body.more as string | null;
    if (!more) expect(next.body.complete).toBe(true);
  }
  expect(total).toBe(80);
  // A work cursor is no conversation cursor, and the reverse; a rebind refuses both.
  expect(
    (await get(`/dots/jojo/messages?before=${encodeURIComponent(log?.more ?? "")}`)).status,
  ).toBe(400);
  const before = page.body.next as string;
  expect(
    (await get(`/dots/jojo/work?sessionID=ses_jojo&cursor=${encodeURIComponent(before)}`)).status,
  ).toBe(400);
  expect(
    (await get(`/dots/jojo/work?sessionID=ses_other&cursor=${encodeURIComponent(log?.more ?? "")}`))
      .status,
  ).toBe(409);
});

test("tool detail and activity reads check the dot's binding and report what OpenCode says", async () => {
  fake.state.details.set(
    "msg_a1/call_1",
    toolDetail(
      "msg_a1",
      part({
        name: "bash",
        done: true,
        state: {
          status: "completed",
          input: { command: "ls" },
          content: [{ type: "text", text: "a\nb" }],
        },
      }),
    ),
  );
  const detail = await get("/dots/jojo/messages/msg_a1/tools/call_1?sessionID=ses_jojo");
  expect(detail.body).toMatchObject({ status: "done", input: "ls", output: "a\nb", label: "ls" });
  expect((await get("/dots/jojo/messages/msg_a1/tools/call_9?sessionID=ses_jojo")).status).toBe(
    404,
  );
  expect((await get("/dots/jojo/messages/msg_a1/tools/call_1?sessionID=ses_old")).status).toBe(409);
  expect((await get("/dots/jojo/messages/msg_a1/tools/call_1")).status).toBe(400);

  expect((await get("/dots/jojo/activity?sessionID=ses_jojo")).body).toMatchObject({
    state: "idle",
    since: null,
  });
  fake.state.activity.set("ses_jojo", { active: true, running: [], since: 5_000 });
  expect((await get("/dots/jojo/activity?sessionID=ses_jojo")).body).toMatchObject({
    state: "thinking",
    since: 5_000,
  });
  fake.state.activity.set("ses_jojo", {
    active: true,
    running: [call("msg_a2", "c9", "bash", "running"), call("msg_a2", "c8", "read", "running")],
    since: 6_000,
  });
  expect((await get("/dots/jojo/activity?sessionID=ses_jojo")).body).toMatchObject({
    state: "tool",
    tool: "bash",
    label: "c9",
    running: 2,
    since: 6_000,
    observedAt: expect.any(Number),
  });
  expect((await get("/dots/jojo/activity?sessionID=ses_old")).status).toBe(409);
});
