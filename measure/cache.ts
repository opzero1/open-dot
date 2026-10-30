#!/usr/bin/env bun
/**
 * Offline prompt-cache measurement of where the plugin puts its memory tail (#62). It builds each
 * step's request with the plugin's own `placeTail`, applies OpenCode 2.2.0's automatic cache policy
 * (manual hints count first against Anthropic's four breakpoints, then the last tool, the first and
 * last system parts and the conversation tail), and scores it with Anthropic's prefix cache: a
 * request reads the longest prefix an earlier request wrote at one of its breakpoints, writes up to
 * its own last breakpoint, and sends the rest uncached. The alternative puts the tail after the
 * owner's message on a turn's first step, so the owner's message no longer ends the request.
 *
 *   bun measure/cache.ts
 *
 * It calls no model and no OpenCode; token sizes are the scenario's, not a provider's counts.
 */
import { placeTail } from "../src/plugin";

interface Part {
  readonly type: "text";
  /** What the part holds: equal keys are equal bytes. */
  readonly key: string;
  readonly tokens: number;
  cache?: unknown;
}
interface Message {
  readonly role: "user" | "assistant" | "tool";
  content: readonly Part[];
}

export interface Scenario {
  /** Tools and system prompt, cached by OpenCode's own breakpoints. */
  readonly prefix: number;
  /** The conversation before the first turn, ending with the dot's last reply. */
  readonly history: number;
  readonly owner: number;
  readonly tail: number;
  /** Each step before a turn's last adds a reply with tool calls and its results. */
  readonly stepTokens: number;
  /** The reply that ends a turn. */
  readonly reply: number;
  readonly steps: number;
}

export type Placement = "before-owner" | "after-owner";

const text = (key: string, tokens: number): Part => ({ type: "text", key, tokens });

/**
 * The step's request: the conversation so far with the tail placed as the plugin places it, or,
 * on a turn's first step, after the owner's message, which then carries the breakpoint instead.
 */
function request(conversation: readonly Message[], placement: Placement, tail: Message) {
  const messages = conversation.map((message) => ({ ...message }));
  if (placement === "before-owner" || messages.at(-1)?.role !== "user") placeTail(messages, tail);
  else {
    const owner = messages.at(-1);
    if (owner) owner.content = owner.content.map((part) => ({ ...part, cache: "ephemeral" }));
    messages.push(tail);
  }
  return messages;
}

/** Blocks in order with their breakpoints after OpenCode's automatic policy fills the slots left. */
function blocks(scenario: Scenario, messages: readonly Message[]) {
  const parts = messages.flatMap((message) => message.content);
  const manual = parts.filter((part) => part.cache).length;
  // The last tool and the first and last system parts take the slots manual hints leave first.
  let free = Math.max(0, 4 - manual - 3);
  const lastIndex = parts.length - 1;
  const marked = parts.map((part, index) => {
    if (part.cache) return true;
    if (index === lastIndex && free > 0) {
      free -= 1;
      return true;
    }
    return false;
  });
  return [
    { key: "prefix", tokens: scenario.prefix, breakpoint: true },
    ...parts.map((part, index) => ({
      key: part.key,
      tokens: part.tokens,
      breakpoint: marked[index] ?? false,
    })),
  ];
}

export interface Cost {
  read: number;
  write: number;
  uncached: number;
}

/**
 * Every step of `turns` turns of the scenario, each scored against what earlier steps wrote. The
 * conversation before the first turn starts cached; the first turn isn't counted, so each counted
 * turn starts from what the placement itself left in the cache.
 */
export function simulate(scenario: Scenario, placement: Placement, turns = 3) {
  const conversation: Message[] = [
    { role: "assistant", content: [text("history", scenario.history)] },
  ];
  const written = new Set(["prefix", "prefix|history"]);
  const steps: (Cost & { turn: number; step: number })[] = [];
  for (let turn = 0; turn < turns; turn++) {
    conversation.push({ role: "user", content: [text(`owner-${turn}`, scenario.owner)] });
    for (let step = 1; step <= scenario.steps; step++) {
      const tail: Message = {
        role: "user",
        content: [text(`tail-${turn}-${step}`, scenario.tail)],
      };
      const list = blocks(scenario, request(conversation, placement, tail));
      const keys = list.map((_, index) =>
        list
          .slice(0, index + 1)
          .map((block) => block.key)
          .join("|"),
      );
      const readUpTo = keys.findLastIndex((key) => written.has(key));
      const lastBreakpoint = list.findLastIndex((block) => block.breakpoint);
      const sum = (from: number, to: number) =>
        list.slice(from, to).reduce((total, block) => total + block.tokens, 0);
      const read = sum(0, readUpTo + 1);
      const write = lastBreakpoint > readUpTo ? sum(readUpTo + 1, lastBreakpoint + 1) : 0;
      const uncached = sum(Math.max(readUpTo, lastBreakpoint) + 1, list.length);
      list.forEach((block, index) => {
        if (block.breakpoint) written.add(keys[index] ?? "");
      });
      if (turn > 0) steps.push({ turn, step, read, write, uncached });
      if (step < scenario.steps)
        conversation.push(
          { role: "assistant", content: [text(`call-${turn}-${step}`, scenario.stepTokens / 2)] },
          { role: "tool", content: [text(`result-${turn}-${step}`, scenario.stepTokens / 2)] },
        );
      else
        conversation.push({ role: "assistant", content: [text(`reply-${turn}`, scenario.reply)] });
    }
  }
  return steps;
}

/** Anthropic's prices relative to uncached input: a cache read costs 0.1, a write 1.25. */
export const weighted = (cost: Cost) => cost.uncached + 1.25 * cost.write + 0.1 * cost.read;

const total = (steps: readonly Cost[]) =>
  steps.reduce(
    (sum, step) => ({
      read: sum.read + step.read,
      write: sum.write + step.write,
      uncached: sum.uncached + step.uncached,
    }),
    { read: 0, write: 0, uncached: 0 },
  );

if (import.meta.main) {
  const base = { prefix: 20_000, history: 36_600, tail: 1_500, stepTokens: 3_000, reply: 400 };
  console.log("owner\tsteps\tplacement\tread\twrite\tuncached\tweighted per turn\tsaving");
  for (const owner of [50, 400, 2_000])
    for (const steps of [1, 4]) {
      const scenario = { ...base, owner, steps };
      const [now, after] = (["before-owner", "after-owner"] as const).map((placement) => {
        const sum = total(simulate(scenario, placement));
        return { placement, sum, perTurn: weighted(sum) / 2 };
      });
      for (const row of [now, after])
        if (row && now)
          console.log(
            `${owner}\t${steps}\t${row.placement}\t${row.sum.read / 2}\t${row.sum.write / 2}\t${row.sum.uncached / 2}\t${row.perTurn.toFixed(0)}\t${(((now.perTurn - row.perTurn) / now.perTurn) * 100).toFixed(2)}%`,
          );
    }
}
