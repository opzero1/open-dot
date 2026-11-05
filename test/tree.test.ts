import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import {
  autoRecall,
  autoRecallHits,
  autoRecallWords,
  recalledBlock,
  saveArchiveSettings,
  settingsOf,
} from "../src/archive";
import { type ContextItem, composeTurn } from "../src/compose";
import { type Db, openDatabase } from "../src/db";
import { forgetMessages, forgetObservation, ledgerHits } from "../src/ledger";
import { OpenCode, OpenCodeError } from "../src/opencode";
import {
  archive,
  dots,
  forgottenObservations,
  ledger,
  treeSamples,
  treeTrials,
} from "../src/schema";
import { dataJSON } from "../src/supervise";
import {
  recordTreeSample,
  reviewTreeSample,
  setTreeTrial,
  shadowTree,
  treeLimits,
  treeNode,
  treeNodes,
  treeReport,
  treeSample,
  treeSampleSource,
  treeStatus,
} from "../src/tree";

let db: Db;
let home: string;
const day = 86_400_000;

const dotOf = (name = "jojo") => {
  const row = db.select().from(dots).where(eq(dots.name, name)).get();
  if (!row) throw new Error("no dot");
  return row;
};

const message = (
  messageID: string,
  text: string,
  createdAt: number,
  {
    dot = "jojo",
    role = "owner",
    session,
  }: { dot?: string; role?: "owner" | "dot"; session?: string } = {},
) =>
  db
    .insert(archive)
    .values({
      dot,
      sessionID: session ?? `ses_${dot}`,
      messageID,
      role,
      text,
      createdAt,
      archivedAt: createdAt,
    })
    .run();

const observe = (
  text: string,
  sources: string[],
  at: number,
  {
    dot = "jojo",
    topic = "plans",
    priority = 2,
    session,
  }: { dot?: string; topic?: string; priority?: number; session?: string } = {},
) =>
  db
    .insert(ledger)
    .values({
      dot,
      sessionID: session ?? `ses_${dot}`,
      kind: "fact",
      topic,
      text,
      priority,
      validFrom: at,
      sources,
      updatedBy: "observer",
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();

/** Forty unrelated messages, so the archive's word statistics are like a real one's. */
const filler = (dot = "jojo") => {
  for (let at = 0; at < 40; at++)
    message(`msg_filler_${dot}_${at}`, `Filler ${at}: lunch plans and the weather today.`, at, {
      dot,
    });
};

const ask = (id: string, text: string, extra: ContextItem[] = []): ContextItem[] => [
  ...extra,
  { id, type: "user", text },
];

const on = () =>
  saveArchiveSettings(db, "jojo", { archive: true, autoRecall: true, ledger: true }, 1);
const samples = () => db.select().from(treeSamples).all();

const byMessage = (id: string) => {
  const row = samples().find((each) => each.messageID === id);
  if (!row) throw new Error("no sample");
  return row.id;
};

/** A tree view that isn't blocked, or the test fails. */
const readable = <T extends object>(value: T | undefined) => {
  if (!value || "blocked" in value) throw new Error(`unreadable: ${JSON.stringify(value)}`);
  return value as Exclude<T, { blocked: string }>;
};

/** What compose would pass for this owner message: the real baseline block, from the archive. */
const shadowOf = (owner: string, query: string) => {
  const words = autoRecallWords(query);
  const visible = new Set([owner]);
  const hits = autoRecall(db, dotOf(), query, visible);
  const observed = ledgerHits(db, "jojo", words, new Set(), autoRecallHits, 2);
  return {
    owner,
    query,
    words,
    hits,
    recalled: recalledBlock(hits, observed),
    shown: new Set<number>(),
    visible,
    ms: 0,
  };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "open-dot-tree-"));
  db = openDatabase(join(home, "open-dot.db"));
  for (const name of ["jojo", "polnareff"])
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

afterEach(() => {
  db.$client.close();
  rmSync(home, { recursive: true, force: true });
});

test("the trial is off by default, needs the layers on, and never changes the live block", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  const items = ask("msg_q1", "What is the Lisbon offsite budget?");
  expect(treeStatus(db, dotOf())).toMatchObject({ enabled: false, state: "off", run: null });
  expect(setTreeTrial(db, "jojo", true, 1)).toMatchObject({ refused: expect.any(String) });
  on();
  const before = composeTurn(db, dotOf(), items);
  expect(samples()).toEqual([]);

  const started = setTreeTrial(db, "jojo", true, Date.now());
  expect(started).toMatchObject({ saved: { enabled: true, state: "collecting" } });
  const after = composeTurn(db, dotOf(), items);
  // The baseline is exactly what the dot gets with the trial off.
  expect(after).toEqual(before);
  expect(after.tail).toContain("<recalled-context>");
  expect(after.tail).not.toContain("recalled-tree");
  expect(samples()).toHaveLength(1);

  // Repeated hooks, a kept cache and a restart's empty cache count the query once.
  const cache: { key?: string; text?: string } = {};
  composeTurn(db, dotOf(), items, cache);
  composeTurn(db, dotOf(), items, cache);
  composeTurn(db, dotOf(), items, {});
  expect(samples()).toHaveLength(1);

  // Enabling again changes nothing: same run, same end, no extension.
  const again = setTreeTrial(db, "jojo", true, Date.now() + day);
  expect("saved" in again && again.saved.run).toEqual("saved" in started && started.saved.run);

  // A native compaction keeps phases 1 and 2 only: no sample.
  composeTurn(db, dotOf(), [
    { id: "cmp_1", type: "compaction", status: "completed", native: {} },
    ...ask("msg_q2", "What is the Lisbon offsite budget again?"),
  ]);
  expect(samples()).toHaveLength(1);

  // A failing shadow collector never touches the baseline.
  db.$client.exec("DROP TABLE tree_samples");
  expect(composeTurn(db, dotOf(), ask("msg_q3", "What is the Lisbon offsite budget?")).tail).toBe(
    before.tail,
  );
});

test("a writer holding the database drops the sample at once and leaves the busy timeout as it was", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  on();
  const items = ask("msg_q", "What is the Lisbon offsite budget?");
  const before = composeTurn(db, dotOf(), items);
  setTreeTrial(db, "jojo", true, Date.now());
  const timeout = () =>
    db.$client.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
  expect(timeout()).toBe(5000);

  const writer = new Database(join(home, "open-dot.db"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const started = performance.now();
    const held = composeTurn(db, dotOf(), items);
    const elapsed = performance.now() - started;
    // Not the 5-second wait: the sample is dropped, unmeasured, and the block is unchanged.
    expect(elapsed).toBeLessThan(1000);
    expect(held).toEqual(before);
    expect(samples()).toEqual([]);
    expect(timeout()).toBe(5000);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  shadowTree(db, dotOf(), shadowOf("msg_q", "What is the Lisbon offsite budget?"));
  expect(samples()).toHaveLength(1);
  expect(samples()[0]?.metrics.tree.collectorMs).toBeGreaterThanOrEqual(0);
  expect(timeout()).toBe(5000);
});

test("older ranges get coarser, every node stays bounded, and children expand to observations", () => {
  for (let at = 0; at < 100; at++) {
    message(`msg_s${at}`, `Source ${at} says something about topic ${at}.`, at);
    observe(`Observation number ${at} about topic ${at}.`, [`msg_s${at}`], at);
  }
  // Nothing is shown with the archive off, and reading the tree doesn't turn it on.
  expect(treeNodes(db, dotOf())).toEqual({ blocked: "archive-off" });
  expect(treeNode(db, dotOf(), "o0")).toEqual({ blocked: "archive-off" });
  expect(settingsOf(db, "jojo").archive).toBe(false);
  on();
  const top = readable(treeNodes(db, dotOf()));
  expect(top.nodes.map((node) => [node.node, node.count])).toEqual([
    ["m", 64],
    ["o0", 8],
    ["o1", 8],
    ["o2", 16],
    ["o3", 32],
    ["o4", 36],
  ]);
  for (const node of top.nodes)
    expect(Buffer.byteLength(dataJSON(node))).toBeLessThanOrEqual(treeLimits.nodeBytes);
  // Older ranges show a smaller share of their items.
  const share = (at: number) => (top.nodes[at]?.entries.length ?? 0) / (top.nodes[at]?.count ?? 1);
  expect(share(1)).toBeGreaterThan(share(5));
  expect(top.nodes[5]?.entries.length).toBeGreaterThan(0);
  expect(top.nodes[5]?.to).toBe(new Date(35).toISOString());

  let path = "o4";
  for (;;) {
    const opened = readable(treeNode(db, dotOf(), path));
    for (const child of opened.children)
      expect(Buffer.byteLength(dataJSON(child))).toBeLessThanOrEqual(treeLimits.nodeBytes);
    if (!opened.children.length) {
      expect(opened.node).toMatchObject({ level: "leaf", count: 1 });
      expect(opened.node.entries).toEqual([
        expect.objectContaining({ sources: [expect.stringMatching(/^msg_s\d+$/)] }),
      ]);
      break;
    }
    path = `${path}.1`;
  }
  expect(treeNode(db, dotOf(), "o9")).toBeUndefined();
  expect(treeNode(db, dotOf(), "o4.2")).toBeUndefined();
  expect(treeNode(db, dotOf(), "o0.1.1.1.1")).toBeUndefined();
});

test("multibyte text keeps every node within its byte bound and never splits a character", () => {
  for (let at = 0; at < 64; at++)
    message(`msg_mb${at}`, `${"東京の予算😀 ".repeat(120)}${at}`, at, {
      role: at % 2 ? "dot" : "owner",
    });
  // Near 500 UTF-16 code units, more than 1,200 bytes whole.
  for (let at = 0; at < 20; at++)
    observe(`${"予算は四万ユーロ€😀".repeat(45)} ${at}`, [`msg_mb${at}`], at);
  on();
  const shown: Record<string, unknown>[] = [];
  const walk = (path: string) => {
    const opened = readable(treeNode(db, dotOf(), path));
    shown.push(opened.node);
    for (const child of opened.children) {
      expect(Buffer.byteLength(dataJSON(child))).toBeLessThanOrEqual(treeLimits.nodeBytes);
      walk(child.node);
    }
  };
  for (const node of readable(treeNodes(db, dotOf())).nodes) {
    expect(Buffer.byteLength(dataJSON(node))).toBeLessThanOrEqual(treeLimits.nodeBytes);
    walk(node.node);
  }
  const leaves = shown.filter((node) => node.level === "leaf");
  expect(leaves.length).toBeGreaterThan(64);
  for (const node of shown) {
    expect(Buffer.byteLength(dataJSON(node))).toBeLessThanOrEqual(treeLimits.nodeBytes);
    for (const entry of node.entries as Record<string, unknown>[])
      for (const value of Object.values(entry))
        if (typeof value === "string") expect(value.isWellFormed()).toBe(true);
  }
  // Every leaf shows its one item, an observation cut to fit with its sources, never nothing.
  for (const node of leaves) {
    expect(node.omitted).toBeUndefined();
    expect(node.entries).toHaveLength(1);
  }
  const observed = leaves.flatMap((node) =>
    (node.entries as Record<string, unknown>[]).filter((entry) => "observation" in entry),
  );
  expect(observed).toHaveLength(20);
  for (const entry of observed) {
    expect(entry.text).toBeUndefined();
    expect(String(entry.excerpt).length).toBeGreaterThan(100);
    expect(entry.sources).toEqual([expect.stringMatching(/^msg_mb\d+$/)]);
  }
  // A leaf shows a message excerpt, shortened to fit.
  expect(
    leaves.some((node) =>
      (node.entries as Record<string, unknown>[]).some(
        (entry) => typeof entry.excerpt === "string",
      ),
    ),
  ).toBe(true);
});

test("a long multibyte observation is credited only as the excerpt shown, and one that can't fit is pointed to", () => {
  filler();
  message("msg_cjk", "Lisbon budget: 四万ユーロ.", 50);
  const text = `Lisbon budget ${"予算は四万ユーロ€😀".repeat(44)}`;
  expect(text.length).toBeGreaterThan(490);
  const long = observe(text, ["msg_cjk"], 50);
  const sources = Array.from({ length: 40 }, (_, at) => `msg_filler_jojo_${at}`);
  const big = observe("予算は四万ユーロ€😀".repeat(30), sources, 30);
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const query = "What is the Lisbon budget?";
  message("msg_q", query, 60);
  composeTurn(db, dotOf(), ask("msg_q", query));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  const record = sample.tree.find((each) =>
    each.refs.some((ref) => ref.kind === "observation" && ref.observation === long.id),
  );
  const ref = record?.refs.find((each) => each.kind === "observation");
  if (!record?.node || ref?.kind !== "observation") throw new Error("not credited");
  expect(ref.length).toEqual(expect.any(Number));
  // Automatic recall shows the whole row.
  for (const each of sample.baseline.flatMap((entry) => entry.refs))
    if (each.kind === "observation") expect(each.length).toBeNull();
  const leaf = readable(treeNode(db, dotOf(), record.node));
  expect(Buffer.byteLength(dataJSON(leaf.node))).toBeLessThanOrEqual(treeLimits.nodeBytes);
  expect(leaf.node.entries).toEqual([
    expect.objectContaining({ observation: long.id, sources: ["msg_cjk"] }),
  ]);

  // The one that can't fit even cut, with its forty sources, is a pointer and never credited.
  const pointer = readable(treeNode(db, dotOf(), "o0.1")).node;
  expect(pointer).toMatchObject({
    level: "leaf",
    entries: [],
    omitted: { reason: "too-large", observation: big.id, sources: 40 },
  });
  expect(JSON.stringify(sample.tree)).not.toContain(`"observation":${big.id},`);

  const shown = () =>
    treeSample(db, dotOf(), sample.id)
      ?.tree.flatMap((each) => each.refs)
      .find((each) => each.kind === "observation" && each.observation === long.id);
  const reconstructed = shown();
  expect(reconstructed).toMatchObject({ state: "reconstructed" });
  if (reconstructed?.state !== "reconstructed") throw new Error("not reconstructed");
  const excerpt = String(reconstructed.shown.excerpt);
  expect(reconstructed.shown.text).toBeUndefined();
  expect(excerpt.startsWith("Lisbon budget")).toBe(true);
  expect(excerpt.isWellFormed()).toBe(true);
  expect(excerpt.length).toBeLessThan(text.length);
  expect(leaf.node.entries).toEqual([expect.objectContaining({ excerpt })]);

  db.$client.close();
  db = openDatabase(join(home, "open-dot.db"));
  expect(shown()).toMatchObject({ state: "reconstructed", shown: { excerpt } });
  // A correction past the shown part still invalidates it.
  db.update(ledger)
    .set({ text: `${text} Corrected.`, version: long.version + 1 })
    .where(eq(ledger.id, long.id))
    .run();
  expect(shown()).toMatchObject({ state: "unavailable", reason: "changed" });
  expect(JSON.stringify(shown())).not.toContain("予算");
});

test("retrieval descends to a represented old fact and credits only what it shows", () => {
  filler();
  for (let at = 100; at < 200; at++) {
    message(`msg_s${at}`, `Routine status ${at}.`, at);
    observe(`Routine status update ${at}.`, [`msg_s${at}`], at, { priority: 3 });
  }
  message("msg_v1", "We picked Contoso as the catering vendor for Lisbon.", 101);
  const fact = observe("Contoso is the Lisbon catering vendor.", ["msg_v1"], 101, {
    topic: "catering",
    priority: 1,
  });
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const query = "Which catering vendor did we pick for Lisbon?";
  message("msg_q", query, 300);
  composeTurn(db, dotOf(), ask("msg_q", query));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  const tree = sample.tree;
  expect(tree).toHaveLength(1);
  // It followed the coarse range down to the leaf with the fact.
  expect(tree[0]?.node).toMatch(/^o\d(\.[01])+$/);
  expect(tree[0]?.refs).toEqual([
    expect.objectContaining({
      kind: "observation",
      sessionID: "ses_jojo",
      observation: fact.id,
      sources: ["msg_v1"],
    }),
  ]);
  expect(sample.metrics.tree.sources).toBe(1);
  expect(sample.metrics.tree.bytes).toBeLessThanOrEqual(treeLimits.blockBytes);
  expect(sample.metrics.tree.visited).toBeGreaterThan(1);
  expect(sample.metrics.coverage).toMatchObject({
    observations: 101,
    observationsTruncated: false,
  });
  // Neither the query nor any summary text is stored: the query only as a hash.
  expect(sample.queryHash).toMatch(/^[0-9a-f]{64}$/);
  const stored = JSON.stringify(db.$client.query("SELECT * FROM tree_samples").all());
  for (const word of ["catering", "Contoso", "vendor", "Lisbon", "Routine"])
    expect(stored).not.toContain(word);

  const detail = treeSample(db, dotOf(), sample.id);
  expect(detail?.available).toBe(true);
  expect(detail?.query).toMatchObject({ state: "reconstructed", text: query });
  expect(detail?.tree[0]?.refs[0]).toMatchObject({
    state: "reconstructed",
    shown: { text: "Contoso is the Lisbon catering vendor." },
  });
});

test("the query is shown and reviewable only while its archived text reproduces the captured hash", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const query = "What is the Lisbon offsite budget?";
  // Never archived.
  recordTreeSample(db, dotOf(), shadowOf("msg_unarchived", query));
  // Archived with other text than compose read.
  message("msg_other", "Something else entirely.", 60);
  recordTreeSample(db, dotOf(), shadowOf("msg_other", query));
  // Archived as read, then changed, then deleted.
  message("msg_q", query, 61);
  recordTreeSample(db, dotOf(), shadowOf("msg_q", query));
  const reason = (id: string) => treeSample(db, dotOf(), byMessage(id))?.query;
  expect(reason("msg_unarchived")).toEqual({ state: "unavailable", reason: "query-not-archived" });
  expect(reason("msg_other")).toEqual({ state: "unavailable", reason: "query-changed" });
  expect(JSON.stringify(treeSample(db, dotOf(), byMessage("msg_other")))).not.toContain(
    "Something else",
  );
  expect(reason("msg_q")).toMatchObject({ state: "reconstructed", text: query });
  const q = byMessage("msg_q");
  expect(reviewTreeSample(db, dotOf(), q, "tree", 5)).toMatchObject({ saved: { review: "tree" } });

  // A positive review needs the query; "insufficient" is always allowed.
  const unarchived = byMessage("msg_unarchived");
  for (const review of ["tree", "baseline", "tie"] as const)
    expect(reviewTreeSample(db, dotOf(), unarchived, review, 5)).toMatchObject({
      refused: expect.stringContaining("query-not-archived"),
    });
  expect(reviewTreeSample(db, dotOf(), unarchived, "insufficient", 5)).toMatchObject({
    saved: { review: "insufficient" },
  });

  db.update(archive)
    .set({ text: "What is the Porto offsite budget?" })
    .where(eq(archive.messageID, "msg_q"))
    .run();
  expect(reason("msg_q")).toEqual({ state: "unavailable", reason: "query-changed" });
  expect(treeSample(db, dotOf(), q)?.available).toBe(false);
  forgetMessages(db, "jojo", ["msg_q"]);
  expect(reason("msg_q")).toEqual({ state: "unavailable", reason: "query-not-archived" });
  // Its earlier positive review no longer counts.
  expect(treeReport(db, dotOf())?.reviews.tree).toBe(0);
});

test("corrections, forgets and deleted sources are enforced in the tree and in every inspection", () => {
  filler();
  message("msg_old", "The Lisbon offsite budget is 30k euros.", 60);
  message("msg_new", "Correction: the Lisbon offsite budget is 40k euros.", 61);
  message("msg_venue", "The Lisbon offsite venue is the riverside hall.", 62);
  const old = observe("The Lisbon offsite budget is 30k euros.", ["msg_old"], 60, {
    topic: "budget",
  });
  const fresh = observe("The Lisbon offsite budget is 40k euros.", ["msg_new"], 61, {
    topic: "budget",
  });
  db.update(ledger).set({ supersededBy: fresh.id }).where(eq(ledger.id, old.id)).run();
  const venue = observe("The Lisbon offsite venue is the riverside hall.", ["msg_venue"], 62, {
    topic: "venue",
  });
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const top = readable(treeNodes(db, dotOf()));
  const shownIDs = JSON.stringify(top);
  expect(shownIDs).not.toContain(`"observation":${old.id},`);
  expect(shownIDs).toContain(`"observation":${fresh.id},`);
  // The superseded row's raw source message is left out of the recent detail too.
  expect(shownIDs).not.toContain("msg_old");
  expect(shownIDs).not.toContain("30k");
  expect(top.coverage.messagesSuperseded).toBe(1);

  composeTurn(db, dotOf(), ask("msg_q", "What is the Lisbon offsite budget 30k?"));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  // The baseline recalled the old message, a source of a superseded row; the tree didn't.
  expect(sample.metrics.baseline.superseded).toBeGreaterThan(0);
  expect(sample.metrics.tree.superseded).toBe(0);
  expect(JSON.stringify(sample.tree)).not.toContain("msg_old");

  // The owner forgets the newer row but keeps its archived message: the tree drops both, and the
  // stored sample can't show either any more.
  const credits = JSON.stringify([sample.baseline, sample.tree]);
  expect(credits).toContain("msg_new");
  forgetObservation(db, "jojo", fresh.id, 1);
  expect(db.select().from(archive).where(eq(archive.messageID, "msg_new")).get()).toBeDefined();
  const after = JSON.stringify(treeNodes(db, dotOf()));
  expect(after).not.toContain("msg_new");
  expect(after).not.toContain("40k");
  const detail = treeSample(db, dotOf(), sample.id);
  expect(detail?.available).toBe(false);
  const all = JSON.stringify(detail);
  expect(all).not.toContain("40k");
  expect(treeSampleSource(db, dotOf(), sample.id, "msg_new")).toMatchObject({
    state: "unavailable",
    captured: [{ arm: "tree", state: "unavailable", reason: "source-of-forgotten-observation" }],
  });
  expect(JSON.stringify(treeSampleSource(db, dotOf(), sample.id, "msg_new"))).not.toContain("40k");

  // Deleting a source from the archive drops the observation it supports.
  forgetMessages(db, "jojo", ["msg_venue"]);
  expect(JSON.stringify(treeNodes(db, dotOf()))).not.toContain(`"observation":${venue.id},`);
  // A current source read is labelled as such; its captured excerpt is shown only when the
  // current text still reproduces it exactly.
  expect(treeSampleSource(db, dotOf(), sample.id, "msg_old")).toMatchObject({
    state: "current-source",
    text: "The Lisbon offsite budget is 30k euros.",
    captured: [{ arm: "baseline", state: "reconstructed" }],
  });
  db.update(archive)
    .set({ text: "The Lisbon offsite budget is 35k euros." })
    .where(eq(archive.messageID, "msg_old"))
    .run();
  const changed = treeSampleSource(db, dotOf(), sample.id, "msg_old");
  // With no reference crediting it reconstructed any more, the current source isn't read either.
  expect(changed).toMatchObject({
    state: "unavailable",
    reason: "changed",
    captured: [{ arm: "baseline", state: "unavailable", reason: "changed" }],
  });
  expect(JSON.stringify(changed)).not.toContain("35k");
  expect(treeSampleSource(db, dotOf(), sample.id, "msg_filler_jojo_1")).toBeUndefined();
});

test("a forgotten fact stays out when reworded from its source or restated verbatim", () => {
  message("msg_a", "The Lisbon offsite budget is 40k euros.", 10);
  message("msg_b", "As I said, the Lisbon offsite budget is 40k euros.", 11);
  message("msg_c", "The Lisbon offsite now has a budget of 45k euros.", 12);
  message("msg_exact", "The Lisbon offsite budget is 40k euros.", 16);
  const forgotten = observe("The Lisbon offsite budget is 40k euros.", ["msg_a"], 10);
  forgetObservation(db, "jojo", forgotten.id, 1);
  const reworded = observe("Lisbon budget: forty thousand euros.", ["msg_a"], 13);
  const verbatim = observe("The Lisbon offsite budget is 40k euros.", ["msg_b"], 14);
  const restated = observe("The Lisbon offsite budget is 45k euros.", ["msg_c"], 15);
  on();
  const shown = JSON.stringify(readable(treeNodes(db, dotOf())));
  expect(shown).not.toContain(`"observation":${reworded.id},`);
  expect(shown).not.toContain(`"observation":${verbatim.id},`);
  expect(shown).toContain(`"observation":${restated.id},`);
  // The forgotten row's own message stays out of the recent detail as well.
  expect(shown).not.toContain("msg_a");
  expect(shown).not.toContain("msg_exact");
});

test("only the dot's bound session contributes, and a rebind pauses the run and hides its samples", () => {
  filler();
  filler("polnareff");
  message("msg_mine", "The Lisbon offsite budget is 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_mine"], 50);
  message("msg_theirs", "The Lisbon offsite budget is secret polnareff stuff.", 51, {
    dot: "polnareff",
  });
  observe("Polnareff's Lisbon offsite budget is elsewhere.", ["msg_theirs"], 51, {
    dot: "polnareff",
  });
  message("msg_earlier", "An earlier session's Lisbon offsite budget.", 52, {
    session: "ses_earlier",
  });
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const tree = JSON.stringify(treeNodes(db, dotOf()));
  expect(tree).not.toContain("polnareff");
  expect(tree).not.toContain("msg_earlier");
  composeTurn(db, dotOf(), ask("msg_q", "What is the Lisbon offsite budget?"));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  expect(treeSample(db, dotOf("polnareff"), sample.id)).toBeUndefined();

  db.update(dots).set({ sessionID: "ses_next" }).where(eq(dots.name, "jojo")).run();
  expect(treeStatus(db, dotOf())).toMatchObject({ state: "session-changed" });
  composeTurn(db, dotOf(), ask("msg_q2", "What is the Lisbon offsite budget?"));
  expect(samples()).toHaveLength(1);
  const detail = JSON.stringify(treeSample(db, dotOf(), sample.id));
  expect(detail).toContain("session-changed");
  expect(detail).not.toContain("40k");
  expect(treeSampleSource(db, dotOf(), sample.id, "msg_mine")).toMatchObject({
    state: "unavailable",
    reason: "session-changed",
  });
});

test("a baseline observation from an earlier session is checked in that session, never by ID alone", () => {
  filler();
  message("msg_x", "Old plan: the Lisbon offsite budget is 25k euros.", 5, {
    session: "ses_earlier",
  });
  // The same message ID in the bound session, with other text.
  message("msg_x", "Unrelated chat about coffee.", 41);
  const earlier = observe("The Lisbon offsite budget was 25k euros.", ["msg_x"], 5, {
    session: "ses_earlier",
  });
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const query = "What was the Lisbon offsite budget plan?";
  message("msg_q", query, 60);
  composeTurn(db, dotOf(), ask("msg_q", query));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  expect(sample.baseline).toContainEqual({
    refs: [expect.objectContaining({ observation: earlier.id, sessionID: "ses_earlier" })],
  });
  // The candidate tree is the bound session's only.
  expect(JSON.stringify(sample.tree)).not.toContain(`"observation":${earlier.id},`);
  const ref = () =>
    treeSample(db, dotOf(), sample.id)
      ?.baseline.flatMap((record) => record.refs)
      .find((each) => each.kind === "observation" && each.observation === earlier.id);
  expect(ref()).toMatchObject({
    state: "reconstructed",
    shown: { text: "The Lisbon offsite budget was 25k euros." },
  });
  // Deleting the earlier session's source invalidates it, though the bound session has that ID.
  forgetMessages(db, "jojo", ["msg_x"], "ses_earlier");
  expect(db.select().from(archive).where(eq(archive.messageID, "msg_x")).all()).toHaveLength(1);
  expect(ref()).toMatchObject({ state: "unavailable", reason: "source-deleted" });
  expect(JSON.stringify(ref())).not.toContain("25k");
});

test("more forget tombstones than the cap blocks every view and every sample, never a partial list", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const query = "What is the Lisbon offsite budget?";
  message("msg_q", query, 60);
  composeTurn(db, dotOf(), ask("msg_q", query));
  const [sample] = samples();
  if (!sample) throw new Error("no sample");
  expect(treeSample(db, dotOf(), sample.id)?.available).toBe(true);
  db.insert(forgottenObservations)
    .values(
      Array.from({ length: treeLimits.tombstones + 1 }, (_, at) => ({
        dot: "jojo",
        sources: [`msg_gone${at}`],
        fingerprint: `print${at}`,
        forgottenAt: at,
      })),
    )
    .run();
  expect(treeNodes(db, dotOf())).toEqual({ blocked: "tombstones-over-limit" });
  expect(treeNode(db, dotOf(), "o0")).toEqual({ blocked: "tombstones-over-limit" });
  expect(treeStatus(db, dotOf())).toMatchObject({ state: "tombstones-over-limit" });
  const detail = treeSample(db, dotOf(), sample.id);
  expect(detail).toMatchObject({
    available: false,
    unavailable: "tombstones-over-limit",
    query: { state: "unavailable", reason: "tombstones-over-limit" },
  });
  expect(JSON.stringify(detail)).not.toContain("40k");
  expect(JSON.stringify(detail)).not.toContain("Lisbon");
  expect(treeSampleSource(db, dotOf(), sample.id, "msg_budget")).toMatchObject({
    state: "unavailable",
    reason: "tombstones-over-limit",
  });
  composeTurn(db, dotOf(), ask("msg_q2", "What is the Lisbon offsite budget now?"));
  expect(samples()).toHaveLength(1);
});

const input = (owner: string) => ({
  owner,
  query: `Row extra ${owner}`,
  words: ["row", "extra"],
  hits: [],
  recalled: "",
  shown: new Set<number>(),
  visible: new Set<string>(),
  ms: 0,
});

test("load, daily and run limits hold, and settings changes pause the run", () => {
  filler();
  for (let at = 0; at < 600; at++) observe(`Row ${at}.`, [`msg_filler_jojo_${at % 40}`], at + 100);
  for (let at = 0; at < 30; at++) message(`msg_extra${at}`, `Extra ${at}.`, 1000 + at);
  on();
  const start = Date.UTC(2026, 10, 6, 12);
  setTreeTrial(db, "jojo", true, start);
  for (let at = 0; at < 25; at++) recordTreeSample(db, dotOf(), input(`msg_d1_${at}`), start + at);
  expect(samples()).toHaveLength(treeLimits.dailySamples);
  const [first] = samples();
  expect(first?.metrics.coverage).toMatchObject({
    observations: 512,
    observationsTruncated: true,
    messages: 64,
    messagesTruncated: true,
  });
  expect(first?.metrics.tree.records).toBeLessThanOrEqual(3);
  expect(first?.metrics.tree.bytes).toBeLessThanOrEqual(treeLimits.blockBytes);
  expect(treeStatus(db, dotOf(), start + 30)).toMatchObject({ state: "daily-limit" });
  // The next UTC day collects again.
  expect(recordTreeSample(db, dotOf(), input("msg_d2_0"), start + day)).toBeDefined();

  // A switch change pauses; putting it back, with no generation change, resumes the same run.
  saveArchiveSettings(db, "jojo", { rankNotes: true }, 2);
  expect(treeStatus(db, dotOf(), start + day)).toMatchObject({ state: "settings-changed" });
  expect(recordTreeSample(db, dotOf(), input("msg_d2_1"), start + day)).toBeUndefined();
  saveArchiveSettings(db, "jojo", { rankNotes: false }, 3);
  expect(recordTreeSample(db, dotOf(), input("msg_d2_1"), start + day)).toBeDefined();

  // The run cap stops collection, but the decision still waits for the 14-day window.
  const trial = db.select().from(treeTrials).get();
  if (!trial) throw new Error("no trial");
  const have = samples().length;
  for (let at = have; at < treeLimits.runSamples; at++)
    db.insert(treeSamples)
      .values({
        dot: "jojo",
        run: trial.run,
        sessionID: "ses_jojo",
        messageID: `msg_bulk${at}`,
        queryHash: "0".repeat(64),
        day: 0,
        createdAt: start,
        baseline: [],
        tree: [],
        metrics: first?.metrics ?? ({} as never),
      })
      .run();
  expect(recordTreeSample(db, dotOf(), input("msg_d3_0"), start + 2 * day)).toBeUndefined();
  expect(treeStatus(db, dotOf(), start + 2 * day)).toMatchObject({ state: "run-full" });
  expect(treeReport(db, dotOf(), start + 2 * day)).toMatchObject({
    run: { ended: false },
    decision: { outcome: "insufficient-evidence" },
  });
  expect(treeReport(db, dotOf(), start + 14 * day)?.run.ended).toBe(true);

  // The window ends after 14 days, and enabling again never extends it.
  expect(treeStatus(db, dotOf(), start + 14 * day)).toMatchObject({ state: "expired" });
  setTreeTrial(db, "jojo", true, start + 14 * day);
  expect(db.select().from(treeTrials).get()?.endsAt).toBe(start + 14 * day);
  // Off then on is a new run that replaces the old samples.
  setTreeTrial(db, "jojo", false, start + 14 * day);
  expect(treeStatus(db, dotOf(), start + 14 * day)).toMatchObject({ enabled: false, state: "off" });
  expect(samples()).toHaveLength(treeLimits.runSamples);
  setTreeTrial(db, "jojo", true, start + 15 * day);
  expect(db.select().from(treeTrials).get()?.run).not.toBe(trial.run);
  expect(samples()).toEqual([]);
});

test("budget changes pause, while archive or observer off and on requires a new run", () => {
  on();
  const start = Date.UTC(2026, 10, 6, 12);
  setTreeTrial(db, "jojo", true, start);
  const status = () => treeStatus(db, dotOf(), start + 1);
  expect(status()).toMatchObject({ state: "collecting" });
  const budget = settingsOf(db, "jojo").observerDailyTokens;
  saveArchiveSettings(db, "jojo", { observerDailyTokens: budget * 2 }, 2);
  expect(status()).toMatchObject({ state: "settings-changed" });
  saveArchiveSettings(db, "jojo", { observerDailyTokens: budget }, 3);
  expect(status()).toMatchObject({ state: "collecting" });

  for (const layer of ["archive", "observer"] as const) {
    setTreeTrial(db, "jojo", false, start);
    setTreeTrial(db, "jojo", true, start);
    expect(status()).toMatchObject({ state: "collecting" });
    const was = settingsOf(db, "jojo")[layer];
    saveArchiveSettings(db, "jojo", { [layer]: !was }, 4);
    saveArchiveSettings(db, "jojo", { [layer]: was }, 5);
    // The same switches again, but a new settings generation.
    expect(status()).toMatchObject({ state: "settings-changed" });
  }
});

test("a run and its samples survive closing and reopening the database", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  on();
  setTreeTrial(db, "jojo", true, Date.now());
  const items = ask("msg_q", "What is the Lisbon offsite budget?");
  composeTurn(db, dotOf(), items);
  const run = db.select().from(treeTrials).get()?.run;
  db.$client.close();
  db = openDatabase(join(home, "open-dot.db"));
  expect(treeStatus(db, dotOf())).toMatchObject({ state: "collecting", run: { id: run } });
  composeTurn(db, dotOf(), items);
  expect(samples()).toHaveLength(1);
  composeTurn(db, dotOf(), ask("msg_q2", "And the Lisbon offsite budget now?"));
  expect(samples()).toHaveLength(2);
});

test("the report counts only reviews of available samples and waits for the 14-day window", () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  on();
  const start = Date.UTC(2026, 10, 6);
  setTreeTrial(db, "jojo", true, start);
  // 22 real, archived owner queries in each week, at most 11 a day.
  const days = [0, 1, 8, 9];
  days.forEach((offset, index) => {
    for (let at = 0; at < 11; at++) {
      const id = `msg_r${index}_${at}`;
      const query = `What is the Lisbon offsite budget, take ${index * 11 + at}?`;
      message(id, query, 100 + index * 11 + at);
      expect(
        recordTreeSample(db, dotOf(), shadowOf(id, query), start + offset * day + at),
      ).toBeDefined();
    }
  });
  const rows = samples();
  expect(rows).toHaveLength(44);
  for (const row of rows) {
    expect(row.tree.length).toBeGreaterThan(0);
    expect(row.baseline.length).toBeGreaterThan(0);
  }
  rows.forEach((row, at) => {
    const review = at % 2 ? "tree" : at % 4 ? "tie" : "baseline";
    expect(reviewTreeSample(db, dotOf(), row.id, review, start)).toMatchObject({
      saved: { review, available: true },
    });
  });
  const during = treeReport(db, dotOf(), start + 13 * day);
  expect(during).toMatchObject({
    run: { ended: false },
    paired: { total: 44, week1: 22, week2: 22 },
    decision: { outcome: "insufficient-evidence" },
    summaryModelTokens: 0,
  });
  const ended = treeReport(db, dotOf(), start + 14 * day);
  if (!ended) throw new Error("no report");
  expect(ended.run.ended).toBe(true);
  expect(ended.reviewSet).toEqual([
    ...rows.slice(0, 10).map((row) => row.id),
    ...rows.slice(22, 32).map((row) => row.id),
  ]);
  expect(ended.sourceSupportedReviews).toBe(20);
  expect(ended.decision.outcome).toBe("benefit-if-no-defect");
  expect(ended.latencyMs.collector).toMatchObject({ n: 44 });

  // A query deleted from the archive takes its sample out of the set, and its review with it.
  const gone = rows[1];
  if (!gone) throw new Error("no sample");
  forgetMessages(db, "jojo", [gone.messageID]);
  const after = treeReport(db, dotOf(), start + 14 * day);
  expect(after?.reviewSet).not.toContain(gone.id);
  expect(after?.reviewSet).toContain(rows[10]?.id);
  expect(after?.invalidated).toContainEqual({ id: gone.id, reason: "query-not-archived" });
  expect(reviewTreeSample(db, dotOf(), gone.id, "tree", start)).toMatchObject({
    refused: expect.any(String),
  });
});

const token = "secret";
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));
const call = (method: string, path: string, body?: string, auth = token) =>
  api(
    db,
    token,
    down,
  )(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    }),
  );

test("the owner's tree routes validate input, are idempotent and expose no other dot's samples", async () => {
  filler();
  message("msg_budget", "The Lisbon offsite budget is now 40k euros.", 50);
  observe("The Lisbon offsite budget is 40k euros.", ["msg_budget"], 50);
  expect((await call("GET", "/dots/jojo/memory/tree", undefined, "wrong")).status).toBe(401);
  expect(await (await call("GET", "/dots/jojo/memory/tree")).json()).toMatchObject({
    enabled: false,
    state: "off",
  });
  expect((await call("PUT", "/dots/jojo/memory/tree", '{"enabled":true}')).status).toBe(409);
  on();
  for (const bad of ['{"enabled":1}', '{"enabled":true,"x":1}', "[]", "nope", "{}"])
    expect((await call("PUT", "/dots/jojo/memory/tree", bad)).status).toBe(400);
  expect((await call("GET", "/dots/jojo/memory/tree?x=1")).status).toBe(400);
  const first = (await (
    await call("PUT", "/dots/jojo/memory/tree", '{"enabled":true}')
  ).json()) as {
    run: { id: string };
  };
  const second = (await (
    await call("PUT", "/dots/jojo/memory/tree", '{"enabled":true}')
  ).json()) as {
    run: { id: string };
  };
  expect(second.run.id).toBe(first.run.id);

  const query = "What is the Lisbon offsite budget?";
  message("msg_q", query, 70);
  composeTurn(db, dotOf(), ask("msg_q", query));
  const listed = (await (await call("GET", "/dots/jojo/memory/tree/samples")).json()) as {
    samples: { id: number }[];
  };
  expect(listed.samples).toHaveLength(1);
  const id = listed.samples[0]?.id;
  expect(JSON.stringify(listed)).not.toContain("40k");
  expect(await (await call("GET", `/dots/jojo/memory/tree/samples/${id}`)).json()).toMatchObject({
    available: true,
    query: { state: "reconstructed", text: query },
  });
  expect((await call("GET", `/dots/polnareff/memory/tree/samples/${id}`)).status).toBe(404);
  expect((await call("GET", "/dots/jojo/memory/tree/samples/0")).status).toBe(404);
  const source = await call("GET", `/dots/jojo/memory/tree/samples/${id}/sources/msg_budget`);
  expect(await source.json()).toMatchObject({ state: "current-source" });
  expect(
    (await call("GET", `/dots/jojo/memory/tree/samples/${id}/sources/msg_filler_jojo_1`)).status,
  ).toBe(404);

  const review = `/dots/jojo/memory/tree/samples/${id}/review`;
  expect((await call("PUT", review, '{"review":"great"}')).status).toBe(400);
  expect((await call("PUT", review, '{"review":"tree","note":"x"}')).status).toBe(400);
  const reviewed = (await (await call("PUT", review, '{"review":"tree"}')).json()) as {
    review: string;
    reviewedAt: number;
  };
  expect(reviewed.review).toBe("tree");
  expect(typeof reviewed.reviewedAt).toBe("number");
  const repeated = (await (await call("PUT", review, '{"review":"tree"}')).json()) as {
    reviewedAt: number;
  };
  expect(repeated.reviewedAt).toBe(reviewed.reviewedAt);
  expect(db.select().from(treeSamples).get()?.review).toBe("tree");

  expect(await (await call("GET", "/dots/jojo/memory/tree/report")).json()).toMatchObject({
    paired: { total: 1 },
    decision: { outcome: "insufficient-evidence" },
  });
  expect((await call("GET", "/dots/jojo/memory/tree/nodes")).status).toBe(200);
  expect((await call("GET", "/dots/jojo/memory/tree/nodes/o0")).status).toBe(200);
  expect((await call("GET", "/dots/jojo/memory/tree/nodes/zz")).status).toBe(404);
  expect((await call("DELETE", "/dots/jojo/memory/tree")).status).toBe(404);

  // Off keeps the samples reviewable while the archive is on.
  expect(
    await (await call("PUT", "/dots/jojo/memory/tree", '{"enabled":false}')).json(),
  ).toMatchObject({ enabled: false, state: "off" });
  composeTurn(db, dotOf(), ask("msg_q2", "What is the Lisbon offsite budget now?"));
  expect(samples()).toHaveLength(1);
  expect(await (await call("GET", `/dots/jojo/memory/tree/samples/${id}`)).json()).toMatchObject({
    available: true,
  });
  expect((await call("GET", "/dots/jojo/memory/tree/nodes")).status).toBe(200);

  // With the archive off, or the dot not ready, every content route withholds content.
  const withheld = async (reason: string) => {
    const nodes = await call("GET", "/dots/jojo/memory/tree/nodes");
    expect(nodes.status).toBe(409);
    expect(await nodes.json()).toEqual({ blocked: reason });
    expect((await call("GET", "/dots/jojo/memory/tree/nodes/o0")).status).toBe(409);
    const detail = await (await call("GET", `/dots/jojo/memory/tree/samples/${id}`)).json();
    expect(detail).toMatchObject({
      available: false,
      unavailable: reason,
      query: { state: "unavailable", reason },
    });
    const sourced = await (
      await call("GET", `/dots/jojo/memory/tree/samples/${id}/sources/msg_budget`)
    ).json();
    expect(sourced).toMatchObject({ state: "unavailable", reason });
    const report = await (await call("GET", "/dots/jojo/memory/tree/report")).json();
    expect(report).toMatchObject({ access: reason, reviewSet: [] });
    for (const shown of [detail, sourced, report]) {
      expect(JSON.stringify(shown)).not.toContain("40k");
      expect(JSON.stringify(shown)).not.toContain("Lisbon");
    }
    expect((await call("PUT", review, '{"review":"tie"}')).status).toBe(409);
  };
  saveArchiveSettings(db, "jojo", { archive: false }, 9);
  await withheld("archive-off");
  // Reading turned nothing on.
  expect(settingsOf(db, "jojo")).toMatchObject({ archive: false });
  saveArchiveSettings(db, "jojo", { archive: true }, 10);
  db.update(dots).set({ sessionState: "creating" }).where(eq(dots.name, "jojo")).run();
  await withheld("not-ready");
});
