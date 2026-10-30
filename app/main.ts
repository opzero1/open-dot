// The app's main process: one window, the menu bar icon, the shortcut, and every call to the
// daemon. The renderer reaches these only through the typed bridge; the token never leaves here.
import { SessionMessage } from "@opencode/client/effect";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  globalShortcut,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
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
  type ReceiptStatus,
  type Result,
  type SendResult,
  type TrayState,
} from "./bridge";
import {
  displayName,
  type Endpoint,
  imageInfo,
  imageLimits,
  imageProblem,
  isImageType,
  loopbackEndpoint,
  safeExternalURL,
  sendOutcome,
  settled,
} from "./chat";

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
};

if (process.env.OPEN_DOT_APP_DATA) app.setPath("userData", resolve(process.env.OPEN_DOT_APP_DATA));
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

// The daemon, found from api.json the way the notch finds it.

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

const failure = (answer: Answer): Result<never> => {
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
    return { ok: false, error: "The daemon's answer wasn't JSON.", status: answer.status };
  }
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

const forgetAttempt = (messageID: string) => {
  const attempts = readAttempts();
  if (attempts.some((attempt) => attempt.messageID === messageID))
    writeAttempts(attempts.filter((attempt) => attempt.messageID !== messageID));
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
  const { dot, sessionID, text, replyTo, images } = input;
  if (
    !isName(dot) ||
    !isName(sessionID) ||
    !isText(text, 1_000_000) ||
    (replyTo !== undefined && !isName(replyTo)) ||
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
      writeAttempts([...readAttempts(), attempt]);
    } catch {
      return refused("Couldn't save the send record, so nothing was sent.");
    }
    const outcome = await post(target, key, attempt, text, replyTo, images);
    if (outcome.outcome !== "unknown") return outcome;
    // The answer was lost: ask about this ID at once, which settles it if the daemon has it.
    const status = await receipt(attempt);
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
    forgetAttempt(messageID);
    return refused(result.error);
  }
  const saved = isRecord(result.value) ? result.value.id : undefined;
  if (saved === messageID) {
    forgetAttempt(messageID);
    return { outcome: "saved", id: messageID };
  }
  if (typeof saved === "string" && messageIDPattern.test(saved)) {
    // It saved the message under an ID of its own, so the app's ID tracks nothing: the message is
    // there, and the app sends nothing more to this daemon.
    forgetAttempt(messageID);
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

/** The daemon's receipt for a saved attempt, dropping the record once the daemon has it. */
const receipt = async (attempt: Attempt): Promise<Result<ReceiptStatus>> => {
  const result = await json(
    "GET",
    `/dots/${segment(attempt.dot)}/pending/${segment(attempt.messageID)}?sessionID=${segment(attempt.sessionID)}`,
  );
  if (!result.ok) return result;
  const status = isRecord(result.value) ? result.value.status : undefined;
  if (!isReceipt(status)) return { ok: false, error: "The daemon's receipt wasn't understood." };
  if (settled(status)) forgetAttempt(attempt.messageID);
  return { ok: true, value: status };
};

/** Sends whose answer is lost, not those whose POST is still out. */
const unresolved = () => readAttempts().filter((attempt) => !posting.has(attempt.messageID));

const reconcile = async (input: unknown): Promise<Result<ReceiptStatus>> => {
  const messageID = isRecord(input) ? input.messageID : undefined;
  const attempt = unresolved().find((known) => known.messageID === messageID);
  if (!attempt) return { ok: true, value: "unknown" };
  return receipt(attempt);
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

// The window, the menu bar icon and the shortcut.

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

const emit = (event: AppEvent) => window?.webContents.send(eventChannel, event);

const showWindow = () => {
  if (!window || smoke) return;
  app.setActivationPolicy("regular");
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
  }
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    void openLink(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on("hide", () => {
    if (!smoke) app.setActivationPolicy("accessory");
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
    if (!isName(dot) || (before !== undefined && !isText(before, 8192)))
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
      return { ok: true, value: { ...page.value, generation: read } };
    });
  },
  message: (dot, id, sessionID) => {
    if (!isName(dot) || !isName(id) || !isName(sessionID)) return { ok: false, error: "Bad read." };
    return coalesce(`message:${dot}:${sessionID}:${id}`, async () => {
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
    });
  },
  send,
  attempts: unresolved,
  reconcile,
  forget: (id) => {
    if (isName(id) && !posting.has(id)) forgetAttempt(id);
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
    const { busy, unread } = state;
    trayState = {
      busy: busy === true,
      unread: Number.isSafeInteger(unread) ? Math.max(0, Number(unread)) : 0,
    };
    updateTray();
  },
};

const smokeAnswer = (value: unknown) => process.stdout.write(`SMOKE ${JSON.stringify(value)}\n`);

/**
 * The hidden smoke test's driver, only with OPEN_DOT_APP_SMOKE=1: each stdin line is a JSON
 * command, `{id, eval}` to run in the page or `{id}` for what main recorded, answered on stdout.
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
      const value =
        typeof command.eval === "string"
          ? await contents.executeJavaScript(command.eval, true)
          : { recorded, attempts: readAttempts(), violations, errors };
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
  window?.webContents.on("did-finish-load", () =>
    emit({ kind: "shortcut", registered: shortcutRegistered }),
  );
});

app.on("before-quit", () => {
  quitting = true;
  for (const directory of shares) removeShare(directory);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});
