import { beforeEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { api } from "../src/api";
import { saveArchiveSettings } from "../src/archive";
import { type Db, openDatabase } from "../src/db";
import { redact } from "../src/memory";
import { OpenCode, OpenCodeError } from "../src/opencode";
import { archive, dots, notes } from "../src/schema";

let db: Db;
const down = Layer.effect(OpenCode, Effect.fail(new OpenCodeError({ message: "Not running" })));

beforeEach(() => {
  db = openDatabase(":memory:");
  for (const name of ["jojo", "polnareff"])
    db.insert(dots)
      .values({
        name,
        directory: `/dots/${name}`,
        sessionID: `ses_${name}`,
        sessionState: "ready",
        createdAt: 0,
      })
      .run();
});

const call = (path: string, token = "secret") =>
  api(
    db,
    "secret",
    down,
  )(new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${token}` } }));

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const archived = (dot: string, messageID: string, text: string, sessionID = `ses_${dot}`) =>
  db
    .insert(archive)
    .values({ dot, sessionID, messageID, role: "owner", text, createdAt: 1, archivedAt: 1 })
    .run();

test("the owner's recall searches notes, and archived messages only while the archive is on", async () => {
  db.insert(notes)
    .values({ dot: "jojo", text: "The release plan lives in docs.", createdAt: 1 })
    .run();
  archived("jojo", "msg_old1", "We moved the release plan to Friday.", "ses_earlier");
  archived("polnareff", "msg_other", "polnareff's release plan.");
  const off = await body(await call("/dots/jojo/memory/recall?q=release%20plan"));
  expect(off.archive).toBe(false);
  expect((off.results as { kind: string }[]).map((result) => result.kind)).toEqual(["note"]);

  saveArchiveSettings(db, "jojo", { archive: true }, 0);
  const on = await body(await call("/dots/jojo/memory/recall?q=release%20plan"));
  const results = on.results as { kind: string; message?: string; sessionID?: string }[];
  expect(results.map((result) => result.kind).toSorted()).toEqual(["message", "note"]);
  // An earlier session's message stays searchable, and another dot's never shows.
  expect(results.find((result) => result.kind === "message")).toMatchObject({
    message: "msg_old1",
    sessionID: "ses_earlier",
  });
  expect(JSON.stringify(on)).not.toContain("polnareff's");

  const opened = await body(await call("/dots/jojo/memory/archive/msg_old1"));
  expect(opened).toMatchObject({
    message: "msg_old1",
    text: "We moved the release plan to Friday.",
  });
  expect((await call("/dots/polnareff/memory/archive/msg_old1")).status).toBe(404);
  saveArchiveSettings(db, "jojo", { archive: false }, 0);
  expect((await call("/dots/jojo/memory/archive/msg_old1")).status).toBe(404);
});

test("recall pages, bounds its parameters strictly, and needs the token", async () => {
  saveArchiveSettings(db, "jojo", { archive: true }, 0);
  for (let index = 0; index < 12; index++)
    archived("jojo", `msg_m${index}`, `shipping note ${index}`);
  const first = await body(await call("/dots/jojo/memory/recall?q=shipping"));
  expect((first.results as unknown[]).length).toBe(8);
  expect(first.next).toBe(8);
  const second = await body(await call("/dots/jojo/memory/recall?q=shipping&offset=8&limit=20"));
  expect((second.results as unknown[]).length).toBe(4);
  expect(second.next).toBeNull();
  for (const query of [
    "",
    "?q=shipping&limit=21",
    "?q=shipping&limit=0",
    "?q=shipping&offset=201",
    "?q=shipping&offset=-1",
    "?q=shipping&q=again",
    "?q=shipping&extra=1",
  ])
    expect((await call(`/dots/jojo/memory/recall${query}`)).status).toBe(400);
  expect((await call("/dots/jojo/memory/recall?q=shipping", "wrong")).status).toBe(401);
  expect((await call("/dots/jojo/memory/archive/msg_m1?offset=x")).status).toBe(400);
  expect((await call("/dots/jojo/memory/archive/msg_m1?other=1")).status).toBe(400);
});

test("an archived message opens 4,000 characters at a time, and saved text stays redacted", async () => {
  saveArchiveSettings(db, "jojo", { archive: true }, 0);
  const secret = `token ghp_${"a".repeat(36)}`;
  archived("jojo", "msg_long", redact(`${"x".repeat(4500)} ${secret}`));
  const part = await body(await call("/dots/jojo/memory/archive/msg_long"));
  expect((part.text as string).length).toBe(4000);
  expect(part.next).toBe(4000);
  const rest = await body(await call("/dots/jojo/memory/archive/msg_long?offset=4000"));
  expect(rest.text).toContain("[redacted]");
  expect(JSON.stringify(rest)).not.toContain("ghp_");
});
