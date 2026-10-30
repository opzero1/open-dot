// The clipboard helper's client (clipboard.m): one command per line on its stdin, answered in order
// on its stdout. Only an outstanding command keeps a callback; each is dropped once answered, timed
// out or stopped, so nothing the helper read is kept by this client after it's handed over.
import type { Readable, Writable } from "node:stream";

export interface Clipboard {
  revision(): Promise<number | undefined>;
  /** The text while the clipboard still holds `revision`, null once it doesn't. */
  text(revision: number): Promise<string | null | undefined>;
  clear(revision: number): Promise<void>;
}

export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): unknown;
  on(event: "error" | "exit", listener: () => void): unknown;
}

const readLine = (buffer: Buffer): [number, string] | undefined => {
  const end = buffer.indexOf(10);
  return end < 0 ? undefined : [end + 1, buffer.subarray(0, end).toString("utf8")];
};

/**
 * A clipboard over the helper `start` spawns when first needed; `pending` counts the callbacks kept
 * for outstanding commands, each command holding one waiter and one reader until it ends.
 */
export const helperClipboard = (start: () => HelperProcess, timeout = 2_000) => {
  let helper: HelperProcess | undefined;
  let buffer = Buffer.alloc(0);
  // Each outstanding command's reader, in order: it takes what it needs from the buffer, or waits.
  const queue: ((buffer: Buffer) => number)[] = [];
  // Each outstanding command's way to end it unanswered, removed as soon as it ends.
  const waiters = new Set<() => void>();

  const stop = () => {
    helper?.kill();
    helper = undefined;
    buffer = Buffer.alloc(0);
    queue.length = 0;
    const ending = [...waiters];
    waiters.clear();
    for (const end of ending) end();
  };

  const running = () => {
    if (helper) return helper;
    try {
      const child = start();
      child.on("error", () => {
        if (helper === child) stop();
      });
      child.on("exit", () => {
        if (helper === child) stop();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (helper !== child) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (queue.length) {
          const used = queue[0]?.(buffer) ?? 0;
          if (used <= 0) break;
          buffer = buffer.subarray(used);
          queue.shift();
        }
        if (buffer.length > 16 * 1024) stop();
      });
      helper = child;
    } catch {
      helper = undefined;
    }
    return helper;
  };

  /** One command, answered by `read`, or undefined if the helper failed or took too long. */
  const ask = <T>(command: string, read: (buffer: Buffer) => [number, T] | undefined) =>
    new Promise<T | undefined>((done) => {
      const child = running();
      if (!child) return done(undefined);
      let finished = false;
      const finish = (value: T | undefined) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        waiters.delete(unanswered);
        done(value);
      };
      const unanswered = () => finish(undefined);
      const timer = setTimeout(() => {
        if (!finished) stop();
      }, timeout);
      waiters.add(unanswered);
      queue.push((received) => {
        const got = read(received);
        if (!got) return 0;
        finish(got[1]);
        return got[0];
      });
      child.stdin.write(`${command}\n`);
    });

  const clipboard: Clipboard = {
    revision: async () => {
      const value = await ask("r", readLine);
      return value !== undefined && /^-?\d{1,18}$/.test(value) ? Number(value) : undefined;
    },
    text: (revision) =>
      ask<string | null | undefined>(`t ${revision}`, (received) => {
        const head = readLine(received);
        if (!head) return undefined;
        const [used, value] = head;
        if (value === "-") return [used, null];
        if (value === "0" || value === "L") return [used, undefined];
        const size = Number(value);
        if (!Number.isSafeInteger(size) || size <= 0 || size > 4096) return [used, undefined];
        if (received.length < used + size) return undefined;
        return [used + size, received.subarray(used, used + size).toString("utf8")];
      }),
    clear: async (revision) => {
      await ask(`c ${revision}`, readLine);
    },
  };

  return { clipboard, stop, pending: () => ({ waiters: waiters.size, readers: queue.length }) };
};
