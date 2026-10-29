import { Session } from "@opencode/client/effect";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { Data, Effect, Result } from "effect";
import { settingsOf } from "./archive";
import type { Db } from "./db";
import { enqueue, gated } from "./daemon";
import { runsWordsTogether } from "./memory";
import { OpenCode } from "./opencode";
import {
  dots,
  feedTriggers,
  outbox,
  requests,
  responsibilities,
  responsibilityRuns,
  workers,
} from "./schema";
import { revisionOf } from "./triggers";

export class FreshError extends Data.TaggedError("FreshError")<{
  readonly status: 404 | 409 | 502;
  readonly message: string;
}> {}

/** The tables whose Slack `route` names the dot's session, so a reply still finds its thread. */
const routed = ["outbox", "reminders", "slack", "slack_events", "slack_threads", "workers"];

const shown = { responsibilities: 20, workers: 10 };
const itemLength = 240;

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= itemLength) return flat;
  const cut = flat.slice(0, itemLength);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), itemLength / 2))}…`;
};

/**
 * The one message a fresh session starts with, built only from open-dot's database: never from
 * the old conversation. An item whose text runs words together is left out, so the habit the
 * fresh session escapes isn't handed straight back.
 */
export function handoff(db: Db, name: string, previous: string) {
  const open = db
    .select()
    .from(responsibilities)
    .where(and(eq(responsibilities.dot, name), eq(responsibilities.status, "active")))
    .orderBy(asc(responsibilities.id))
    .all();
  const unfinished = db
    .select()
    .from(workers)
    .where(and(eq(workers.dot, name), ne(workers.state, "done")))
    .orderBy(asc(workers.id))
    .all();
  let omitted = 0;
  const keep = (line: string) => {
    if (runsWordsTogether(line)) {
      omitted++;
      return [];
    }
    return [line];
  };
  const goals = open
    .slice(0, shown.responsibilities)
    .flatMap((item) =>
      keep(
        `- Responsibility #${item.id}: ${clip(item.goal)} Next action: ${clip(item.nextAction)}`,
      ),
    );
  const tasks = unfinished
    .slice(0, shown.workers)
    .flatMap((worker) =>
      keep(
        `- Worker #${worker.id}, ${worker.state}, in session ${worker.sessionID}: ${clip(worker.task)}`,
      ),
    );
  const archived = settingsOf(db, name).archive;
  const lines = [
    `This is a fresh session for you, ${name}. Your owner started it so you can continue without the long history of your earlier conversation. That conversation is kept, unchanged, in session ${previous}.`,
    "Your notes, responsibilities, reminders, workers, supervisions, grants, Slack threads and instructions all carry over. Your memory shows them as usual.",
    goals.length
      ? `Your open responsibilities:\n${goals.join("\n")}`
      : open.length
        ? ""
        : "You have no open responsibilities.",
    tasks.length
      ? `Your unfinished workers, whose reports still come to you here:\n${tasks.join("\n")}`
      : "",
    open.length > shown.responsibilities || unfinished.length > shown.workers || omitted
      ? "Some items aren't listed here. Your memory lists every open responsibility."
      : "",
    archived
      ? "To look something up from before, use dot_recall to search your notes and archived messages from every session, and dot_zoom to read one in full."
      : "To look something up from before, use dot_search_notes for your saved notes. Your owner can turn on the conversation archive so dot_recall also searches earlier messages.",
    "Write in plain sentences with a space between every word.",
  ];
  return {
    text: lines.filter(Boolean).join("\n\n"),
    responsibilities: goals.length,
    workers: tasks.length,
    omitted,
  };
}

const archivedTitle = (name: string, now: number) =>
  `${name} (archived ${new Date(now).toLocaleDateString("en-CA")})`;

const running = new Set<string>();

/**
 * Moves the dot to a new OpenCode session with the same directory, permissions and model, and
 * keeps everything open-dot owns. The new ID is saved before OpenCode is asked to create it, and
 * the dot is rebound in one transaction only once the session exists, so a failure leaves the dot
 * on its old session and a retry finds the same new one. Pending messages for the old session
 * move to the new one, after a lookup confirms OpenCode never admitted them; the old session is
 * renamed and left in place.
 */
export const startFresh = (db: Db, name: string, force: boolean, now = Date.now()) =>
  Effect.gen(function* () {
    const dot = db.select().from(dots).where(eq(dots.name, name)).get();
    if (!dot) return yield* new FreshError({ status: 404, message: `No dot named "${name}".` });
    if (dot.sessionState !== "ready")
      return yield* new FreshError({
        status: 409,
        message: `${name}'s session isn't ready yet. Open it once, then try again.`,
      });
    if (running.has(name))
      return yield* new FreshError({ status: 409, message: `${name} is already starting fresh.` });
    running.add(name);
    return yield* fresh(db, dot, force, now).pipe(
      Effect.ensuring(Effect.sync(() => running.delete(name))),
    );
  });

const fresh = (db: Db, dot: typeof dots.$inferSelect, force: boolean, now: number) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode;
    const previous = dot.sessionID;
    if (!force) {
      const busy =
        (yield* opencode.activeSessions).has(previous) ||
        (yield* opencode.inbox(previous)).length > 0 ||
        db
          .select({ id: requests.id })
          .from(requests)
          .where(and(eq(requests.dot, dot.name), inArray(requests.state, ["queued", "answering"])))
          .get() !== undefined;
      if (busy)
        return yield* new FreshError({
          status: 409,
          message: `${dot.name} is in the middle of a turn. Wait until it's idle, or force it.`,
        });
    }
    const sessionID = dot.freshSessionID ?? Session.ID.create();
    if (!dot.freshSessionID)
      db.update(dots).set({ freshSessionID: sessionID }).where(eq(dots.name, dot.name)).run();
    const model = yield* opencode
      .sessionModel(previous)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const exists = yield* opencode.sessionExists(sessionID);
    if (!exists) {
      const created = yield* Effect.result(
        opencode.createSession({
          id: sessionID,
          directory: dot.directory,
          title: `Dot: ${dot.name}`,
          model,
        }),
      );
      if (Result.isFailure(created)) {
        // Only a confirmed absence lets the next attempt pick a new ID.
        const there = yield* opencode
          .sessionExists(sessionID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (there === false)
          db.update(dots).set({ freshSessionID: null }).where(eq(dots.name, dot.name)).run();
        if (there !== true)
          return yield* new FreshError({
            status: 502,
            message: `OpenCode didn't create the new session, so ${dot.name} keeps its current one. ${created.failure.message}`,
          });
      }
    }
    const note = handoff(db, dot.name, previous);
    const moved = yield* gated(previous)(
      Effect.gen(function* () {
        const pending = db
          .select()
          .from(outbox)
          .where(and(eq(outbox.sessionID, previous), eq(outbox.state, "pending")))
          .all();
        const admitted = new Set<string>();
        for (const row of pending)
          if (
            row.startedAt !== null &&
            (yield* opencode.messageExists({ sessionID: previous, messageID: row.messageID }))
          )
            admitted.add(row.messageID);
        return db.transaction((tx) => {
          const current = tx.select().from(dots).where(eq(dots.name, dot.name)).get();
          if (current?.sessionID !== previous || current.freshSessionID !== sessionID)
            return undefined;
          tx.update(dots)
            .set({ sessionID, freshSessionID: null })
            .where(eq(dots.name, dot.name))
            .run();
          // Admitted ones already reached the old session; the daemon settles them there.
          if (admitted.size)
            tx.update(outbox)
              .set({ state: "sent" })
              .where(and(inArray(outbox.messageID, [...admitted]), eq(outbox.state, "pending")))
              .run();
          const moving = pending
            .filter((row) => !admitted.has(row.messageID))
            .map((row) => row.messageID);
          if (moving.length) {
            tx.update(outbox)
              .set({ sessionID, startedAt: null })
              .where(and(inArray(outbox.messageID, moving), eq(outbox.state, "pending")))
              .run();
            tx.update(responsibilityRuns)
              .set({ sessionID })
              .where(inArray(responsibilityRuns.messageID, moving))
              .run();
          }
          for (const trigger of tx
            .select()
            .from(feedTriggers)
            .where(
              and(
                eq(feedTriggers.dot, dot.name),
                eq(feedTriggers.sessionID, previous),
                ne(feedTriggers.state, "revoked"),
              ),
            )
            .all())
            tx.update(feedTriggers)
              .set({ sessionID, revision: revisionOf({ ...trigger, sessionID }), updatedAt: now })
              .where(eq(feedTriggers.id, trigger.id))
              .run();
          for (const table of routed)
            tx.run(
              sql`UPDATE ${sql.identifier(table)} SET route = json_set(route, '$.sessionID', ${sessionID}) WHERE route IS NOT NULL AND json_extract(route, '$.dot') = ${dot.name} AND json_extract(route, '$.sessionID') = ${previous}`,
            );
          // Steered, so it goes ahead of the messages that moved with the dot.
          const seeded = enqueue(tx, sessionID, note.text, undefined, "steer");
          return { moved: moving.length, handoffID: seeded.messageID };
        });
      }),
    );
    if (!moved)
      return yield* new FreshError({
        status: 409,
        message: `${dot.name}'s conversation changed meanwhile. Nothing moved; try again.`,
      });
    const title = archivedTitle(dot.name, now);
    const renamed = yield* opencode.renameSession(previous, title).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    return {
      name: dot.name,
      sessionID,
      previousSessionID: previous,
      previousTitle: renamed ? title : null,
      moved: moved.moved,
      handoffID: moved.handoffID,
      responsibilities: note.responsibilities,
      workers: note.workers,
      omitted: note.omitted,
    };
  });
