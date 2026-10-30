// The clipboard helper's client over fake pipes: no helper runs and the real clipboard is never read.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { helperClipboard } from "../clipboard";

const fakeHelper = () => {
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: 0,
    kill() {
      child.killed++;
    },
  });
  child.stdin.on("data", (chunk: Buffer) => commands.push(...chunk.toString().split("\n")));
  const answer = (text: string) => child.stdout.write(Buffer.from(text, "utf8"));
  const sent = async (count: number) => {
    for (let tick = 0; tick < 50 && commands.filter(Boolean).length < count; tick++)
      await new Promise((done) => setTimeout(done, 5));
    return commands.filter(Boolean);
  };
  return { child, answer, sent };
};

test("answered requests, copies taken or not, leave no callback behind", async () => {
  const fake = fakeHelper();
  let spawned = 0;
  const client = helperClipboard(() => {
    spawned++;
    return fake.child;
  });
  const token = ["xoxb", "1111111111", "2222222222222", "a".repeat(24)].join("-");

  const revision = client.clipboard.revision();
  expect(client.pending()).toEqual({ waiters: 1, readers: 1 });
  await fake.sent(1);
  fake.answer("7\n");
  expect(await revision).toBe(7);
  expect(client.pending()).toEqual({ waiters: 0, readers: 0 });

  // A token, split across chunks, and a copy that's no longer there.
  const text = client.clipboard.text(7);
  const gone = client.clipboard.text(6);
  expect(client.pending()).toEqual({ waiters: 2, readers: 2 });
  expect(await fake.sent(3)).toEqual(["r", "t 7", "t 6"]);
  fake.answer(`${Buffer.byteLength(token)}\n${token.slice(0, 10)}`);
  await new Promise((done) => setTimeout(done, 5));
  expect(client.pending()).toEqual({ waiters: 2, readers: 2 });
  fake.answer(`${token.slice(10)}-\n`);
  expect(await text).toBe(token);
  expect(await gone).toBeNull();
  expect(client.pending()).toEqual({ waiters: 0, readers: 0 });

  const cleared = client.clipboard.clear(7);
  await fake.sent(4);
  fake.answer("ok\n");
  await cleared;
  expect(client.pending()).toEqual({ waiters: 0, readers: 0 });
  expect(spawned).toBe(1);
  expect(fake.child.killed).toBe(0);
});

test("an unanswered request ends unknown at its time limit or on stop, and leaves nothing", async () => {
  const fake = fakeHelper();
  const client = helperClipboard(() => fake.child, 30);
  const late = client.clipboard.text(1);
  expect(client.pending()).toEqual({ waiters: 1, readers: 1 });
  expect(await late).toBeUndefined();
  expect(client.pending()).toEqual({ waiters: 0, readers: 0 });
  expect(fake.child.killed).toBe(1);

  const second = fakeHelper();
  const restarted = helperClipboard(() => second.child);
  const waiting = restarted.clipboard.revision();
  restarted.stop();
  expect(await waiting).toBeUndefined();
  expect(restarted.pending()).toEqual({ waiters: 0, readers: 0 });

  // A helper that can't start answers nothing, at once.
  const broken = helperClipboard(() => {
    throw new Error("missing");
  });
  expect(await broken.clipboard.revision()).toBeUndefined();
  expect(broken.pending()).toEqual({ waiters: 0, readers: 0 });
});
