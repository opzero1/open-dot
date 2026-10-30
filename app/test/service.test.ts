// OpenCode server controls against a fake binary and a fake login shell in a temporary directory:
// no real OpenCode, shell profile or service is ever run.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceView } from "../bridge";
import { parseStatus, serviceBinary, serviceControl } from "../service";

const scratch = mkdtempSync(join(tmpdir(), "open-dot-service-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

/** A fake `opencode2` that logs each argument list and keeps its server's state in a file. */
const fakeBinary = (name: string, extra = "") => {
  const directory = mkdtempSync(join(scratch, "bin-"));
  const log = join(directory, "log");
  const state = join(directory, "state");
  writeFileSync(state, "stopped");
  script(
    join(directory, name),
    `printf '%s|' "$@" >> '${log}'; echo >> '${log}'
${extra}
case "$2" in
  status) if [ "$(cat '${state}')" = running ]; then echo "running http://127.0.0.1:4096"; else echo stopped; fi ;;
  start|restart) echo running > '${state}'; echo "http://127.0.0.1:4096" ;;
  stop) echo stopped > '${state}' ;;
esac`,
  );
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|").filter(Boolean));
  return { directory, binary: join(directory, name), calls, state };
};

const control = (options: { binary: string | undefined; shell?: string; path?: string }) => {
  const views: ServiceView[] = [];
  const service = serviceControl({
    binary: options.binary,
    shell: options.shell,
    env: { PATH: options.path ?? "/usr/bin:/bin", HOME: scratch },
    onChange: (view) => views.push(view),
    timeouts: { status: 2_000, action: 2_000 },
  });
  return { service, views };
};

test("status reads running or stopped, and anything else is not known", () => {
  expect(parseStatus("running http://127.0.0.1:4096\n")).toEqual({
    state: "running",
    url: "http://127.0.0.1:4096",
  });
  expect(parseStatus("stopped\n")).toEqual({ state: "stopped", url: null });
  expect(parseStatus("Error: something\n")).toEqual({ state: "unknown", url: null });
  expect(serviceBinary({})).toBe("opencode2");
  expect(serviceBinary({ OPEN_DOT_OPENCODE: " /opt/oc " })).toBe("/opt/oc");
  expect(serviceBinary({ OPEN_DOT_OPENCODE: "bad\nname" })).toBe("opencode2");
});

test("Start runs `service start` exactly, then reads the status again", async () => {
  const fake = fakeBinary("opencode2");
  const { service, views } = control({ binary: fake.binary });
  expect((await service.status()).state).toBe("stopped");
  const result = await service.run("start");
  expect(result.ok && result.value).toMatchObject({
    state: "running",
    url: "http://127.0.0.1:4096",
    busy: null,
    last: { action: "start", ok: true, output: "http://127.0.0.1:4096" },
  });
  expect(fake.calls()).toEqual([
    ["service", "status"],
    ["service", "start"],
    ["service", "status"],
  ]);
  // The view said it was starting while it ran.
  expect(views.some((view) => view.busy === "start")).toBe(true);
});

test("one command at a time: a second while one runs is refused and never reaches the binary", async () => {
  const fake = fakeBinary("opencode2", `[ "$2" = stop ] && sleep 0.5`);
  const { service } = control({ binary: fake.binary });
  const first = service.run("stop");
  expect(await service.run("restart")).toEqual({
    ok: false,
    error: "Another OpenCode command is still running.",
  });
  await first;
  expect(fake.calls()).toEqual([
    ["service", "stop"],
    ["service", "status"],
  ]);
});

test("a command that hangs is stopped at its timeout and says it may have taken effect", async () => {
  const fake = fakeBinary("opencode2", `[ "$2" = restart ] && sleep 30`);
  const { service } = control({ binary: fake.binary });
  const result = await service.run("restart");
  expect(result.ok && result.value.last).toMatchObject({ action: "restart", ok: false });
  expect(result.ok && result.value.last?.output).toContain("may still have taken effect");
  // The status was read again afterwards, and the control is free.
  expect(result.ok && result.value).toMatchObject({ state: "stopped", busy: null });
}, 10_000);

test("a failing command shows its own error output", async () => {
  const fake = fakeBinary("opencode2", `[ "$2" = start ] && { echo "port in use" >&2; exit 3; }`);
  const { service } = control({ binary: fake.binary });
  const result = await service.run("start");
  expect(result.ok && result.value.last).toEqual({
    action: "start",
    ok: false,
    output: "port in use\nIt exited 3.",
    at: expect.any(Number),
  });
});

test("a bare name is found on the login shell's PATH, not the app's", async () => {
  const fake = fakeBinary("opencode-fake");
  const shell = script(
    join(scratch, "fake-shell"),
    `[ "$1 $2 $3" = "-i -l -c" ] || exit 9
PATH='${fake.directory}:/usr/bin:/bin'
eval "$4"`,
  );
  const { service } = control({ binary: "opencode-fake", shell, path: "/usr/bin:/bin" });
  expect(await service.status()).toMatchObject({ state: "stopped", problem: null });
  expect(fake.calls()).toEqual([["service", "status"]]);
});

test("nothing runs without a binary, or when the name isn't on the PATH", async () => {
  const none = control({ binary: undefined });
  expect(await none.service.status()).toMatchObject({
    state: "unknown",
    problem: "No OpenCode binary is set for this run.",
  });
  const missing = control({ binary: "opencode-missing-xyz", path: scratch });
  expect((await missing.service.status()).problem).toContain("wasn't found on your login PATH");
  const relative = control({ binary: "bin/opencode" });
  expect((await relative.service.status()).problem).toContain("isn't an executable file");
});
