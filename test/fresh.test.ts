import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Model } from "@opencode/client/effect";
import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";
import { type Db, openDatabase } from "../src/db";
import { createDot, ensureSession, findDot } from "../src/dots";
import { handoff, startFresh } from "../src/fresh";
import type { OpenCode } from "../src/opencode";
import {
  type Dot,
  dots,
  notes,
  outbox,
  reminders,
  responsibilities,
  type Route,
  slackThreads,
  workers,
} from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;
let dot: Dot;

const run = <A, E>(effect: Effect.Effect<A, E, OpenCode>) =>
  Effect.runPromise(Effect.result(Effect.provide(effect, fake.layer)));

beforeEach(async () => {
  process.env.OPEN_DOT_HOME = mkdtempSync(join(tmpdir(), "open-dot-test-"));
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  const created = Effect.runSync(createDot(db, "jojo", "Help."));
  await run(ensureSession(db, created));
  dot = findDot(db, "jojo") as Dot;
  fake.state.created = [];
});

const route = (sessionID: string): Route => ({
  kind: "shared",
  dot: "jojo",
  sessionID,
  owner: "U1",
  team: "T1",
  bot: "B1",
  dm: true,
  channel: "D1",
  thread: "1.1",
});

test("a fresh start rebinds the dot, moves what's pending and keeps its memory", async () => {
  const old = dot.sessionID;
  fake.state.models.set(old, Model.Ref.parse("openai/gpt-6.1"));
  db.insert(notes).values({ dot: "jojo", text: "Keep this.", createdAt: 1 }).run();
  db.insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Ship the release.",
      nextAction: "Check the build on Friday.",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(responsibilities)
    .values({
      dot: "jojo",
      goal: "Continueactualacceptance ATTEMPT4 nowexplicitmiddlewareaccepts preservingnodesedges SAMEcommittedbytesdigest",
      nextAction: "x",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(workers)
    .values({
      dot: "jojo",
      task: "Write the report.",
      directory: "/tmp",
      sessionID: "ses_worker",
      state: "running",
      createdAt: 1,
    })
    .run();
  db.insert(outbox)
    .values([
      {
        sessionID: old,
        messageID: "msg_waiting",
        text: "hi",
        state: "pending",
        createdAt: 1,
        route: route(old),
      },
      {
        sessionID: old,
        messageID: "msg_started",
        text: "hi",
        state: "pending",
        createdAt: 1,
        startedAt: 2,
      },
      {
        sessionID: old,
        messageID: "msg_admitted",
        text: "hi",
        state: "pending",
        createdAt: 1,
        startedAt: 2,
      },
      { sessionID: old, messageID: "msg_done", text: "hi", state: "sent", createdAt: 1 },
    ])
    .run();
  fake.state.messages.add("msg_admitted");
  db.insert(reminders)
    .values({
      dot: "jojo",
      text: "Later.",
      dueAt: 9e12,
      state: "scheduled",
      createdAt: 1,
      route: route(old),
    })
    .run();
  db.insert(slackThreads)
    .values({ key: "k", route: route(old), oldest: "1.1", newest: "1.1", activeAt: 1 })
    .run();

  const result = await run(startFresh(db, "jojo", false, Date.UTC(2026, 9, 29)));

  expect(Result.isSuccess(result)).toBe(true);
  const fresh = findDot(db, "jojo");
  expect(fresh?.sessionID).not.toBe(old);
  expect(fresh?.freshSessionID).toBeNull();
  expect(fake.state.created).toEqual([
    {
      id: String(fresh?.sessionID),
      directory: dot.directory,
      title: "Dot: jojo",
      model: Model.Ref.parse("openai/gpt-6.1"),
    },
  ]);
  expect(fake.state.titles.get(old)).toBe("jojo (archived 2026-10-29)");
  const rows = new Map(
    db
      .select()
      .from(outbox)
      .all()
      .map((row) => [row.messageID, row]),
  );
  expect(rows.get("msg_waiting")).toMatchObject({ sessionID: fresh?.sessionID, state: "pending" });
  expect(rows.get("msg_waiting")?.route?.sessionID).toBe(fresh?.sessionID);
  expect(rows.get("msg_started")).toMatchObject({ sessionID: fresh?.sessionID, startedAt: null });
  expect(rows.get("msg_admitted")).toMatchObject({ sessionID: old, state: "sent" });
  expect(rows.get("msg_done")).toMatchObject({ sessionID: old });
  expect(db.select().from(reminders).get()?.route?.sessionID).toBe(fresh?.sessionID);
  expect(db.select().from(slackThreads).get()?.route.sessionID).toBe(fresh?.sessionID);
  expect(db.select().from(notes).all()).toHaveLength(1);

  const seeded = db
    .select()
    .from(outbox)
    .all()
    .find((row) => row.sessionID === fresh?.sessionID && row.delivery === "steer");
  expect(seeded?.text).toContain(`session ${old}`);
  expect(seeded?.text).toContain("Ship the release. Next action: Check the build on Friday.");
  expect(seeded?.text).toContain("Worker #1, running, in session ses_worker: Write the report.");
  expect(seeded?.text).not.toContain("Continueactualacceptance");
  expect(seeded?.text).toContain("Some items aren't listed here.");
});

test("a busy dot is refused unless forced", async () => {
  fake.state.active.add(dot.sessionID);
  const refused = await run(startFresh(db, "jojo", false));
  expect(Result.isFailure(refused) && refused.failure).toMatchObject({ status: 409 });
  expect(findDot(db, "jojo")?.sessionID).toBe(dot.sessionID);
  expect(fake.state.created).toEqual([]);

  const forced = await run(startFresh(db, "jojo", true));
  expect(Result.isSuccess(forced)).toBe(true);
  expect(findDot(db, "jojo")?.sessionID).not.toBe(dot.sessionID);
});

test("a failed creation keeps the old session and a retry reuses a session that appeared", async () => {
  fake.state.create = "fail";
  const failed = await run(startFresh(db, "jojo", false));
  expect(Result.isFailure(failed) && failed.failure).toMatchObject({ status: 502 });
  expect(findDot(db, "jojo")).toMatchObject({ sessionID: dot.sessionID, freshSessionID: null });
  expect(db.select().from(outbox).all()).toEqual([]);

  // A lost answer: the ID stays saved, and the next attempt finds the session by it.
  db.update(dots).set({ freshSessionID: "ses_saved" }).where(eq(dots.name, "jojo")).run();
  fake.state.sessions.add("ses_saved");
  fake.state.create = "ok";
  const retried = await run(startFresh(db, "jojo", false));
  expect(Result.isSuccess(retried)).toBe(true);
  expect(findDot(db, "jojo")).toMatchObject({ sessionID: "ses_saved", freshSessionID: null });
  expect(fake.state.created).toEqual([]);
});

test("the handoff says so when there's nothing open", () => {
  const note = handoff(db, "jojo", "ses_old");
  expect(note.text).toContain("You have no open responsibilities.");
  expect(note.text).toContain("dot_search_notes");
  expect(note).toMatchObject({ responsibilities: 0, workers: 0, omitted: 0 });
});
