import { expect, test } from "bun:test";
import type { FeedItem, Instructions } from "../bridge";
import { linkAppID, tokenMatches } from "../slack";
import {
  changedFields,
  Drafts,
  FeedReplies,
  FeedState,
  Fence,
  InstructionsState,
  Searches,
} from "../surfaces";

const item = (id: number): FeedItem => ({
  id,
  source: "github",
  reason: "Mentioned",
  title: `Item ${id}`,
  context: "acme/app",
  url: null,
  time: id,
  handedTo: null,
});
const shown = (state: FeedState) => state.items.map((row) => row.id);
const loaded = (ids: number[]) => {
  const state = new FeedState();
  expect(state.apply(state.startPoll(), ids.map(item))).toBe(true);
  return state;
};

test("a poll begun before a clear can't bring it back after a newer poll settles it", () => {
  const state = loaded([1, 2]);
  const a = state.startPoll();
  const sent = state.items;
  state.dismiss(sent.map((row) => row.id));
  expect(shown(state)).toEqual([]);
  state.finish(sent, new Set([1, 2]), () => "unused");
  expect(state.apply(state.startPoll(), [item(3)])).toBe(true);
  expect(state.apply(a, [item(1), item(2)])).toBe(false);
  expect(shown(state)).toEqual([3]);
});

test("a poll in flight during a clear keeps cleared items hidden until a fresh poll", () => {
  const state = loaded([1, 2]);
  const sent = state.items;
  state.dismiss([1, 2]);
  const during = state.startPoll();
  state.finish(sent, new Set([1, 2]), () => "unused");
  expect(state.apply(during, [item(1), item(2), item(3)])).toBe(true);
  expect(shown(state)).toEqual([3]);
  expect(state.apply(state.startPoll(), [item(3)])).toBe(true);
  expect(state.apply(state.startPoll(), [item(1), item(3)])).toBe(true);
  expect(shown(state)).toEqual([1, 3]);
});

test("a partial failure restores only failed items and keeps new arrivals", () => {
  const state = loaded([1, 2, 3]);
  const sent = state.items;
  state.dismiss([1, 2, 3]);
  expect(state.apply(state.startPoll(), [1, 2, 3, 4].map(item))).toBe(true);
  expect(shown(state)).toEqual([4]);
  state.finish(sent, new Set([1, 3]), () => "There's no such feed item.");
  expect(shown(state)).toEqual([2, 4]);
  expect([...state.errors]).toEqual([[2, "There's no such feed item."]]);
});

test("a failure survives an older poll, and a newer poll decides", () => {
  const state = loaded([1, 2]);
  const sent = state.items;
  state.dismiss([1, 2]);
  const before = state.startPoll();
  state.finish(sent, new Set(), () => "open-dot daemon isn't running");
  expect(shown(state)).toEqual([1, 2]);
  expect(state.apply(before, [item(1), item(5)])).toBe(true);
  expect(shown(state)).toEqual([1, 2, 5]);
  expect(state.errors.size).toBe(2);
  expect(state.apply(state.startPoll(), [item(1), item(5)])).toBe(true);
  expect(shown(state)).toEqual([1, 5]);
});

test("a lost clear keeps the whole bounded snapshot and the overflow", () => {
  const state = loaded(Array.from({ length: 1000 }, (_, index) => index + 1));
  const sent = state.items;
  state.dismiss(sent.map((row) => row.id));
  const during = state.startPoll();
  expect(state.apply(during, [item(1001)])).toBe(true);
  state.finish(sent, new Set(), () => "Response lost");
  expect(state.items.length).toBe(1000);
  expect(state.overflow).toBe(1);
  expect(state.errors.size).toBe(1000);
  const retry = state.items;
  state.dismiss(retry.map((row) => row.id));
  expect(shown(state)).toEqual([1001]);
});

test("a feed reply never sends again to a dot whose send saved or is unknown, and keeps its content until all saved", () => {
  const replies = new FeedReplies<string>();
  const box = replies.open(item(1), "jotaro");
  replies.change(1, () => ({
    dots: ["jotaro", "jolyne", "giorno"],
    text: " Take this on ",
    images: ["a.png", "b.png"],
  }));
  const sent = replies.begin(1);
  expect(sent).toEqual({
    item: 1,
    text: "Take this on",
    images: ["a.png", "b.png"],
    dots: ["jotaro", "jolyne", "giorno"],
  });
  // While it sends, nothing changes and a second Send sends nothing.
  expect(replies.change(1, () => ({ text: "other" }))).toBe(false);
  expect(replies.begin(1)).toBeUndefined();
  expect(replies.cancel(1)).toBe(false);
  const attempt = { dot: "jolyne", sessionID: "ses_j", messageID: "msg_j", createdAt: 1 };
  replies.record(1, "jotaro", { outcome: "saved" });
  replies.record(1, "jolyne", { outcome: "unknown", attempt });
  replies.record(1, "giorno", { outcome: "refused", error: "No session." });
  expect(replies.end(1, sent?.dots ?? [])).toBe("kept");
  // Only the dot that refused stays picked; the text and images stay for it.
  expect(box.dots).toEqual(["giorno"]);
  expect(box.text).toBe(" Take this on ");
  expect(box.images).toEqual(["a.png", "b.png"]);
  expect(["jotaro", "jolyne", "giorno", "josuke"].map((dot) => replies.canPick(1, dot))).toEqual([
    false,
    false,
    true,
    true,
  ]);
  // Picking a dot already reached is refused.
  replies.change(1, () => ({ dots: ["jotaro", "giorno"] }));
  expect(box.dots).toEqual(["giorno"]);
  // Reopening the item, as after Escape or a move to Handed off, gives the same reply.
  expect(replies.open(item(1), "jotaro")).toBe(box);
  // The unknown send reconciles by its ID; a cancelled one may be picked again.
  expect(replies.unknown()).toEqual([{ id: 1, dot: "jolyne", attempt }]);
  expect(replies.settle(1, "jolyne", "unknown")).toBe(false);
  expect(replies.settle(1, "jolyne", "cancelled")).toBe(true);
  expect(replies.canPick(1, "jolyne")).toBe(true);
  replies.change(1, () => ({ dots: ["giorno", "jolyne"] }));
  const again = replies.begin(1);
  expect(again?.dots).toEqual(["giorno", "jolyne"]);
  replies.record(1, "giorno", { outcome: "saved" });
  replies.record(1, "jolyne", { outcome: "unknown", attempt });
  expect(replies.end(1, again?.dots ?? [])).toBe("kept");
  expect(replies.boxes.has(1)).toBe(true);
  // Once every dot is known to have it, the reply ends.
  expect(replies.settle(1, "jolyne", "delivered")).toBe(true);
  expect(replies.boxes.has(1)).toBe(false);
});

test("a late saved receipt keeps text and images changed after the send it settles", () => {
  const replies = new FeedReplies<string>();
  const box = replies.open(item(2), "jolyne");
  replies.change(2, () => ({ text: "Look", images: ["a.png"] }));
  const sent = replies.begin(2);
  const attempt = { dot: "jolyne", sessionID: "ses_j", messageID: "msg_j", createdAt: 1 };
  replies.record(2, "jolyne", { outcome: "unknown", attempt });
  expect(replies.end(2, sent?.dots ?? [])).toBe("kept");
  // Between the unknown answer and its receipt, the owner edits the text and adds an image.
  replies.change(2, (current) => ({ text: "Look again", images: [...current.images, "b.png"] }));
  expect(replies.settle(2, "jolyne", "sent")).toBe(true);
  expect(replies.boxes.get(2)).toBe(box);
  expect(box).toMatchObject({ text: "Look again", images: ["a.png", "b.png"], dots: [] });
  expect(replies.canPick(2, "jolyne")).toBe(false);
  // Picking a dot alone isn't a change to the content, and a dismissed reply goes.
  replies.change(2, () => ({ dots: ["giorno"] }));
  expect(box.revision).toBe(2);
  expect(replies.cancel(2)).toBe(true);
});

const file = (content: string, revision: string, canRevert = false): Instructions => ({
  content,
  revision,
  canRevert,
});
const editor = () => {
  const state = new InstructionsState();
  expect(state.beginRead(false)).toBe(true);
  state.finishRead({ ok: true, value: file("# jojo\n", "r1") });
  return state;
};

test("instructions save the loaded revision once at a time", () => {
  const state = editor();
  expect(state.canSave).toBe(false);
  expect(state.edit("# jojo\nBe brief.\n")).toBe(true);
  expect(state.beginSave(false)).toEqual({ content: "# jojo\nBe brief.\n", revision: "r1" });
  expect(state.beginSave(false)).toBeUndefined();
  expect(state.edit("typed while saving")).toBe(false);
  expect(state.beginRead(true)).toBe(false);
  state.finish({ ok: true, value: file("# jojo\nBe brief.\n", "r2", true) });
  expect(state.dirty).toBe(false);
  expect(state.canRevert).toBe(true);
  expect(state.notice).toBe("Saved.");
});

test("a conflict keeps the draft and Overwrite uses the conflict's revision", () => {
  const state = editor();
  state.edit("mine");
  state.beginSave(false);
  state.finish({ ok: false, error: "changed", status: 409, current: file("disk", "r2") });
  expect(state.draft).toBe("mine");
  expect(state.conflict?.revision).toBe("r2");
  expect(state.canSave).toBe(false);
  expect(state.canRevert).toBe(false);
  expect(state.beginSave(true)).toEqual({ content: "mine", revision: "r2" });
  state.finish({ ok: true, value: file("mine", "r3", true) });
  expect(state.conflict).toBeUndefined();
});

test("an unknown outcome keeps the draft and a retry that already landed is recognised", () => {
  const state = editor();
  state.edit("mine");
  state.beginSave(false);
  state.finish({ ok: false, error: "lost", lost: true });
  expect(state.draft).toBe("mine");
  expect(state.error).toContain("Nothing was retried");
  state.beginSave(false);
  state.finish({ ok: false, error: "changed", status: 409, current: file("mine", "r2") });
  expect(state.conflict).toBeUndefined();
  expect(state.notice).toBe("The file already has your text.");
  expect(state.dirty).toBe(false);
});

test("oversized or NUL instructions are never sent and Cancel goes back", () => {
  const state = editor();
  state.edit("a".repeat(64 * 1024 + 1));
  expect(state.canSave).toBe(false);
  expect(state.beginSave(false)).toBeUndefined();
  state.edit("a\0b");
  expect(state.beginSave(false)).toBeUndefined();
  expect(state.error).toBe("Instructions can't contain NUL characters.");
  state.discard();
  expect(state.draft).toBe("# jojo\n");
  expect(state.beginRead(false)).toBe(true);
});

test("a dirty editor isn't reloaded unless the owner discards", () => {
  const state = editor();
  state.edit("mine");
  expect(state.beginRead(false)).toBe(false);
  expect(state.beginRead(true)).toBe(true);
});

test("memory edits send only the fields the owner changed", () => {
  expect(
    changedFields(
      { goal: "a", nextAction: "b", status: "active" },
      { goal: "a", nextAction: "c", status: "active" },
    ),
  ).toEqual({ nextAction: "c" });
});

test("a read begun before a change is fenced out", () => {
  const fence = new Fence();
  const before = fence.current("jotaro");
  fence.advance("jotaro");
  expect(fence.holds("jotaro", before)).toBe(false);
  expect(fence.holds("jotaro", fence.current("jotaro"))).toBe(true);
  expect(fence.holds("jolyne", 0)).toBe(true);
});

const bot = ["xoxb", "1111111111", "2222222222222", "a".repeat(24)].join("-");
const appToken = ["xapp", "1", "AJOJO01", "3333333333333", "b".repeat(64)].join("-");
const access = `xoxe.xoxp-1-${"c".repeat(120)}`;
const refresh = `xoxe-1-${"d".repeat(120)}`;

test("Slack token forms are whole, anchored and only for their own step", () => {
  expect(tokenMatches("bot", bot, undefined)).toBe(true);
  expect(tokenMatches("app", appToken, "AJOJO01")).toBe(true);
  expect(tokenMatches("access", access, undefined)).toBe(true);
  expect(tokenMatches("refresh", refresh, undefined)).toBe(true);
  expect(tokenMatches("bot", appToken, undefined)).toBe(false);
  expect(tokenMatches("access", refresh, undefined)).toBe(false);
  expect(tokenMatches("refresh", access, undefined)).toBe(false);
  expect(tokenMatches("app", appToken, "AOTHER01")).toBe(false);
  expect(tokenMatches("app", appToken, undefined)).toBe(false);
  for (const text of [
    ` ${bot}`,
    `${bot} `,
    `${bot}\n`,
    `x${bot}`,
    `${bot}x!`,
    `${bot}\n${bot}`,
    `token: ${bot}`,
    "xoxb-test",
    `XOXB-1111111111-2222222222222-${"a".repeat(24)}`,
    `xoxp-1111111111-2222222222222-${"a".repeat(24)}`,
    "",
  ])
    expect(tokenMatches("bot", text, undefined)).toBe(false);
  expect(tokenMatches("refresh", `xoxe-1-${"d".repeat(1100)}`, undefined)).toBe(false);
  expect(linkAppID(appToken)).toBe("AJOJO01");
});

test("an edit keeps the version it began from, so a save after a newer poll conflicts instead", () => {
  const drafts = new Drafts<string>();
  drafts.start("note:1", 1, "Likes tea");
  drafts.edit("note:1", "Likes green tea");
  // A poll now lists version 2; going back to Edit keeps the draft and its version.
  expect(drafts.start("note:1", 2, "Likes coffee")).toMatchObject({
    version: 1,
    original: "Likes tea",
    edited: "Likes green tea",
  });
  expect(drafts.begin("note:1")).toEqual({
    version: 1,
    original: "Likes tea",
    edited: "Likes green tea",
  });
  // A second click while it's out sends nothing, and typing is refused until it answers.
  expect(drafts.begin("note:1")).toBeUndefined();
  expect(drafts.edit("note:1", "Likes green tea a lot")).toBe(false);
  expect(drafts.cancel("note:1")).toBe(false);
  // The conflict shows the rejected text, so the draft ends.
  expect(
    drafts.finish("note:1", { ok: false, error: "Changed.", status: 409, current: {} }, true),
  ).toBe("conflict");
  expect(drafts.get("note:1")).toBeUndefined();
});

test("a refused, unreachable or unconfirmed save keeps the draft and its version to try again", () => {
  const drafts = new Drafts<{ goal: string }>();
  for (const failed of [
    { ok: false as const, error: "Can't reach the daemon.", lost: true },
    { ok: false as const, error: "Too long.", status: 400 },
    // A 409 whose current value couldn't be shown keeps the draft too.
    { ok: false as const, error: "Changed.", status: 409 },
  ]) {
    drafts.start("responsibility:2", 3, { goal: "Ship" });
    drafts.edit("responsibility:2", { goal: "Ship v1" });
    drafts.begin("responsibility:2");
    expect(drafts.finish("responsibility:2", failed, false)).toBe("kept");
    expect(drafts.get("responsibility:2")).toMatchObject({
      version: 3,
      original: { goal: "Ship" },
      edited: { goal: "Ship v1" },
    });
    expect(drafts.get("responsibility:2")?.sending).toBeUndefined();
  }
  drafts.begin("responsibility:2");
  expect(drafts.finish("responsibility:2", { ok: true, value: true }, false)).toBe("saved");
  expect(drafts.get("responsibility:2")).toBeUndefined();
});

const append = (old: { results: number[]; next: number | null }, more: typeof old) => ({
  ...more,
  results: [...old.results, ...more.results],
});

const sure = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
};

test("a search begun before or during a change is dropped, and the change's end runs it again", () => {
  const searches = new Searches<{ results: number[]; next: number | null }>();
  const before = searches.start(" tea ");
  expect(before?.query).toBe("tea");
  searches.changed();
  const during = searches.rerun();
  searches.changed();
  expect(searches.finish(sure(before), { ok: true, value: { results: [1], next: null } })).toBe(
    false,
  );
  expect(searches.finish(sure(during), { ok: true, value: { results: [1], next: null } })).toBe(
    false,
  );
  expect(searches.searching).toBe(true);
  const after = searches.rerun();
  expect(searches.finish(sure(after), { ok: true, value: { results: [2], next: 1 } })).toBe(true);
  expect(searches.shown?.value.results).toEqual([2]);
  // A page counts only while the results still end where it began.
  const page = searches.more();
  expect(page?.offset).toBe(1);
  expect(
    searches.finish(sure(page), { ok: true, value: { results: [3], next: null } }, append),
  ).toBe(true);
  expect(searches.shown?.value.results).toEqual([2, 3]);
  // Clearing drops a search still out, and a blank search clears.
  const cleared = searches.start("coffee");
  searches.clear();
  expect(searches.finish(sure(cleared), { ok: true, value: { results: [9], next: null } })).toBe(
    false,
  );
  expect(searches.shown).toBeUndefined();
  expect(searches.start("   ")).toBeUndefined();
  expect(searches.rerun()).toBeUndefined();
  const failing = searches.start("x");
  expect(
    searches.finish(sure(failing), {
      ok: false,
      error: "The search must be at most 200 characters.",
    }),
  ).toBe(true);
  expect(searches.error).toBe("The search must be at most 200 characters.");
  expect(searches.searching).toBe(false);
});
