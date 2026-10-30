import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { home } from "./home";

/**
 * Remote images and videos a dot's reply links to, fetched by the daemon so the app never loads a
 * remote URL itself. Only public addresses, only real image and video bytes, size and time bounded,
 * and cached privately for a day.
 */
export type MediaKind = "image" | "video";
export type MediaLink = { id: string; url: string; kind: MediaKind };
export type MediaResult =
  | { ok: true; bytes: Buffer; mime: string }
  | { ok: false; status: number; message: string };

const extensions = new Map<string, MediaKind>([
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["avif", "image"],
  ["mp4", "video"],
  ["webm", "video"],
]);

/** Query parameters that look like they carry a credential: such a URL is never fetched. */
const credential =
  /^(?:x-amz-.*|x-goog-.*|token|access_token|id_token|auth|authorization|key|api_key|apikey|sig|signature|password|passwd|secret|session|sessionid|code|jwt)$/i;

/** The URL's canonical form if open-dot may fetch it, else undefined. */
export const mediaURL = (raw: string) => {
  if (raw.length > 2048 || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if ([...url.searchParams.keys()].some((key) => credential.test(key))) return undefined;
  url.hash = "";
  return url.href;
};

const extensionKind = (href: string) =>
  extensions.get(/\.([a-z\d]+)$/i.exec(new URL(href).pathname)?.[1]?.toLowerCase() ?? "");

const textOf = (node: Nodes): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

export const mediaID = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);

const mediaLimit = 8;

/**
 * The media a reply shows inline: its Markdown images, inline or by reference, and bare links
 * (text equal to the URL) to an image or video file. Code, HTML and links with their own text are
 * never fetched.
 */
export const mediaLinks = (text: string): MediaLink[] => {
  if (text.length > 200_000 || !text.includes("http")) return [];
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // Reference definitions by their normalized label; the first of a label wins, as in CommonMark.
  const definitions = new Map<string, string>();
  const define = (node: Nodes) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if ("children" in node) for (const child of node.children) define(child);
  };
  define(tree);
  const found = new Map<string, MediaLink>();
  const walk = (node: Nodes) => {
    if (found.size >= mediaLimit) return;
    const image = node.type === "image" || node.type === "imageReference";
    const target =
      node.type === "image" || node.type === "link"
        ? node.url
        : node.type === "imageReference" || node.type === "linkReference"
          ? definitions.get(node.identifier)
          : undefined;
    if (target !== undefined && (image || textOf(node) === target)) {
      const url = mediaURL(target);
      const kind = url && (extensionKind(url) ?? (image ? "image" : undefined));
      if (url && kind) found.set(url, { id: mediaID(url), url, kind });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return [...found.values()];
};

const private4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  private4.addSubnet(network, prefix, "ipv4");
// Global unicast only. Loopback, link-local, unique-local, multicast, mapped IPv4, NAT64 and SRv6
// all fall outside 2000::/3; inside it, every block IANA's special-purpose registry lists as not
// globally reachable, or reserved for documentation, is refused too.
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const special6 = new BlockList();
for (const [network, prefix] of [
  // IETF protocol assignments: Teredo, benchmarking, ORCHID and the rest.
  ["2001::", 23],
  ["2001:db8::", 32],
  // 6to4, which embeds an IPv4 address of any kind.
  ["2002::", 16],
  // Documentation (RFC 9637).
  ["3fff::", 20],
] as const)
  special6.addSubnet(network, prefix, "ipv6");

/** Whether an address is on the public internet, so fetching it can't reach this machine's network. */
export const isPublic = (address: string) => {
  const family = isIP(address);
  if (family === 4) return !private4.check(address, "ipv4");
  if (family === 6) return global6.check(address, "ipv6") && !special6.check(address, "ipv6");
  return false;
};

let allowed = isPublic;
let deadline = 15_000;

/** Seams for tests only: which addresses count as allowed, and the total time limit. */
export const mediaTesting = {
  allow: (policy: (address: string) => boolean) => {
    allowed = policy;
  },
  deadline: (ms: number) => {
    deadline = ms;
  },
  reset: () => {
    allowed = isPublic;
    deadline = 15_000;
  },
};

const limits: Record<MediaKind, number> = { image: 10 * 1024 * 1024, video: 32 * 1024 * 1024 };

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCodePoint(...bytes.subarray(start, end));

const mp4Brands = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash"]);

/** The type the bytes really are, from their signature. Never SVG, HTML or anything else. */
export const sniff = (bytes: Uint8Array): { mime: string; kind: MediaKind } | undefined => {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 8) === "PNG\r\n\u001A\n")
    return { mime: "image/png", kind: "image" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", kind: "image" };
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { mime: "image/gif", kind: "image" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return { mime: "image/webp", kind: "image" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", kind: "image" };
    if (mp4Brands.has(brand)) return { mime: "video/mp4", kind: "video" };
    return undefined;
  }
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    ascii(bytes, 0, Math.min(bytes.length, 64)).includes("webm")
  )
    return { mime: "video/webm", kind: "video" };
  return undefined;
};

const fail = (status: number, message: string): MediaResult => ({ ok: false, status, message });

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const stop = () => reject(new Refused(504, "The media took too long."));
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
  });

/** Every address the host resolves to, each one allowed, or a refusal. */
const resolve = async (hostname: string, signal: AbortSignal) => {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(bare);
  const addresses = family
    ? [{ address: bare, family }]
    : await Promise.race([lookup(bare, { all: true, verbatim: true }), aborted(signal)]).catch(
        (cause: unknown) => {
          if (cause instanceof Refused) throw cause;
          throw new Refused(502, "The media's host didn't resolve.");
        },
      );
  const [first] = addresses;
  if (!first || !addresses.every((entry) => allowed(entry.address)))
    throw new Refused(403, "The media's host isn't on the public internet.");
  return first;
};

type Address = { address: string; family: number };

/** One GET to the approved address only, with no proxy, cookies or credentials. */
const request = (url: URL, pinned: Address, signal: AbortSignal) =>
  new Promise<http.IncomingMessage>((done, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const outgoing = client.request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: { accept: "image/*, video/*", "accept-encoding": "identity" },
        lookup: (_host, options, callback) =>
          options.all
            ? (callback as (error: null, all: Address[]) => void)(null, [pinned])
            : callback(null, pinned.address, pinned.family),
      },
      done,
    );
    outgoing.on("error", (cause) =>
      reject(signal.aborted ? new Refused(504, "The media took too long.") : cause),
    );
    outgoing.end();
  });

const redirects = new Set([301, 302, 303, 307, 308]);

/** The response body, refused once it passes the limit. */
const body = (response: http.IncomingMessage, limit: number, signal: AbortSignal) =>
  new Promise<Buffer>((done, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        response.destroy();
        reject(new Refused(413, "The media is too large."));
      } else chunks.push(chunk);
    });
    response.on("end", () => done(Buffer.concat(chunks)));
    response.on("error", () =>
      reject(
        signal.aborted
          ? new Refused(504, "The media took too long.")
          : new Refused(502, "The media's server failed."),
      ),
    );
    signal.addEventListener("abort", () => reject(new Refused(504, "The media took too long.")), {
      once: true,
    });
  });

const download = async (link: MediaLink): Promise<MediaResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  const { signal } = controller;
  try {
    let href = link.url;
    for (let hop = 0; ; hop++) {
      const url = new URL(href);
      const pinned = await resolve(url.hostname, signal);
      const response = await Promise.race([request(url, pinned, signal), aborted(signal)]).catch(
        (cause: unknown) => {
          if (cause instanceof Refused) throw cause;
          throw new Refused(502, "The media's server didn't answer.");
        },
      );
      const peer = response.socket?.remoteAddress?.replace(/^::ffff:(?=\d+\.)/, "");
      if (!peer || peer !== pinned.address.replace(/^::ffff:(?=\d+\.)/, "") || !allowed(peer)) {
        response.destroy();
        throw new Refused(403, "The media's host isn't on the public internet.");
      }
      const status = response.statusCode ?? 0;
      if (redirects.has(status)) {
        response.destroy();
        const location = response.headers.location;
        const next =
          location && URL.canParse(location, href) ? mediaURL(new URL(location, href).href) : null;
        if (!next) throw new Refused(403, "The media redirected somewhere open-dot won't fetch.");
        if (hop >= 3) throw new Refused(502, "The media redirected too many times.");
        href = next;
        continue;
      }
      if (status !== 200) {
        response.destroy();
        throw new Refused(502, `The media's server answered ${status}.`);
      }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding.toLowerCase() !== "identity") {
        response.destroy();
        throw new Refused(415, "The media came compressed.");
      }
      const limit = limits[link.kind];
      if (Number(response.headers["content-length"] ?? 0) > limit) {
        response.destroy();
        throw new Refused(413, "The media is too large.");
      }
      const bytes = await body(response, limit, signal);
      const type = sniff(bytes);
      if (!type || type.kind !== link.kind)
        return fail(415, `That link isn't ${link.kind === "image" ? "an image" : "a video"}.`);
      return { ok: true, bytes, mime: type.mime };
    }
  } catch (cause) {
    return cause instanceof Refused
      ? fail(cause.status, cause.message)
      : fail(502, "The media couldn't be fetched.");
  } finally {
    clearTimeout(timer);
  }
};

const cacheLife = 24 * 60 * 60 * 1000;
const cacheBytes = 256 * 1024 * 1024;
const cacheEntries = 100;

export const mediaCache = () => join(home(), "cache", "media");

const cacheName = (url: string) => createHash("sha256").update(url).digest("hex");

/** A real, private directory, made when missing; never one reached through a symlink. */
const realDirectory = async (path: string, make: boolean) => {
  if (make) await mkdir(path, { mode: 0o700 }).catch(() => {});
  const info = await lstat(path);
  return info.isDirectory() && !info.isSymbolicLink();
};

/**
 * The cache directory, or undefined unless open-dot's home, its cache and the media cache are
 * each a real directory, the last one private: a symlink anywhere below home is refused.
 */
const cacheDirectory = async () => {
  const directory = mediaCache();
  try {
    if (!(await realDirectory(home(), false))) return undefined;
    if (!(await realDirectory(dirname(directory), true))) return undefined;
    if (!(await realDirectory(directory, true))) return undefined;
    const info = await lstat(directory);
    return (info.mode & 0o077) === 0 ? directory : undefined;
  } catch {
    return undefined;
  }
};

/** A cached file's bytes, opened without following a symlink, or undefined. */
const readCached = async (path: string, limit: number) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit || Date.now() - info.mtimeMs > cacheLife)
      return undefined;
    return await file.readFile();
  } finally {
    await file.close();
  }
};

const cached = async (link: MediaLink): Promise<MediaResult | undefined> => {
  const directory = await cacheDirectory();
  if (!directory) return undefined;
  const path = join(directory, cacheName(link.url));
  try {
    const bytes = await readCached(path, limits[link.kind]);
    if (!bytes) {
      await rm(path, { force: true });
      return undefined;
    }
    const type = sniff(bytes);
    return type?.kind === link.kind ? { ok: true, bytes, mime: type.mime } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Drops expired, odd and stale temporary files, then the oldest cached files until everything,
 * temporary files being written and `reserve` bytes about to be included, fits the size and count
 * caps.
 */
const evict = async (directory: string, reserve = 0) => {
  const entries = [];
  let total = reserve;
  let count = reserve ? 1 : 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    const age = Date.now() - info.mtimeMs;
    const temporary = name.startsWith(".tmp-");
    if (!info.isFile() || age > cacheLife || (temporary && age > 60_000)) {
      await rm(path, { force: true, recursive: false }).catch(() => {});
      continue;
    }
    if (temporary) {
      total += info.size;
      count++;
    } else entries.push({ path, size: info.size, time: info.mtimeMs });
  }
  entries.sort((a, b) => b.time - a.time);
  for (const entry of entries) {
    total += entry.size;
    count++;
    if (count > cacheEntries || total > cacheBytes) {
      await rm(entry.path, { force: true });
      total -= entry.size;
      count--;
    }
  }
};

const store = async (link: MediaLink, bytes: Buffer) => {
  const directory = await cacheDirectory();
  if (!directory) return;
  const temporary = join(directory, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    // Room first, so the cache never holds more than its caps, even while writing.
    await evict(directory, bytes.length);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, cacheName(link.url)));
    await evict(directory);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

const flights = new Map<string, Promise<MediaResult>>();
const waiting: (() => void)[] = [];
let active = 0;

const slot = async () => {
  if (active >= 4) await new Promise<void>((resume) => waiting.push(resume));
  active++;
};

const release = () => {
  active--;
  waiting.shift()?.();
};

/** The media's bytes, from the cache or the network, with at most four fetches at a time. */
export const loadMedia = (link: MediaLink): Promise<MediaResult> => {
  const flight = flights.get(link.url);
  if (flight) return flight;
  const next = (async () => {
    const hit = await cached(link);
    if (hit) return hit;
    await slot();
    try {
      const result = await download(link);
      if (result.ok) await store(link, result.bytes);
      return result;
    } finally {
      release();
    }
  })().finally(() => flights.delete(link.url));
  flights.set(link.url, next);
  return next;
};
