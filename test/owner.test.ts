import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "../src/db";
import {
  budgetRefusal,
  changeFact,
  factText,
  ownerEntryLimit,
  ownerMemory,
  ownerSection,
  parsePatch,
  pendingPerDot,
  proposeFact,
  readFact,
  renderOwner,
  secretRefusal,
} from "../src/owner";
import { ownerFactKeys } from "../src/schema";

let directory: string;
let path: string;
let db: Db;
const origin = (messageID: string, dot = "jojo") => ({ dot, sessionID: "ses_jojo", messageID });
const bound = () => true;
const mutation = () => crypto.randomUUID();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "open-dot-owner-"));
  path = join(directory, "open-dot.db");
  db = openDatabase(path);
});
afterEach(() => {
  db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

const propose = (text: string, messageID = "msg_1", dot?: string) => {
  const result = proposeFact(db, origin(messageID, dot), text, bound);
  if (!("proposed" in result)) return result;
  const fact = readFact(db, result.proposed.id);
  if (!fact) throw new Error("not saved");
  return fact;
};

test("only the owner's versioned changes move a fact, and a stale version changes nothing", () => {
  const fact = propose("Prefers tea.");
  if (!("id" in fact)) throw new Error("not proposed");
  expect(fact).toMatchObject({ state: "pending", version: 1, lastMutationID: null });
  // Another session's approval at the same version wins; the slower one is a conflict.
  const first = changeFact(db, fact.id, 1, mutation(), { action: "approve" });
  expect(first).toMatchObject({ saved: { state: "approved", version: 2 } });
  const stale = changeFact(db, fact.id, 1, mutation(), { action: "reject" });
  expect(stale).toMatchObject({ conflict: { state: "approved", version: 2 } });
  // An approved fact can't be rejected, only edited or deleted.
  expect(changeFact(db, fact.id, 2, mutation(), { action: "reject" })).toHaveProperty("conflict");
  // An identical edit is a no-op; a real one advances the version.
  expect(
    changeFact(db, fact.id, 2, mutation(), { action: "edit", text: "Prefers tea." }),
  ).toMatchObject({ saved: { version: 2 } });
  const edit = mutation();
  expect(
    changeFact(db, fact.id, 2, edit, { action: "edit", text: "Prefers green tea." }),
  ).toMatchObject({ saved: { version: 3, text: "Prefers green tea.", lastMutationID: edit } });
  // The same mutation again, as after a lost answer, answers the fact as it is and saves nothing.
  expect(
    changeFact(db, fact.id, 2, edit, { action: "edit", text: "Prefers green tea." }),
  ).toMatchObject({ saved: { version: 3 } });
  expect(changeFact(db, crypto.randomUUID(), 1, mutation(), { action: "delete" })).toEqual({
    missing: true,
  });
});

test("rejected and deleted facts keep their aliases across a restart and are never proposed again", () => {
  const tea = propose("Prefers tea.", "msg_tea");
  const jazz = propose("Likes jazz.", "msg_jazz");
  if (!("id" in tea) || !("id" in jazz)) throw new Error("not proposed");
  changeFact(db, tea.id, 1, mutation(), { action: "reject" });
  changeFact(db, jazz.id, 1, mutation(), { action: "approve" });
  changeFact(db, jazz.id, 2, mutation(), { action: "edit", text: "Loves jazz." });
  changeFact(db, jazz.id, 3, mutation(), { action: "delete" });
  expect(readFact(db, tea.id)).toMatchObject({ state: "rejected", text: null, version: 2 });
  // No alias holds text, only hashes.
  expect(
    db
      .select()
      .from(ownerFactKeys)
      .all()
      .every((row) => /^[0-9a-f]{64}$/.test(row.key)),
  ).toBe(true);
  db.$client.close();
  db = openDatabase(path);
  // The rejected text, however written, the deleted fact's old and new wording, and anything else
  // from a removed fact's message are refused.
  expect(propose("PREFERS  tea!", "msg_new")).toEqual({ suppressed: true });
  expect(propose("Likes jazz", "msg_new")).toEqual({ suppressed: true });
  expect(propose("Loves jazz", "msg_new")).toEqual({ suppressed: true });
  expect(propose("Something else entirely.", "msg_tea")).toEqual({ suppressed: true });
  // A different fact from a new message is a new proposal: paraphrases aren't detected.
  expect(propose("Enjoys a cup of tea.", "msg_new")).toHaveProperty("id");
  // The owner can't add a tombstoned text; only an explicit restore at its version brings it back.
  expect(
    changeFact(db, crypto.randomUUID(), 0, mutation(), { action: "create", text: "Prefers tea." }),
  ).toMatchObject({ conflict: null, existing: { id: tea.id, state: "rejected" } });
  expect(
    changeFact(db, tea.id, 2, mutation(), { action: "restore", text: "Prefers tea." }),
  ).toMatchObject({ saved: { state: "approved", version: 3, text: "Prefers tea." } });
  // A restore keeps the source blocked.
  expect(propose("Another fact.", "msg_tea")).toEqual({ suppressed: true });
});

test("detected credentials are refused in fixed words before anything is stored", () => {
  for (const text of ["password: hunter2", "key ghp_abcdefghijklmnop1234 here"]) {
    expect(propose(text)).toEqual({ invalid: secretRefusal });
    expect(factText(text)).toEqual({ invalid: secretRefusal });
  }
  expect(db.select().from(ownerFactKeys).all()).toEqual([]);
  expect(factText("x".repeat(501))).toHaveProperty("invalid");
  expect(factText("?!")).toHaveProperty("invalid");
  expect(factText("bad \ud800 text")).toHaveProperty("invalid");
  expect(factText("  Plain.  ")).toBe("Plain.");
  expect(parsePatch({ action: "approve", version: 1, mutationID: "nope" })).toHaveProperty(
    "invalid",
  );
  expect(
    parsePatch({ action: "edit", version: 1, mutationID: crypto.randomUUID(), text: "pass: x1" }),
  ).toEqual({ invalid: secretRefusal });
});

test("the approved set stays within its UTF-8 budget, refused whole and rolled back", () => {
  const facts = Array.from({ length: 40 }, (_, at) => `${at} ${"é".repeat(120)}`);
  let refused = 0;
  for (const text of facts) {
    const result = changeFact(db, crypto.randomUUID(), 0, mutation(), { action: "create", text });
    if ("refused" in result) {
      expect(result.refused).toBe(budgetRefusal);
      refused++;
    }
  }
  expect(refused).toBeGreaterThan(0);
  const { approved, entryBytes } = ownerMemory(db);
  expect(entryBytes).toBeLessThanOrEqual(ownerEntryLimit);
  expect(Buffer.byteLength(ownerSection(db).text)).toBe(entryBytes);
  // A refused create left no alias, so the same text can be proposed once room is made.
  expect(db.select().from(ownerFactKeys).all()).toHaveLength(approved.length);
});

test("pending proposals are capped per dot and refused without eviction; a failed write saves nothing", () => {
  for (let at = 0; at < pendingPerDot; at++) propose(`Fact number ${at}.`, `msg_${at}`);
  expect(propose("One too many.", "msg_more")).toHaveProperty("full");
  expect(propose("From another dot.", "msg_other", "polnareff")).toHaveProperty("id");
  expect(ownerMemory(db).pending).toHaveLength(pendingPerDot + 1);
  expect(() =>
    proposeFact(db, origin("msg_throw", "polnareff"), "Thrown midway.", () => {
      throw new Error("binding read failed");
    }),
  ).toThrow();
  expect(proposeFact(db, origin("msg_moved"), "Rebound.", () => false)).toEqual({ unbound: true });
  expect(ownerMemory(db).pending).toHaveLength(pendingPerDot + 1);
});

test("a second connection sees the first's aliases at once, as concurrent proposals do", () => {
  const other = openDatabase(path);
  try {
    expect(proposeFact(other, origin("msg_a"), "Lives in Lisbon.", bound)).toHaveProperty(
      "proposed",
    );
    expect(proposeFact(db, origin("msg_b", "polnareff"), "lives in lisbon", bound)).toHaveProperty(
      "existing",
    );
    expect(ownerMemory(db).pending).toHaveLength(1);
  } finally {
    other.$client.close();
  }
});

test("rendering is fixed for the empty set, sorted by code point and free of metadata", () => {
  expect(renderOwner([])).toEndWith("No approved facts.");
  // U+FF21 sorts after U+1F600's surrogates by UTF-16 code unit, but before it by code point.
  const rendered = renderOwner(["😀 smile", "Ａ wide", "Ａ wide"]);
  expect(rendered.indexOf("Ａ")).toBeLessThan(rendered.indexOf("😀"));
  expect(rendered.match(/Ａ wide/g)).toHaveLength(1);
  expect(renderOwner(["b", "a"])).toBe(renderOwner(["a", "b"]));
});
