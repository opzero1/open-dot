import { basename } from "node:path";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./db";
import { looksSecret } from "./memory";
import { type Grant, grants } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type Operation = Grant["operation"];

/** The longest a grant may last. */
export const grantLimitMs = 30 * 24 * 60 * 60_000;

const words = (command: string) =>
  command
    .replace(/["']/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");

const wrappers = new Set(["sudo", "env", "command", "exec", "nohup", "time", "npx", "bunx"]);

/** The command without leading variable assignments and wrappers such as sudo, env or npx. */
const unwrapped = (tokens: readonly string[]) => {
  let at = 0;
  const flags = () => {
    while (tokens[at]?.startsWith("-")) at++;
  };
  for (;;) {
    const word = tokens[at] ?? "";
    if (/^\w+=/.test(word) || word === "--") at++;
    else if (wrappers.has(word)) {
      at++;
      flags();
    } else if (/^(npm|pnpm|yarn|bun)$/.test(word) && /^(dlx|exec|x)$/.test(tokens[at + 1] ?? "")) {
      at += 2;
      flags();
    } else return tokens.slice(at);
  }
};

const valued = new Set(["-R", "--repo", "-C", "-c", "-f", "-F", "--ref", "-e", "--env"]);

/** The arguments that aren't flags, nor the value of a flag that takes one. */
const positional = (args: readonly string[]) =>
  args.filter((arg, at) => !arg.startsWith("-") && !valued.has(args[at - 1] ?? ""));

const deploySubcommands: Record<string, RegExp> = {
  terraform: /^(apply|destroy)$/,
  tofu: /^(apply|destroy)$/,
  terragrunt: /^(apply|destroy|run-all)$/,
  pulumi: /^(up|update|destroy)$/,
  cdk: /^(deploy|destroy)$/,
  cdktf: /^(deploy|destroy)$/,
  kubectl: /^(apply|create|delete|replace|patch|rollout|scale|set|edit)$/,
  oc: /^(apply|create|delete|replace|patch|rollout|scale|set|edit)$/,
  helm: /^(install|upgrade|uninstall|rollback|delete)$/,
  railway: /^(up|redeploy)$/,
  vercel: /^(deploy|redeploy|promote|rollback)$/,
  wrangler: /^(deploy|publish)$/,
};

// Tools with a deploy subcommand anywhere among their arguments, such as `gcloud run deploy`.
const deployTools = new Set([
  "netlify",
  "fly",
  "flyctl",
  "firebase",
  "sam",
  "serverless",
  "sls",
  "eb",
  "gcloud",
  "aws",
  "az",
  "doctl",
  "docker",
  "deployctl",
  "amplify",
  "copilot",
  "kamal",
]);

const deployish = /deploy|release|prod|preview|publish/i;

/**
 * The merge, ready mark or deploy one simple command makes, which open-dot lets a dot approve only
 * under its owner's grant. Reading or naming a deploy script, such as `cat scripts/deploy.sh`, and
 * git commands that only mention merges, such as `git merge-base`, aren't one.
 */
export const gatedOperation = (command: string): Operation | undefined => {
  const [head = "", ...args] = unwrapped(words(command));
  const tool = basename(head);
  const [first = "", second = ""] = positional(args);
  if (tool === "git") {
    let at = 0;
    while (args[at]?.startsWith("-")) at += args[at] === "-C" || args[at] === "-c" ? 2 : 1;
    return args[at] === "merge" && !/^--(abort|quit)$/.test(args[at + 1] ?? "")
      ? "merge"
      : undefined;
  }
  if (tool === "gh") {
    if (first === "pr" && (second === "merge" || second === "ready")) return second;
    if (first === "api" && args.some((arg) => /\/merges?\b/.test(arg))) return "merge";
    if (first === "workflow" && second === "run" && args.some((arg) => deployish.test(arg)))
      return "deploy";
    return undefined;
  }
  const subcommand = deploySubcommands[tool];
  if (subcommand) {
    if (tool === "vercel" && (first === "" || args.some((arg) => arg.startsWith("--prod"))))
      return "deploy";
    if (tool === "wrangler")
      return positional(args).some((arg) => subcommand.test(arg)) ? "deploy" : undefined;
    return subcommand.test(first) ? "deploy" : undefined;
  }
  if (deployTools.has(tool)) return positional(args).includes("deploy") ? "deploy" : undefined;
  if (/^(npm|pnpm|yarn|bun|deno)$/.test(tool)) {
    const script = /^(run|run-script|task)$/.test(first) ? second : first;
    return /deploy/i.test(script) ? "deploy" : undefined;
  }
  if (/^(make|just|task|mise|rake)$/.test(tool))
    return positional(args).some((arg) => /deploy/i.test(arg)) ? "deploy" : undefined;
  if (/^(bash|sh|zsh|node|python3?|ruby|tsx|ts-node)$/.test(tool)) {
    const inline = args.indexOf("-c");
    if (inline >= 0) return gatedOperation(args.slice(inline + 1).join(" "));
    return /deploy/i.test(basename(first)) ? "deploy" : undefined;
  }
  return /deploy/i.test(tool) ? "deploy" : undefined;
};

const git = (directory: string, args: readonly string[]) => {
  try {
    const out = Bun.spawnSync(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return out.exitCode === 0 ? out.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
};

const githubRepo = (url: string) =>
  url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];

const pullRequest = (arg: string) => {
  const url = arg.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  if (url) return { repo: url[1], pr: Number(url[2]) };
  const number = arg.match(/^#?([1-9]\d{0,9})$/);
  return number ? { repo: undefined, pr: Number(number[1]) } : undefined;
};

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");

const production = /(^|[^a-z0-9])prod(uction)?([^a-z0-9]|$)/i;

/**
 * The owner's grant that covers one simple command's merge, ready mark or deploy, run in
 * `directory`. A merge or ready mark of a pull request needs its number, and `git merge` merges into
 * the branch the directory has checked out now. A deploy needs a word of the command that matches
 * the grant's target, and a production deploy needs a target that names production. Main and master
 * are covered only by a grant for exactly that branch. A grant with a repository needs the command's
 * `--repo`, or the directory's GitHub origin, to be that one.
 */
export const covering = (
  command: string,
  operation: Operation,
  active: readonly Grant[],
  directory: string,
): Grant | undefined => {
  const candidates = active.filter((grant) => grant.operation === operation);
  if (candidates.length === 0) return undefined;
  const tokens = words(command);
  const [head = "", ...args] = unwrapped(tokens);
  // An environment variable, such as GH_REPO, could point the command elsewhere.
  const prefix = tokens.slice(0, tokens.length - args.length - 1);
  if (prefix.some((word) => word === "env" || /^\w+=/.test(word))) return undefined;
  const tool = basename(head);
  const flag = args.findIndex((arg) => arg === "-R" || arg === "--repo");
  const named =
    flag >= 0
      ? args[flag + 1]
      : args.find((arg) => arg.startsWith("--repo="))?.slice("--repo=".length);
  let origin: string | undefined | null = null;
  const repoOf = (fromURL?: string) => {
    if (named !== undefined || fromURL !== undefined) return named ?? fromURL;
    if (origin === null) {
      const url = git(directory, ["remote", "get-url", "origin"]);
      origin = url === undefined ? undefined : githubRepo(url);
    }
    return origin;
  };
  const inRepo = (grant: Grant, fromURL?: string) =>
    grant.repo === null || repoOf(fromURL)?.toLowerCase() === grant.repo.toLowerCase();
  if (operation === "deploy") {
    const prod = production.test(command);
    const targets = args.flatMap((arg) => arg.split(/[=,]/));
    return candidates.find(
      (grant) =>
        grant.target !== null &&
        (!prod || /prod/i.test(grant.target)) &&
        targets.some((word) => glob(grant.target ?? "").test(word)) &&
        inRepo(grant),
    );
  }
  if (tool === "gh") {
    const [, verb, target, ...more] = positional(args);
    if (verb !== operation || target === undefined || more.length) return undefined;
    if (args.some((arg) => /^(--admin|-d|--delete-branch)$/.test(arg))) return undefined;
    const pr = pullRequest(target);
    return pr && candidates.find((grant) => grant.pr === pr.pr && inRepo(grant, pr.repo));
  }
  if (tool !== "git" || operation !== "merge" || args[0] !== "merge") return undefined;
  const branch = git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return branch === undefined
    ? undefined
    : candidates.find((grant) => grant.branch === branch && inRepo(grant));
};

/** The dot's grants that haven't expired or been revoked, oldest first. */
export const activeGrants = (db: Db | Tx, dot: string, now = Date.now()) =>
  db
    .select()
    .from(grants)
    .where(and(eq(grants.dot, dot), isNull(grants.revokedAt), gt(grants.expiresAt, now)))
    .orderBy(asc(grants.id))
    .all();

/** What a grant lets the dot approve, in a few words, without its expiry. */
export const grantScope = (grant: Grant) =>
  `${
    grant.operation === "deploy"
      ? `deploy to a target matching "${grant.target}"`
      : grant.operation === "ready"
        ? `mark PR #${grant.pr} ready`
        : grant.pr !== null
          ? `merge PR #${grant.pr}`
          : `merge into ${grant.branch}`
  } in ${grant.repo ?? "any repository"}`;

export const describeGrant = (grant: Grant) =>
  `#${grant.id}\t${grant.dot}\t${grantScope(grant)}\tuntil ${new Date(grant.expiresAt).toLocaleString()}${grant.revokedAt === null ? "" : "\trevoked"}`;

export const grantView = (grant: Grant) => ({
  id: grant.id,
  operation: grant.operation,
  repo: grant.repo,
  branch: grant.branch,
  pr: grant.pr,
  target: grant.target,
  summary: grantScope(grant),
  expiresAt: grant.expiresAt,
  createdBy: grant.createdBy,
  createdAt: grant.createdAt,
});

/** When `--until` (HH:MM, next occurrence, or a date and time) or `--for` (30m, 2h, 1d) ends. */
export const parseExpiry = (
  flag: "--until" | "--for",
  value: string,
  now: number,
): number | string => {
  let at = Number.NaN;
  const duration = value.match(/^([1-9]\d{0,4})([mhd])$/);
  const clock = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (flag === "--for" && duration)
    at =
      now +
      Number(duration[1]) *
        (duration[2] === "d" ? 86_400_000 : duration[2] === "h" ? 3_600_000 : 60_000);
  else if (flag === "--until" && clock) {
    const day = new Date(now);
    day.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    at = day.getTime() <= now ? day.getTime() + 86_400_000 : day.getTime();
  } else if (flag === "--until") at = Date.parse(value);
  if (!Number.isFinite(at))
    return `${flag} takes ${flag === "--for" ? "30m, 2h or 1d" : "HH:MM or a date and time"}.`;
  if (at <= now) return "That time has passed.";
  if (at - now > grantLimitMs) return "A grant lasts at most 30 days.";
  return at;
};

export type GrantInput = Pick<
  Grant,
  "dot" | "operation" | "repo" | "branch" | "pr" | "target" | "expiresAt"
>;

/**
 * Reads `merge (--branch <name> | --pr <n>)`, `ready --pr <n>` or `deploy --target <pattern>`, with
 * an optional `--repo owner/name` and `--until` or `--for`.
 */
export const parseGrant = (
  dot: string,
  operation: string | undefined,
  flags: readonly string[],
  now: number,
): GrantInput | string => {
  if (operation !== "merge" && operation !== "ready" && operation !== "deploy")
    return "The operation is merge, ready or deploy.";
  const values = new Map<string, string>();
  for (let at = 0; at < flags.length; at += 2) {
    const [flag = "", value] = [flags[at], flags[at + 1]];
    if (!/^--(repo|branch|pr|target|until|for)$/.test(flag) || value === undefined)
      return `Unknown or incomplete option ${flag}.`;
    if (values.has(flag)) return `${flag} is given twice.`;
    values.set(flag, value);
  }
  const allowed = { merge: ["--branch", "--pr"], ready: ["--pr"], deploy: ["--target"] }[operation];
  const scopes = ["--branch", "--pr", "--target"].filter((flag) => values.has(flag));
  if (scopes.length !== 1 || !allowed.includes(scopes[0] ?? ""))
    return `${operation} takes exactly one of ${allowed.join(" or ")}.`;
  const repo = values.get("--repo") ?? null;
  if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return "--repo takes owner/name.";
  const branch = values.get("--branch") ?? null;
  if (branch !== null && (!/^[\w./-]+$/.test(branch) || /^-|\.\.|\/$/.test(branch)))
    return "--branch takes one exact branch name.";
  const pr = values.get("--pr");
  if (pr !== undefined && !/^[1-9]\d{0,9}$/.test(pr)) return "--pr takes a pull request number.";
  const target = values.get("--target") ?? null;
  if (
    target !== null &&
    (!/^[\w.:/@*-]{1,100}$/.test(target) || target.replaceAll("*", "").length < 3)
  )
    return "--target takes a pattern of letters, digits and . : / @ - with at least 3 that aren't *.";
  // A grant's scope is listed in the dot's memory every turn, so none may hold a credential.
  if ([repo, branch, target].some((value) => value !== null && looksSecret(value)))
    return "A scope that looks like it holds a credential isn't saved.";
  const until = values.get("--until");
  const span = values.get("--for");
  if ((until === undefined) === (span === undefined))
    return "Give exactly one of --until or --for.";
  const expiresAt =
    until === undefined
      ? parseExpiry("--for", span ?? "", now)
      : parseExpiry("--until", until, now);
  if (typeof expiresAt === "string") return expiresAt;
  return {
    dot,
    operation,
    repo,
    branch,
    pr: pr === undefined ? null : Number(pr),
    target,
    expiresAt,
  };
};

/** Saves a grant the owner confirmed. */
export const saveGrant = (db: Db, input: GrantInput, createdBy: string, now = Date.now()) =>
  db
    .insert(grants)
    .values({ ...input, createdBy, createdAt: now })
    .returning()
    .get();

/**
 * Revokes an active grant, scoped to `dot` when given. A grant that already expired or was revoked
 * is a conflict; nothing changes.
 */
export const revokeGrant = (
  db: Db,
  id: number,
  dot?: string,
  now = Date.now(),
): { saved: Grant } | { conflict: Grant } | { missing: true } =>
  db.transaction((tx) => {
    const grant = tx.select().from(grants).where(eq(grants.id, id)).get();
    if (!grant || (dot !== undefined && grant.dot !== dot)) return { missing: true as const };
    if (grant.revokedAt !== null || grant.expiresAt <= now) return { conflict: grant };
    const saved = tx
      .update(grants)
      .set({ revokedAt: now })
      .where(and(eq(grants.id, id), isNull(grants.revokedAt)))
      .returning()
      .get();
    return saved ? { saved } : { conflict: grant };
  });
