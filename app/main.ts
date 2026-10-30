// The app's main process: one window, the menu bar icon, the shortcut, and every call to the
// daemon. The renderer reaches these only through the typed bridge; the token never leaves here.
import { SessionMessage } from "@opencode/client/effect";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  ShareMenu,
  shell,
  Tray,
} from "electron";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  type AppEvent,
  type Attempt,
  type Bytes,
  type Channel,
  channels,
  type DraftImage,
  eventChannel,
  type Operation,
  type PickupState,
  type PickupStep,
  type Reply,
  type ReceiptStatus,
  type Result,
  type SendResult,
  type ServiceAction,
  type TrayState,
} from "./bridge";
import {
  cursorLimit,
  displayName,
  type Endpoint,
  imageInfo,
  imageLimits,
  mediaLimit,
  mediaType,
  imageProblem,
  isImageType,
  loopbackEndpoint,
  safeExternalURL,
  sendOutcome,
  settled,
} from "./chat";
import { type Clipboard, helperClipboard } from "./clipboard";
import { decoded } from "./decode";
import { isServiceAction, serviceBinary, serviceControl } from "./service";
import {
  isSlackAppID,
  linkAppID,
  pickupAfter,
  pickupMilliseconds,
  pickupNames,
  tokenMatches,
} from "./slack";

// The smoke test runs the app hidden against a fake daemon, with native integrations recorded
// instead of used; it never shows or focuses a window.
const smoke = process.env.OPEN_DOT_APP_SMOKE === "1";
const startHidden = smoke || process.argv.includes("--hidden");
const recorded = {
  show: 0,
  focus: 0,
  emojiPanel: 0,
  openExternal: [] as string[],
  clipboard: [] as { text?: string; images?: number }[],
  shares: [] as { texts: number; files: number; directory: string }[],
  saves: [] as { name: string; bytes: number }[],
  quitPrompts: 0,
  // The OpenCode commands main asked the owner about, which the driver's `confirm` answers.
  confirms: [] as string[],
  // Every request the page made to anything but the app's own files, blobs and data, and how
  // many it made to its own, which shows the count is live.
  remote: [] as string[],
  local: 0,
};
let smokeConfirm = false;

if (process.env.OPEN_DOT_APP_DATA) app.setPath("userData", resolve(process.env.OPEN_DOT_APP_DATA));
// A normal Dock app otherwise: its icon stays while it runs, hidden or not, and clicking it
// ("activate") shows the window. Only the hidden smoke test runs without one.
if (smoke) app.setActivationPolicy("accessory");

const scheme = "app";
const origin = `${scheme}://open-dot`;
protocol.registerSchemesAsPrivileged([
  { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Only the app's own files: scripts, styles and fonts it ships, images from blobs it makes.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // KaTeX's generated layout; the sanitizer strips any style the text itself carries.
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' blob:",
  // A reply's remote images and videos, only as blobs of bytes the daemon fetched and checked.
  "media-src blob:",
  "worker-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

// Bun inlines __dirname at build time, so paths come from the running app's own directory.
const rendererRoot = join(app.getAppPath(), "renderer");

/** Serves only files under the packaged renderer directory, never a path outside it. */
const serveAsset = async (request: Request) => {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.host !== "open-dot")
    return new Response(null, { status: 404 });
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  const file = normalize(join(rendererRoot, path === "/" ? "index.html" : path));
  const type = types[extname(file)];
  if (!file.startsWith(rendererRoot + sep) || path.includes("\0") || !type)
    return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: {
        "content-type": type,
        "content-security-policy": csp,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
};

// The daemon, found from api.json the way the app finds it.

const home = process.env.OPEN_DOT_HOME
  ? resolve(process.env.OPEN_DOT_HOME.replace(/^~(?=$|\/)/, homedir()))
  : join(homedir(), ".opendot");
let endpoint: Endpoint | undefined;
// The last daemon discovered, by address and token, and how many have been: a new one voids the
// old one's cursors and whatever it said it could do.
let endpointKey: string | undefined;
let generation = 0;
// The daemon, by key, whose message page said it takes the app's own message IDs, and one that
// answered a send with another ID, which the app no longer sends to.
let capable: string | undefined;
let distrusted: string | undefined;

const keyOf = (target: Endpoint) => `${target.url}\n${target.token}`;

const current = () => {
  if (endpoint) return endpoint;
  try {
    const raw = readFileSync(join(home, "api.json"), "utf8");
    endpoint = raw.length < 4096 ? loopbackEndpoint(JSON.parse(raw)) : undefined;
  } catch {
    endpoint = undefined;
  }
  if (endpoint && keyOf(endpoint) !== endpointKey) {
    endpointKey = keyOf(endpoint);
    generation++;
    capable = undefined;
  }
  return endpoint;
};

interface Answer {
  status: number;
  type: string;
  body: Buffer;
}

/**
 * One request to the daemon, never through a proxy and never following a redirect. A failure
 * before the request went out is status 0; one after it may have arrived is `lost`.
 */
const exchange = (
  target: Endpoint | undefined,
  method: string,
  path: string,
  body?: unknown,
  timeout = 10_000,
  limit = 16 * 1024 * 1024,
): Promise<Answer | { failed: string; lost: boolean }> => {
  if (!target) return Promise.resolve({ failed: "open-dot's daemon isn't running.", lost: false });
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  // Only this daemon's failure sends the app back to api.json, not one it already replaced.
  const rediscover = () => {
    if (endpoint === target) endpoint = undefined;
  };
  return new Promise((done) => {
    let sent = false;
    const forget = (failed: string) => {
      rediscover();
      done({ failed, lost: sent });
    };
    const request = httpRequest(
      `${target.url}${path}`,
      {
        method,
        timeout,
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            request.destroy();
            forget("The daemon's answer was too large.");
          } else chunks.push(chunk);
        });
        response.on("error", () => forget("The connection to the daemon was lost."));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          // A new token means the daemon restarted; a redirect is no daemon's answer.
          if (status === 401 || (status >= 300 && status < 400)) rediscover();
          done({
            status,
            type: response.headers["content-type"] ?? "",
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      forget("The daemon didn't answer in time.");
    });
    request.on("error", () =>
      forget(sent ? "The connection to the daemon was lost." : "open-dot's daemon isn't running."),
    );
    request.on("finish", () => {
      sent = true;
    });
    request.end(data);
  });
};

const unreached = ({ failed, lost }: { failed: string; lost: boolean }): Result<never> =>
  lost ? { ok: false, error: failed, lost } : { ok: false, error: failed, status: 0 };

const failure = (answer: Answer): { ok: false; error: string; status: number } => {
  let text = `The daemon answered ${answer.status}.`;
  try {
    const parsed: unknown = JSON.parse(answer.body.toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    )
      text = parsed.error.slice(0, 500);
  } catch {}
  return { ok: false, error: text, status: answer.status };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A JSON answer, passed on as data: main reads only the few fields it acts on itself. */
const json = async (
  method: string,
  path: string,
  body?: unknown,
  timeout?: number,
  target = current(),
): Promise<Result<unknown>> => {
  const answer = await exchange(target, method, path, body, timeout);
  if ("failed" in answer) return unreached(answer);
  if (answer.status < 200 || answer.status >= 300) return failure(answer);
  try {
    return { ok: true, value: JSON.parse(answer.body.toString("utf8")) as unknown };
  } catch {
    // The daemon took the request and said so, but not what it did: the outcome is unknown.
    return {
      ok: false,
      error: "The daemon's answer wasn't understood.",
      status: answer.status,
      lost: true,
    };
  }
};

/** A remote image or video the daemon fetched: only MP4, WebM and raster images, by their bytes. */
const mediaBytes = async (path: string): Promise<Result<Bytes>> => {
  const answer = await exchange(current(), "GET", path, undefined, 30_000, mediaLimit + 1024);
  if ("failed" in answer) return unreached(answer);
  if (answer.status !== 200) return failure(answer);
  const mime = mediaType(answer.body);
  return mime
    ? { ok: true, value: { mime, data: new Uint8Array(answer.body) } }
    : { ok: false, error: "That isn't media the app shows." };
};

const bytes = async (path: string): Promise<Result<Bytes>> => {
  const answer = await exchange(
    current(),
    "GET",
    path,
    undefined,
    20_000,
    imageLimits.bytes + 1024,
  );
  if ("failed" in answer) return unreached(answer);
  if (answer.status !== 200) return failure(answer);
  // Only the four raster types, by their bytes, whatever the daemon labelled them.
  const info = imageInfo(answer.body);
  if (!info || info.mime === "image/tiff")
    return { ok: false, error: "That isn't an image the app shows." };
  return { ok: true, value: { mime: info.mime, data: new Uint8Array(answer.body) } };
};

// Overlapping reads of the same thing share one request.
const flights = new Map<string, Promise<unknown>>();
const coalesce = (key: string, read: () => Promise<unknown>) => {
  const known = flights.get(key);
  if (known) return known;
  const flight = read().finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
};

const segment = (value: string) => encodeURIComponent(value);

// Sends: an ID-only record is saved before every POST, so a lost answer is looked up, never resent.

const attemptsFile = () => join(app.getPath("userData"), "sends.json");
// Message IDs whose POST is still out.
const posting = new Set<string>();

const isAttempt = (value: unknown): value is Attempt =>
  isRecord(value) &&
  typeof value.dot === "string" &&
  typeof value.sessionID === "string" &&
  typeof value.messageID === "string" &&
  typeof value.createdAt === "number";

const readAttempts = (): Attempt[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(attemptsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isAttempt) : [];
  } catch {
    return [];
  }
};

/** Replaces the record atomically and durably; a failure throws, so nothing is sent. */
const writeAttempts = (attempts: Attempt[]) => {
  mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${attemptsFile()}.${process.pid}.tmp`;
  const handle = openSync(temporary, "w", 0o600);
  try {
    writeSync(handle, JSON.stringify(attempts));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, attemptsFile());
};

// Sends with a known outcome whose records couldn't be removed yet: never reconciled or offered
// again, and removed by the next write that succeeds. After a restart a leftover record is
// reconciled by its receipt instead.
const retired = new Set<string>();

/** Every record still open, without those already settled. */
const openAttempts = () => readAttempts().filter((attempt) => !retired.has(attempt.messageID));

/**
 * Retires a send whose outcome is known. Never throws: the outcome stands even if the record file
 * can't be written, and the record stays for later cleanup.
 */
const retire = (messageID: string) => {
  retired.add(messageID);
  try {
    const attempts = readAttempts();
    if (attempts.some((attempt) => retired.has(attempt.messageID)))
      writeAttempts(attempts.filter((attempt) => !retired.has(attempt.messageID)));
    retired.clear();
  } catch {
    // Kept in `retired`; the next successful write drops it.
  }
};

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const isName = (value: unknown): value is string => isText(value, 255) && value.length > 0;
const isID = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const validImage = (image: unknown): image is DraftImage => {
  if (!isRecord(image)) return false;
  const { mime, name, data } = image;
  return (
    data instanceof Uint8Array &&
    isName(name) &&
    imageProblem(data, 0) === undefined &&
    imageInfo(data)?.mime === mime
  );
};

const refused = (error: string): SendResult => ({ outcome: "refused", error });

/** Whether this daemon's latest page says it takes the app's own message IDs. */
const takesClientIDs = (target: Endpoint, page: Result<unknown>) => {
  if (!page.ok || keyOf(target) !== endpointKey) return;
  const key = keyOf(target);
  if (isRecord(page.value) && page.value.clientMessageIDs === true && distrusted !== key)
    capable = key;
  else if (capable === key) capable = undefined;
};

const messageIDPattern = /^msg_[\w-]{1,100}$/;

const send = async (input: unknown): Promise<SendResult> => {
  if (!isRecord(input)) return refused("Bad send.");
  const { dot, sessionID, text, replyTo, feed, images } = input;
  if (
    !isName(dot) ||
    !isName(sessionID) ||
    !isText(text, 1_000_000) ||
    (replyTo !== undefined && !isName(replyTo)) ||
    (feed !== undefined && (!isID(feed) || replyTo !== undefined)) ||
    !Array.isArray(images) ||
    images.length > imageLimits.count ||
    !images.every(validImage)
  )
    return refused("That message can't be sent.");
  const target = current();
  if (!target) return refused("open-dot's daemon isn't running.");
  const key = keyOf(target);
  // Only to a daemon this one discovery verified: a restarted, older one would ignore the app's ID.
  if (capable !== key && distrusted !== key)
    takesClientIDs(
      target,
      await json("GET", `/dots/${segment(dot)}/messages?limit=1`, undefined, 10_000, target),
    );
  if (capable !== key)
    return refused(
      "This daemon can't confirm the app's sends. Update and restart open-dot's daemon.",
    );
  const messageID = SessionMessage.ID.create();
  const attempt = { dot, sessionID, messageID, createdAt: Date.now() };
  // While the POST is out, receipts can't retire its record: only this send, once it has an
  // outcome, settles it or hands it on to reconcile.
  posting.add(messageID);
  try {
    try {
      writeAttempts([...openAttempts(), attempt]);
      retired.clear();
    } catch {
      return refused("Couldn't save the send record, so nothing was sent.");
    }
    let outcome: SendResult;
    try {
      outcome = await post(target, key, attempt, text, replyTo, feed, images);
    } catch {
      // Whatever failed, the POST may have reached the daemon: the record stays to reconcile.
      return {
        outcome: "unknown",
        id: messageID,
        error: "The app lost track of this send.",
      };
    }
    if (outcome.outcome !== "unknown") return outcome;
    // The answer was lost: ask about this ID at once, which settles it if the daemon has it.
    const status = await receipt(attempt).catch((): Result<ReceiptStatus> => ({
      ok: false,
      error: "No receipt.",
    }));
    if (!status.ok || !settled(status.value)) return outcome;
    if (status.value === "cancelled")
      return refused(
        "open-dot cancelled a message it hadn't confirmed, so it wasn't sent. It's still in the message box.",
      );
    return {
      outcome: "saved",
      id: messageID,
      ...(status.value === "held"
        ? { warning: "open-dot has the message and is holding it until the dot can take it." }
        : {}),
    };
  } finally {
    posting.delete(messageID);
  }
};

const post = async (
  target: Endpoint,
  key: string,
  { dot, sessionID, messageID }: Attempt,
  text: string,
  replyTo: string | undefined,
  feed: number | undefined,
  images: DraftImage[],
): Promise<SendResult> => {
  const result = await json(
    "POST",
    `/dots/${segment(dot)}/messages`,
    {
      text,
      messageID,
      sessionID,
      ...(replyTo ? { replyTo } : {}),
      ...(feed !== undefined ? { feed } : {}),
      ...(images.length
        ? {
            files: images.map((image) => ({
              mime: image.mime,
              name: displayName(image.name, image.mime),
              data: Buffer.from(image.data).toString("base64"),
            })),
          }
        : {}),
    },
    60_000,
    target,
  );
  // Only an answer that says what happened settles the record; anything else stays to reconcile.
  if (!result.ok) {
    if (sendOutcome(result) === "unknown")
      return { outcome: "unknown", id: messageID, error: result.error };
    retire(messageID);
    return refused(result.error);
  }
  const saved = isRecord(result.value) ? result.value.id : undefined;
  if (saved === messageID) {
    retire(messageID);
    return { outcome: "saved", id: messageID };
  }
  if (typeof saved === "string" && messageIDPattern.test(saved)) {
    // It saved the message under an ID of its own, so the app's ID tracks nothing: the message is
    // there, and the app sends nothing more to this daemon.
    retire(messageID);
    distrusted = key;
    capable = undefined;
    return {
      outcome: "saved",
      id: saved,
      warning:
        "open-dot's daemon saved this message without the app's ID, so the app stopped sending. Update and restart open-dot's daemon.",
    };
  }
  return {
    outcome: "unknown",
    id: messageID,
    error: "open-dot's answer didn't say which message it saved.",
  };
};

const receipts: readonly unknown[] = [
  "sending",
  "confirming",
  "sent",
  "delivered",
  "held",
  "cancelled",
  "unknown",
] satisfies ReceiptStatus[];
const isReceipt = (value: unknown): value is ReceiptStatus => receipts.includes(value);

// The last receipts that settled a record, by message ID, so every surface that asks after one
// learns its outcome even once another surface's read retired its record. Bounded and in memory.
const outcomes = new Map<string, ReceiptStatus>();
const outcomeLimit = 1000;

/** The daemon's receipt for a saved attempt, dropping the record once the daemon has it. */
const receipt = async (attempt: Attempt): Promise<Result<ReceiptStatus>> => {
  const result = await json(
    "GET",
    `/dots/${segment(attempt.dot)}/pending/${segment(attempt.messageID)}?sessionID=${segment(attempt.sessionID)}`,
  );
  if (!result.ok) return result;
  const status = isRecord(result.value) ? result.value.status : undefined;
  if (!isReceipt(status)) return { ok: false, error: "The daemon's receipt wasn't understood." };
  if (settled(status)) {
    outcomes.delete(attempt.messageID);
    outcomes.set(attempt.messageID, status);
    for (const old of outcomes.keys()) {
      if (outcomes.size <= outcomeLimit) break;
      outcomes.delete(old);
    }
    retire(attempt.messageID);
  }
  return { ok: true, value: status };
};

/** Sends whose answer is lost, not those whose POST is still out. */
const unresolved = () => openAttempts().filter((attempt) => !posting.has(attempt.messageID));

const reconcile = async (input: unknown): Promise<Result<ReceiptStatus>> => {
  const messageID = isRecord(input) ? input.messageID : undefined;
  const attempt = unresolved().find((known) => known.messageID === messageID);
  if (attempt) return receipt(attempt);
  const known = typeof messageID === "string" ? outcomes.get(messageID) : undefined;
  return { ok: true, value: known ?? "unknown" };
};

interface Authoritative {
  id: string;
  sessionID: string;
  text: string;
  // The images among its attachments, by index.
  images: number[];
}

/** The message as the daemon has it now, in the session the owner saw it in. */
const readMessage = async (
  dot: string,
  id: string,
  sessionID: string,
): Promise<Result<Authoritative>> => {
  const read = await json(
    "GET",
    `/dots/${segment(dot)}/messages/${segment(id)}?sessionID=${segment(sessionID)}`,
  );
  if (!read.ok) return read;
  const { value } = read;
  if (!isRecord(value) || value.id !== id || value.sessionID !== sessionID)
    return { ok: false, error: "The daemon's message wasn't understood." };
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  return {
    ok: true,
    value: {
      id,
      sessionID,
      text: typeof value.text === "string" ? value.text : "",
      images: attachments.flatMap((item) =>
        isRecord(item) &&
        isIndex(item.index) &&
        typeof item.mime === "string" &&
        isImageType(item.mime)
          ? [item.index]
          : [],
      ),
    },
  };
};

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const exportLimit = 10;

/** Every image of the message, or a failure if any one can't be read: never a partial set. */
const messageImages = async (
  dot: string,
  message: Authoritative,
  verb: string,
): Promise<Result<Bytes[]>> => {
  if (message.images.length > exportLimit)
    return {
      ok: false,
      error: `This message has more than ${exportLimit} images, so nothing was ${verb}.`,
    };
  const images: Bytes[] = [];
  for (const index of message.images) {
    const read = await bytes(
      `/dots/${segment(dot)}/messages/${segment(message.id)}/attachments/${index}?sessionID=${segment(message.sessionID)}`,
    );
    if (!read.ok) return { ok: false, error: `Couldn't load every image, so nothing was ${verb}.` };
    images.push(read.value);
  }
  return { ok: true, value: images };
};

const writeClipboardText = async (text: string) => {
  if (smoke) recorded.clipboard.push({ text });
  else await clipboard.writeText(text);
};

/** Copies the message's text, or for an image-only message every image, all at once. */
const copyMessage = async (dot: string, id: string, sessionID: string): Promise<Result<true>> => {
  const message = await readMessage(dot, id, sessionID);
  if (!message.ok) return message;
  if (message.value.text) {
    await writeClipboardText(message.value.text);
    return { ok: true, value: true };
  }
  if (!message.value.images.length) return { ok: false, error: "There's nothing to copy." };
  const images = await messageImages(dot, message.value, "copied");
  if (!images.ok) return images;
  const pngs = images.value.map((image) => nativeImage.createFromBuffer(Buffer.from(image.data)));
  if (pngs.some((image) => image.isEmpty()))
    return { ok: false, error: "Couldn't read every image, so nothing was copied." };
  if (smoke) recorded.clipboard.push({ images: pngs.length });
  else
    await clipboard.write(
      pngs.map(
        (image) =>
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }),
          }),
      ),
    );
  return { ok: true, value: true };
};

// Shared images go in a private temporary directory, removed after a while and on quit.
const shares = new Set<string>();
const removeShare = (directory: string) => {
  rmSync(directory, { recursive: true, force: true });
  shares.delete(directory);
};

const present = (texts: string[], filePaths: string[], directory?: string) => {
  if (smoke)
    recorded.shares.push({
      texts: texts.length,
      files: filePaths.length,
      directory: directory ?? "",
    });
  else if (window) new ShareMenu({ texts, filePaths }).popup({ window });
};

/** Shares the text and every image, or nothing if any image fails to load. */
const shareMessage = async (dot: string, id: string, sessionID: string): Promise<Result<true>> => {
  const message = await readMessage(dot, id, sessionID);
  if (!message.ok) return message;
  const texts = message.value.text ? [message.value.text] : [];
  if (!texts.length && !message.value.images.length)
    return { ok: false, error: "There's nothing to share." };
  const images = await messageImages(dot, message.value, "shared");
  if (!images.ok) return images;
  if (!images.value.length) {
    present(texts, []);
    return { ok: true, value: true };
  }
  const directory = mkdtempSync(join(tmpdir(), "open-dot-share-"));
  shares.add(directory);
  setTimeout(() => removeShare(directory), 10 * 60_000).unref();
  let filePaths: string[];
  try {
    filePaths = images.value.map((image, index) => {
      const path = join(directory, `image-${index + 1}.${image.mime.split("/")[1]}`);
      writeFileSync(path, image.data, { mode: 0o600 });
      return path;
    });
  } catch {
    removeShare(directory);
    return { ok: false, error: "Couldn't prepare the images, so nothing was shared." };
  }
  present(texts, filePaths, directory);
  return { ok: true, value: true };
};

/** Validates an attached image in main; a pasted TIFF becomes a PNG within the same limits. */
const ingest = (input: unknown): Result<DraftImage> => {
  if (!isRecord(input)) return { ok: false, error: "Bad image." };
  const { name, data } = input;
  if (!(data instanceof Uint8Array) || !isText(name, 1024))
    return { ok: false, error: "Bad image." };
  const problem = imageProblem(data, 0);
  if (problem) return { ok: false, error: problem };
  const info = imageInfo(data);
  if (!info) return { ok: false, error: "Unsupported image." };
  if (info.mime !== "image/tiff")
    return {
      ok: true,
      value: {
        mime: info.mime,
        name: displayName(name, info.mime),
        data,
        width: info.width,
        height: info.height,
      },
    };
  const png = nativeImage.createFromBuffer(Buffer.from(data));
  if (png.isEmpty()) return { ok: false, error: "That TIFF image couldn't be read." };
  const converted = new Uint8Array(png.toPNG());
  const again = imageProblem(converted, 0);
  if (again) return { ok: false, error: again };
  const size = png.getSize();
  return {
    ok: true,
    value: {
      mime: "image/png",
      name: displayName(name.replace(/\.tiff?$/i, ".png"), "image/png"),
      data: converted,
      width: size.width,
      height: size.height,
    },
  };
};

const openLink = async (raw: unknown) => {
  const url = safeExternalURL(raw);
  if (!url) return false;
  if (smoke) recorded.openExternal.push(url);
  else await shell.openExternal(url, { activate: true });
  return true;
};

// The daemon's other surfaces: each operation the renderer names becomes one request main builds
// from checked arguments. A 409 keeps the daemon's `current` value; a 204 is success.

/** One request whose answer keeps a conflict's current value and treats an empty success as done. */
const reply = async (
  method: string,
  path: string,
  body?: unknown,
  timeout?: number,
  limit?: number,
): Promise<Reply<unknown>> => {
  const answer = await exchange(current(), method, path, body, timeout, limit);
  if ("failed" in answer) return unreached(answer);
  if (answer.status >= 200 && answer.status < 300) {
    if (answer.status === 204 || answer.body.length === 0) return { ok: true, value: true };
    try {
      return { ok: true, value: JSON.parse(answer.body.toString("utf8")) as unknown };
    } catch {
      return {
        ok: false,
        error: "The daemon's answer wasn't understood.",
        status: answer.status,
        lost: true,
      };
    }
  }
  const failed = failure(answer);
  if (answer.status !== 409) return failed;
  try {
    const parsed: unknown = JSON.parse(answer.body.toString("utf8"));
    if (isRecord(parsed) && "current" in parsed) return { ...failed, current: parsed.current };
  } catch {}
  return failed;
};

const isVersion = (value: unknown): value is number => isID(value);
const isQuery = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const isMessageID = (value: unknown): value is string =>
  typeof value === "string" && /^msg_[\w-]{1,100}$/.test(value);
const isRevision = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const memoryText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2000;
const optionalID = (value: unknown) => value === null || isID(value);

interface Built {
  method: string;
  path: string;
  body?: unknown;
  timeout?: number;
}

/** The request for an operation, or undefined when its arguments aren't what it takes. */
const build = (op: Operation, args: unknown[]): Built | undefined => {
  const [dot, a, b, c] = args;
  const base = isName(dot) ? `/dots/${segment(dot)}` : undefined;
  const memory = base && `${base}/memory`;
  switch (op) {
    case "feed":
      return { method: "GET", path: "/feed" };
    case "dismiss":
      return isID(dot) ? { method: "POST", path: `/feed/${dot}/dismiss` } : undefined;
    case "dismissAll":
      return Array.isArray(dot) && dot.length > 0 && dot.length <= 1000 && dot.every(isID)
        ? { method: "POST", path: "/feed/dismiss", body: { ids: dot } }
        : undefined;
    case "health":
      return { method: "GET", path: "/health", timeout: 30_000 };
    case "slackLogin":
      return { method: "POST", path: "/slack/login", body: {}, timeout: 30_000 };
  }
  if (!base || !memory) return undefined;
  switch (op) {
    case "memory":
      return { method: "GET", path: memory };
    case "observations":
      return isID(a) ? { method: "GET", path: `${memory}/observations?before=${a}` } : undefined;
    case "observationSource":
      return isID(a) && isMessageID(b)
        ? { method: "GET", path: `${memory}/observations/${a}/sources/${segment(b)}` }
        : undefined;
    case "noteSource":
      return isID(a)
        ? { method: "GET", path: `${memory}/notes/${a}/source`, timeout: 30_000 }
        : undefined;
    case "recall":
      return isQuery(a) && isOffset(b)
        ? { method: "GET", path: `${memory}/recall?q=${segment(a.trim())}&offset=${b}` }
        : undefined;
    case "searchNotes":
      return isQuery(a)
        ? { method: "GET", path: `${memory}/search?q=${segment(a.trim())}&limit=20` }
        : undefined;
    case "archived":
      return isMessageID(a) && isOffset(b)
        ? { method: "GET", path: `${memory}/archive/${segment(a)}?offset=${b}` }
        : undefined;
    case "archiveStatus":
      return { method: "GET", path: `${memory}/archive` };
    case "runs":
      return isID(a) && optionalID(b)
        ? {
            method: "GET",
            path: `${memory}/responsibilities/${a}/runs${b === null ? "" : `?before=${b}`}`,
          }
        : undefined;
    case "requests":
      return optionalID(a)
        ? { method: "GET", path: `${base}/requests${a === null ? "" : `?before=${a}`}` }
        : undefined;
    case "addNote":
      return memoryText(a)
        ? { method: "POST", path: `${memory}/notes`, body: { text: a } }
        : undefined;
    case "addObservation":
      return memoryText(a)
        ? { method: "POST", path: `${memory}/observations`, body: { text: a } }
        : undefined;
    case "editNote":
    case "editObservation":
      return isID(a) && isVersion(b) && memoryText(c)
        ? {
            method: "PATCH",
            path: `${memory}/${op === "editNote" ? "notes" : "observations"}/${a}`,
            body: { version: b, text: c },
          }
        : undefined;
    case "deleteNote":
    case "cancelReminder":
      return isID(a) && isVersion(b)
        ? {
            method: "DELETE",
            path: `${memory}/${op === "deleteNote" ? "notes" : "reminders"}/${a}?version=${b}`,
          }
        : undefined;
    case "forgetObservation":
      return isID(a) && isVersion(b) && typeof c === "boolean"
        ? {
            method: "DELETE",
            path: `${memory}/observations/${a}?version=${b}${c ? "&sources=true" : ""}`,
          }
        : undefined;
    case "editResponsibility": {
      if (!isID(a) || !isVersion(b) || !isRecord(c)) return undefined;
      const change: Record<string, string> = {};
      for (const [key, value] of Object.entries(c)) {
        if (!["goal", "nextAction", "status"].includes(key) || !memoryText(value)) return undefined;
        change[key] = value;
      }
      if (!Object.keys(change).length) return undefined;
      return {
        method: "PATCH",
        path: `${memory}/responsibilities/${a}`,
        body: { version: b, ...change },
      };
    }
    case "editReminder": {
      if (!isID(a) || !isVersion(b) || !isRecord(c)) return undefined;
      const change: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(c)) {
        if (key === "dueAt" && typeof value === "number" && Number.isSafeInteger(value))
          change.dueAt = value;
        else if (key === "everyMinutes" && (value === null || isID(value)))
          change.everyMinutes = value;
        else return undefined;
      }
      if (!Object.keys(change).length) return undefined;
      return { method: "PATCH", path: `${memory}/reminders/${a}`, body: { version: b, ...change } };
    }
    case "deleteArchived":
      return isMessageID(a)
        ? { method: "DELETE", path: `${memory}/archive/${segment(a)}` }
        : undefined;
    case "approveWatch":
      return isID(a) ? { method: "POST", path: `${memory}/supervisions/${a}/approve` } : undefined;
    case "endWatch":
      return isID(a) ? { method: "DELETE", path: `${memory}/supervisions/${a}` } : undefined;
    case "revokeGrant":
      return isID(a) ? { method: "DELETE", path: `${memory}/grants/${a}` } : undefined;
    case "createTrigger": {
      if (!isRecord(a)) return undefined;
      const { responsibility, repository, reasons, task } = a;
      return isID(responsibility) &&
        isText(repository, 200) &&
        Array.isArray(reasons) &&
        reasons.length <= 10 &&
        reasons.every((reason) => isText(reason, 64)) &&
        memoryText(task)
        ? {
            method: "POST",
            path: `${memory}/triggers`,
            body: { responsibility, repository, reasons, task },
          }
        : undefined;
    }
    case "previewTrigger":
      return isID(a) ? { method: "GET", path: `${memory}/triggers/${a}/preview` } : undefined;
    case "enableTrigger":
      return isID(a) && isRevision(b)
        ? { method: "POST", path: `${memory}/triggers/${a}/enable`, body: { revision: b } }
        : undefined;
    case "pauseTrigger":
      return isID(a) ? { method: "POST", path: `${memory}/triggers/${a}/pause` } : undefined;
    case "revokeTrigger":
      return isID(a) ? { method: "DELETE", path: `${memory}/triggers/${a}` } : undefined;
    case "instructions":
      return { method: "GET", path: `${base}/instructions` };
    case "saveInstructions":
      return typeof a === "string" && Buffer.byteLength(a, "utf8") <= 64 * 1024 && isRevision(b)
        ? { method: "PUT", path: `${base}/instructions`, body: { content: a, revision: b } }
        : undefined;
    case "revertInstructions":
      return isRevision(a)
        ? { method: "POST", path: `${base}/instructions/revert`, body: { revision: a } }
        : undefined;
    case "library":
      return optionalID(a)
        ? { method: "GET", path: `${base}/library${a === null ? "" : `?before=${a}`}` }
        : undefined;
    case "slack":
      return { method: "GET", path: `${base}/slack` };
    case "slackConnect":
      return typeof a === "boolean"
        ? { method: "POST", path: `${base}/slack/connect`, body: a ? { retry: true } : {} }
        : undefined;
    case "slackAttach":
      return isSlackAppID(a)
        ? { method: "POST", path: `${base}/slack/attach`, body: { appID: a } }
        : undefined;
    case "slackInstall":
      return { method: "POST", path: `${base}/slack/install`, body: {} };
    case "slackUpdate":
      return a === null ||
        (Array.isArray(a) && a.length <= 20 && a.every((change) => isText(change, 4000)))
        ? {
            method: "POST",
            path: `${base}/slack/update`,
            body: a === null ? {} : { approve: a },
            timeout: 60_000,
          }
        : undefined;
    case "slackIcon":
      return { method: "POST", path: `${base}/slack/icon`, body: {} };
    case "slackDMCheck":
      return { method: "POST", path: `${base}/slack/dm-check`, body: {} };
    case "activity":
      return isName(a)
        ? { method: "GET", path: `${base}/activity?sessionID=${segment(a)}`, timeout: 5_000 }
        : undefined;
    case "work":
      return isName(a) && isText(b, cursorLimit)
        ? { method: "GET", path: `${base}/work?sessionID=${segment(a)}&cursor=${segment(b)}` }
        : undefined;
    case "toolDetail":
      return isName(a) && isName(b) && isName(c)
        ? {
            method: "GET",
            path: `${base}/messages/${segment(a)}/tools/${segment(c)}?sessionID=${segment(b)}`,
          }
        : undefined;
    case "fresh":
      return typeof a === "boolean"
        ? {
            method: "POST",
            path: `${base}/fresh`,
            body: a ? { force: true } : {},
            timeout: 120_000,
          }
        : undefined;
  }
  return undefined;
};

const operationNames = new Set<string>([
  "feed",
  "dismiss",
  "dismissAll",
  "memory",
  "observations",
  "observationSource",
  "noteSource",
  "recall",
  "searchNotes",
  "archived",
  "archiveStatus",
  "runs",
  "requests",
  "addNote",
  "editNote",
  "deleteNote",
  "editResponsibility",
  "editReminder",
  "cancelReminder",
  "addObservation",
  "editObservation",
  "forgetObservation",
  "deleteArchived",
  "approveWatch",
  "endWatch",
  "revokeGrant",
  "createTrigger",
  "previewTrigger",
  "enableTrigger",
  "pauseTrigger",
  "revokeTrigger",
  "instructions",
  "saveInstructions",
  "revertInstructions",
  "library",
  "health",
  "slack",
  "slackConnect",
  "slackAttach",
  "slackInstall",
  "slackUpdate",
  "slackIcon",
  "slackDMCheck",
  "slackLogin",
  "fresh",
  "activity",
  "work",
  "toolDetail",
] satisfies Operation[]);

const isOperation = (value: unknown): value is Operation =>
  typeof value === "string" && operationNames.has(value);

// Overlapping reads of the same thing share one request.
const readFlights = new Map<string, Promise<Reply<unknown>>>();

/** Never retried: a mutation whose answer was lost is reported as unknown for the owner to check. */
const operate = (op: unknown, ...args: unknown[]): Promise<Reply<unknown>> | Reply<unknown> => {
  if (!isOperation(op)) return { ok: false, error: "That isn't something the app does." };
  const built = build(op, args);
  if (!built) return { ok: false, error: "That request isn't valid." };
  if (built.method === "GET") {
    const known = readFlights.get(built.path);
    if (known) return known;
    const flight = reply("GET", built.path, undefined, built.timeout)
      .then((result) => decoded(op, "GET", result))
      .finally(() => readFlights.delete(built.path));
    readFlights.set(built.path, flight);
    return flight;
  }
  return reply(built.method, built.path, built.body, built.timeout).then((result) =>
    decoded(op, built.method, result),
  );
};

// Secrets: typed in a secure field or picked up from the clipboard, sent once to the daemon and
// never kept, logged, journaled or retried. The words of a failure never repeat one.

const secretWords = "The daemon refused it, and the app kept nothing.";

const sendSecret = async (
  path: string,
  body: Record<string, string>,
  values: string[],
): Promise<Reply<unknown>> => {
  const result = await reply("POST", path, body, 30_000);
  // Only main's references go; JavaScript can't promise the memory is erased.
  for (const key of Object.keys(body)) body[key] = "";
  if (result.ok) return result;
  if (values.some((value) => value && result.error.includes(value)))
    return { ok: false, error: secretWords, ...(result.status ? { status: result.status } : {}) };
  return result;
};

const isSecret = (value: unknown, max = 1024): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const secret = (input: unknown): Promise<Reply<unknown>> | Reply<unknown> => {
  if (!isRecord(input)) return { ok: false, error: "That request isn't valid." };
  switch (input.kind) {
    case "slackToken": {
      const { dot, token, value } = input;
      if (!isName(dot) || (token !== "bot" && token !== "app") || !isSecret(value)) break;
      return sendSecret(
        `/dots/${segment(dot)}/slack/tokens`,
        { kind: token, token: value.trim() },
        [value.trim()],
      );
    }
    case "slackConfig": {
      const { token, refreshToken } = input;
      if (!isSecret(token) || !isSecret(refreshToken)) break;
      return sendSecret(
        "/slack/config",
        { token: token.trim(), refreshToken: refreshToken.trim() },
        [token.trim(), refreshToken.trim()],
      );
    }
    case "slackLink": {
      const { dot, bot, app: appToken, replaceAppID } = input;
      if (
        !isName(dot) ||
        !isSecret(bot) ||
        !isSecret(appToken) ||
        (replaceAppID !== undefined && !isSlackAppID(replaceAppID))
      )
        break;
      return sendSecret(
        `/dots/${segment(dot)}/slack/link`,
        { bot: bot.trim(), app: appToken.trim(), ...(replaceAppID ? { replaceAppID } : {}) },
        [bot.trim(), appToken.trim()],
      );
    }
    case "slackChallenge": {
      const { attempt, challenge } = input;
      if (!isText(attempt, 200) || !/^[\w-]{1,200}$/.test(attempt) || !isSecret(challenge, 128))
        break;
      return sendSecret(`/slack/login/${segment(attempt)}`, { challenge: challenge.trim() }, [
        challenge.trim(),
      ]);
    }
  }
  return { ok: false, error: "That request isn't valid." };
};

// Clipboard pickup. Electron can't read the clipboard's change count, so a small helper does,
// over its own pipes; in the smoke test a fake stands in, so tests never touch the real one.

const fakeClipboard = {
  revision: 0,
  text: "" as string | undefined,
  reads: 0,
  clears: 0,
  // While set, a read or clear of that kind waits until the test lets it go, as a slow helper would.
  hold: null as "text" | "clear" | null,
  held: 0,
};
const releaseClipboard: (() => void)[] = [];
const clipboardWait = async (kind: "text" | "clear") => {
  if (fakeClipboard.hold !== kind) return;
  fakeClipboard.held++;
  await new Promise<void>((done) => releaseClipboard.push(done));
};

const smokeClipboard: Clipboard = {
  revision: async () => fakeClipboard.revision,
  text: async (revision) => {
    fakeClipboard.reads++;
    const text = revision === fakeClipboard.revision ? fakeClipboard.text : null;
    await clipboardWait("text");
    return text;
  },
  clear: async (revision) => {
    await clipboardWait("clear");
    if (revision !== fakeClipboard.revision) return;
    fakeClipboard.text = undefined;
    fakeClipboard.revision++;
    fakeClipboard.clears++;
  },
};

const helperPath = () =>
  join(app.getAppPath(), "clipboard-helper").replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );

// The real helper is started only when a pickup first looks, and stopped on quit.
const nativeClipboard = helperClipboard(() =>
  spawn(helperPath(), [], { stdio: ["pipe", "pipe", "ignore"] }),
);
const stopHelper = nativeClipboard.stop;

const clipboardFor = (): Clipboard => (smoke ? smokeClipboard : nativeClipboard.clipboard);

interface Armed {
  dot: string;
  step: PickupStep;
  /** The app a bot or app-level token must name. */
  appID: string | null;
  /** The dot's app as its Slack view showed it when armed, or null for none. */
  binding: string | null;
  seen: number;
  deadline: number;
  mismatched: boolean;
}

interface Held {
  dot: string;
  step: "access" | "linkBot";
  binding: string | null;
  token: string;
  deadline: number;
  // A picked-up app-level token waiting for the owner to confirm it replaces `replace`.
  app?: string;
  replace?: string;
}

let armed: Armed | undefined;
let held: Held | undefined;
let pickupNotice: { dot: string; text: string } | undefined;
let pickupTimer: ReturnType<typeof setInterval> | undefined;
let pickupBusy = false;
// Every stop, leave and new arm moves this on, so a look begun before it delivers nothing.
let pickupGeneration = 0;
let shownSlack: { dot: string; appID: string | null } | undefined;
let pickupAvailable = true;

const pickupState = (): PickupState => ({
  dot: armed?.dot ?? held?.dot ?? pickupNotice?.dot ?? null,
  step: armed?.step ?? null,
  holding: held && !held.app ? held.step : null,
  mismatched: armed?.mismatched ?? false,
  notice: pickupNotice?.text ?? null,
  replace: held?.replace ?? null,
  available: pickupAvailable,
});

const announce = () => emit({ kind: "pickup", state: pickupState() });

const leftView = "Pickup stopped when you left the dot's Slack view. Nothing was kept.";

/** Whether the Slack view still shows this dot with the app it showed when the pickup began. */
const pinned = (to: { dot: string; binding: string | null }) =>
  shownSlack?.dot === to.dot && shownSlack.appID === to.binding;

/** Why a pickup that's no longer pinned stopped. */
const unpinned = (dot: string) =>
  shownSlack?.dot === dot
    ? "The dot's app changed, so the pickup stopped. Nothing was kept."
    : leftView;

const dropHeld = () => {
  if (held) {
    held.token = "";
    if (held.app) held.app = "";
  }
  held = undefined;
};

/** Ends the pickup and drops a held token, saying why to the dot's view. */
const endPickup = (said?: string) => {
  const dot = armed?.dot ?? held?.dot;
  pickupGeneration++;
  armed = undefined;
  dropHeld();
  if (pickupTimer) clearInterval(pickupTimer);
  pickupTimer = undefined;
  if (dot && said) pickupNotice = { dot, text: said };
  announce();
};

/** Sends what a pickup took, once, and says what became of it. */
const deliverPickup = async (dot: string, run: () => Promise<Reply<unknown>>, what: string) => {
  pickupBusy = true;
  const result = await run().finally(() => {
    pickupBusy = false;
  });
  pickupNotice = {
    dot,
    text: result.ok
      ? `${what} sent to the daemon once. Saved isn't connected: this view says Connected only once the daemon checked it.`
      : result.lost
        ? `Couldn't confirm the daemon got the ${what.toLowerCase()}. It isn't sent again: check this view, and save it again if needed.`
        : `Not saved: ${result.error}`,
  };
  announce();
};

/** One look at the clipboard for the armed pickup: each new copy is read once, after arming. */
const checkPickup = async () => {
  const now = Date.now();
  if (held) {
    if (!pinned(held)) return endPickup(unpinned(held.dot));
    if (now >= held.deadline)
      return endPickup(
        held.step === "linkBot"
          ? "The app-level token wasn't picked up within 2 minutes, so the bot token was dropped. Nothing was saved."
          : "The refresh token wasn't picked up within 2 minutes, so the access token was dropped. Nothing was saved.",
      );
  }
  const pickup = armed;
  if (!pickup || pickupBusy) return;
  if (!pinned(pickup)) return endPickup(unpinned(pickup.dot));
  if (now >= pickup.deadline)
    return endPickup(
      `No ${pickupNames[pickup.step]} was copied within 2 minutes, so the pickup stopped. Nothing was kept.`,
    );
  pickupBusy = true;
  const look = pickupGeneration;
  // Whether this look still stands after an await: no stop, leave, new arm, app change or
  // timeout came meanwhile. A secret read once it doesn't is dropped, never held or sent.
  const stands = () =>
    look === pickupGeneration && armed === pickup && pinned(pickup) && Date.now() < pickup.deadline;
  try {
    const board = clipboardFor();
    const revision = await board.revision();
    if (!stands()) return;
    if (revision === undefined) {
      pickupAvailable = false;
      return endPickup(
        "The app can't watch the clipboard here, so pickup is off. Use the secure fields.",
      );
    }
    if (revision === pickup.seen) return;
    pickup.seen = revision;
    const copied = await board.text(revision);
    if (!stands() || copied === null) return;
    if (copied === undefined || !tokenMatches(pickup.step, copied, pickup.appID ?? undefined)) {
      pickup.mismatched = true;
      announce();
      return;
    }
    await board.clear(revision);
    if (!stands()) return;
    armed = undefined;
    if (pickupTimer && !held && pickup.step !== "access" && pickup.step !== "linkBot") {
      clearInterval(pickupTimer);
      pickupTimer = undefined;
    }
    const dot = pickup.dot;
    switch (pickup.step) {
      case "access":
      case "linkBot":
        held = {
          dot,
          step: pickup.step,
          binding: pickup.binding,
          token: copied,
          deadline: now + pickupMilliseconds,
        };
        pickupNotice = {
          dot,
          text:
            pickup.step === "access"
              ? "Access token picked up and held in the app's memory only. Pick up the refresh token within 2 minutes; nothing is saved until both are."
              : "Bot token picked up and held in the app's memory only. Pick up the app-level token within 2 minutes; nothing is saved until both are.",
        };
        announce();
        return;
      case "refresh": {
        const first = held;
        if (!first || first.dot !== dot || first.step !== "access" || !pinned(first))
          return endPickup();
        const token = first.token;
        endPickup();
        pickupBusy = false;
        return deliverPickup(
          dot,
          () => sendSecret("/slack/config", { token, refreshToken: copied }, [token, copied]),
          "Configuration token pair",
        );
      }
      case "linkApp": {
        const first = held;
        if (!first || first.dot !== dot || first.step !== "linkBot" || !pinned(first))
          return endPickup();
        const view = await reply("GET", `/dots/${segment(dot)}/slack`);
        if (look !== pickupGeneration || held !== first) return;
        if (!pinned(first)) return endPickup(unpinned(dot));
        const bound =
          view.ok && isRecord(view.value) && isRecord(view.value.app) ? view.value.app : undefined;
        // The daemon's app now, whatever its state; one other than shown when armed ends it all.
        const daemonApp = bound && isSlackAppID(bound.appID) ? bound.appID : null;
        const boundID =
          bound &&
          (bound.state === "created" || bound.state === "active") &&
          isSlackAppID(bound.appID)
            ? bound.appID
            : undefined;
        if (!view.ok) {
          endPickup();
          pickupNotice = {
            dot,
            text: "Couldn't read the dot's app, so nothing was saved. Pick up both tokens again.",
          };
          announce();
          return;
        }
        if (daemonApp !== first.binding)
          return endPickup("The dot's app changed, so the pickup stopped. Nothing was kept.");
        if (boundID && linkAppID(copied) !== boundID) {
          // Held until the owner confirms the replacement, within the bot token's own time.
          first.app = copied;
          first.replace = boundID;
          announce();
          return;
        }
        const bot = first.token;
        endPickup();
        pickupBusy = false;
        return deliverPickup(
          dot,
          () => sendSecret(`/dots/${segment(dot)}/slack/link`, { bot, app: copied }, [bot, copied]),
          "App token pair",
        );
      }
      case "bot":
      case "app":
        endPickup();
        pickupBusy = false;
        return deliverPickup(
          dot,
          () =>
            sendSecret(`/dots/${segment(dot)}/slack/tokens`, { kind: pickup.step, token: copied }, [
              copied,
            ]),
          pickup.step === "bot" ? "Bot token" : "App-level token",
        );
    }
  } finally {
    pickupBusy = false;
  }
};

const steps: readonly unknown[] = [
  "access",
  "refresh",
  "bot",
  "app",
  "linkBot",
  "linkApp",
] satisfies PickupStep[];
const isStep = (value: unknown): value is PickupStep => steps.includes(value);

/** Arms the one pickup for this dot's step, replacing any other; only later copies count. */
const armPickup = async (dot: unknown, step: unknown, appID: unknown): Promise<PickupState> => {
  if (step === null) {
    endPickup("Pickup stopped. Nothing was kept.");
    return pickupState();
  }
  if (!isName(dot) || !isStep(step) || !(appID === null || isSlackAppID(appID)))
    return pickupState();
  const chosen = step;
  if (shownSlack?.dot !== dot) return pickupState();
  // Pinned to the app the view shows now: a bot or app-level token must name that same app.
  const pin = { dot, binding: shownSlack.appID };
  // Any look still out for an earlier arm delivers nothing.
  const look = ++pickupGeneration;
  if ((chosen === "bot" || chosen === "app") && (!appID || appID !== pin.binding))
    return pickupState();
  const after = pickupAfter(chosen);
  if (
    after &&
    !(
      held &&
      held.dot === dot &&
      held.binding === pin.binding &&
      held.step === after &&
      !held.app &&
      Date.now() < held.deadline
    )
  ) {
    endPickup();
    pickupNotice = {
      dot,
      text: `Pick up the ${after === "access" ? "access" : "bot"} token first.`,
    };
    announce();
    return pickupState();
  }
  if (!after) dropHeld();
  const revision = await clipboardFor().revision();
  if (look !== pickupGeneration) return pickupState();
  if (!pinned(pin)) {
    endPickup(unpinned(dot));
    return pickupState();
  }
  if (revision === undefined) {
    pickupAvailable = false;
    endPickup("The app can't watch the clipboard here, so pickup is off. Use the secure fields.");
    return pickupState();
  }
  pickupAvailable = true;
  armed = {
    dot,
    step: chosen,
    appID: chosen === "bot" || chosen === "app" ? appID : null,
    binding: pin.binding,
    seen: revision,
    deadline: Date.now() + pickupMilliseconds,
    mismatched: false,
  };
  pickupNotice = undefined;
  if (!pickupTimer) pickupTimer = setInterval(() => void checkPickup(), 250);
  announce();
  return pickupState();
};

const confirmReplace = (dot: unknown, appID: unknown, replace: unknown): PickupState => {
  const first = held;
  if (!first?.app || first.dot !== dot || first.replace !== appID || typeof replace !== "boolean")
    return pickupState();
  if (!pinned(first)) {
    endPickup(unpinned(first.dot));
    return pickupState();
  }
  const bot = first.token;
  const linked = first.app;
  const replaced = first.replace ?? "";
  endPickup();
  if (!replace) {
    pickupNotice = {
      dot: first.dot,
      text: `Nothing was saved. ${first.dot} keeps the app ${replaced}.`,
    };
    announce();
    return pickupState();
  }
  void deliverPickup(
    first.dot,
    () =>
      sendSecret(
        `/dots/${segment(first.dot)}/slack/link`,
        { bot, app: linked, replaceAppID: replaced },
        [bot, linked],
      ),
    "App token pair",
  );
  return pickupState();
};

const slackShown = (dot: unknown, appID: unknown) => {
  shownSlack = isName(dot) && (appID === null || isSlackAppID(appID)) ? { dot, appID } : undefined;
  if (pickupNotice && pickupNotice.dot !== shownSlack?.dot) pickupNotice = undefined;
  // Leaving the view, or the dot's app changing, ends the pickup now, even while a look is out.
  const stopped = (armed && !pinned(armed) && armed) || (held && !pinned(held) && held);
  if (stopped) endPickup(unpinned(stopped.dot));
  else if (armed || held) void checkPickup();
};

// The Library: a file downloads by its ID, checks against the size and digest its listing gave,
// and is offered to save; it's never previewed or opened.

const artifactLimit = 10 * 1024 * 1024;

const exportArtifact = async (
  dot: unknown,
  artifact: unknown,
): Promise<Reply<{ saved: boolean }>> => {
  if (!isName(dot) || !isRecord(artifact))
    return { ok: false, error: "That file can't be exported." };
  const { id, name, size, sha256 } = artifact;
  if (
    !isID(id) ||
    !isText(name, 255) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > artifactLimit ||
    !isRevision(sha256)
  )
    return { ok: false, error: "That file can't be exported." };
  const answer = await exchange(
    current(),
    "GET",
    `/dots/${segment(dot)}/library/${id}/content`,
    undefined,
    60_000,
    size + 1,
  );
  if ("failed" in answer) return unreached(answer);
  if (answer.status !== 200) return failure(answer);
  if (
    answer.body.length !== size ||
    createHash("sha256").update(answer.body).digest("hex") !== sha256
  )
    return {
      ok: false,
      error: "The file didn't match what the Library lists, so nothing was saved.",
    };
  const suggested = name.split(/[\\/]/).at(-1)?.replace(/^\.+/, "") || `deliverable-${id}`;
  if (smoke) {
    recorded.saves.push({ name: suggested, bytes: answer.body.length });
    return { ok: true, value: { saved: true } };
  }
  const chosen = window
    ? await dialog.showSaveDialog(window, { defaultPath: suggested })
    : await dialog.showSaveDialog({ defaultPath: suggested });
  if (chosen.canceled || !chosen.filePath) return { ok: true, value: { saved: false } };
  try {
    writeFileSync(chosen.filePath, answer.body, { mode: 0o600 });
  } catch {
    return { ok: false, error: "Couldn't write the file there, so nothing was saved." };
  }
  return { ok: true, value: { saved: true } };
};

// The window, the menu bar icon and the shortcut.

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

const emit = (event: AppEvent) => window?.webContents.send(eventChannel, event);

const showWindow = () => {
  if (!window || smoke) return;
  window.show();
  window.focus();
  emit({ kind: "shown" });
};

const toggleWindow = () => {
  if (window?.isVisible() && window.isFocused()) window.hide();
  else showWindow();
};

/** A small dot drawn for the menu bar: filled while a dot is busy, a ring otherwise. */
const trayIcon = (busy: boolean) => {
  const size = 36;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5);
      const inside = busy ? distance < 12 : distance < 12 && distance > 8;
      if (inside) pixels.writeUInt32LE(0xff000000, (y * size + x) * 4);
    }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
};

let trayState: TrayState = { busy: false, unread: 0 };
let shortcutRegistered = true;

// OpenCode's background server. The smoke test runs only the absolute fake binary it names, never
// one found on a PATH, so no test reaches the owner's OpenCode.
const named = serviceBinary(process.env);
const loginShell = process.env.SHELL?.trim();
const opencode = serviceControl({
  binary: smoke ? (named.startsWith("/") ? named : undefined) : named,
  shell: smoke ? undefined : loginShell?.startsWith("/") ? loginShell : "/bin/zsh",
  env: process.env,
  onChange: (view) => {
    updateTray();
    emit({ kind: "opencode", view });
  },
});

const asks = {
  restart: {
    message: "Restart OpenCode?",
    detail:
      "Restarting OpenCode's background server interrupts every running session, your dots and their workers included. open-dot reconnects once it's back.",
    button: "Restart OpenCode",
  },
  stop: {
    message: "Stop OpenCode?",
    detail:
      "Stopping OpenCode's background server interrupts every running session, your dots and their workers included, and none runs again until you start it. open-dot reconnects once it's back.",
    button: "Stop OpenCode",
  },
} as const;

/** Runs the owner's OpenCode command, asking first before Restart and Stop. */
const controlOpenCode = async (action: ServiceAction) => {
  if (action !== "status" && opencode.view().busy)
    return { ok: false as const, error: "Another OpenCode command is still running." };
  if (action === "restart" || action === "stop") {
    const ask = asks[action];
    let confirmed: boolean;
    if (smoke) {
      recorded.confirms.push(action);
      confirmed = smokeConfirm;
    } else {
      const options = {
        type: "warning" as const,
        message: ask.message,
        detail: ask.detail,
        buttons: ["Cancel", ask.button],
        defaultId: 0,
        cancelId: 0,
      };
      const parent = window?.isVisible() ? window : undefined;
      const answer = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      confirmed = answer.response === 1;
    }
    if (!confirmed) return { ok: true as const, value: opencode.view() };
  }
  return opencode.run(action);
};

/** The menu bar menu's OpenCode commands: a failure is shown, since the window may be hidden. */
const controlFromMenu = async (action: ServiceAction) => {
  const result = await controlOpenCode(action);
  const last = opencode.view().last;
  const error = !result.ok ? result.error : last && !last.ok ? last.output : undefined;
  if (error && !smoke)
    void dialog.showMessageBox({
      type: "warning",
      message: "OpenCode's command didn't work.",
      detail: error.slice(-1_000),
    });
};

const openCodeItems = (): MenuItemConstructorOptions[] => {
  const view = opencode.view();
  const busy = view.busy !== null;
  const state = view.busy
    ? `OpenCode: ${{ start: "starting", restart: "restarting", stop: "stopping" }[view.busy]}…`
    : `OpenCode: ${{ running: "running", stopped: "stopped", unknown: "not known" }[view.state]}`;
  const last = view.last
    ? `Last ${view.last.action}: ${view.last.ok ? "done" : "failed"}${view.last.output ? ` — ${view.last.output.split("\n")[0]?.slice(0, 60)}` : ""}`
    : undefined;
  return [
    { label: state, enabled: false },
    ...(last ? [{ label: last, enabled: false }] : []),
    {
      label: "Start OpenCode",
      enabled: !busy && view.state !== "running",
      click: () => void controlFromMenu("start"),
    },
    {
      label: "Restart OpenCode…",
      enabled: !busy && view.state !== "stopped",
      click: () => void controlFromMenu("restart"),
    },
    {
      label: "Stop OpenCode…",
      enabled: !busy && view.state !== "stopped",
      click: () => void controlFromMenu("stop"),
    },
  ];
};

const updateTray = () => {
  if (!tray) return;
  tray.setImage(trayIcon(trayState.busy));
  tray.setTitle(trayState.unread ? String(trayState.unread) : "");
  tray.setToolTip(
    `open-dot${trayState.busy ? " — busy" : ""}${trayState.unread ? ` — ${trayState.unread} unread` : ""}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open open-dot", click: showWindow },
      {
        label: shortcutRegistered
          ? "Show or hide: Control-Option-Space"
          : "Control-Option-Space is taken by another app",
        enabled: false,
      },
      { type: "separator" },
      ...openCodeItems(),
      { type: "separator" },
      { label: "Quit open-dot", click: () => app.quit() },
    ]),
  );
};

const createWindow = () => {
  window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: "open-dot",
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161616" : "#ffffff",
    webPreferences: {
      preload: join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: true,
      // The menu bar badges keep updating while the window is hidden.
      backgroundThrottling: false,
    },
  });
  if (smoke) {
    // The smoke test fails if anything tries to show or focus the window.
    for (const name of ["show", "showInactive", "focus", "moveTop"] as const) {
      window[name] = () => {
        if (name === "focus") recorded.focus++;
        else recorded.show++;
      };
    }
    // And if the page asks for anything remote: it must only ever load what main hands it.
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      if (!/^(?:blob|data|devtools):/.test(details.url) && !details.url.startsWith(`${origin}/`))
        recorded.remote.push(details.url);
      else recorded.local++;
      callback({});
    });
  }
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    void openLink(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // A reload or a crashed page loses the view a pickup belongs to.
  contents.on("did-start-loading", () => {
    shownSlack = undefined;
    if (armed || held) endPickup();
  });
  contents.on("render-process-gone", () => {
    shownSlack = undefined;
    endPickup();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  void window.loadURL(`${origin}/index.html`);
  if (!startHidden) contents.once("did-finish-load", showWindow);
  return window;
};

/** Accepts a call only from the app's own page in its main frame. */
const trusted = (event: IpcMainInvokeEvent) =>
  window !== undefined &&
  event.sender === window.webContents &&
  event.senderFrame === window.webContents.mainFrame &&
  event.senderFrame.url.startsWith(`${origin}/`);

const handlers: Record<Channel, (...args: unknown[]) => unknown> = {
  dots: () => coalesce("dots", () => json("GET", "/dots")),
  messages: (dot, before, from) => {
    if (!isName(dot) || (before !== undefined && !isText(before, cursorLimit)))
      return { ok: false, error: "Bad read." };
    const target = current();
    const read = generation;
    // A cursor belongs to the daemon that signed it; after a restart only the latest page reads.
    if (before !== undefined && from !== read)
      return {
        ok: false,
        error: "open-dot restarted, so older messages load again from Back to latest.",
      };
    const query = typeof before === "string" ? `?before=${segment(before)}` : "";
    return coalesce(`messages:${read}:${dot}:${query}`, async () => {
      const startedAt = Date.now();
      const page = await json(
        "GET",
        `/dots/${segment(dot)}/messages${query}`,
        undefined,
        undefined,
        target,
      );
      if (!page.ok) return page;
      if (target) takesClientIDs(target, page);
      if (!isRecord(page.value))
        return { ok: false, error: "The daemon's answer wasn't understood." };
      return { ok: true, value: { ...page.value, generation: read, startedAt } };
    });
  },
  // Never shared with a read already out: a pinned read must begin after the change it checks.
  message: async (dot, id, sessionID) => {
    if (!isName(dot) || !isName(id) || !isName(sessionID)) return { ok: false, error: "Bad read." };
    const read = await json(
      "GET",
      `/dots/${segment(dot)}/messages/${segment(id)}?sessionID=${segment(sessionID)}`,
    );
    if (
      read.ok &&
      (!isRecord(read.value) || read.value.id !== id || read.value.sessionID !== sessionID)
    )
      return { ok: false, error: "The daemon's message wasn't understood." };
    return read;
  },
  send,
  attempts: unresolved,
  reconcile,
  forget: (id) => {
    if (isName(id) && !posting.has(id)) retire(id);
  },
  react: (dot, id, sessionID, emoji) => {
    if (!isName(dot) || !isName(id) || !isName(sessionID) || !(emoji === null || isText(emoji, 64)))
      return { ok: false, error: "Bad reaction." };
    return json("PUT", `/dots/${segment(dot)}/messages/${segment(id)}/reaction`, {
      emoji,
      sessionID,
    });
  },
  hide: (dot, id, sessionID, hidden) => {
    if (!isName(dot) || !isName(id) || !isName(sessionID) || typeof hidden !== "boolean")
      return { ok: false, error: "Bad change." };
    return json("PUT", `/dots/${segment(dot)}/messages/${segment(id)}/hidden`, {
      sessionID,
      hidden,
    });
  },
  pending: (dot, id, change) => {
    if (!isName(dot) || !isName(id) || (change !== "steer" && change !== "cancel"))
      return { ok: false, error: "Bad change." };
    const path = `/dots/${segment(dot)}/pending/${segment(id)}`;
    return change === "steer" ? json("PATCH", path, { delivery: "steer" }) : json("DELETE", path);
  },
  image: (dot, id, sessionID, index) => {
    if (
      !isName(dot) ||
      !isName(id) ||
      !isName(sessionID) ||
      !(Number.isSafeInteger(index) && Number(index) >= 0)
    )
      return { ok: false, error: "Bad image." };
    return bytes(
      `/dots/${segment(dot)}/messages/${segment(id)}/attachments/${Number(index)}?sessionID=${segment(sessionID)}`,
    );
  },
  media: (dot, id, sessionID, mediaID) =>
    isName(dot) &&
    isName(id) &&
    isName(sessionID) &&
    typeof mediaID === "string" &&
    /^[\da-f]{16}$/.test(mediaID)
      ? coalesce(`media\0${dot}\0${sessionID}\0${id}\0${mediaID}`, () =>
          mediaBytes(
            `/dots/${segment(dot)}/messages/${segment(id)}/media/${mediaID}?sessionID=${segment(sessionID)}`,
          ),
        )
      : { ok: false, error: "Bad media." },
  avatar: (dot) =>
    isName(dot) ? bytes(`/dots/${segment(dot)}/avatar`) : { ok: false, error: "Bad dot." },
  ingest,
  openLink,
  copyText: async (text) => {
    if (!isText(text, 1_000_000)) return false;
    await writeClipboardText(text);
    return true;
  },
  shareText: (text) => {
    if (!isText(text, 1_000_000) || !text) return false;
    present([text], []);
    return true;
  },
  copyMessage: (dot, id, sessionID) =>
    isName(dot) && isName(id) && isName(sessionID)
      ? copyMessage(dot, id, sessionID)
      : { ok: false, error: "Bad message." },
  shareMessage: (dot, id, sessionID) =>
    isName(dot) && isName(id) && isName(sessionID)
      ? shareMessage(dot, id, sessionID)
      : { ok: false, error: "Bad message." },
  emojiPanel: () => {
    if (smoke) recorded.emojiPanel++;
    else app.showEmojiPanel();
  },
  openWorker: (id) =>
    isID(id) ? json("POST", `/workers/${id}/open`) : { ok: false, error: "Bad worker." },
  stopWorker: (id) =>
    isID(id)
      ? json("POST", `/workers/${id}/stop`, undefined, 30_000)
      : { ok: false, error: "Bad worker." },
  openRequest: (id) =>
    isID(id) ? json("POST", `/requests/${id}/open`) : { ok: false, error: "Bad request." },
  setTray: (state) => {
    if (typeof state !== "object" || state === null) return;
    if (!isRecord(state)) return;
    const { busy, unread, unsaved } = state;
    trayState = {
      busy: busy === true,
      unread: Number.isSafeInteger(unread) ? Math.max(0, Number(unread)) : 0,
      unsaved: Number.isSafeInteger(unsaved) ? Math.max(0, Number(unsaved)) : 0,
    };
    updateTray();
  },
  call: operate,
  secret,
  pickup: armPickup,
  slackShown,
  confirmReplace,
  exportArtifact,
  opencode: (action) =>
    isServiceAction(action) ? controlOpenCode(action) : { ok: false, error: "Bad command." },
};

const smokeAnswer = (value: unknown) => process.stdout.write(`SMOKE ${JSON.stringify(value)}\n`);

/**
 * The hidden smoke test's driver, only with OPEN_DOT_APP_SMOKE=1: each stdin line is a JSON
 * command, `{id, eval}` to run in the page or `{id}` for what main recorded, answered on stdout;
 * `emit: "shown"` first tells the page the window was shown.
 */
const smokeDriver = () => {
  if (!window) return;
  const contents = window.webContents;
  const violations: string[] = [];
  const errors: string[] = [];
  contents.on("console-message", (event) => {
    if (/Content.Security.Policy|Refused to/i.test(event.message)) violations.push(event.message);
    else if (event.level === "error" && errors.length < 20)
      errors.push(event.message.slice(0, 500));
  });
  const run = async (line: string) => {
    let id: unknown;
    try {
      const command: unknown = JSON.parse(line);
      if (!isRecord(command)) return;
      id = command.id;
      // What showing the window tells the page, without showing it.
      if (command.emit === "shown") emit({ kind: "shown" });
      // A copy to the fake clipboard pickup watches: a new revision, as a real copy makes.
      if (typeof command.clipboard === "string") {
        fakeClipboard.text = command.clipboard;
        fakeClipboard.revision++;
      }
      if (command.clipboardHold === "text" || command.clipboardHold === "clear")
        fakeClipboard.hold = command.clipboardHold;
      if (typeof command.confirm === "boolean") smokeConfirm = command.confirm;
      if (command.clipboardRelease === true) {
        fakeClipboard.hold = null;
        for (const done of releaseClipboard.splice(0)) done();
      }
      const value =
        typeof command.eval === "string"
          ? await contents.executeJavaScript(command.eval, true)
          : {
              recorded,
              attempts: readAttempts(),
              open: unresolved(),
              violations,
              errors,
              clipboard: { ...fakeClipboard },
            };
      smokeAnswer({ id, ok: true, value });
      if (command.quit === true) app.quit();
    } catch (cause) {
      smokeAnswer({ id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      void run(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  process.stdin.on("end", () => app.quit());
  smokeAnswer({ ready: true });
};

void app.whenReady().then(() => {
  if (!smoke && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", showWindow);
  const browser = session.defaultSession;
  browser.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  browser.setPermissionCheckHandler(() => false);
  // The renderer has no network: only its own files, blobs it made and devtools.
  browser.webRequest.onBeforeRequest((details, answer) =>
    answer({
      cancel: !/^(app:\/\/open-dot\/|blob:app:\/\/open-dot\/|devtools:)/.test(details.url),
    }),
  );
  protocol.handle(scheme, serveAsset);
  for (const channel of channels)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Refused.");
      return handlers[channel](...args);
    });
  createWindow();
  app.on("activate", showWindow);
  if (smoke) {
    window?.webContents.once("did-finish-load", smokeDriver);
    return;
  }
  tray = new Tray(trayIcon(false));
  tray.on("click", showWindow);
  shortcutRegistered = globalShortcut.register("Control+Alt+Space", toggleWindow);
  updateTray();
  // Only reads: whether OpenCode's server runs, for the menu and the Health view.
  void opencode.status();
  setInterval(() => void opencode.status(), 60_000);
  window?.webContents.on("did-finish-load", () =>
    emit({ kind: "shortcut", registered: shortcutRegistered }),
  );
});

app.on("before-quit", (event) => {
  // Unsaved instructions are only in the renderer: quitting asks once before it drops them.
  if (!quitting && (trayState.unsaved ?? 0) > 0) {
    if (smoke) recorded.quitPrompts++;
    else {
      const choice = dialog.showMessageBoxSync({
        type: "warning",
        message: "Quit and discard unsaved instructions?",
        detail: "Your edits to a dot's instructions aren't saved. Quitting discards them.",
        buttons: ["Cancel", "Discard and Quit"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice !== 1) {
        event.preventDefault();
        return;
      }
    }
  }
  quitting = true;
  endPickup();
  stopHelper();
  for (const directory of shares) removeShare(directory);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});
