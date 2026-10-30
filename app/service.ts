// OpenCode's background server, controlled only by the owner's click in the app: main runs
// `<bin> service status|start|restart|stop` with a fixed argument list, no shell and a timeout.
// open-dot never runs start, restart or stop on its own; status only reads.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Result, ServiceAction, ServiceView } from "./bridge";

export const isServiceAction = (value: unknown): value is ServiceAction =>
  value === "status" || value === "start" || value === "restart" || value === "stop";

const plain = (text: string) => Array.from(text).every((c) => c.charCodeAt(0) > 31 && c !== "\x7f");

/** `OPEN_DOT_OPENCODE`, as the daemon's Open reads it, else `opencode2`. */
export const serviceBinary = (env: Record<string, string | undefined>) => {
  const named = env.OPEN_DOT_OPENCODE?.trim();
  return named && plain(named) ? named : "opencode2";
};

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** An absolute path as given, or a bare name found in PATH's absolute directories. */
export const findBinary = (name: string, path: string) => {
  if (name.includes("/")) return isAbsolute(name) && executable(name) ? name : undefined;
  for (const directory of path.split(delimiter))
    if (isAbsolute(directory) && executable(join(directory, name))) return join(directory, name);
  return undefined;
};

interface Ran {
  code: number | null;
  output: string;
  problem?: string;
}

const outputLimit = 4_000;

/** Runs `binary` with `args` and no shell, killing it after `timeout`; keeps the output's end. */
export const runBinary = (
  binary: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeout: number,
) =>
  new Promise<Ran>((done) => {
    let output = "";
    let timedOut = false;
    let finished = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      done({ code: null, output, problem: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-outputLimit);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const finish = (ran: Ran) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(ran);
    };
    child.on("error", (cause) => finish({ code: null, output, problem: cause.message }));
    // A child that leaves its pipes open past its exit, such as a server it starts, doesn't hold
    // the answer: whatever it printed by a moment after exiting is its output.
    child.on("exit", (code, signal) => {
      const ran = (): Ran =>
        timedOut
          ? {
              code,
              output,
              problem: `It didn't finish within ${timeout / 1000} seconds and was stopped; it may still have taken effect.`,
            }
          : code === 0
            ? { code, output }
            : {
                code,
                output,
                problem: signal ? `It was stopped by ${signal}.` : `It exited ${code}.`,
              };
      child.on("close", () => finish(ran()));
      setTimeout(() => finish(ran()), 500);
    });
  });

/** What `service status` printed: `running <url>` or `stopped`, else not known. */
export const parseStatus = (output: string): Pick<ServiceView, "state" | "url"> => {
  const text = output.trim();
  if (text === "stopped") return { state: "stopped", url: null };
  const running = /^running (\S{1,200})$/.exec(text);
  return running ? { state: "running", url: running[1] ?? null } : { state: "unknown", url: null };
};

const marker = "__OPEN_DOT_PATH__";

/**
 * The owner's login PATH, as their terminal sets it for the daemon's Open: the login shell, run
 * interactively with a fixed script, prints it between markers. Undefined when it can't.
 */
export const loginPath = async (shell: string, env: Record<string, string | undefined>) => {
  if (!isAbsolute(shell) || !plain(shell)) return undefined;
  const ran = await runBinary(
    shell,
    ["-i", "-l", "-c", `printf '%s%s%s' ${marker} "$PATH" ${marker}`],
    env,
    5_000,
  );
  if (ran.problem) return undefined;
  const parts = ran.output.split(marker);
  return parts.length >= 3 && parts[1] ? parts[1] : undefined;
};

export interface ControlOptions {
  /** The binary's name or absolute path; undefined when none may run, as in the smoke test. */
  binary: string | undefined;
  /** The owner's login shell, to read their PATH; undefined to use `env`'s PATH alone. */
  shell: string | undefined;
  env: Record<string, string | undefined>;
  onChange(view: ServiceView): void;
  timeouts?: { status: number; action: number };
}

/**
 * Runs the owner's commands one at a time and keeps the view: Start, Restart and Stop each refresh
 * the status afterwards, and a status read begun before one of them started is dropped.
 */
export const serviceControl = (options: ControlOptions) => {
  const timeouts = options.timeouts ?? { status: 10_000, action: 60_000 };
  let view: ServiceView = {
    state: "unknown",
    url: null,
    checkedAt: null,
    problem: null,
    busy: null,
    last: null,
  };
  let path: string | undefined;
  let epoch = 0;
  let reading: Promise<ServiceView> | undefined;

  const change = (next: Partial<ServiceView>) => {
    view = { ...view, ...next };
    options.onChange(view);
  };

  /** The binary and the PATH it runs with, reading the login PATH again when it isn't found. */
  const locate = async (): Promise<
    { binary: string; path: string } | { binary: undefined; problem: string }
  > => {
    const { binary } = options;
    if (binary === undefined)
      return { binary: undefined, problem: "No OpenCode binary is set for this run." };
    const fallback = options.env.PATH ?? "";
    for (const fresh of [false, true]) {
      if (options.shell && (fresh || path === undefined))
        path = (await loginPath(options.shell, options.env)) ?? path;
      const found = findBinary(binary, path ?? fallback);
      if (found) return { binary: found, path: path ?? fallback };
      if (!options.shell) break;
    }
    return {
      binary: undefined,
      problem: binary.includes("/")
        ? `${binary} isn't an executable file.`
        : `${binary} wasn't found on your login PATH. Set OPEN_DOT_OPENCODE to its full path.`,
    };
  };

  const exec = async (action: ServiceAction): Promise<Ran> => {
    const located = await locate();
    if (located.binary === undefined) return { code: null, output: "", problem: located.problem };
    return runBinary(
      located.binary,
      ["service", action],
      { ...options.env, PATH: located.path },
      action === "status" ? timeouts.status : timeouts.action,
    );
  };

  const status = () => {
    if (reading) return reading;
    const began = epoch;
    reading = exec("status")
      .then((ran) => {
        // An action started since: its own read afterwards is the one that counts.
        if (began !== epoch) return view;
        const read = ran.problem
          ? { state: "unknown" as const, url: null }
          : parseStatus(ran.output);
        change({
          ...read,
          checkedAt: Date.now(),
          problem:
            ran.problem ??
            (read.state === "unknown" ? `It printed: ${ran.output.trim().slice(0, 200)}` : null),
        });
        return view;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };

  const run = async (action: ServiceAction): Promise<Result<ServiceView>> => {
    if (action === "status") return { ok: true, value: await status() };
    if (view.busy) return { ok: false, error: "Another OpenCode command is still running." };
    epoch++;
    change({ busy: action });
    try {
      const ran = await exec(action);
      const output = [ran.output.trim(), ran.problem].filter(Boolean).join("\n");
      change({ last: { action, ok: !ran.problem, output, at: Date.now() } });
      // Read afterwards, past any read the action outdated.
      await reading?.catch(() => {});
      epoch++;
      await status().catch(() => {});
    } finally {
      change({ busy: null });
    }
    return { ok: true, value: view };
  };

  return { view: () => view, status, run };
};
