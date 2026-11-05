import { mkdir } from "node:fs/promises";

const controls = [
  {
    model: "Avatar",
    name: "duplicate-pending-load",
    from: "NeedsLoad(r) == done # r /\\ loading # r",
    to: "NeedsLoad(r) == done # r",
    invariant: "NoRedundantLoad",
  },
  {
    model: "Supervision",
    name: "lost-timestamp-tie",
    from: "Time(e) > seen \\/ (Time(e) = seen /\\ seenIDs # {} /\\ e \\notin seenIDs)",
    to: "Time(e) > seen",
    invariant: "NoEligibleEndMissed",
  },
  {
    model: "Supervision",
    name: "forgot-waiting-id",
    from: "told' = told \\cup waiting",
    to: "told' = waiting",
    invariant: "NoDuplicateWaiting",
  },
  {
    model: "Observer",
    name: "read-after-change",
    from: '/\\ job = "running" /\\ pc = "turn" /\\ valid',
    to: '/\\ job = "running" /\\ pc = "turn"',
    invariant: "NoUnwantedRead",
  },
  {
    model: "Observer",
    name: "retry-unknown-job",
    from: 'Claim ==\n    /\\ job = "queued" /\\ pc = "idle" /\\ valid',
    to: 'Claim ==\n    /\\ job \\in {"queued", "unknown"} /\\ pc = "idle" /\\ valid',
    invariant: "NoPromptReplay",
  },
  {
    model: "Observer",
    name: "discard-known-cost",
    from: "recordedUsage' = known",
    to: "recordedUsage' = (known /\\ valid)",
    invariant: "KnownCostRecorded",
  },
  {
    model: "Outbox",
    name: "revoked-prompt",
    from: '/\\ gate = c /\\ pc[c] = "absent" /\\ allowed',
    to: '/\\ gate = c /\\ pc[c] = "absent"',
    invariant: "NoUnauthorizedCall",
  },
  {
    model: "Outbox",
    name: "forget-admission",
    from: 'IF admitted THEN "ack" ELSE "absent"',
    to: '"absent"',
    invariant: "NoDuplicateAdmission",
  },
  {
    model: "Feed",
    name: "stale-poll",
    from: "/\\ p \\in reads /\\ p = polls",
    to: "/\\ p \\in reads",
    invariant: "OnlyLatestPollApplies",
  },
  {
    model: "Feed",
    name: "lost-restoration",
    from: "restored[i] > at[p] /\\ i \\notin (hiding \\ settled[p])",
    to: "FALSE",
    invariant: "FailuresStayVisible",
  },
  {
    model: "Avatar",
    name: "stale-image",
    from: "/\\ r \\in flights /\\ listed = r /\\ loading = r",
    to: "/\\ r \\in flights",
    invariant: "OnlyWantedRevisionPublishes",
  },
  {
    model: "Avatar",
    name: "deleted-image",
    from: "/\\ listed' = 0 /\\ loading' = 0 /\\ done' = 0 /\\ image' = 0",
    to: "/\\ listed' = 0 /\\ loading' = 0 /\\ done' = 0 /\\ image' = image",
    invariant: "DeletedStaysEmpty",
  },
];

for (const control of controls) {
  const source = await Bun.file(`model/${control.model}.tla`).text();
  if (source.split(control.from).length !== 2) throw new Error(`Ambiguous ${control.name}`);
  const path = `.research/model-negative/${control.name}`;
  await mkdir(path, { recursive: true });
  await Bun.write(`${path}/${control.model}.tla`, source.replace(control.from, control.to));
  const config = await Bun.file(`model/${control.model}.cfg`).text();
  await Bun.write(
    `${path}/${control.model}.cfg`,
    config.replace(/^INVARIANTS .+$/m, `INVARIANT ${control.invariant}`),
  );
  const result = Bun.spawnSync([
    "bun",
    "node_modules/tla-ts/dist/cli.js",
    "-workers",
    "1",
    `${path}/${control.model}.tla`,
  ]);
  const output = result.stdout.toString() + result.stderr.toString();
  await Bun.write(`${path}/checker.log`, output);
  if (result.exitCode !== 12 || !output.includes(`Invariant ${control.invariant} is violated`)) {
    throw new Error(
      `${control.name}: expected ${control.invariant}, exit 12; got ${result.exitCode}\n${output}`,
    );
  }
  console.log(`${control.model}/${control.name}: ${control.invariant} rejected (exit 12)`);
}
