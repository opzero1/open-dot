#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import { api, spawnRun } from "./api";
import { deleteArchived } from "./archive";
import { addObservation, observationTextLimit } from "./ledger";
import { memoryText } from "./memory";
import {
  type Change,
  changeFact,
  type FactView,
  factText,
  isUUID,
  ownerMemory,
  readFact,
} from "./owner";
import { avatarPath, iconSizeWarning, setAvatar } from "./avatar";
import { daemonLoops } from "./daemon";
import { backupDatabase, claimDaemon, openDatabase, restoreDatabase } from "./db";
import {
  daemonHealth,
  databaseSampler,
  describeReport,
  doctor,
  loopback,
  type Observations,
  observe,
} from "./doctor";
import { createDot, ensureSession, findDot, listDots, pickDot } from "./dots";
import { collect, github, linear } from "./feed";
import { describeGrant, grantScope, parseGrant, revokeGrant, saveGrant } from "./grants";
import { apiPath, databasePath } from "./home";
import { instructionsPath } from "./instructions";
import { OpenCode } from "./opencode";
import { grants, slackApps, type Supervision, supervisions } from "./schema";
import { sharedNotices, slackChat, slackClient, slackFeed } from "./slack";
import { slackAgents } from "./slack-agents";
import {
  approveBinding,
  defaultBusyMinutes,
  describeMode,
  endBinding,
  saveBinding,
  sessionIDPattern,
} from "./supervise";
import {
  attachApp,
  checkPrompts,
  configItem,
  describe,
  noticesLine,
  promptsOf,
  provision,
  readHidden,
  realSetup,
  requestApp,
  saveConfigPair,
  setNotices,
  setPrompts,
  updateApp,
} from "./slack-setup";

const usage = `Usage:
  open-dot create <name> [purpose]   Create a dot and its OpenCode session
  open-dot list                      List dots
  open-dot open [name]               Open a dot in OpenCode
  open-dot avatar <name> <file>      Set a dot's avatar from a square PNG or JPEG
  open-dot instructions <name>       Print the path of a dot's AGENTS.md, to edit it in an editor
  open-dot fresh <name> [--force]    Move a dot to a new OpenCode session, keeping its memory, once you confirm.
                                     The daemon must be running; --force skips the check for a turn in progress
  open-dot daemon                    Deliver reminders and run workers until stopped
  open-dot doctor [--json]           Check setup and runtime health, read only; starts nothing
  open-dot backup                    Back up the database without migrating it
  open-dot restore <file>            Restore a backup while the daemon is stopped
  open-dot slack config              Save your Slack app configuration tokens, typed without echo
  open-dot slack connect <name> [--retry]
                                     Ask the daemon to create the dot's own Slack app
  open-dot slack attach <name> <app ID>
                                     Adopt an app whose creation had no clear answer
  open-dot slack status [name]       Show each dot's Slack app and what to do next
  open-dot slack update <name>       Add this version's events to the dot's existing app, once you confirm
  open-dot slack prompts <name> [<file.json> | --reset]
                                     Show or set the 2 to 4 prompts the dot's agent view suggests
  open-dot slack notices enable|disable
                                     Turn on or off the shared app's one note to others who DM it
  open-dot watch add <name> <session ID> [--send] [--busy-minutes N]
                                     Let a dot supervise a session you started, once you confirm
  open-dot watch list [name]         List requested and active supervisions
  open-dot watch approve <id>        Approve a dot's request to supervise a session, once you confirm
  open-dot watch revoke <id>         End a supervision or decline a request
  open-dot grant add <name> merge (--branch <branch> | --pr <n>) [--repo owner/name] (--until <HH:MM|date> | --for <30m|2h|1d>)
  open-dot grant add <name> ready --pr <n> [--repo owner/name] (--until … | --for …)
  open-dot grant add <name> deploy --target <pattern> [--repo owner/name] (--until … | --for …)
                                     Let a dot approve its workers' matching merges, ready marks or deploys, once you confirm
  open-dot grant list [name]         List active grants
  open-dot grant revoke <id>         Revoke a grant
  open-dot archive delete <name> <message ID>
                                     Delete one archived message from a dot's memory, once you confirm
  open-dot observation add <name> <text>
                                     Add your own observed row, such as a fact you forgot and want back, once you confirm
  open-dot owner list|show <id>      List the facts about you every dot shares, or show one
  open-dot owner add                 Add a fact about you, typed at the prompt, once you confirm
  open-dot owner approve <id> <version> [--edit]
  open-dot owner edit|reject|delete|restore <id> <version>
                                     Review a dot's proposal or change a fact, once you confirm; text is typed at the prompt

Forgetting: forget an observed row in the app's Memory view. The observer won't note it again
from the messages it came from, or with the same text under any topic, but may if you say it again
in a new message. To erase it completely, forget it and delete its source messages: choose Forget
and Delete Sources in the app, or run archive delete for each source message.`;

const [command, ...args] = process.argv.slice(2);
// Before anything opens the database, which would migrate it: doctor only reads.
if (command === "doctor") {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > (json ? 1 : 0)) {
    console.error(usage);
    process.exit(1);
  }
  try {
    const report = await doctor();
    const text = json ? JSON.stringify(report, null, 2) : describeReport(report);
    // Written in full before exiting, even into a pipe.
    await Bun.write(Bun.stdout, `${text}\n`);
    process.exit(report.checks.some((check) => check.status === "failed") ? 1 : 0);
  } catch {
    console.error("The health check itself failed. Nothing was changed.");
    process.exit(2);
  }
}
if (command === "backup" || command === "restore") {
  try {
    if (command === "backup" && args.length === 0) console.log(backupDatabase(databasePath()));
    else if (command === "restore" && args.length === 1 && args[0]) {
      const backup = restoreDatabase(databasePath(), args[0]);
      console.log(`Restored ${args[0]}. Previous database backed up at ${backup}`);
    } else throw new Error(usage);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
// Help, or a command open-dot doesn't have, never opens or migrates the database.
if (
  ![
    "create",
    "list",
    "avatar",
    "open",
    "daemon",
    "slack",
    "watch",
    "grant",
    "instructions",
    "fresh",
    "archive",
    "observation",
    "owner",
  ].includes(command ?? "")
) {
  console.log(usage);
  process.exit(0);
}
if (command === "daemon") {
  const release = claimDaemon(databasePath());
  process.on("exit", release);
}
const db = openDatabase(databasePath());

const create = (name: string, purpose: string) =>
  Effect.gen(function* () {
    const dot = yield* createDot(db, name, purpose || "Help your owner with whatever they need.");
    const ready = yield* ensureSession(db, dot);
    console.log(`Created ${ready.name} (${ready.sessionID}) in ${ready.directory}`);
    offerSlack(ready.name);
  }).pipe(Effect.provide(OpenCode.layer));

/** Asks in a terminal whether to give the new dot its own Slack app. No is the default. */
function offerSlack(name: string) {
  const later = `To give ${name} its own Slack app, run: open-dot slack connect ${name}`;
  if (!process.stdin.isTTY) return console.log(later);
  const answer = prompt(`Connect ${name} to Slack with its own app? [y/N]`);
  if (!/^y(es)?$/i.test(answer?.trim() ?? "")) return console.log(later);
  const app = requestApp(db, name);
  if (app) console.log(describe(db, app));
}

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

/** Saves the owner's configuration token pair in one Keychain item. Nothing is echoed or logged. */
const saveConfig = Effect.suspend(() => {
  if (!process.stdin.isTTY) return fail("Run open-dot slack config in a terminal.");
  console.log(
    "Generate a token pair at https://api.slack.com/apps under Your App Configuration Tokens, then paste each token. Neither is shown.",
  );
  const hiddenFailure =
    "This terminal couldn't hide what you type, so nothing was read or saved. Run open-dot slack config in a normal terminal.";
  const token = readHidden("Access token (xoxe.xoxp-…):");
  if (token === undefined) return fail(hiddenFailure);
  const refresh = readHidden("Refresh token (xoxe-…):");
  if (refresh === undefined) return fail(hiddenFailure);
  return Effect.promise(() => saveConfigPair(db, realSetup, token, refresh)).pipe(
    Effect.andThen((problem) =>
      problem
        ? fail(problem)
        : Effect.sync(() =>
            console.log(
              `Saved in the Keychain item ${configItem}. The daemon rotates the pair before each use.`,
            ),
          ),
    ),
  );
});

const slackCommand = (sub: string | undefined, name: string | undefined, rest: string[]) => {
  if (sub === "config") return saveConfig;
  if (sub === "notices" && (name === "enable" || name === "disable"))
    return Effect.sync(() => {
      setNotices(db, name === "enable");
      console.log(noticesLine(db));
    });
  if (sub === "status")
    return Effect.sync(() => {
      if (!name) console.log(noticesLine(db));
      const apps = db
        .select()
        .from(slackApps)
        .all()
        .filter((app) => !name || app.dot === name);
      if (apps.length === 0)
        return console.log(
          name
            ? `${name} has no Slack app of its own. Run: open-dot slack connect ${name}`
            : "No dot has its own Slack app. Run: open-dot slack connect <name>",
        );
      for (const app of apps) console.log(describe(db, app));
    });
  if (!name || !findDot(db, name)) return fail(name ? `No dot named "${name}".` : usage);
  if (sub === "connect")
    return Effect.sync(() => {
      const app = requestApp(db, name, rest.includes("--retry"));
      if (app) console.log(describe(db, app));
    });
  if (sub === "prompts") {
    const app = db.select().from(slackApps).where(eq(slackApps.dot, name)).get();
    if (!app)
      return fail(`${name} has no Slack app of its own. Run: open-dot slack connect ${name}`);
    if (rest[0] === "--reset" && rest.length === 1)
      return Effect.sync(() => {
        setPrompts(db, name, null);
        console.log(`${name}'s agent view suggests prompts made from its purpose again.`);
      });
    if (rest.length === 0)
      return Effect.sync(() =>
        console.log(JSON.stringify(promptsOf(app, findDot(db, name)?.purpose ?? null), null, 2)),
      );
    if (rest.length !== 1 || !rest[0]) return fail(usage);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(rest[0], "utf8"));
    } catch (error) {
      return fail(
        `Couldn't read ${rest[0]} as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const prompts = checkPrompts(parsed);
    if (typeof prompts === "string") return fail(`${prompts} Nothing changed.`);
    return Effect.sync(() => {
      setPrompts(db, name, prompts);
      console.log(
        `Saved ${prompts.length} prompts. ${name}'s agent view shows them the next time you open it.`,
      );
    });
  }
  if (sub === "update" && rest.length === 0) {
    if (!process.stdin.isTTY)
      return fail(
        "Run this in a terminal: an app update needs you to confirm it. Nothing changed.",
      );
    return Effect.promise(() =>
      updateApp(db, realSetup, name, (changes) => {
        console.log(`This adds to ${name}'s app manifest, keeping everything else in it:`);
        for (const change of changes) console.log(`  ${change}`);
        return confirmed("Update the app in Slack?");
      }).then(
        (said) => ({ said, failed: false }),
        (error: unknown) => ({
          said: error instanceof Error ? error.message : String(error),
          failed: true,
        }),
      ),
    ).pipe(
      Effect.andThen(({ said, failed }) =>
        failed
          ? fail(`Couldn't update ${name}'s app: ${said}`)
          : Effect.sync(() => console.log(said)),
      ),
    );
  }
  if (sub === "attach" && rest[0])
    return attachApp(db, name, rest[0])
      ? Effect.sync(() =>
          console.log(
            `The daemon checks ${rest[0]} with Slack before using it. Run: open-dot slack status ${name}`,
          ),
        )
      : fail(
          `Couldn't attach ${rest[0]}: it isn't an app ID like A0123ABCDEF, or ${name}'s app is already set up.`,
        );
  return fail(usage);
};

const describeBinding = (binding: Supervision) =>
  `#${binding.id}\t${binding.dot}\t${binding.state}\t${describeMode(binding.mode)}\t${binding.sessionID}\t${binding.directory}\tbusy alert after ${binding.busyMinutes} min`;

/**
 * Asks the owner at a terminal. A binding needs a person's yes, so a script or a dot's shell
 * without a terminal can't make one.
 */
const confirmed = (question: string) =>
  process.stdin.isTTY && /^y(es)?$/i.test(prompt(`${question} [y/N]`)?.trim() ?? "");

const noTerminal =
  "Run this in a terminal: a supervision needs you to confirm it. Nothing changed.";

const watchCommand = (sub: string | undefined, rest: string[]) => {
  if (sub === "list")
    return Effect.sync(() => {
      const open = db
        .select()
        .from(supervisions)
        .all()
        .filter((row) => row.state !== "ended" && (!rest[0] || row.dot === rest[0]));
      if (open.length === 0) return console.log("No dot supervises a session.");
      for (const binding of open) console.log(describeBinding(binding));
    });
  const id = Number(rest[0]);
  if ((sub === "approve" || sub === "revoke") && rest.length === 1 && Number.isSafeInteger(id)) {
    if (sub === "revoke")
      return Effect.suspend(() => {
        const ended = endBinding(db, id, "owner");
        if ("missing" in ended) return fail(`There's no supervision #${id}.`);
        if ("conflict" in ended) return fail(`Supervision #${id} already ended.`);
        return Effect.sync(() => console.log(`Ended ${describeBinding(ended.saved)}`));
      });
    return Effect.suspend(() => {
      const request = db.select().from(supervisions).where(eq(supervisions.id, id)).get();
      if (request?.state !== "requested")
        return fail(`There's no supervision request #${id} waiting for approval.`);
      if (!process.stdin.isTTY) return fail(noTerminal);
      if (
        !confirmed(
          `Let ${request.dot} ${describeMode(request.mode)} session ${request.sessionID} in ${request.directory}?`,
        )
      )
        return Effect.sync(() => console.log("Nothing changed."));
      const approved = approveBinding(db, id);
      if (!("saved" in approved)) return fail(`Request #${id} changed meanwhile. Nothing changed.`);
      return Effect.sync(() => console.log(`Active: ${describeBinding(approved.saved)}`));
    });
  }
  const [dot, sessionID, ...flags] = rest;
  const busyAt = flags.indexOf("--busy-minutes");
  const busyMinutes = busyAt < 0 ? defaultBusyMinutes : Number(flags[busyAt + 1]);
  const known = flags.every(
    (flag, at) =>
      flag === "--send" || flag === "--busy-minutes" || (busyAt >= 0 && at === busyAt + 1),
  );
  if (sub !== "add" || !dot || !sessionID || !known || (busyAt >= 0 && !flags[busyAt + 1]))
    return fail(usage);
  if (!sessionIDPattern.test(sessionID)) return fail(`${sessionID} isn't a session ID.`);
  if (!findDot(db, dot)) return fail(`No dot named "${dot}".`);
  if (!process.stdin.isTTY) return fail(noTerminal);
  return Effect.gen(function* () {
    const directory = yield* (yield* OpenCode).sessionDirectory(sessionID);
    if (directory === undefined) return yield* fail(`OpenCode has no session ${sessionID}.`);
    const mode = flags.includes("--send") ? ("send" as const) : ("watch" as const);
    if (!confirmed(`Let ${dot} ${describeMode(mode)} session ${sessionID} in ${directory}?`))
      return yield* Effect.sync(() => console.log("Nothing changed."));
    const saved = saveBinding(db, { dot, sessionID, directory, mode, busyMinutes }, "active");
    if (typeof saved === "string") return yield* fail(saved);
    return yield* Effect.sync(() => console.log(`Active: ${describeBinding(saved)}`));
  }).pipe(Effect.provide(OpenCode.layer));
};

/** The owner deletes one archived message, so recall and zoom never find it and it's never copied again. */
const archiveDelete = (name: string, messageID: string) =>
  Effect.suspend(() => {
    if (!findDot(db, name)) return fail(`No dot named "${name}".`);
    if (!/^msg_[\w-]{1,100}$/.test(messageID)) return fail(`"${messageID}" isn't a message ID.`);
    if (!process.stdin.isTTY)
      return fail(
        "Run this in a terminal: deleting a message needs you to confirm it. Nothing changed.",
      );
    if (
      !confirmed(
        `Delete ${messageID} from ${name}'s archive? Recall and zoom won't find it again, and it's never copied back. OpenCode's own history keeps it.`,
      )
    )
      return Effect.sync(() => console.log("Nothing changed."));
    return deleteArchived(db, name, messageID)
      ? Effect.sync(() => console.log(`Deleted ${messageID} from ${name}'s archive.`))
      : fail(`${name} has no archived message ${messageID}.`);
  });

/**
 * The owner adds their own observed row; one with a forgotten fact's exact text, as tombstones
 * compare it, lets that fact be observed again.
 */
const observationAdd = (name: string, given: string) =>
  Effect.suspend(() => {
    const dot = findDot(db, name);
    if (!dot) return fail(`No dot named "${name}".`);
    const text = memoryText(given, "text");
    if (typeof text !== "string") return fail(text.invalid);
    if (text.length > observationTextLimit)
      return fail(`The text must be at most ${observationTextLimit} characters.`);
    if (!process.stdin.isTTY)
      return fail("Run this in a terminal: adding a row needs you to confirm it. Nothing changed.");
    if (
      !confirmed(
        `Add to ${name}'s observed memory: "${text}"? Only a forgotten fact with exactly this text, ignoring case, accents, spacing and punctuation, may then be observed again from the messages it came from; other forgotten facts keep their block.`,
      )
    )
      return Effect.sync(() => console.log("Nothing changed."));
    const added = addObservation(db, dot, text);
    return Effect.sync(() => console.log(`Added observation #${added.id} to ${name}.`));
  });

const describeFact = (fact: FactView) =>
  `${fact.id}\t${fact.state}\tversion ${fact.version}\t${fact.origin ? `proposed by ${fact.origin.dot} in ${fact.origin.sessionID} ${fact.origin.messageID}` : "added by you"}${fact.text === null ? "" : `\n  ${JSON.stringify(fact.text)}`}`;

/**
 * The owner's facts, shared with every dot. Each change needs the version the owner saw and a yes
 * at a terminal, and its text is typed at the prompt, never taken from the command line.
 */
const ownerCommand = (sub: string | undefined, rest: string[]) =>
  Effect.suspend(() => {
    if (sub === "list" && rest.length === 0)
      return Effect.sync(() => {
        const { pending, approved, removed } = ownerMemory(db);
        console.log(
          "Pending proposals are a dot's suggestions, not evidence they're true. Approved facts reach every dot.",
        );
        for (const [title, facts] of [
          ["Pending", pending],
          ["Approved", approved],
          ["Rejected or deleted", removed],
        ] as const)
          console.log(`${title}:\n${facts.length ? facts.map(describeFact).join("\n") : "(none)"}`);
      });
    if (sub === "show" && rest.length === 1) {
      const fact = isUUID(rest[0]) ? readFact(db, rest[0]) : undefined;
      return fact
        ? Effect.sync(() => console.log(describeFact(fact)))
        : fail("There's no such fact.");
    }
    if (!process.stdin.isTTY)
      return fail(
        "Run this in a terminal: a fact needs you to type it and confirm it. Nothing changed.",
      );
    const id = sub === "add" ? crypto.randomUUID() : rest[0];
    const version = sub === "add" ? 0 : Number(rest[1]);
    const editing = sub === "approve" && rest[2] === "--edit";
    const arity = sub === "add" ? 0 : editing ? 3 : 2;
    if (
      !["add", "approve", "edit", "reject", "delete", "restore"].includes(sub ?? "") ||
      rest.length !== arity ||
      !isUUID(id) ||
      !Number.isSafeInteger(version) ||
      (sub !== "add" && version < 1)
    )
      return fail(usage);
    const current = sub === "add" ? undefined : readFact(db, id);
    if (sub !== "add" && !current) return fail("There's no such fact.");
    if (current) console.log(describeFact(current));
    let text: string | undefined;
    if (sub === "add" || sub === "edit" || sub === "restore" || editing) {
      const answer = factText(prompt("The fact's text:") ?? "");
      if (typeof answer !== "string") return fail(`${answer.invalid} Nothing changed.`);
      text = answer;
    }
    const change: Change =
      sub === "add"
        ? { action: "create", text: text ?? "" }
        : sub === "approve"
          ? text === undefined
            ? { action: "approve" }
            : { action: "approve", text }
          : sub === "edit" || sub === "restore"
            ? { action: sub, text: text ?? "" }
            : { action: sub === "reject" ? "reject" : "delete" };
    const shown = text ?? current?.text;
    const question =
      sub === "reject" || sub === "delete"
        ? `${sub === "reject" ? "Reject" : "Delete"} this fact? No dot will propose it, or anything else from its message, again.`
        : `Every dot will see this about you as your own word: ${JSON.stringify(shown)}. Save it?`;
    if (!confirmed(question)) return Effect.sync(() => console.log("Nothing changed."));
    const result = changeFact(db, id, version, crypto.randomUUID(), change);
    if ("saved" in result) return Effect.sync(() => console.log(describeFact(result.saved)));
    if ("missing" in result) return fail("There's no such fact. Nothing changed.");
    if ("refused" in result) return fail(result.refused);
    return fail(
      `${result.reason} Nothing changed.${result.existing ? ` See ${result.existing.id}.` : ""}`,
    );
  });

const grantCommand = (sub: string | undefined, rest: string[]) => {
  if (sub === "list" && rest.length <= 1)
    return Effect.sync(() => {
      const now = Date.now();
      const active = db
        .select()
        .from(grants)
        .all()
        .filter(
          (grant) =>
            grant.revokedAt === null &&
            grant.expiresAt > now &&
            (!rest[0] || grant.dot === rest[0]),
        );
      if (active.length === 0) return console.log("No active grants.");
      for (const grant of active) console.log(describeGrant(grant));
    });
  const id = Number(rest[0]);
  if (sub === "revoke" && rest.length === 1 && Number.isSafeInteger(id))
    return Effect.suspend(() => {
      const revoked = revokeGrant(db, id);
      if ("missing" in revoked) return fail(`There's no grant #${id}.`);
      if ("conflict" in revoked) return fail(`Grant #${id} already expired or was revoked.`);
      return Effect.sync(() => console.log(`Revoked ${describeGrant(revoked.saved)}`));
    });
  const [dot, operation, ...flags] = rest;
  if (sub !== "add" || !dot) return fail(usage);
  return Effect.suspend(() => {
    if (!findDot(db, dot)) return fail(`No dot named "${dot}".`);
    const input = parseGrant(dot, operation, flags, Date.now());
    if (typeof input === "string") return fail(`${input} Nothing changed.`);
    // Only a person at a terminal can make a grant, so no dot's or worker's shell can.
    if (!process.stdin.isTTY)
      return fail("Run this in a terminal: a grant needs you to confirm it. Nothing changed.");
    const preview = { ...input, id: 0, createdBy: "", createdAt: 0, revokedAt: null };
    if (
      !confirmed(
        `Let ${dot} approve its workers' requests to ${grantScope(preview)}, until ${new Date(input.expiresAt).toLocaleString()}?${
          input.branch === "main" || input.branch === "master" || /prod/i.test(input.target ?? "")
            ? " This names main, master or production."
            : ""
        }`,
      )
    )
      return Effect.sync(() => console.log("Nothing changed."));
    const saved = saveGrant(db, input, "owner (CLI)");
    return Effect.sync(() => console.log(`Active: ${describeGrant(saved)}`));
  });
};

const open = (name: string | undefined) =>
  Effect.gen(function* () {
    const dot = yield* ensureSession(db, yield* pickDot(db, name));
    const opencode = process.env.OPEN_DOT_OPENCODE ?? "opencode";
    const child = Bun.spawn([opencode, "--session", dot.sessionID, dot.directory], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    yield* Effect.promise(() => child.exited);
  }).pipe(Effect.provide(OpenCode.layer));

/** Checks the image and copies it in. A failure leaves the dot's current avatar as it was. */
const avatar = (name: string, file: string) =>
  Effect.suspend(() => {
    if (!findDot(db, name)) return fail(`No dot named "${name}".`);
    const image = setAvatar(name, file);
    if (typeof image === "string")
      return fail(`Couldn't use ${file}: ${image} ${name}'s avatar is unchanged.`);
    return Effect.sync(() => {
      console.log(
        `Saved ${name}'s avatar (${image.mime === "image/png" ? "PNG" : "JPEG"}, ${image.width}×${image.height}) at ${avatarPath(name)}. The app shows it within a few seconds.`,
      );
      const warning = iconSizeWarning(image);
      if (warning) console.log(warning);
    });
  });

/** Only the path, so `$EDITOR "$(open-dot instructions jojo)"` works. */
const instructions = (name: string) =>
  Effect.suspend(() =>
    findDot(db, name)
      ? Effect.sync(() => console.log(instructionsPath(name)))
      : fail(`No dot named "${name}".`),
  );

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Asks the running daemon to move the dot to a fresh session, with the owner's token from
 * api.json, once the owner confirms at a terminal. The daemon does the work, so it can hold the
 * dot's delivery while pending messages move.
 */
const fresh = (name: string, force: boolean) =>
  Effect.suspend(() => {
    const dot = findDot(db, name);
    if (!dot) return fail(`No dot named "${name}".`);
    if (!process.stdin.isTTY)
      return fail(
        "Run this in a terminal: a fresh start needs you to confirm it. Nothing changed.",
      );
    if (
      !confirmed(
        `Move ${name} to a new OpenCode session? Its notes, responsibilities, reminders, workers, grants and Slack threads carry over; its current session ${dot.sessionID} is renamed and kept.`,
      )
    )
      return Effect.sync(() => console.log("Nothing changed."));
    return Effect.promise(async () => {
      let endpoint: unknown;
      try {
        endpoint = JSON.parse(readFileSync(apiPath(), "utf8"));
      } catch {
        return "The daemon isn't running, so nothing changed. Start it, then try again.";
      }
      const token = field(endpoint, "token");
      const url = loopback(field(endpoint, "url"));
      if (!url || typeof token !== "string")
        return "api.json doesn't name a daemon on this Mac, so nothing changed. Restart the daemon.";
      const answer = await fetch(new URL(`/dots/${encodeURIComponent(name)}/fresh`, url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
        redirect: "manual",
      }).catch(() => undefined);
      if (!answer)
        return "Nothing answers at api.json's address. Start the daemon, then try again.";
      const text = await answer.text();
      if (answer.status === 201) {
        const result = parsed(text);
        const previous = String(field(result, "previousSessionID"));
        const title = field(result, "previousTitle");
        const moved = field(result, "moved");
        console.log(
          `${name} now uses session ${String(field(result, "sessionID"))}. ${typeof title === "string" ? `Its old session ${previous} is now "${title}".` : `Its old session ${previous} is kept, but OpenCode didn't confirm its new title.`}${typeof moved === "number" && moved > 0 ? ` ${moved} pending messages moved with it.` : ""}`,
        );
        return undefined;
      }
      if (answer.status === 404 && !text.includes(name))
        return "This daemon doesn't know fresh starts yet. Restart it, then try again.";
      const said = field(parsed(text), "error");
      const message = typeof said === "string" ? said : text;
      return `${message}${answer.status === 409 && !force ? " Pass --force to start fresh anyway." : ""}`;
    }).pipe(Effect.andThen((problem) => (problem ? fail(problem) : Effect.void)));
  });

const list = Effect.sync(() => {
  const all = listDots(db);
  if (all.length === 0) return console.log("No dots yet. Run: open-dot create <name>");
  for (const dot of all)
    console.log(
      `${dot.name}\t${dot.sessionState}\t${dot.sessionID}\t${dot.directory}\t${dot.purpose ?? ""}`,
    );
});

/** Serves the app's API on a fresh port and token, then saves both where only the owner can read them. */
const apiToken = randomBytes(32).toString("hex");
/** Each feed source's latest finished pass, for GET /health. Kept in memory only. */
const feedPasses: Observations = new Map();
/** GET /health reads only this pinned sample, which the daemon's ticks take, never the database. */
const databaseSample = databaseSampler(db.$client);
const notchAPI = api(db, apiToken, OpenCode.layer, spawnRun, Date.now, () =>
  daemonHealth(databaseSample.current(), feedPasses),
);
const serve = Effect.sync(() => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: notchAPI,
  });
  const temporary = `${apiPath()}.${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(
    temporary,
    JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: apiToken }),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  renameSync(temporary, apiPath());
  console.log(`open-dot API on http://127.0.0.1:${server.port}`);
});

const slack = slackClient();
const sources = [github(), linear(), slackFeed(slack)];

/** One pass of the owner's chat with the dots in Slack. Problems are logged inside. */
const converse = slackChat(db, slack, OpenCode.layer);

/** Each dot's own Slack app: its connection, the owner's mentions and DMs, and the replies. */
const agents = slackAgents(db, OpenCode.layer, undefined, (event) => {
  if (event.type === "ended") notchAPI.invalidate(event.sessionID);
});

const logged = (part: string, run: () => Promise<void>) =>
  Effect.promise(() =>
    run().catch((error: unknown) =>
      console.error(`${part}: ${error instanceof Error ? error.message : String(error)}`),
    ),
  );

const setUp = logged("Slack app setup", () => provision(db, slack));
const outsiders = sharedNotices(db, slack);
const tellOutsiders = logged("Slack notes", outsiders);

/** Collects each source's feed. One failing source doesn't stop the others. */
const gather = Effect.promise(() =>
  Promise.all(
    sources.map((source) =>
      collect(db, source, Date.now()).then(
        (polled) =>
          observe(feedPasses, source.name, polled ? "polled" : "not_configured", Date.now()),
        (error: unknown) => {
          observe(feedPasses, source.name, "failed", Date.now());
          console.error(
            `Feed from ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      ),
    ),
  ),
);

const daemon = Effect.sync(() => {
  console.log(`open-dot daemon watching ${databasePath()}`);
  databaseSample.tick();
}).pipe(
  Effect.andThen(serve),
  Effect.andThen(
    Effect.all(
      [
        daemonLoops(db, OpenCode.layer),
        Effect.repeat(
          Effect.sync(() => {
            void notchAPI.refresh();
            databaseSample.tick();
          }),
          Schedule.spaced("1 second"),
        ),
        Effect.repeat(converse, Schedule.spaced("3 seconds")),
        Effect.repeat(agents.tick, Schedule.spaced("3 seconds")),
        // Only while a dot's own app is active; it only keeps text for the tick to stream.
        agents.events,
        Effect.repeat(setUp, Schedule.spaced("10 seconds")),
        Effect.repeat(tellOutsiders, Schedule.spaced("1 minute")),
        // GitHub asks clients to poll notifications at most once a minute.
        Effect.repeat(gather, Schedule.spaced("1 minute")),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  ),
);

const program =
  command === "create" && args[0]
    ? create(args[0], args.slice(1).join(" "))
    : command === "list"
      ? list
      : command === "avatar" && args.length === 2 && args[0] && args[1]
        ? avatar(args[0], args[1])
        : command === "open"
          ? open(args[0])
          : command === "daemon"
            ? daemon
            : command === "slack"
              ? slackCommand(args[0], args[1], args.slice(2))
              : command === "watch"
                ? watchCommand(args[0], args.slice(1))
                : command === "grant"
                  ? grantCommand(args[0], args.slice(1))
                  : command === "instructions" && args.length === 1 && args[0]
                    ? instructions(args[0])
                    : command === "fresh" &&
                        args[0] &&
                        (args.length === 1 || (args.length === 2 && args[1] === "--force"))
                      ? fresh(args[0], args[1] === "--force")
                      : command === "archive" &&
                          args.length === 3 &&
                          args[0] === "delete" &&
                          args[1] &&
                          args[2]
                        ? archiveDelete(args[1], args[2])
                        : command === "observation" &&
                            args.length === 3 &&
                            args[0] === "add" &&
                            args[1] &&
                            args[2]
                          ? observationAdd(args[1], args[2])
                          : command === "owner"
                            ? ownerCommand(args[0], args.slice(1))
                            : Effect.sync(() => console.log(usage));

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
