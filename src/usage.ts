import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "./db";
import { type HistoryItem, OpenCode, OpenCodeError, type Tokens } from "./opencode";
import { dots, usageDays, usageState } from "./schema";

// What each dot's model steps cost in prompt-cache terms, read from OpenCode's public history:
// every assistant message is one model request, a step, and reports its own five counts.

/** Local midnight of `time`'s day, the day a step counts on. */
export const dayStart = (time: number) => new Date(time).setHours(0, 0, 0, 0);

const pageLimit = 200;
const pagesPerPass = 10;

/** A step after a turn's first that writes at least this much, and more than it reads, is heavy. */
export const heavyWrite = 20_000;
/** This many heavy steps in a row, ignoring turns' first steps, raise the cache alarm. */
export const alarmSteps = 3;

type State = typeof usageState.$inferSelect;
type Dot = typeof dots.$inferSelect;

/** The dot's walk state, started afresh, counting nothing yet, for a new or rebound session. */
function stateFor(db: Db, dot: Dot): State {
  const row = db.select().from(usageState).where(eq(usageState.dot, dot.name)).get();
  if (row?.sessionID === dot.sessionID) return row;
  const fresh = {
    sessionID: dot.sessionID,
    cursor: null,
    anchor: null,
    last: null,
    stepped: false,
    counting: false,
    streak: 0,
    streakAt: null,
    revision: (row?.revision ?? 0) + 1,
  };
  return db
    .insert(usageState)
    .values({ dot: dot.name, ...fresh })
    .onConflictDoUpdate({ target: usageState.dot, set: fresh })
    .returning()
    .get();
}

interface Step {
  readonly time: number;
  readonly tokens: Tokens | undefined;
}

/** Whether a step after a turn's first wrote far more to the cache than it read from it. */
export const heavy = (tokens: Tokens) =>
  tokens.cacheWrite >= heavyWrite && tokens.cacheWrite > tokens.cacheRead;

/**
 * Saves a walk's progress and the steps it counted, in one transaction, only while the dot is
 * still ready on the same session and nothing else moved its walk since it was read. Undefined
 * when either changed: nothing is saved, so no step is counted twice.
 */
function save(
  db: Db,
  from: State,
  change: Pick<
    State,
    "cursor" | "anchor" | "last" | "stepped" | "counting" | "streak" | "streakAt"
  >,
  steps: readonly Step[],
) {
  return db.transaction(
    (tx) => {
      const dot = tx.select().from(dots).where(eq(dots.name, from.dot)).get();
      if (dot?.sessionState !== "ready" || dot.sessionID !== from.sessionID) return undefined;
      const saved = tx
        .update(usageState)
        .set({ ...change, revision: from.revision + 1 })
        .where(and(eq(usageState.dot, from.dot), eq(usageState.revision, from.revision)))
        .returning()
        .get();
      if (!saved) return undefined;
      for (const [day, group = []] of Object.entries(
        Object.groupBy(steps, (step) => dayStart(step.time)),
      )) {
        const sum = (key: keyof Tokens) =>
          group.reduce((total, step) => total + (step.tokens?.[key] ?? 0), 0);
        const added = {
          steps: group.length,
          input: sum("input"),
          output: sum("output"),
          reasoning: sum("reasoning"),
          cacheRead: sum("cacheRead"),
          cacheWrite: sum("cacheWrite"),
        };
        tx.insert(usageDays)
          .values({ dot: from.dot, day: Number(day), ...added })
          .onConflictDoUpdate({
            target: [usageDays.dot, usageDays.day],
            set: {
              steps: sql`${usageDays.steps} + ${added.steps}`,
              input: sql`${usageDays.input} + ${added.input}`,
              output: sql`${usageDays.output} + ${added.output}`,
              reasoning: sql`${usageDays.reasoning} + ${added.reasoning}`,
              cacheRead: sql`${usageDays.cacheRead} + ${added.cacheRead}`,
              cacheWrite: sql`${usageDays.cacheWrite} + ${added.cacheWrite}`,
            },
          })
          .run();
      }
      return saved;
    },
    { behavior: "immediate" },
  );
}

/**
 * Whether `item` opens a new prompt, so a model step after it is a turn's first: the idle that
 * ends a turn, the owner's message that starts one, or a compaction that rewrites the prompt.
 * System and context announcements, OpenCode's other items, don't.
 */
const opensTurn = (item: HistoryItem) =>
  item.type === "idle" || item.type === "user" || item.type === "compaction";

/**
 * One pass of the usage walk over a dot's bound session, at most ten pages of its public history,
 * oldest first. A new or rebound session is first read to its end without counting, so only
 * steps from then on count. Each finished assistant message is a step, counted on the local day
 * it started; the walk stops before one OpenCode hasn't finished and reads it again next pass. A
 * page that no longer holds the last counted item is passed over uncounted, and a cursor whose item
 * is gone starts the walk afresh, so nothing is ever counted twice.
 */
export const usageDot = (db: Db, name: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode;
    const dot = db.select().from(dots).where(eq(dots.name, name)).get();
    if (dot?.sessionState !== "ready") return;
    let row = stateFor(db, dot);
    const seen = new Set(row.cursor ? [row.cursor] : []);
    for (let pages = 0; pages < pagesPerPass; pages++) {
      const page = yield* opencode.historyPage(dot.sessionID, pageLimit, row.cursor ?? undefined);
      if (!page.items.length) {
        // An empty page after a cursor is the end, or a cursor whose item is gone.
        if (
          row.anchor !== null &&
          !(yield* opencode.historyItem({ sessionID: dot.sessionID, messageID: row.anchor }))
        )
          save(
            db,
            row,
            {
              ...row,
              cursor: null,
              anchor: null,
              last: null,
              stepped: false,
              counting: false,
            },
            [],
          );
        // The end of the history: from here on, steps count.
        else if (!row.counting) save(db, row, { ...row, counting: true }, []);
        return;
      }
      const at = row.last === null ? -1 : page.items.findIndex((item) => item.id === row.last);
      const passed = row.last !== null && at < 0;
      const counted = row.counting && !passed;
      const items = passed ? page.items : page.items.slice(at + 1);
      let { last, stepped, streak, streakAt } = row;
      const steps: Step[] = [];
      let stopped = false;
      for (const item of items) {
        if (item.type === "assistant") {
          if (counted) {
            if (!item.complete) {
              stopped = true;
              break;
            }
            steps.push({ time: item.time, tokens: item.tokens });
            if (stepped && item.tokens) {
              const bad = heavy(item.tokens);
              streak = bad ? streak + 1 : 0;
              streakAt = bad ? item.time : null;
            }
          }
          stepped = true;
        } else if (opensTurn(item)) stepped = false;
        last = item.id;
      }
      const end = page.items.length < pageLimit;
      if (stopped || !page.next) {
        save(db, row, { ...row, last, stepped, streak, streakAt }, steps);
        return;
      }
      if (seen.has(page.next)) {
        yield* new OpenCodeError({
          message: `OpenCode returned a history cursor of ${dot.sessionID} that would loop`,
        });
        return;
      }
      seen.add(page.next);
      const saved = save(
        db,
        row,
        {
          cursor: page.next,
          anchor: page.items.at(-1)?.id ?? null,
          last: null,
          stepped,
          counting: row.counting || end,
          streak,
          streakAt,
        },
        steps,
      );
      if (!saved || end) return;
      row = saved;
    }
  });

/** The dots whose usage is walked: every ready one. */
export const readyDots = (db: Db) =>
  db
    .select({ name: dots.name })
    .from(dots)
    .where(eq(dots.sessionState, "ready"))
    .all()
    .map((dot) => dot.name);

/** One usage pass over every ready dot. One dot's failure doesn't stop the rest. */
export const usageAll = (db: Db) =>
  Effect.suspend(() =>
    Effect.forEach(
      readyDots(db),
      (name) =>
        usageDot(db, name).pipe(
          Effect.timeout("60 seconds"),
          Effect.catch((error) =>
            Effect.sync(() => console.error(`Usage of ${name}: ${error.message}`)),
          ),
        ),
      { discard: true },
    ),
  );

/** How many days `GET /dots/<name>/usage` lists. */
export const usageDays7 = 7;

/**
 * A dot's recorded steps per local day over the last week, newest first, and whether its latest
 * steps after a turn's first keep writing more to the cache than they read.
 */
export function dotUsage(db: Db, name: string, now: number) {
  const since = dayStart(now - (usageDays7 - 1) * 24 * 60 * 60 * 1000);
  const days = db
    .select()
    .from(usageDays)
    .where(and(eq(usageDays.dot, name), gte(usageDays.day, since)))
    .orderBy(desc(usageDays.day))
    .all()
    .map(({ dot: _, ...day }) => ({ ...day, hitPercent: hitPercent(day) }));
  const dot = db.select().from(dots).where(eq(dots.name, name)).get();
  const state = db.select().from(usageState).where(eq(usageState.dot, name)).get();
  const current = state && state.sessionID === dot?.sessionID ? state : undefined;
  return {
    days,
    counting: current?.counting ?? false,
    streak: current?.streak ?? 0,
    alarm: (current?.streak ?? 0) >= alarmSteps,
  };
}

/** Cache reads as a whole percentage of every prompt token, or null with none. */
export const hitPercent = (day: { input: number; cacheRead: number; cacheWrite: number }) => {
  const prompt = day.input + day.cacheRead + day.cacheWrite;
  return prompt ? Math.round((100 * day.cacheRead) / prompt) : null;
};
