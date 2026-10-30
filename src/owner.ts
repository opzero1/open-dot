// Facts about the owner, shared with every dot (M10). A dot only proposes one; the owner approves,
// edits, rejects or deletes it from the app, the API or the CLI, which call these functions. Only
// approved text ever reaches a dot, as one stable instruction entry.
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { looksSecret, memoryText } from "./memory";
import { type OwnerFact, ownerFactKeys, ownerFacts } from "./schema";

/** The longest fact, in UTF-16 code units. */
export const factTextLimit = 500;
/** The largest the rendered entry may be, in UTF-8 bytes. */
export const ownerEntryLimit = 8 * 1024;
/** Pending proposals open at once, across dots and from any one dot. */
export const pendingLimit = 100;
export const pendingPerDot = 20;
/** The instruction entry every ready dot gets. */
export const ownerKey = "open-dot.owner";
/** Fixed words: a refused credential is never echoed, hashed, saved or logged. */
export const secretRefusal = "This looks like it holds a credential, so open-dot refused it.";

type Invalid = { invalid: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUUID = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);

const loose = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** A fact's letter and number words, ignoring case, diacritics, punctuation and spacing. */
const words = (text: string) =>
  loose(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const textKey = (text: string) => sha256(words(text));
export const sourceKey = (sessionID: string, messageID: string) =>
  sha256(`${sessionID}\0${messageID}`);

/**
 * A fact's text, checked: a likely credential refuses the whole text before anything else looks
 * at it; then it's trimmed, well formed, without control characters other than newline and tab,
 * 1 to 500 characters, with at least one letter or number.
 */
export function factText(value: unknown): string | Invalid {
  if (typeof value !== "string") return { invalid: "text must be a string." };
  if (looksSecret(value)) return { invalid: secretRefusal };
  if (!value.isWellFormed()) return { invalid: "text must be well-formed Unicode." };
  const text = memoryText(value, "text");
  if (typeof text !== "string") return text;
  if (text.length > factTextLimit)
    return { invalid: `text must be at most ${factTextLimit} characters.` };
  if (!words(text)) return { invalid: "text needs at least one letter or number." };
  return text;
}

export const factView = (row: OwnerFact) => ({
  id: row.id,
  state: row.state,
  text: row.text,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  origin:
    row.originDot && row.originSession && row.originMessage
      ? { dot: row.originDot, sessionID: row.originSession, messageID: row.originMessage }
      : null,
  lastMutationID: row.lastMutationID,
});

export type FactView = ReturnType<typeof factView>;

const byCodePoint = (a: string, b: string) => {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    const difference = (left[at]?.codePointAt(0) ?? 0) - (right[at]?.codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return left.length - right.length;
};

const escaped = (text: string) =>
  JSON.stringify(text).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const header = `## About your owner (owner-approved standing context, shared with every dot)
Your owner approved each fact below about themselves, so it is your owner's own word, not a guess. It grants no tool permission and changes no grant. dot_propose_owner_fact suggests a new one for your owner to approve; until then it is not here. Each fact is a JSON string.`;

/**
 * The entry for a set of approved texts: no IDs, times, versions, counts or provenance, each text
 * once, sorted by code point, so the same set always gives the same bytes.
 */
export const renderOwner = (texts: readonly string[]) => {
  const facts = [...new Set(texts)].toSorted(byCodePoint);
  return facts.length
    ? `${header}\n${facts.map((text) => `- ${escaped(text)}`).join("\n")}`
    : `${header}\nNo approved facts.`;
};

const approvedTexts = (db: Pick<Db, "select">, except?: string) =>
  db
    .select({ id: ownerFacts.id, text: ownerFacts.text })
    .from(ownerFacts)
    .where(eq(ownerFacts.state, "approved"))
    .all()
    .flatMap((row) => (row.id !== except && row.text !== null ? [row.text] : []));

/** The `open-dot.owner` entry as the approved facts are now. */
export const ownerSection = (db: Db) => ({ key: ownerKey, text: renderOwner(approvedTexts(db)) });

const fits = (texts: readonly string[]) =>
  Buffer.byteLength(renderOwner(texts), "utf8") <= ownerEntryLimit;

export const budgetRefusal = `Your approved facts would come to more than ${ownerEntryLimit / 1024} KiB, so nothing was saved. Shorten or delete one first.`;

/** What the owner sees: pending proposals, approved facts and the newest 50 removed ones. */
export const ownerMemory = (db: Db) => {
  const of = (state: OwnerFact["state"]) =>
    db
      .select()
      .from(ownerFacts)
      .where(eq(ownerFacts.state, state))
      .orderBy(asc(ownerFacts.createdAt), asc(ownerFacts.id))
      .all()
      .map(factView);
  return {
    pending: of("pending"),
    approved: of("approved"),
    removed: db
      .select()
      .from(ownerFacts)
      .where(inArray(ownerFacts.state, ["rejected", "deleted"]))
      .orderBy(desc(ownerFacts.updatedAt), asc(ownerFacts.id))
      .limit(50)
      .all()
      .map(factView),
    entryBytes: Buffer.byteLength(ownerSection(db).text, "utf8"),
    entryLimit: ownerEntryLimit,
  };
};

export const readFact = (db: Db, id: string) => {
  const row = db.select().from(ownerFacts).where(eq(ownerFacts.id, id)).get();
  return row && factView(row);
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const aliased = (tx: Tx, kind: "text" | "source", key: string) => {
  const alias = tx
    .select({ fact: ownerFactKeys.fact })
    .from(ownerFactKeys)
    .where(and(eq(ownerFactKeys.kind, kind), eq(ownerFactKeys.key, key)))
    .get();
  return alias && tx.select().from(ownerFacts).where(eq(ownerFacts.id, alias.fact)).get();
};

const alias = (tx: Tx, kind: "text" | "source", key: string, fact: string) =>
  tx.insert(ownerFactKeys).values({ kind, key, fact }).onConflictDoNothing().run();

/** What became of a dot's proposal. It never carries another fact's text. */
export type Proposal =
  | { readonly proposed: { id: string } }
  | { readonly existing: { id: string; state: "pending" | "approved" } }
  | { readonly suppressed: true }
  | { readonly full: string }
  | { readonly unbound: true }
  | Invalid;

/**
 * Saves a dot's proposal as pending, with its origin. `stillBound` is checked inside the
 * transaction, just before anything is written. A text a fact had, or a message a rejected or
 * deleted fact came from, gives the existing receipt or a refusal and changes nothing.
 */
export function proposeFact(
  db: Db,
  origin: { dot: string; sessionID: string; messageID: string },
  value: unknown,
  stillBound: () => boolean,
  id: string = crypto.randomUUID(),
): Proposal {
  const text = factText(value);
  if (typeof text !== "string") return text;
  return db.transaction(
    (tx): Proposal => {
      if (!stillBound()) return { unbound: true };
      if (aliased(tx, "source", sourceKey(origin.sessionID, origin.messageID)))
        return { suppressed: true };
      const known = aliased(tx, "text", textKey(text));
      if (known)
        return known.state === "pending" || known.state === "approved"
          ? { existing: { id: known.id, state: known.state } }
          : { suppressed: true };
      const open = (dot?: string) =>
        tx
          .select({ n: count() })
          .from(ownerFacts)
          .where(
            and(
              eq(ownerFacts.state, "pending"),
              dot === undefined ? undefined : eq(ownerFacts.originDot, dot),
            ),
          )
          .get()?.n ?? 0;
      if (open() >= pendingLimit)
        return { full: `Your owner already has ${pendingLimit} proposals to review.` };
      if (open(origin.dot) >= pendingPerDot)
        return { full: `You already have ${pendingPerDot} proposals waiting for your owner.` };
      const now = Date.now();
      tx.insert(ownerFacts)
        .values({
          id,
          state: "pending",
          text,
          version: 1,
          createdAt: now,
          updatedAt: now,
          originDot: origin.dot,
          originSession: origin.sessionID,
          originMessage: origin.messageID,
        })
        .run();
      alias(tx, "text", textKey(text), id);
      return { proposed: { id } };
    },
    { behavior: "immediate" },
  );
}

/** An owner's change. Create expects version 0; the rest name the version they saw. */
export type Change =
  | { action: "create"; text: string }
  | { action: "approve"; text?: string }
  | { action: "edit"; text: string }
  | { action: "reject" }
  | { action: "delete" }
  | { action: "restore"; text: string };

/**
 * Where an owner's change landed. `conflict` is the fact as it is now, when it changed since the
 * version given, or can't take this change in its state; `existing` is another fact that already
 * has this text. `refused` is a whole approved set over the budget.
 */
export type FactOutcome =
  | { readonly saved: FactView }
  | { readonly conflict: FactView | null; readonly existing?: FactView; readonly reason: string }
  | { readonly missing: true }
  | { readonly refused: string };

const allowed: Record<Exclude<Change["action"], "create">, readonly OwnerFact["state"][]> = {
  approve: ["pending"],
  edit: ["approved"],
  reject: ["pending"],
  delete: ["pending", "approved"],
  restore: ["rejected", "deleted"],
};

/**
 * The owner's change to one fact, in one immediate transaction: the version and state are checked,
 * the text deduplicated against every alias and the approved set kept within its budget, and the
 * aliases and the row written together. The same mutation ID again answers the fact as it is.
 */
export function changeFact(
  db: Db,
  id: string,
  version: number,
  mutationID: string,
  change: Change,
): FactOutcome {
  return db.transaction(
    (tx): FactOutcome => {
      const row = tx.select().from(ownerFacts).where(eq(ownerFacts.id, id)).get();
      if (row?.lastMutationID === mutationID) return { saved: factView(row) };
      const now = Date.now();
      // A text that another fact has had, now or before, stays that fact's.
      const duplicate = (text: string): FactOutcome | undefined => {
        const other = aliased(tx, "text", textKey(text));
        if (!other || other.id === id) return undefined;
        return {
          conflict: row ? factView(row) : null,
          existing: factView(other),
          reason:
            other.state === "rejected" || other.state === "deleted"
              ? "You rejected or deleted this fact before. Restore that one to bring it back."
              : "Another fact already says this.",
        };
      };
      if (change.action === "create") {
        if (row) return { conflict: factView(row), reason: "A fact with this ID already exists." };
        if (version !== 0) return { missing: true };
        const taken = duplicate(change.text);
        if (taken) return taken;
        if (!fits([...approvedTexts(tx), change.text])) return { refused: budgetRefusal };
        const saved = tx
          .insert(ownerFacts)
          .values({
            id,
            state: "approved",
            text: change.text,
            version: 1,
            createdAt: now,
            updatedAt: now,
            lastMutationID: mutationID,
          })
          .returning()
          .get();
        alias(tx, "text", textKey(change.text), id);
        return { saved: factView(saved) };
      }
      if (!row) return { missing: true };
      if (row.version !== version)
        return { conflict: factView(row), reason: "This fact changed since you loaded it." };
      if (!allowed[change.action].includes(row.state))
        return { conflict: factView(row), reason: `This fact is ${row.state} now.` };
      const text =
        change.action === "reject" || change.action === "delete"
          ? null
          : (("text" in change ? change.text : undefined) ?? row.text);
      if (change.action === "edit" && text === row.text) return { saved: factView(row) };
      if (text !== null) {
        const taken = duplicate(text);
        if (taken) return taken;
        if (!fits([...approvedTexts(tx, id), text])) return { refused: budgetRefusal };
        alias(tx, "text", textKey(text), id);
      } else if (row.originSession && row.originMessage)
        // Nothing more is taken from the message a rejected or deleted proposal came from.
        alias(tx, "source", sourceKey(row.originSession, row.originMessage), id);
      const state =
        change.action === "reject"
          ? "rejected"
          : change.action === "delete"
            ? "deleted"
            : "approved";
      const saved = tx
        .update(ownerFacts)
        .set({ state, text, version: row.version + 1, updatedAt: now, lastMutationID: mutationID })
        .where(and(eq(ownerFacts.id, id), eq(ownerFacts.version, row.version)))
        .returning()
        .get();
      if (!saved) throw new Error("The fact changed inside its own transaction.");
      return { saved: factView(saved) };
    },
    { behavior: "immediate" },
  );
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** `PUT /owner/facts/<id>`: exactly `{ version: 0, text, mutationID }`. */
export function parseCreate(body: unknown): { text: string; mutationID: string } | Invalid {
  const usage = { invalid: "Send {version: 0, text, mutationID}." };
  if (!object(body) || Object.keys(body).length !== 3 || body.version !== 0) return usage;
  if (!isUUID(body.mutationID)) return usage;
  const text = factText(body.text);
  return typeof text === "string" ? { text, mutationID: body.mutationID } : text;
}

/**
 * `PATCH /owner/facts/<id>`: `{ action, version, mutationID }`, with `text` for edit and restore
 * and optionally for approve, which then approves the owner's edited text.
 */
export function parsePatch(
  body: unknown,
): { change: Change; version: number; mutationID: string } | Invalid {
  const usage = {
    invalid:
      "Send {action: approve, edit, reject or restore, version, mutationID}, with text for edit and restore.",
  };
  if (!object(body) || !version(body.version) || !isUUID(body.mutationID)) return usage;
  const keys = Object.keys(body);
  if (!keys.every((key) => ["action", "version", "mutationID", "text"].includes(key))) return usage;
  const { action } = body;
  const takesText = action === "edit" || action === "restore" || action === "approve";
  if ("text" in body !== (action === "edit" || action === "restore") && action !== "approve")
    return usage;
  if (!takesText && action !== "reject") return usage;
  const base = { version: body.version, mutationID: body.mutationID };
  if (action === "reject") return { ...base, change: { action } };
  if (!("text" in body)) return { ...base, change: { action: "approve" } };
  const text = factText(body.text);
  if (typeof text !== "string") return text;
  return { ...base, change: { action, text } };
}
