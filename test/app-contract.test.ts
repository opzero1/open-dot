// The app's requests and answer shapes held against the daemon's real API: what the app sends is
// what the daemon parses, and what the daemon answers fits what main lets through to the renderer.
import { beforeEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { decoded, fits, shapes } from "../app/decode";
import { triggerReasons } from "../app/surfaces";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { dots, feed, reminders, responsibilities } from "../src/schema";

let db: Db;
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));

beforeEach(() => {
  db = openDatabase(":memory:");
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

const call = async (method: string, path: string, body?: unknown) => {
  const response = await api(
    db,
    "secret",
    down,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, value: text ? (JSON.parse(text) as unknown) : null };
};

test("a feed trigger the app's form makes is one the daemon accepts, with every reason it offers", async () => {
  db.insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Keep acme/app green",
      nextAction: "Watch reviews",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  // The body main builds for createTrigger, with each reason the form lists.
  for (const reason of triggerReasons) {
    const created = await call("POST", "/dots/jojo/memory/triggers", {
      responsibility: 1,
      repository: "acme/app",
      reasons: [reason],
      task: `Look at the ${reason} activity.`,
    });
    expect(created.status).toBeLessThan(300);
  }
  const all = await call("POST", "/dots/jojo/memory/triggers", {
    responsibility: 1,
    repository: "acme/app",
    reasons: [...triggerReasons],
    task: "Look at all of it.",
  });
  expect(all.status).toBeLessThan(300);
  const memory = await call("GET", "/dots/jojo/memory");
  expect(fits(memory.value, shapes.memory)).toBe(true);
});

test("the daemon's memory, search, recall, audit, feed and instructions answers fit what main passes on", async () => {
  db.insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Ship",
      nextAction: "Docs",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      schedule: { kind: "interval", everyMinutes: 60 },
    })
    .run();
  db.insert(reminders)
    .values({
      dot: "jojo",
      text: "Stand up",
      dueAt: 10,
      everyMinutes: null,
      state: "scheduled",
      createdAt: 1,
    })
    .run();
  db.insert(feed)
    .values({
      source: "github",
      sourceID: "1",
      reason: "Mentioned",
      title: "Fix it",
      context: "acme/app",
      url: null,
      updatedAt: 1,
      state: "unread",
      createdAt: 1,
    })
    .run();
  expect((await call("POST", "/dots/jojo/memory/notes", { text: "Likes green tea" })).status).toBe(
    201,
  );
  const reads = {
    memory: "/dots/jojo/memory",
    searchNotes: "/dots/jojo/memory/search?q=tea&limit=20",
    recall: "/dots/jojo/memory/recall?q=tea&offset=0",
    archiveStatus: "/dots/jojo/memory/archive",
    requests: "/dots/jojo/requests",
    feed: "/feed",
    runs: "/dots/jojo/memory/responsibilities/1/runs",
  } as const;
  for (const [op, path] of Object.entries(reads) as [keyof typeof reads, string][]) {
    const answer = await call("GET", path);
    expect({ op, status: answer.status }).toEqual({ op, status: 200 });
    expect({ op, fits: fits(answer.value, shapes[op]) }).toEqual({ op, fits: true });
  }
  const search = await call("GET", reads.searchNotes);
  expect(search.value).toMatchObject({ results: [{ id: 1, version: 1 }] });
});

test("an answer that doesn't fit is an error for a read and an unknown outcome for a change", () => {
  expect(decoded("saveInstructions", "PUT", { ok: true, value: {} })).toMatchObject({
    ok: false,
    lost: true,
  });
  expect(decoded("memory", "GET", { ok: true, value: { notes: "x" } })).toMatchObject({
    ok: false,
  });
  expect(decoded("memory", "GET", { ok: true, value: { notes: "x" } })).not.toHaveProperty("lost");
  expect(decoded("editNote", "PATCH", { ok: true, value: true })).toEqual({
    ok: true,
    value: true,
  });
  const conflict = { ok: false as const, error: "Changed.", status: 409, current: { text: "x" } };
  expect(decoded("editNote", "PATCH", conflict)).toBe(conflict);
});
