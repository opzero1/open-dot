import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../src/api";
import { openDatabase } from "../src/db";
import {
  activeGrants,
  gatedOperation,
  parseExpiry,
  parseGrant,
  revokeGrant,
  saveGrant,
} from "../src/grants";
import { prohibited, review } from "../src/requests";
import { dots, type Grant } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

test("the merge and deploy guards match real merges and deploys, not text that mentions them", () => {
  for (const command of [
    "cat scripts/deploy.sh",
    "ls deploy/",
    "grep -rn deploy src",
    "rg deploy",
    "git merge-base main HEAD",
    "git log --merges --oneline",
    "git log --no-merges",
    "git merge --abort",
    "git mergetool",
    "gh pr view 12",
    "gh workflow run ci.yml",
    "gh workflow list",
    "bun test deploy.test.ts",
    "vim docs/deploy.md",
    "terraform plan",
    "kubectl get pods",
    "helm list",
    "vercel env ls",
    "wrangler dev",
    "npm run build",
    "echo deploy",
    "git commit -m 'deploy fix'",
  ])
    expect([command, gatedOperation(command)]).toEqual([command, undefined]);
  for (const [command, operation] of [
    ["git merge feature", "merge"],
    ["git -C /repo merge feature", "merge"],
    ["git merge --no-ff feat/x", "merge"],
    ["gh pr merge 12 --squash", "merge"],
    ["gh api repos/o/r/pulls/12/merge -X PUT", "merge"],
    ["gh pr ready 34", "ready"],
    ["gh workflow run deploy-preview.yml", "deploy"],
    ["gh workflow run release.yml -f env=production", "deploy"],
    ["terraform apply -auto-approve", "deploy"],
    ["terraform -chdir=infra destroy", "deploy"],
    ["kubectl apply -f k8s/", "deploy"],
    ["kubectl rollout restart deploy/app", "deploy"],
    ["kubectl delete deployment app", "deploy"],
    ["helm upgrade --install app ./chart", "deploy"],
    ["vercel", "deploy"],
    ["vercel --prod", "deploy"],
    ["npx vercel deploy", "deploy"],
    ["fly deploy", "deploy"],
    ["wrangler deploy --env preview", "deploy"],
    ["bunx wrangler pages deploy dist", "deploy"],
    ["netlify deploy --prod", "deploy"],
    ["gcloud run deploy api", "deploy"],
    ["npm run deploy", "deploy"],
    ["bun run deploy:preview", "deploy"],
    ["yarn deploy", "deploy"],
    ["make deploy", "deploy"],
    ["./scripts/deploy.sh preview", "deploy"],
    ["bash scripts/deploy.sh", "deploy"],
    ["sh -c 'npm run deploy'", "deploy"],
    ["CI=1 sudo terraform apply", "deploy"],
  ] as const)
    expect([command, gatedOperation(command)]).toEqual([command, operation]);
});

const grant = (fields: Partial<Grant>): Grant => ({
  id: 1,
  dot: "jojo",
  operation: "merge",
  repo: null,
  branch: null,
  pr: null,
  target: null,
  expiresAt: Number.MAX_SAFE_INTEGER,
  createdBy: "owner (CLI)",
  createdAt: 0,
  revokedAt: null,
  ...fields,
});
const shell = (command: string, grants: readonly Grant[], directory = "/nowhere") =>
  review({ kind: "permission", action: "shell", resources: [command] }, null, {
    grants,
    directory,
  });

test("a merge into a branch is covered only by a grant for the branch checked out, and main only by name", () => {
  const repo = mkdtempSync(join(tmpdir(), "open-dot-grant-"));
  try {
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "ignore" }).exitCode).toBe(0);
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/app.git");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const feature = grant({ branch: "feat/foo", repo: "acme/app" });
    // Before checking out the branch, HEAD is main, which no grant names.
    expect(shell("git merge dot/jojo-1", [feature], repo).refuse).toContain("no active grant");
    git("checkout", "-q", "-b", "feat/foo");
    expect(shell("git merge dot/jojo-1", [feature], repo)).toEqual({ grant: feature });
    expect(shell("git merge dot/jojo-1", [{ ...feature, repo: "acme/other" }], repo).refuse).toBe(
      "merges branches or a pull request, and no active grant from your owner covers it",
    );
    // Chained, relocated or wrapped commands are never covered.
    for (const command of [
      "git checkout main && git merge dot/jojo-1",
      "cd /elsewhere && git merge x",
      "git -C /elsewhere merge x",
    ])
      expect(shell(command, [feature], repo).refuse).toBeString();
    git("checkout", "-q", "main");
    expect(shell("git merge feat/foo", [feature], repo).refuse).toBeString();
    const main = grant({ branch: "main" });
    expect(shell("git merge feat/foo", [main], repo)).toEqual({ grant: main });
  } finally {
    rmSync(repo, { recursive: true });
  }
});

test("ready and pull request merges need the exact number, repository and no extra powers", () => {
  const ready = grant({ operation: "ready", pr: 34, repo: "acme/app" });
  expect(shell("gh pr ready 34 --repo acme/app", [ready])).toEqual({ grant: ready });
  expect(shell("gh pr ready https://github.com/acme/app/pull/34", [ready])).toEqual({
    grant: ready,
  });
  for (const command of [
    "gh pr ready 35 --repo acme/app",
    "gh pr ready 34 --repo acme/other",
    "gh pr ready",
    "gh pr merge 34 --repo acme/app",
  ])
    expect(shell(command, [ready]).refuse).toBeString();
  const merge = grant({ pr: 12 });
  expect(shell("gh pr merge 12 --squash", [merge])).toEqual({ grant: merge });
  for (const command of ["gh pr merge 12 --admin", "gh pr merge 12 --delete-branch", "gh pr merge"])
    expect(shell(command, [merge]).refuse).toBeString();
});

test("a deploy needs a word matching the grant's target, and production a target that names it", () => {
  const preview = grant({ operation: "deploy", target: "preview" });
  expect(shell("wrangler deploy --env preview", [preview])).toEqual({ grant: preview });
  expect(shell("gh workflow run deploy.yml -f environment=preview", [preview])).toEqual({
    grant: preview,
  });
  for (const command of [
    "wrangler deploy",
    "vercel --prod",
    "gh workflow run deploy.yml -f environment=preview -f stage=production",
    "terraform apply",
  ])
    expect(shell(command, [preview]).refuse).toBe(
      "deploys, and no active grant from your owner covers it",
    );
  const wide = grant({ operation: "deploy", target: "deploy*" });
  expect(shell("npm run deploy:preview", [wide]).grant).toEqual(wide);
  expect(shell("npm run deploy:prod", [wide]).refuse).toBeString();
  const prod = grant({ operation: "deploy", target: "deploy:prod" });
  expect(shell("npm run deploy:prod", [prod]).grant).toEqual(prod);
  // Grants never reach the rest of the list.
  for (const command of [
    "git push --force origin feat/foo",
    "npm publish",
    "open-dot grant add jojo deploy --target x --for 1h",
  ])
    expect(shell(command, [preview, wide, grant({ branch: "feat/foo" })]).refuse).toBeString();
  expect(prohibited({ kind: "permission", action: "shell", resources: ["fly deploy"] }, null)).toBe(
    "deploys, and no active grant from your owner covers it",
  );
});

test("grants are parsed strictly, expire, and are revoked once", () => {
  const now = new Date(2026, 9, 28, 12, 0).getTime();
  expect(parseGrant("jojo", "merge", ["--branch", "feat/foo", "--until", "18:00"], now)).toEqual({
    dot: "jojo",
    operation: "merge",
    repo: null,
    branch: "feat/foo",
    pr: null,
    target: null,
    expiresAt: new Date(2026, 9, 28, 18, 0).getTime(),
  });
  expect(parseExpiry("--until", "09:00", now)).toBe(new Date(2026, 9, 29, 9, 0).getTime());
  expect(parseExpiry("--for", "2h", now)).toBe(now + 2 * 3_600_000);
  for (const [operation, flags] of [
    ["push", ["--branch", "x", "--for", "1h"]],
    ["merge", ["--for", "1h"]],
    ["merge", ["--branch", "x", "--pr", "1", "--for", "1h"]],
    ["ready", ["--branch", "x", "--for", "1h"]],
    ["deploy", ["--target", "*", "--for", "1h"]],
    ["deploy", ["--target", "pre view", "--for", "1h"]],
    ["merge", ["--branch", "x"]],
    ["merge", ["--branch", "x", "--for", "31d"]],
    ["merge", ["--branch", "x", "--until", "2020-01-01T00:00"]],
    ["merge", ["--branch", "x", "--for", "1h", "--yes", "1"]],
  ] as const)
    expect(parseGrant("jojo", operation, flags, now)).toBeString();

  const db = openDatabase(":memory:");
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/d",
      sessionID: "ses_j",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  const input = parseGrant("jojo", "ready", ["--pr", "3", "--for", "1h"], now);
  if (typeof input === "string") throw new Error(input);
  const saved = saveGrant(db, input, "owner (CLI)", now);
  expect(activeGrants(db, "jojo", now).map((row) => row.id)).toEqual([saved.id]);
  expect(activeGrants(db, "jojo", now + 3_600_000)).toEqual([]);
  expect(revokeGrant(db, saved.id, "dio", now)).toEqual({ missing: true });
  expect(revokeGrant(db, saved.id, "jojo", now)).toMatchObject({ saved: { revokedAt: now } });
  expect(revokeGrant(db, saved.id, "jojo", now)).toHaveProperty("conflict");
  expect(activeGrants(db, "jojo", now)).toEqual([]);
});

test("the CLI makes a grant only after a yes typed at a terminal", () => {
  const home = mkdtempSync(join(tmpdir(), "open-dot-cli-"));
  try {
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
        env: { ...process.env, OPEN_DOT_HOME: home },
        stdin: "pipe",
      });
    const db = openDatabase(join(home, "open-dot.db"));
    db.insert(dots)
      .values({
        name: "jojo",
        directory: "/d",
        sessionID: "ses_j",
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
    const made = cli("grant", "add", "jojo", "deploy", "--target", "preview", "--for", "1h");
    expect(made.exitCode).toBe(1);
    expect(made.stderr.toString()).toContain("Run this in a terminal");
    expect(activeGrants(db, "jojo")).toEqual([]);
    expect(cli("grant", "list").stdout.toString()).toContain("No active grants.");
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("the notch lists a dot's active grants and revokes them, but can't make one", async () => {
  const db = openDatabase(":memory:");
  for (const name of ["jojo", "dio"])
    db.insert(dots)
      .values({
        name,
        directory: "/d",
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
  const input = parseGrant("jojo", "merge", ["--branch", "feat/foo", "--for", "1h"], Date.now());
  if (typeof input === "string") throw new Error(input);
  const saved = saveGrant(db, input, "owner (CLI)");
  const call = (path: string, method = "GET") =>
    api(
      db,
      "secret",
      fakeOpenCode().layer,
      async () => undefined,
    )(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { authorization: "Bearer secret" },
      }),
    );
  const memory = (await (await call("/dots/jojo/memory")).json()) as { grants: unknown[] };
  expect(memory.grants).toEqual([
    expect.objectContaining({ id: saved.id, summary: "merge into feat/foo in any repository" }),
  ]);
  expect((await call("/dots/jojo/memory/grants", "POST")).status).toBe(404);
  expect((await call(`/dots/dio/memory/grants/${saved.id}`, "DELETE")).status).toBe(404);
  expect((await call(`/dots/jojo/memory/grants/${saved.id}`, "DELETE")).status).toBe(200);
  expect((await call(`/dots/jojo/memory/grants/${saved.id}`, "DELETE")).status).toBe(409);
  expect(activeGrants(db, "jojo")).toEqual([]);
});
