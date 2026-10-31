import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { RequestCard } from "../app/bridge";
import { fits, shapes } from "../app/decode";
import { cardDetail, formAnswer, initialValues } from "../app/surfaces";
import { api } from "../src/api";
import { answerAll, settleRequests, watchOwn } from "../src/daemon";
import { type Db, openDatabase } from "../src/db";
import { formWaiting } from "../src/opencode";
import { graceMs, queueAnswer } from "../src/requests";
import { dots, outbox, requestAnswers, requests, workers } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

let db: Db;
let fake: ReturnType<typeof fakeOpenCode>;

beforeEach(() => {
  db = openDatabase(":memory:");
  fake = fakeOpenCode();
  for (const name of ["jojo", "dio"])
    db.insert(dots)
      .values({
        name,
        directory: `/dots/${name}`,
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const own = () => run(Effect.provide(watchOwn(db), fake.layer));
const answer = () => run(Effect.provide(answerAll(db), fake.layer));

const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
  api(
    db,
    "secret",
    fake.layer,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: "Bearer secret" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );

interface Card {
  id: number;
  dot: string;
  source: string;
  revision: string;
  actionable: boolean;
  state: string;
  attempt: { id: string; actor: string; state: string } | null;
}

const pending = async (query = "") =>
  (await (await call(`/requests/pending${query}`)).json()) as {
    requests: Card[];
    next: number | null;
  };

const post = (card: Card, body: Record<string, unknown>, dot = card.dot) =>
  call(`/dots/${dot}/requests/${card.id}/answer`, {
    method: "POST",
    body: {
      attemptID: crypto.randomUUID(),
      boundSessionID: `ses_${card.dot}`,
      revision: card.revision,
      ...body,
    },
  });

const form = {
  id: "frm_1",
  kind: "question" as const,
  summary: "Build choices",
  detail: {
    kind: "question" as const,
    title: "Build choices",
    fields: [
      {
        key: "branch",
        type: "string",
        required: true,
        options: [
          { value: "main", label: "Main" },
          { value: "dev", label: "Dev" },
        ],
        custom: true,
      },
      {
        key: "targets",
        type: "multiselect",
        options: [
          { value: "mac", label: "Mac" },
          { value: "linux", label: "Linux" },
        ],
      },
      { key: "note", type: "string" },
    ],
  },
};

test("the dot's own permission request becomes the owner's card, counted once, and the owner's once is sent once", async () => {
  fake.state.waiting.set("ses_jojo", [{ id: "per_1", kind: "permission", summary: "shell: ls" }]);
  await own();
  await own();
  // No notice asks the dot to approve its own request.
  expect(db.select().from(outbox).all()).toEqual([]);
  const dotsView = (await (await call("/dots")).json()) as {
    name: string;
    sessions: { source: string; needs: string[] }[];
  }[];
  expect(dotsView.find((dot) => dot.name === "jojo")?.sessions).toMatchObject([
    { source: "dot", needs: ["permission"] },
  ]);
  // What the daemon answers fits what main lets through to the app.
  const page = await pending();
  expect(fits(page, shapes.pendingRequests)).toBe(true);
  const [card] = page.requests;
  expect(card).toMatchObject({
    dot: "jojo",
    source: "dot",
    actionable: true,
    state: "escalated",
    boundSessionID: "ses_jojo",
  });
  if (!card) throw new Error("no card");
  const attemptID = crypto.randomUUID();
  const body = {
    attemptID,
    boundSessionID: "ses_jojo",
    revision: card.revision,
    answer: { decision: "once" },
  };
  const first = await call(`/dots/jojo/requests/${card.id}/answer`, { method: "POST", body });
  expect(first.status).toBe(202);
  expect(fits(await first.json(), shapes.answerRequest)).toBe(true);
  // A double click or a second window: the same attempt answers its receipt, another conflicts.
  const again = await call(`/dots/jojo/requests/${card.id}/answer`, { method: "POST", body });
  expect(again.status).toBe(202);
  expect(((await again.json()) as { attemptID: string }).attemptID).toBe(attemptID);
  expect((await post(card, { answer: { decision: "once" } })).status).toBe(409);
  await answer();
  await answer();
  expect(fake.state.answers).toEqual([
    { sessionID: "ses_jojo", kind: "permission", requestID: "per_1", answer: { decision: "once" } },
  ]);
  const receipt = (await (await call(`/dots/jojo/requests/${card.id}`)).json()) as {
    attempts: { id: string; actor: string; state: string; confirmedAt: number | null }[];
  };
  expect(fits(receipt, shapes.requestReceipt)).toBe(true);
  expect(receipt.attempts).toMatchObject([{ id: attemptID, actor: "owner", state: "confirmed" }]);
  await own();
  expect((await pending()).requests).toEqual([]);
  expect(db.select().from(outbox).all()).toEqual([]);
});

test("a question takes the owner's whole form: a choice, several choices and typed text, or Decline", async () => {
  fake.state.waiting.set("ses_jojo", [form, { ...form, id: "frm_2" }]);
  await own();
  const [first, second] = (await pending("?dot=jojo")).requests;
  if (!first || !second) throw new Error("no cards");
  // Not an option, multiple choice outside its options, and a typed credential are all refused.
  expect(
    (await post(first, { answer: { decision: "reply", answer: { targets: ["windows"] } } })).status,
  ).toBe(422);
  const leaked = await post(first, {
    answer: {
      decision: "reply",
      answer: { branch: "dev", note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    },
  });
  expect(leaked.status).toBe(422);
  expect(await leaked.text()).not.toContain("ghp_");
  // The app reads the real card's form and builds the whole answer from what the owner chose.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the daemon's answer, as main passes it
  const detail = cardDetail(first as unknown as RequestCard);
  if (detail.kind !== "question") throw new Error("the app can't render the form");
  const built = formAnswer(detail.fields, {
    ...initialValues(detail.fields),
    branch: "release/1.0",
    targets: ["mac", "linux"],
    note: "Ship it",
  });
  if (!("answer" in built)) throw new Error(built.error);
  const reply = built.answer;
  expect(reply).toEqual({ branch: "release/1.0", targets: ["mac", "linux"], note: "Ship it" });
  expect((await post(first, { answer: { decision: "reply", answer: reply } })).status).toBe(202);
  expect((await post(second, { answer: { decision: "cancel" } })).status).toBe(202);
  await answer();
  expect(fake.state.answers.map((item) => [item.requestID, item.answer])).toEqual([
    ["frm_1", { decision: "reply", answer: reply }],
    ["frm_2", { decision: "cancel" }],
  ]);
});

test("Always needs the owner's confirmation, and a rejection carries its message", async () => {
  fake.state.waiting.set("ses_jojo", [
    { id: "per_1", kind: "permission", summary: "shell: bun test" },
    { id: "per_2", kind: "permission", summary: "shell: rm -rf build" },
  ]);
  await own();
  const [first, second] = (await pending()).requests;
  if (!first || !second) throw new Error("no cards");
  expect((await post(first, { answer: { decision: "always" } })).status).toBe(422);
  expect((await post(first, { answer: { decision: "once" }, confirmedAlways: true })).status).toBe(
    422,
  );
  expect(
    (await post(second, { answer: { decision: "reject", message: "token=abc123secretvalue" } }))
      .status,
  ).toBe(422);
  expect(
    (await post(first, { answer: { decision: "always" }, confirmedAlways: true })).status,
  ).toBe(202);
  expect(
    (await post(second, { answer: { decision: "reject", message: "Not in this repo" } })).status,
  ).toBe(202);
  await answer();
  expect(fake.state.answers.map((item) => item.answer)).toEqual([
    { decision: "always" },
    { decision: "reject", message: "Not in this repo" },
  ]);
});

test("the owner answers an escalated worker request the dot couldn't, and the audit keeps both answers", async () => {
  db.insert(workers)
    .values({
      id: 1,
      dot: "jojo",
      task: "Task",
      directory: "/work/1",
      sessionID: "ses_w1",
      state: "running",
      createdAt: 0,
    })
    .run();
  const detail = { kind: "permission" as const, action: "bash", resources: ["git push --force"] };
  const row = db
    .insert(requests)
    .values({
      dot: "jojo",
      source: "worker",
      worker: 1,
      sessionID: "ses_w1",
      title: "Task",
      directory: "/work/1",
      kind: "permission",
      requestID: "per_w",
      detail,
      state: "open",
      createdAt: 0,
      noticedAt: 0,
    })
    .returning()
    .get();
  fake.state.waiting.set("ses_w1", [{ id: "per_w", kind: "permission", summary: "x", detail }]);
  // The dot rejects it, but the daemon finds it changed and refuses, so the owner gets it.
  expect(
    typeof queueAnswer(db, {
      id: row.id,
      dot: "jojo",
      actorSession: "ses_jojo",
      kind: "permission",
      answer: { decision: "reject" },
    }),
  ).toBe("object");
  db.update(dots).set({ sessionID: "ses_jojo2" }).where(eq(dots.name, "jojo")).run();
  await answer();
  db.update(dots).set({ sessionID: "ses_jojo" }).where(eq(dots.name, "jojo")).run();
  expect(db.select().from(requests).get()?.state).toBe("escalated");
  const [card] = (await pending()).requests;
  if (!card) throw new Error("no card");
  // Another dot's path, a foreign session or a stale revision change nothing.
  expect((await post(card, { answer: { decision: "once" } }, "dio")).status).toBe(404);
  expect(
    (await post(card, { answer: { decision: "once" }, boundSessionID: "ses_dio" })).status,
  ).toBe(409);
  expect(
    (await post(card, { answer: { decision: "once" }, revision: "0".repeat(32) })).status,
  ).toBe(409);
  expect((await post(card, { answer: { decision: "once" }, actor: "dot" })).status).toBe(400);
  // The owner's explicit consent approves what open-dot won't let a dot approve.
  expect((await post(card, { answer: { decision: "once" } })).status).toBe(202);
  await answer();
  expect(fake.state.answers.map((item) => item.answer)).toEqual([{ decision: "once" }]);
  expect(
    db
      .select()
      .from(requestAnswers)
      .all()
      .map((attempt) => [attempt.actor, attempt.state, attempt.answer.decision]),
  ).toEqual([
    ["dot", "refused", "reject"],
    ["owner", "confirmed", "once"],
  ]);
});

test("a grace-expired worker request becomes a card, and one answered elsewhere drops out", async () => {
  db.insert(workers)
    .values({
      id: 1,
      dot: "jojo",
      task: "Task",
      directory: "/work/1",
      sessionID: "ses_w1",
      state: "running",
      createdAt: 0,
    })
    .run();
  db.insert(requests)
    .values({
      dot: "jojo",
      source: "worker",
      worker: 1,
      sessionID: "ses_w1",
      title: "Task",
      directory: "/work/1",
      kind: "permission",
      requestID: "per_w",
      detail: { kind: "permission", action: "bash", resources: ["ls"] },
      state: "open",
      createdAt: 0,
      noticedAt: Date.now() - graceMs - 1,
    })
    .run();
  expect((await pending()).requests).toEqual([]);
  settleRequests(db, Date.now());
  const [card] = (await pending()).requests;
  expect(card).toMatchObject({ source: "worker", actionable: true });
  if (!card) throw new Error("no card");
  // Answered in the terminal: OpenCode stops listing it, and the card goes.
  db.update(requests).set({ goneAt: Date.now() }).run();
  expect((await pending()).requests).toEqual([]);
  expect((await post(card, { answer: { decision: "once" } })).status).toBe(409);
  await answer();
  expect(fake.state.answers).toEqual([]);
});

test("a lost answer stays unknown and read-only, and is never sent again, even after a restart", async () => {
  fake.state.waiting.set("ses_jojo", [{ id: "per_1", kind: "permission", summary: "shell: ls" }]);
  await own();
  const [card] = (await pending()).requests;
  if (!card) throw new Error("no card");
  fake.state.answer = "lost";
  expect((await post(card, { answer: { decision: "once" } })).status).toBe(202);
  await answer();
  // OpenCode keeps listing it, as if the answer never landed.
  fake.state.waiting.set("ses_jojo", [{ id: "per_1", kind: "permission", summary: "shell: ls" }]);
  await own();
  expect((await pending()).requests).toMatchObject([
    { id: card.id, state: "unknown", actionable: false, attempt: { state: "unknown" } },
  ]);
  expect((await post(card, { answer: { decision: "reject" } })).status).toBe(409);
  await answer();
  expect(fake.state.answers).toHaveLength(1);
  // The owner's own answer tells nobody else in the chat.
  expect(db.select().from(outbox).all()).toEqual([]);
});

test("an owner's answer a stopped daemon was sending becomes unknown, never sent again", async () => {
  fake.state.waiting.set("ses_jojo", [{ id: "per_1", kind: "permission", summary: "shell: ls" }]);
  await own();
  const [card] = (await pending()).requests;
  if (!card) throw new Error("no card");
  expect((await post(card, { answer: { decision: "once" } })).status).toBe(202);
  // The previous daemon saved the attempt and stopped before OpenCode answered.
  db.update(requests).set({ state: "answering", attemptedAt: 1 }).run();
  db.update(requestAnswers).set({ state: "sending", attemptedAt: 1 }).run();
  settleRequests(db, Date.now());
  await answer();
  expect(fake.state.answers).toEqual([]);
  expect(db.select().from(requestAnswers).get()).toMatchObject({
    state: "unknown",
    error: "daemon-restart",
  });
  expect(db.select().from(requests).get()?.state).toBe("unknown");
});

test("a question that may ask for a secret is terminal-only, and Start Fresh ends the old session's cards", async () => {
  fake.state.waiting.set("ses_jojo", [
    formWaiting({ id: "frm_s", title: "Enter your API token", fields: [...form.detail.fields] }),
    { id: "per_9", kind: "permission", summary: "shell: ls" },
  ]);
  await own();
  const [card, permission] = (await pending()).requests;
  if (!permission) throw new Error("no permission card");
  expect(card).toMatchObject({ actionable: false, state: "escalated" });
  if (!card) throw new Error("no card");
  expect(JSON.stringify(db.select().from(requests).all())).not.toContain("API token");
  expect((await post(card, { answer: { decision: "cancel" } })).status).toBe(422);
  // A rebind leaves the old session's request for the owner's terminal only.
  db.update(dots).set({ sessionID: "ses_new" }).where(eq(dots.name, "jojo")).run();
  expect(
    (await post(permission, { answer: { decision: "once" }, boundSessionID: "ses_new" })).status,
  ).toBe(409);
});

test("pending cards page without dropping any", async () => {
  fake.state.waiting.set(
    "ses_jojo",
    Array.from({ length: 3 }, (_, index) => ({
      id: `per_${index}`,
      kind: "permission" as const,
      summary: `shell: echo ${index}`,
    })),
  );
  await own();
  const first = await pending("?limit=2");
  expect(first.requests).toHaveLength(2);
  const rest = await pending(`?limit=2&after=${first.next}`);
  expect(rest).toMatchObject({ next: null });
  expect([...first.requests, ...rest.requests].map((card) => card.id)).toHaveLength(3);
  expect((await call("/requests/pending?limit=0")).status).toBe(400);
});
