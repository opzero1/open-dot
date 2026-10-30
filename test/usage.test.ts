import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import { captureDatabase, parseReport } from "../src/doctor";
import type { HistoryItem, Tokens } from "../src/opencode";
import { dots, usageDays } from "../src/schema";
import { alarmSteps, dayStart, dotUsage, usageAll } from "../src/usage";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

const now = Date.now();

beforeEach(() => {
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

const history = (sessionID = "ses_jojo") => {
  const items = fake.state.items.get(sessionID) ?? [];
  fake.state.items.set(sessionID, items);
  return items;
};

let next = 0;
const add = (type: HistoryItem["type"], tokens?: Partial<Tokens>, complete = true) => {
  const id = `msg_${String(next++).padStart(4, "0")}`;
  history().push({
    id,
    type,
    text: "",
    time: now,
    complete,
    ...(tokens
      ? {
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            ...tokens,
          },
        }
      : {}),
  });
  return id;
};

const healthy = { input: 10, output: 100, reasoning: 5, cacheRead: 40_000, cacheWrite: 2_000 };
const regressed = { input: 10, output: 100, reasoning: 0, cacheRead: 36_600, cacheWrite: 110_000 };

/** A turn: the owner's message, then its steps, then the idle that ends it. */
const turn = (...steps: Partial<Tokens>[]) => {
  add("user");
  for (const step of steps) add("assistant", step);
  add("idle");
};

const pass = () => Effect.runPromise(Effect.provide(usageAll(db), fake.layer));
const today = () =>
  db
    .select()
    .from(usageDays)
    .where(eq(usageDays.day, dayStart(now)))
    .get();

test("only steps after the walk first reaches the end count, each once, however many passes run", async () => {
  turn(healthy, healthy);
  await pass();
  expect(today()).toBeUndefined();
  turn(healthy, healthy, healthy);
  await pass();
  await pass();
  expect(today()).toMatchObject({
    steps: 3,
    input: 30,
    output: 300,
    reasoning: 15,
    cacheRead: 120_000,
    cacheWrite: 6_000,
  });
  expect(dotUsage(db, "jojo", now)).toMatchObject({
    counting: true,
    alarm: false,
    days: [{ steps: 3, hitPercent: 95 }],
  });
});

test("a step OpenCode hasn't finished is counted once it finishes, never before", async () => {
  await pass();
  add("user");
  add("assistant", healthy);
  const running = add("assistant", { output: 1 }, false);
  await pass();
  expect(today()?.steps).toBe(1);
  const item = history().find((entry) => entry.id === running);
  if (!item) throw new Error("no item");
  Object.assign(item, { complete: true, tokens: { ...healthy, output: 7 } });
  add("idle");
  await pass();
  await pass();
  expect(today()).toMatchObject({ steps: 2, output: 107 });
});

test("several heavy steps after a turn's first raise the alarm; first steps neither raise nor clear it", async () => {
  await pass();
  // A turn's first step writes the new input, however much, and doesn't count toward the alarm.
  turn(regressed, regressed, regressed);
  await pass();
  expect(dotUsage(db, "jojo", now)).toMatchObject({ streak: 2, alarm: false });
  turn(regressed, regressed);
  await pass();
  expect(dotUsage(db, "jojo", now)).toMatchObject({ streak: alarmSteps, alarm: true });

  const report = () => {
    const snapshot = captureDatabase(db.$client, now);
    return snapshot.cache;
  };
  expect(report()).toMatchObject({
    id: "cache",
    status: "failed",
    counts: { dots: 1, steps: 5, alarmed: 1, cacheRead: 5 * 36_600, cacheWrite: 5 * 110_000 },
  });
  expect(report()?.nextStep).toContain("OpenCode upgrade");

  // The daemon's report passes through doctor's allowlist unchanged in its counts.
  const parsed = parseReport({
    schemaVersion: 1,
    checkedAt: now,
    sampledAt: now,
    checks: [report()],
  });
  expect(parsed?.checks.get("cache")?.counts).toEqual(report()?.counts);

  // One healthy step after a turn's first clears it.
  turn(regressed, healthy);
  await pass();
  expect(dotUsage(db, "jojo", now)).toMatchObject({ streak: 0, alarm: false });
  expect(report()).toMatchObject({ status: "healthy", counts: { alarmed: 0, steps: 7 } });
});

test("a rebound dot starts afresh on its new session, and its old streak no longer counts", async () => {
  await pass();
  turn(healthy, regressed, regressed, regressed);
  await pass();
  expect(dotUsage(db, "jojo", now).alarm).toBe(true);
  db.update(dots).set({ sessionID: "ses_fresh" }).where(eq(dots.name, "jojo")).run();
  expect(captureDatabase(db.$client, now).cache).toMatchObject({ counts: { alarmed: 0 } });
  fake.state.items.set("ses_fresh", [
    { id: "msg_new", type: "user", text: "", time: now, complete: true },
  ]);
  await pass();
  expect(dotUsage(db, "jojo", now)).toMatchObject({ streak: 0, alarm: false, counting: true });
  // The day's steps stay the dot's.
  expect(today()?.steps).toBe(4);
});

test("a cursor whose item is gone starts the walk afresh without counting anything again", async () => {
  turn(healthy);
  for (let i = 0; i < 200; i++) add("other");
  await pass();
  turn(healthy, healthy);
  await pass();
  expect(today()?.steps).toBe(2);
  // OpenCode drops the history the cursor named, as a revert might.
  fake.state.items.set("ses_jojo", history().slice(0, 3));
  await pass();
  await pass();
  expect(today()?.steps).toBe(2);
  turn(healthy);
  await pass();
  expect(today()?.steps).toBe(3);
});

test("GET /dots/<name>/usage gives the week's days and the alarm, and refuses parameters", async () => {
  await pass();
  turn(healthy, healthy);
  await pass();
  const handler = api(db, "secret", fake.layer);
  const get = (path: string) =>
    handler(
      new Request(`http://127.0.0.1${path}`, { headers: { authorization: "Bearer secret" } }),
    );
  const answer = await get("/dots/jojo/usage");
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ alarm: false, days: [{ steps: 2 }] });
  expect((await get("/dots/jojo/usage?days=30")).status).toBe(400);
  expect((await get("/dots/nobody/usage")).status).toBe(404);
});
