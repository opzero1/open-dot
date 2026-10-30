import { expect, test } from "bun:test";
import type { FeedItem, Instructions } from "../bridge";
import { linkAppID, tokenMatches } from "../slack";
import { changedFields, FeedState, Fence, InstructionsState, unsentRecipients } from "../surfaces";

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

test("a feed reply never sends again to a dot whose send saved or is unknown", () => {
  const outcomes = new Map([
    ["jotaro", "saved"],
    ["jolyne", "unknown"],
    ["giorno", "refused"],
  ] as const);
  expect(unsentRecipients(["jotaro", "jolyne", "giorno", "josuke"], outcomes)).toEqual([
    "giorno",
    "josuke",
  ]);
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
