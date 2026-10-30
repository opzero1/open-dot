import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../src/api";
import { type Db, openDatabase } from "../src/db";
import {
  isPublic,
  loadMedia,
  mediaCache,
  mediaID,
  mediaLinks,
  mediaTesting,
  sniff,
} from "../src/media";
import { dots } from "../src/schema";
import { fakeOpenCode } from "./fake-opencode";

const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32, 1)]);
const mp4 = Buffer.concat([
  Buffer.from("0000001866747970", "hex"),
  Buffer.from("isom"),
  Buffer.alloc(16),
]);

// One local server plays every remote host; each path is one behavior.
const hits = new Map<string, number>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path.startsWith("/ok")) return new Response(png);
    if (path === "/video.mp4") return new Response(mp4);
    if (path === "/svg.png")
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
        headers: { "content-type": "image/png" },
      });
    if (path === "/html.png") return new Response("<!doctype html><script>x</script>");
    if (path === "/gzip.png") return new Response(png, { headers: { "content-encoding": "gzip" } });
    if (path === "/huge.png") {
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(stream) {
            sent += 1024 * 1024;
            if (sent > 11 * 1024 * 1024) stream.close();
            else stream.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
      );
    }
    if (path === "/slow.png") {
      await Bun.sleep(1_000);
      return new Response(png);
    }
    const hop = /^\/hop(\d+)\.png$/.exec(path);
    if (hop) {
      const left = Number(hop[1]);
      return Response.redirect(left === 0 ? "/ok-final.png" : `/hop${left - 1}.png`, 302);
    }
    if (path === "/to-private.png") return Response.redirect(`http://[::1]:${port}/ok.png`);
    return new Response("no", { status: 404 });
  },
});
const { port } = server;
const base = `http://127.0.0.1:${port}`;
const link = (path: string, kind: "image" | "video" = "image") => {
  const url = `${base}${path}`;
  return { id: mediaID(url), url, kind } as const;
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "open-dot-media-"));
  process.env.OPEN_DOT_HOME = home;
  hits.clear();
  // The fake host is local, so only its exact address passes in these tests.
  mediaTesting.allow((address) => address === "127.0.0.1");
});
afterEach(() => {
  mediaTesting.reset();
  delete process.env.OPEN_DOT_HOME;
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => server.stop(true));

test("a reply's images and bare media links are listed, never code, titled links or credentials", () => {
  const text = [
    "![chart](https://example.com/chart.png) and ![noext](https://example.com/render)",
    "https://example.com/clip.mp4",
    "[the docs](https://example.com/doc.png) <https://example.com/auto.webm>",
    "`https://example.com/code.png`",
    "```\n![x](https://example.com/fenced.png)\n```",
    "![s](https://example.com/s.png?X-Amz-Signature=abc) ![t](https://example.com/t.png?token=1)",
    "![u](https://user:pw@example.com/u.png) ![f](file:///etc/passwd.png) ![d](data:image/png;base64,AA)",
  ].join("\n\n");
  expect(mediaLinks(text).map((entry) => [entry.url, entry.kind])).toEqual([
    ["https://example.com/chart.png", "image"],
    ["https://example.com/render", "image"],
    ["https://example.com/clip.mp4", "video"],
    ["https://example.com/auto.webm", "video"],
  ]);
  const many = Array.from({ length: 12 }, (_, index) => `![${index}](https://e.com/${index}.png)`);
  expect(mediaLinks(many.join(" "))).toHaveLength(8);
});

test("only public addresses pass, including in IPv6 and mapped forms", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"])
    expect(isPublic(address)).toBe(true);
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "localhost",
  ])
    expect([address, isPublic(address)]).toEqual([address, false]);
});

test("only real image and video bytes are recognized", () => {
  expect(sniff(png)?.mime).toBe("image/png");
  expect(sniff(mp4)?.mime).toBe("video/mp4");
  expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  expect(sniff(Buffer.from("<!doctype html><html></html>"))).toBeUndefined();
});

test("an allowed image is fetched once, then served from a private cache", async () => {
  const [first, second] = await Promise.all([
    loadMedia(link("/ok.png")),
    loadMedia(link("/ok.png")),
  ]);
  expect(first).toEqual({ ok: true, bytes: png, mime: "image/png" });
  expect(second).toEqual(first);
  expect(await loadMedia(link("/ok.png"))).toEqual(first);
  expect(hits.get("/ok.png")).toBe(1);
  expect(lstatSync(mediaCache()).mode & 0o777).toBe(0o700);
  const names = readdirSync(mediaCache());
  expect(names.map((name) => lstatSync(join(mediaCache(), name)).mode & 0o777)).toEqual([0o600]);
  expect((await loadMedia(link("/video.mp4", "video"))).ok).toBe(true);
});

test("private hosts are refused before any connection, and on every redirect", async () => {
  mediaTesting.reset();
  expect(await loadMedia(link("/ok.png"))).toMatchObject({ ok: false, status: 403 });
  const local = `http://localhost:${server.port}/ok.png`;
  expect(await loadMedia({ id: mediaID(local), url: local, kind: "image" })).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(hits.size).toBe(0);
  mediaTesting.allow((address) => address === "127.0.0.1");
  expect(await loadMedia(link("/to-private.png"))).toMatchObject({ ok: false, status: 403 });
  expect(hits.get("/ok.png")).toBeUndefined();
  expect(await loadMedia(link("/hop2.png"))).toMatchObject({ ok: true });
  expect(await loadMedia(link("/hop3.png"))).toMatchObject({ ok: false, status: 502 });
});

test("oversized, compressed, slow, mislabeled, SVG and HTML responses are refused", async () => {
  expect(await loadMedia(link("/huge.png"))).toMatchObject({ ok: false, status: 413 });
  expect(await loadMedia(link("/gzip.png"))).toMatchObject({ ok: false, status: 415 });
  expect(await loadMedia(link("/svg.png"))).toMatchObject({ ok: false, status: 415 });
  expect(await loadMedia(link("/html.png"))).toMatchObject({ ok: false, status: 415 });
  expect(await loadMedia(link("/video.mp4", "image"))).toMatchObject({ ok: false, status: 415 });
  mediaTesting.deadline(200);
  expect(await loadMedia(link("/slow.png"))).toMatchObject({ ok: false, status: 504 });
  expect(readdirSync(mediaCache()).length).toBe(0);
});

test("the cache drops leftovers, links and the oldest entries past its cap", async () => {
  const directory = mediaCache();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const old = Date.now() / 1000 - 3600;
  for (let index = 0; index < 100; index++) {
    const path = join(directory, `old${String(index).padStart(3, "0")}`);
    writeFileSync(path, png, { mode: 0o600 });
    utimesSync(path, old + index, old + index);
  }
  writeFileSync(join(directory, ".tmp-left"), "x");
  utimesSync(join(directory, ".tmp-left"), old, old);
  symlinkSync("/etc/hosts", join(directory, "link"));
  expect((await loadMedia(link("/ok-new.png"))).ok).toBe(true);
  const left = readdirSync(directory);
  expect(left).toHaveLength(100);
  expect(left).not.toContain("old000");
  expect(left).not.toContain(".tmp-left");
  expect(left).not.toContain("link");
});

test("the daemon serves only media a shown reply lists now", async () => {
  const db: Db = openDatabase(":memory:");
  const fake = fakeOpenCode();
  db.insert(dots)
    .values({
      name: "jojo",
      directory: "/dots/jojo",
      sessionID: "ses_jojo",
      sessionState: "ready",
      createdAt: 0,
    })
    .run();
  const reply = `Here: ![chart](${base}/ok-api.png) [named](${base}/ok-named.png)`;
  fake.state.history.set("ses_jojo", [
    { id: "msg_dot", role: "assistant", text: reply, tools: [], files: [], time: 0 },
    {
      id: "msg_owner",
      role: "user",
      text: `![x](${base}/ok-user.png)`,
      tools: [],
      files: [],
      time: 0,
    },
  ]);
  const get = (path: string) =>
    api(
      db,
      "secret",
      fake.layer,
    )(new Request(`http://127.0.0.1${path}`, { headers: { authorization: "Bearer secret" } }));
  const listed = mediaID(`${base}/ok-api.png`);
  const shown = await get("/dots/jojo/messages/msg_dot?sessionID=ses_jojo");
  expect(((await shown.json()) as { media: unknown }).media).toEqual([
    { id: listed, url: `${base}/ok-api.png`, kind: "image" },
  ]);
  const media = await get(`/dots/jojo/messages/msg_dot/media/${listed}?sessionID=ses_jojo`);
  expect(media.status).toBe(200);
  expect(media.headers.get("content-type")).toBe("image/png");
  expect(media.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await media.arrayBuffer())).toEqual(png);
  for (const path of [
    `/dots/jojo/messages/msg_dot/media/${mediaID(`${base}/ok-named.png`)}?sessionID=ses_jojo`,
    `/dots/jojo/messages/msg_owner/media/${mediaID(`${base}/ok-user.png`)}?sessionID=ses_jojo`,
    `/dots/jojo/messages/msg_dot/media/0123456789abcdef?sessionID=ses_jojo`,
  ])
    expect((await get(path)).status).toBe(404);
  expect((await get(`/dots/jojo/messages/msg_dot/media/${listed}?sessionID=ses_old`)).status).toBe(
    409,
  );
  expect(hits.get("/ok-named.png")).toBeUndefined();
  expect(hits.get("/ok-user.png")).toBeUndefined();
});
