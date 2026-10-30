/** @jsxImportSource react */
// The window: a sidebar of dots and the selected dot's chat. Drafts, unread marks and image blobs
// live only in this renderer's memory; the daemon owns every message.
import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Attempt,
  Bridge,
  DotView,
  DraftImage,
  MessageView,
  PageView,
  PendingView,
  ReceiptStatus,
  Result,
  SendResult,
} from "./bridge";
import {
  afterSend,
  applyIntents,
  backoff,
  canReact,
  capture,
  continues,
  type Captured,
  type Conversation,
  deliveredID,
  type Draft,
  editDraft,
  emptyDraft,
  fenced,
  fencePage,
  imageLimits,
  type Intent,
  isImageType,
  keepSent,
  mergeLatest,
  mergeOlder,
  olderRead,
  pendingActions,
  pendingLabel,
  reactionOf,
  recentTapbacks,
  redoDraft,
  replaceMessage,
  returnAction,
  type Sent,
  sentLimit,
  settledBy,
  tapbacks,
  undoDraft,
  unlistedTapback,
  unreadSince,
  workerActions,
} from "./chat";
import { Markdown } from "./Markdown";

const loaded = globalThis.openDot;
if (!loaded) throw new Error("The app's preload didn't load.");
const bridge: Bridge = loaded;

// Older pages a list too short to scroll loads on its own before it waits for Load older.
const autoFillLimit = 10;

// Daemon images become blob URLs, a bounded number at a time; evicted ones are revoked.
const blobs = new Map<string, string>();
const blobLimit = 150;
const remember = (key: string, bytes: { mime: string; data: Uint8Array }) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes.data)], { type: bytes.mime }));
  blobs.set(key, url);
  while (blobs.size > blobLimit) {
    const [oldest, stale] = blobs.entries().next().value ?? [];
    if (oldest === undefined || stale === undefined) break;
    blobs.delete(oldest);
    URL.revokeObjectURL(stale);
  }
  return url;
};

/** A daemon image as a blob URL, whether its read failed, and a way to try again. */
const useBlob = (key: string, load: () => Promise<Result<{ mime: string; data: Uint8Array }>>) => {
  const [url, setURL] = useState(() => blobs.get(key));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const known = blobs.get(key);
    setFailed(false);
    if (known) setURL(known);
    else
      void load().then((result) => {
        if (!live) return;
        if (result.ok) setURL(remember(key, result.value));
        else setFailed(true);
      });
    return () => {
      live = false;
    };
    // The key names exactly what load reads.
  }, [key, attempt]);
  return { url, failed, retry: () => setAttempt((count) => count + 1) };
};

/** State whose latest value async work reads from the ref, updated in both at once. */
const useLive = <T,>(initial: T) => {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const update = useCallback((change: (current: T) => T) => {
    ref.current = change(ref.current);
    setValue(ref.current);
  }, []);
  return [value, ref, update] as const;
};

const Avatar = ({ dot }: { dot: DotView }) => {
  const { url } = useBlob(`avatar:${dot.name}:${dot.avatar?.revision ?? "none"}`, () =>
    dot.avatar ? bridge.avatar(dot.name) : Promise.resolve({ ok: false, error: "none" }),
  );
  return url ? (
    <img className="avatar" src={url} alt="" />
  ) : (
    <span className="avatar placeholder">{dot.name.slice(0, 1).toUpperCase()}</span>
  );
};

const fileName = (attachment: { name: string | null; mime: string }) =>
  attachment.name?.split("/").at(-1) || attachment.mime;

const Thumb = ({
  dot,
  message,
  index,
  name,
  onOpen,
}: {
  dot: string;
  message: MessageView;
  index: number;
  name: string;
  onOpen: (url: string) => void;
}) => {
  const { url, failed, retry } = useBlob(
    `image:${dot}:${message.sessionID}:${message.id}:${index}`,
    () => bridge.image(dot, message.id, message.sessionID, index),
  );
  if (url)
    return (
      <button
        type="button"
        className="thumb"
        onClick={() => onOpen(url)}
        aria-label={`Open ${name}`}
        title={name}
      >
        <img src={url} alt="" />
      </button>
    );
  // An image that failed to load says so, and a click tries again.
  return failed ? (
    <button
      type="button"
      className="attachment-chip"
      data-failed
      title="Click to try again"
      onClick={retry}
    >
      ↻ {name} · couldn't load
    </button>
  ) : (
    <span className="thumb loading" aria-label={`Loading ${name}`} />
  );
};

/** A local image's preview, released when it leaves the screen. */
const LocalThumb = ({
  image,
  className,
  onRemove,
}: {
  image: DraftImage;
  className: string;
  onRemove?: () => void;
}) => {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mime })),
    [image],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <span className={className}>
      <img src={url} alt={image.name} title={image.name} />
      {onRemove ? (
        <button type="button" aria-label={`Remove ${image.name}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
};

const needsCount = (dot: DotView) =>
  dot.workers.reduce((sum, worker) => sum + worker.needs.length, 0) +
  dot.sessions.reduce((sum, item) => sum + item.needs.length, 0);

interface Menu {
  message: MessageView;
  x: number;
  y: number;
  details?: boolean;
}

interface Toast {
  text: string;
  undo?: () => void;
}

type Row =
  | { kind: "message"; key: string; message: MessageView }
  | { kind: "pending"; key: string; pending: PendingView; sent?: Sent | undefined }
  | { kind: "attempt"; key: string; attempt: Attempt; sent?: Sent | undefined };

const singleEmoji = /^\p{RGI_Emoji}$/v;

const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

const App = () => {
  const [dots, setDots] = useState<DotView[]>([]);
  const [dotsError, setDotsError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [conversations, conversationsRef, updateConversations] = useLive(
    new Map<string, Conversation>(),
  );
  const [readErrors, setReadErrors] = useState(new Map<string, string>());
  const [olderErrors, setOlderErrors] = useState(new Map<string, string>());
  const [recent, setRecent] = useState<string[]>([]);
  const [intents, intentsRef, updateIntents] = useLive(new Map<string, Map<string, Intent>>());
  const [drafts, draftsRef, updateDrafts] = useLive(new Map<string, Draft>());
  const [seen, setSeen] = useState(new Map<string, string>());
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [sending, setSending] = useState(new Set<string>());
  const [sent, sentRef, updateSent] = useLive(new Map<string, Sent>());
  const [changing, setChanging] = useState(new Set<string>());
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<Menu>();
  const [viewer, setViewer] = useState<string>();
  const [toast, setToast] = useState<Toast>();
  const [confirm, setConfirm] = useState<{ text: string; action: string; run: () => void }>();
  const [capturing, setCapturing] = useState<{ dot: string; message: MessageView }>();
  const [shortcut, setShortcut] = useState(true);
  const [sendAnyway, setSendAnyway] = useState(false);
  const [composerErrors, setComposerErrors] = useState(new Map<string, string>());
  // Messages a selection spans in the open chat, which history trimming keeps.
  const selectionKeep = useRef<ReadonlySet<string>>(new Set());

  const conversation = selected ? conversations.get(selected) : undefined;
  const dot = dots.find((item) => item.name === selected);
  const draft = (selected && drafts.get(selected)) || emptyDraft();
  const composerError = selected ? composerErrors.get(selected) : undefined;

  const setDraft = useCallback(
    (name: string, change: (draft: Draft) => Draft) =>
      updateDrafts((current) =>
        new Map(current).set(name, change(current.get(name) ?? emptyDraft())),
      ),
    [updateDrafts],
  );

  const setComposerError = useCallback((name: string, text: string | undefined) => {
    setComposerErrors((current) =>
      text === undefined ? without(current, name) : new Map(current).set(name, text),
    );
  }, []);

  const showToast = useCallback((next: Toast) => {
    setToast(next);
    setTimeout(() => setToast((shown) => (shown === next ? undefined : shown)), 10_000);
  }, []);

  // Reads: the selected chat every second, dots every two, other chats every thirty.

  const failures = useRef(new Map<string, number>());
  const due = useRef(new Map<string, number>());
  // The dot list's and each send receipt's clocks, kept while the scheduler restarts.
  const clocks = useRef({
    dots: 0,
    dotFailures: 0,
    list: 0,
    receipts: new Map<string, number>(),
    receiptFailures: new Map<string, number>(),
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dotsRef = useRef(dots);
  dotsRef.current = dots;

  // Per dot, when each settled change was confirmed: reads that began earlier can't replace it.
  const fences = useRef(new Map<string, Map<string, number>>());
  // Per dot, bumped by Back to latest: a latest read that began before it is dropped.
  const epochs = useRef(new Map<string, number>());
  // Per dot, the session of the last page applied; Back to latest drops the page, not this.
  const sessions = useRef(new Map<string, string>());
  // Undo of a delete clicked before that delete settled, by dot and message: it runs once it has.
  const undoes = useRef(new Map<string, { name: string; id: string; sessionID: string }>());

  /** Drops intents once nothing can change their message or a read settled them, and fences them. */
  const dropIntents = useCallback(
    (name: string, ids: readonly string[]) => {
      if (!ids.length) return;
      const at = Date.now();
      const fence = fences.current.get(name) ?? new Map<string, number>();
      for (const id of ids) fence.set(id, at);
      fences.current.set(name, fence);
      updateIntents((all) => {
        const next = new Map(all.get(name));
        for (const id of ids) next.delete(id);
        return new Map(all).set(name, next);
      });
    },
    [updateIntents],
  );

  /** Drops the intents a read that started at `startedAt` settles. */
  const settle = useCallback(
    (name: string, messages: readonly MessageView[], startedAt: number) => {
      const mine = intentsRef.current.get(name);
      if (mine?.size) dropIntents(name, settledBy(messages, mine, startedAt));
    },
    [dropIntents, intentsRef],
  );

  const applyPage = useCallback(
    (name: string, read: PageView) => {
      const previous = conversationsRef.current.get(name);
      const { startedAt } = read;
      const page = fencePage(read, previous, fences.current.get(name), startedAt);
      const session = sessions.current.get(name);
      sessions.current.set(name, page.sessionID);
      if (session !== undefined && session !== page.sessionID) {
        // A new session: old actions, quotes and intents no longer apply; the draft text stays.
        fences.current.delete(name);
        for (const [key, undo] of undoes.current)
          if (undo.name === name) {
            undoes.current.delete(key);
            showToast({ text: `Undo no longer applies: ${name} moved to a new conversation.` });
          }
        updateIntents((all) => without(all, name));
        updateDrafts((all) => {
          const kept = all.get(name);
          return kept?.quote ? new Map(all).set(name, { ...kept, quote: undefined }) : all;
        });
        setMenu(undefined);
        setCapturing(undefined);
        setOlderErrors((all) => without(all, name));
      }
      const keep = name === selectedRef.current ? selectionKeep.current : new Set<string>();
      updateConversations((current) =>
        new Map(current).set(name, mergeLatest(current.get(name), page, keep)),
      );
      settle(name, page.messages, startedAt);
      updateSent((current) => keepSent(current, name, page, Date.now()));
      setRecent(page.recentEmojis);
      setReadErrors((current) =>
        page.refreshError ? new Map(current).set(name, page.refreshError) : without(current, name),
      );
      setSeen((current) => {
        const last = page.messages.at(-1)?.id;
        // The first successful read is the baseline: nothing before it counts as unread.
        if (!last || (current.has(name) && !(name === selectedRef.current && document.hasFocus())))
          return current;
        return new Map(current).set(name, last);
      });
    },
    [
      conversationsRef,
      settle,
      showToast,
      updateConversations,
      updateDrafts,
      updateIntents,
      updateSent,
    ],
  );

  const readChat = useCallback(
    async (name: string) => {
      const epoch = epochs.current.get(name) ?? 0;
      const result = await bridge.messages(name);
      if (epoch !== (epochs.current.get(name) ?? 0)) return;
      const count = failures.current.get(name) ?? 0;
      if (result.ok) {
        failures.current.set(name, 0);
        applyPage(name, result.value);
      } else {
        failures.current.set(name, count + 1);
        due.current.set(name, Date.now() + backoff(count + 1) * 1000);
        setReadErrors((current) => new Map(current).set(name, result.error));
      }
    },
    [applyPage],
  );

  /** Reads one message pinned to its session, wherever it's loaded, and settles its intent. */
  const refreshMessage = useCallback(
    async (name: string, id: string, sessionID: string) => {
      const startedAt = Date.now();
      const result = await bridge.message(name, id, sessionID);
      // A change confirmed since this read began may be missing from it.
      if (fenced(fences.current.get(name), id, startedAt)) return;
      if (result.ok) {
        updateConversations((current) => {
          const known = current.get(name);
          return known ? new Map(current).set(name, replaceMessage(known, result.value)) : current;
        });
        settle(name, [result.value], startedAt);
      } else if (result.status === 404 || result.status === 409) {
        // Gone, or its session moved on: nothing more can change it, so it blocks nothing.
        const intent = intentsRef.current.get(name)?.get(id);
        if (intent?.settledAt !== undefined && startedAt >= intent.settledAt)
          dropIntents(name, [id]);
      }
    },
    [dropIntents, intentsRef, settle, updateConversations],
  );

  /** What an attempt's receipt says about the draft it was captured from. */
  const settleSend = useCallback(
    (attempt: Attempt, status: ReceiptStatus) => {
      const item = sentRef.current.get(attempt.messageID);
      if (status === "unknown") return;
      if (status === "cancelled") {
        updateSent((current) => without(current, attempt.messageID));
        setComposerError(
          attempt.dot,
          "open-dot cancelled a message it hadn't confirmed, so it wasn't sent. It's still in the message box.",
        );
        return;
      }
      // The daemon has it: what it captured leaves the draft, keeping anything typed since.
      if (item?.state === "unknown") {
        setDraft(item.dot, (current) => afterSend(current, item.captured));
        updateSent((current) =>
          new Map(current).set(attempt.messageID, {
            ...item,
            state: "pending",
            at: Date.now(),
            listed: false,
          }),
        );
      }
      setComposerError(
        attempt.dot,
        status === "held"
          ? "open-dot has the message and is holding it until the dot can take it."
          : undefined,
      );
    },
    [sentRef, setComposerError, setDraft, updateSent],
  );

  useEffect(() => {
    const run = { stopped: false };
    // The dot list, each conversation and each send's receipt are read on their own clocks. A
    // key's due time is Infinity while its read is out, so a slow read delays only its own key.
    const clock = clocks.current;
    const { receipts: receiptDue, receiptFailures } = clock;
    const start = (task: () => Promise<void>) => void task().catch(() => {});

    const readDots = async () => {
      const result = await bridge.dots();
      if (result.ok) {
        clock.dotFailures = 0;
        clock.dots = Date.now() + 2000;
        setDots(result.value);
        setDotsError(undefined);
        setSelected((current) =>
          current && result.value.some((item) => item.name === current)
            ? current
            : result.value[0]?.name,
        );
      } else {
        clock.dotFailures++;
        clock.dots = Date.now() + backoff(clock.dotFailures) * 1000;
        setDotsError(result.error);
      }
    };

    const readReceipt = async (attempt: Attempt) => {
      const id = attempt.messageID;
      const result = await bridge
        .reconcile(attempt)
        .catch((): Result<ReceiptStatus> => ({ ok: false, error: "No receipt." }));
      const failed = result.ok ? 0 : (receiptFailures.get(id) ?? 0) + 1;
      receiptFailures.set(id, failed);
      receiptDue.set(id, Date.now() + Math.max(2, backoff(failed)) * 1000);
      if (result.ok) settleSend(attempt, result.value);
      setAttempts(await bridge.attempts());
    };

    const listReceipts = async () => {
      const known = await bridge.attempts();
      clock.list = Date.now() + 2000;
      if (run.stopped) return;
      setAttempts(known);
      const open = new Set(known.map((attempt) => attempt.messageID));
      for (const id of receiptDue.keys())
        if (!open.has(id)) {
          receiptDue.delete(id);
          receiptFailures.delete(id);
        }
      const now = Date.now();
      for (const attempt of known) {
        if (now < (receiptDue.get(attempt.messageID) ?? 0)) continue;
        receiptDue.set(attempt.messageID, Infinity);
        start(async () => {
          try {
            await readReceipt(attempt);
          } finally {
            if (receiptDue.get(attempt.messageID) === Infinity)
              receiptDue.set(attempt.messageID, Date.now() + 2000);
          }
        });
      }
    };

    const readConversation = async (name: string) => {
      try {
        await readChat(name);
        // Changes whose call returned are settled by reading their own message, which may be
        // far older than the latest page.
        for (const [id, intent] of intentsRef.current.get(name) ?? [])
          if (intent.settledAt !== undefined) await refreshMessage(name, id, intent.sessionID);
      } finally {
        // A read asked for while this one was out (due set to 0) runs next instead of waiting.
        if (due.current.get(name) === Infinity)
          due.current.set(name, Date.now() + (name === selectedRef.current ? 1000 : 30_000));
      }
    };

    const tick = () => {
      const now = Date.now();
      if (now >= clock.dots) {
        clock.dots = Infinity;
        start(async () => {
          try {
            await readDots();
          } finally {
            if (clock.dots === Infinity) clock.dots = Date.now() + 2000;
          }
        });
      }
      if (now >= clock.list) {
        clock.list = Infinity;
        start(async () => {
          try {
            await listReceipts();
          } finally {
            if (clock.list === Infinity) clock.list = Date.now() + 2000;
          }
        });
      }
      for (const name of new Set([
        selectedRef.current,
        ...dotsRef.current.map((item) => item.name),
      ])) {
        if (!name || now < (due.current.get(name) ?? 0)) continue;
        due.current.set(name, Infinity);
        start(() => readConversation(name));
      }
    };
    const timer = setInterval(() => {
      if (!run.stopped) tick();
    }, 250);
    tick();
    return () => {
      run.stopped = true;
      clearInterval(timer);
    };
  }, [intentsRef, readChat, refreshMessage, settleSend]);

  useEffect(() => {
    if (selected) due.current.set(selected, 0);
  }, [selected]);

  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event.kind === "shortcut") setShortcut(event.registered);
        if (event.kind === "shown" && selectedRef.current) due.current.set(selectedRef.current, 0);
      }),
    [],
  );

  const unread = useMemo(
    () =>
      new Map(
        dots.map((item) => [
          item.name,
          unreadSince(conversations.get(item.name)?.latest ?? [], seen.get(item.name)),
        ]),
      ),
    [dots, conversations, seen],
  );

  useEffect(() => {
    const total = [...unread.values()].reduce((sum, count) => sum + count, 0);
    void bridge.setTray({ busy: dots.some((item) => item.busy), unread: total });
  }, [dots, unread]);

  // Looking at a chat marks it read.
  useEffect(() => {
    const last = conversation?.latest.at(-1)?.id;
    if (selected && last && seen.get(selected) !== last && document.hasFocus())
      setSeen((current) => new Map(current).set(selected, last));
  }, [selected, conversation, seen]);

  const mine = (selected && intents.get(selected)) || undefined;
  const shown = useMemo(
    () => (conversation ? applyIntents(conversation.messages, mine ?? new Map()) : []),
    [conversation, mine],
  );

  const blocked = (id: string) => intents.get(selected ?? "")?.has(id) ?? false;
  // A change whose answer was lost and that no read has shown yet: the owner may ask again.
  const unconfirmed = (id: string) => {
    const intent = intents.get(selected ?? "")?.get(id);
    return intent?.uncertain === true && intent.settledAt !== undefined;
  };

  /** The message as it's shown now, with any change the owner made, rather than as captured. */
  const currentMessage = (name: string, id: string) => {
    const known = conversationsRef.current.get(name)?.messages.find((item) => item.id === id);
    return known && applyIntents([known], intentsRef.current.get(name) ?? new Map())[0];
  };

  /**
   * Makes the intended change's call. A refused one is dropped (a refused retry leaves the lost
   * call before it as it was); one that returned, or whose answer was lost, stays shown and blocks
   * other changes until a read of that message settles it.
   */
  const commit = async (name: string, id: string, intent: Intent) => {
    const setIntent = (value: Intent | undefined) =>
      updateIntents((all) => {
        const next = new Map(all.get(name));
        if (value) next.set(id, value);
        else next.delete(id);
        return new Map(all).set(name, next);
      });
    setIntent({ ...intent, settledAt: undefined });
    const result =
      intent.emoji !== undefined
        ? await bridge.react(name, id, intent.sessionID, intent.emoji)
        : await bridge.hide(name, id, intent.sessionID, intent.hidden ?? false);
    if (!result.ok && !result.lost) {
      setIntent(intent.uncertain ? intent : undefined);
      showToast({ text: result.error });
      return false;
    }
    if (!result.ok)
      showToast({
        text: "Couldn't confirm that change. It stays shown until open-dot shows it saved.",
      });
    setIntent({ ...intent, settledAt: Date.now(), uncertain: intent.uncertain || !result.ok });
    void refreshMessage(name, id, intent.sessionID);
    due.current.set(name, 0);
    return result.ok;
  };

  /** One change to one message at a time. */
  const mutate = (
    name: string,
    message: Pick<MessageView, "id" | "sessionID">,
    change: Pick<Intent, "emoji" | "hidden">,
  ): Promise<boolean> => {
    if (intentsRef.current.get(name)?.has(message.id)) {
      showToast({ text: "Waiting for saved message state before another change." });
      return Promise.resolve(false);
    }
    return commit(name, message.id, { ...change, sessionID: message.sessionID });
  };

  /** The owner asks again for a change whose answer was lost: the same value, never another. */
  const retry = (name: string, id: string) => {
    setMenu(undefined);
    const intent = intentsRef.current.get(name)?.get(id);
    if (intent?.uncertain && intent.settledAt !== undefined) void commit(name, id, intent);
  };

  const react = (name: string, target: MessageView, emoji: string) => {
    setMenu(undefined);
    const message = currentMessage(name, target.id) ?? target;
    if (message.sessionID !== target.sessionID) return;
    const next = reactionOf(message, "owner") === emoji ? null : emoji;
    void mutate(name, message, { emoji: next });
  };

  const hide = (name: string, message: Pick<MessageView, "id" | "sessionID">, hidden: boolean) => {
    void mutate(name, message, { hidden }).then((done) => {
      if (done && hidden)
        showToast({
          text: "Message deleted from the app.",
          undo: () => undoDelete(name, message),
        });
    });
  };

  /** Undo of a delete that's still settling waits for it rather than being refused. */
  const undoDelete = (name: string, message: Pick<MessageView, "id" | "sessionID">) => {
    if (!intentsRef.current.get(name)?.has(message.id)) return hide(name, message, false);
    undoes.current.set(`${name}\n${message.id}`, {
      name,
      id: message.id,
      sessionID: message.sessionID,
    });
    showToast({ text: "Undoing once open-dot shows the delete saved…" });
  };

  // A waiting Undo runs once its delete has settled, as the restore Show deleted offers.
  useEffect(() => {
    for (const [key, undo] of undoes.current) {
      if (intentsRef.current.get(undo.name)?.has(undo.id)) continue;
      undoes.current.delete(key);
      hide(undo.name, undo, false);
    }
  });

  // The composer.

  const unknownHere = attempts.filter((attempt) => attempt.dot === selected);

  const send = async () => {
    if (!selected || !conversation || sending.has(selected)) return;
    const name = selected;
    const captured = capture(draft);
    if (!captured.text.trim() && !captured.images.length) return;
    const unknownSent = [...sentRef.current.values()].some(
      (item) => item.dot === name && item.state === "unknown",
    );
    if ((unknownHere.length || unknownSent) && !sendAnyway) {
      setComposerError(
        name,
        "An earlier message's delivery is still unknown. Check the conversation first, or choose Send anyway.",
      );
      return;
    }
    setComposerError(name, undefined);
    setSending((current) => new Set(current).add(name));
    let result: SendResult;
    try {
      result = await bridge.send({
        dot: name,
        sessionID: conversation.sessionID,
        text: captured.text,
        ...(captured.quote ? { replyTo: captured.quote.id } : {}),
        images: captured.images,
      });
    } catch {
      // Main failed without saying what became of it: any record it saved is reconciled.
      setComposerError(
        name,
        "Couldn't tell whether open-dot got this message. The app is checking and won't send it again.",
      );
      setAttempts(await bridge.attempts().catch(() => []));
      return;
    } finally {
      setSending((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
      setSendAnyway(false);
    }
    const track = (id: string, state: Sent["state"]) =>
      updateSent((current) =>
        keepSentLimit(
          new Map(current).set(id, {
            dot: name,
            sessionID: conversation.sessionID,
            captured,
            at: Date.now(),
            state,
            listed: false,
          }),
        ),
      );
    if (result.outcome === "saved") {
      track(result.id, "pending");
      setDraft(name, (current) => afterSend(current, captured));
      if (result.warning) setComposerError(name, result.warning);
      due.current.set(name, 0);
      return;
    }
    // The draft stays either way; nothing is sent again on its own.
    if (result.outcome === "unknown") {
      track(result.id, "unknown");
      setComposerError(
        name,
        "open-dot didn't confirm this message. It may still arrive; the app is checking and won't send it again.",
      );
      setAttempts(await bridge.attempts());
    } else setComposerError(name, result.error);
  };

  const attach = async (name: string, files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const count = draftsRef.current.get(name)?.images.length ?? 0;
      if (count >= imageLimits.count) return setComposerError(name, "Attach at most five images.");
      if (file.size === 0 || file.size > imageLimits.bytes)
        return setComposerError(name, "Each image can be at most 10 MiB.");
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await bridge.ingest({ name: file.name, data });
      if (!result.ok) return setComposerError(name, result.error);
      setDraft(name, (current) =>
        current.images.length >= imageLimits.count
          ? current
          : { ...current, images: [...current.images, result.value] },
      );
    }
    setComposerError(name, undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!selected) return;
    const name = selected;
    if (event.metaKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      setDraft(name, event.shiftKey ? redoDraft : undoDraft);
      return;
    }
    const action = returnAction({ ...event, isComposing: event.nativeEvent.isComposing });
    if (action === "send") {
      event.preventDefault();
      void send();
    } else if (action === "newline" && event.altKey) {
      // Option-Return types a line break too, like Shift-Return.
      event.preventDefault();
      const box = event.currentTarget;
      const text = `${box.value.slice(0, box.selectionStart)}\n${box.value.slice(box.selectionEnd)}`;
      const caret = box.selectionStart + 1;
      setDraft(name, (current) => editDraft(current, text, Date.now()));
      requestAnimationFrame(() => box.setSelectionRange(caret, caret));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length || !selected) return;
    event.preventDefault();
    void attach(selected, files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (selected) void attach(selected, [...event.dataTransfer.files]);
  };

  // The emoji panel: the first emoji typed into the capture field is the one reaction.
  const captureRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (capturing) {
      captureRef.current?.focus();
      void bridge.emojiPanel();
    }
  }, [capturing]);

  // Rows: the messages shown, then the owner's pending sends, then sends with an unknown outcome.
  const rows = useMemo<Row[]>(() => {
    const listed: Row[] = shown
      .filter((message) => showHidden || !message.hidden)
      .map((message) => ({ kind: "message", key: message.id, message }));
    const ids = new Set(shown.map((message) => message.id));
    if (!conversation?.detached)
      for (const pending of conversation?.pending ?? [])
        if (!ids.has(pending.id))
          listed.push({
            kind: "pending",
            key: `p:${pending.id}`,
            pending,
            sent: sent.get(pending.id),
          });
    for (const attempt of unknownHere)
      listed.push({
        kind: "attempt",
        key: `a:${attempt.messageID}`,
        attempt,
        sent: sent.get(attempt.messageID),
      });
    return listed;
  }, [shown, showHidden, conversation, sent, unknownHere]);

  const delivered = conversation
    ? deliveredID(applyIntents(conversation.latest, mine ?? new Map()), conversation.pending)
    : undefined;

  const loadOlder = async () => {
    const name = selectedRef.current;
    const known = name ? conversationsRef.current.get(name) : undefined;
    const read = known && olderRead(known);
    if (!name || !known || !read) return;
    const result = await bridge.messages(name, read.cursor, known.generation);
    // Whatever replaced the window meanwhile, the answer belongs to the old one: drop it.
    if (!continues(conversationsRef.current.get(name), read)) return;
    if (!result.ok) {
      setOlderErrors((current) => new Map(current).set(name, result.error));
      return;
    }
    setOlderErrors((current) => without(current, name));
    updateConversations((current) => {
      const latest = current.get(name);
      return latest
        ? new Map(current).set(name, mergeOlder(latest, result.value, read, selectionKeep.current))
        : current;
    });
  };

  const backToLatest = () => {
    if (!selected) return;
    // Reads already out answer for the window being left, so none of them may rebuild it.
    epochs.current.set(selected, (epochs.current.get(selected) ?? 0) + 1);
    updateConversations((current) => without(current, selected));
    setOlderErrors((current) => without(current, selected));
    due.current.set(selected, 0);
  };

  const changePending = (name: string, pending: PendingView, change: "steer" | "cancel") => {
    if (changing.has(pending.id)) return;
    setChanging((current) => new Set(current).add(pending.id));
    void bridge.pending(name, pending.id, change).then((result) => {
      setChanging((current) => {
        const next = new Set(current);
        next.delete(pending.id);
        return next;
      });
      const verb = change === "steer" ? "sent now" : "cancelled";
      if (!result.ok)
        showToast({
          text: result.lost
            ? `Outcome unknown: it may be ${verb} after the next refresh. No automatic retry.`
            : `Not ${verb}. ${result.error}`,
        });
      due.current.set(name, 0);
    });
  };

  const menuMessage = menu && selected ? currentMessage(selected, menu.message.id) : undefined;

  return (
    <div
      className="app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      data-sent={sent.size}
    >
      <aside className="sidebar">
        <div className="sidebar-title">open-dot</div>
        {dotsError ? <div className="banner">{dotsError}</div> : null}
        {!shortcut ? (
          <div className="banner">Control-Option-Space is taken by another app.</div>
        ) : null}
        <nav>
          {dots.map((item) => {
            const count = unread.get(item.name) ?? 0;
            const needs = needsCount(item);
            return (
              <button
                key={item.name}
                type="button"
                data-dot={item.name}
                data-busy={item.busy ? "" : undefined}
                className={`dot ${item.name === selected ? "selected" : ""}`}
                onClick={() => {
                  setSelected(item.name);
                  setMenu(undefined);
                }}
              >
                <Avatar dot={item} />
                <span className="dot-name">{item.name}</span>
                {item.busy ? <span className="badge busy" aria-label="Busy" /> : null}
                {needs ? (
                  <span className="badge needs" aria-label={`${needs} need you`}>
                    {needs}
                  </span>
                ) : null}
                {count ? (
                  <span className="badge unread" aria-label={`${count} unread`}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="chat">
        {dot && conversation ? (
          <>
            <header className="chat-head">
              <div>
                <div className="chat-title">{dot.name}</div>
                {dot.purpose ? <div className="chat-purpose">{dot.purpose}</div> : null}
              </div>
              <div className="chat-tools">
                {readErrors.get(dot.name) ? (
                  <span className="stale" title={readErrors.get(dot.name)}>
                    Not up to date
                  </span>
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(event) => setShowHidden(event.target.checked)}
                  />{" "}
                  Show deleted
                </label>
              </div>
            </header>
            <MessageList
              key={`${dot.name}:${conversation.sessionID}`}
              dot={dot.name}
              rows={rows}
              conversation={conversation}
              delivered={delivered}
              busy={dot.busy}
              blocked={blocked}
              changing={changing}
              olderError={olderErrors.get(dot.name)}
              keep={selectionKeep}
              onMenu={setMenu}
              onOpenImage={setViewer}
              onOlder={loadOlder}
              onLatest={backToLatest}
              onRestore={(message) => hide(dot.name, message, false)}
              unconfirmed={unconfirmed}
              onRetry={(message) => retry(dot.name, message.id)}
              onPending={(pending, change) => changePending(dot.name, pending, change)}
              onCopyText={(text) => void bridge.copyText(text)}
              onShareText={(text) => void bridge.shareText(text)}
              onForget={(attempt) => {
                setConfirm({
                  text: "Stop tracking this message? open-dot never confirmed it, and it won't be sent again.",
                  action: "Stop tracking",
                  run: () =>
                    void bridge.forget(attempt.messageID).then(() => {
                      updateSent((current) => without(current, attempt.messageID));
                      return bridge.attempts().then(setAttempts);
                    }),
                });
              }}
            />
            <Workers dot={dot} onConfirm={setConfirm} onToast={showToast} />
            <div className="composer">
              {draft.quote ? (
                <div className="quote-bar">
                  <span>Replying to {draft.quote.author === "owner" ? "you" : dot.name}: </span>
                  <span className="quote-text">{draft.quote.text}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft(dot.name, (current) => ({ ...current, quote: undefined }))
                    }
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
              {draft.images.length ? (
                <div className="draft-images">
                  {draft.images.map((image, index) => (
                    <LocalThumb
                      key={index}
                      className="draft-thumb"
                      image={image}
                      onRemove={() =>
                        setDraft(dot.name, (current) => ({
                          ...current,
                          images: current.images.filter((other) => other !== image),
                        }))
                      }
                    />
                  ))}
                </div>
              ) : null}
              {composerError ? (
                <div className="composer-error" data-composer-error>
                  {composerError}
                  {unknownHere.length ||
                  [...sent.values()].some(
                    (item) => item.dot === selected && item.state === "unknown",
                  ) ? (
                    <button type="button" onClick={() => setSendAnyway(true)}>
                      Send anyway
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="composer-row">
                <textarea
                  value={draft.text}
                  rows={1}
                  placeholder={`Message ${dot.name}`}
                  title="Paste or drop images to attach them."
                  onChange={(event) => {
                    const text = event.target.value;
                    setDraft(dot.name, (current) => editDraft(current, text, Date.now()));
                  }}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                />
                <button
                  type="button"
                  className="send"
                  disabled={sending.has(dot.name) || (!draft.text.trim() && !draft.images.length)}
                  onClick={() => void send()}
                >
                  {sending.has(dot.name) ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            {dots.length ? "Loading…" : dotsError ? "Waiting for open-dot's daemon…" : "Loading…"}
          </div>
        )}
      </main>
      {menu && selected && menuMessage ? (
        <MessageMenu
          menu={{ ...menu, message: menuMessage }}
          dot={selected}
          recent={recent}
          blocked={blocked(menuMessage.id)}
          onClose={() => setMenu(undefined)}
          onReact={(emoji) => react(selected, menuMessage, emoji)}
          onEmoji={() => {
            setCapturing({ dot: selected, message: menuMessage });
            setMenu(undefined);
          }}
          onDetails={() => setMenu({ ...menu, details: true })}
          onReply={() => {
            setDraft(selected, (current) => ({
              ...current,
              quote: {
                id: menuMessage.id,
                author: menuMessage.kind === "owner" ? "owner" : "dot",
                text: menuMessage.text.slice(0, 240),
              },
            }));
            setMenu(undefined);
          }}
          onCopy={() => {
            void bridge
              .copyMessage(selected, menuMessage.id, menuMessage.sessionID)
              .then((result) => {
                if (!result.ok) showToast({ text: `Nothing was copied: ${result.error}` });
              });
            setMenu(undefined);
          }}
          onShare={() => {
            void bridge
              .shareMessage(selected, menuMessage.id, menuMessage.sessionID)
              .then((result) => {
                if (!result.ok) showToast({ text: result.error });
              });
            setMenu(undefined);
          }}
          onDelete={() => {
            setMenu(undefined);
            setConfirm({
              text: "Delete this message from the app? It stays in the dot's history and context.",
              action: "Delete",
              run: () => hide(selected, menuMessage, true),
            });
          }}
        />
      ) : null}
      {capturing ? (
        <input
          ref={captureRef}
          className="emoji-capture"
          aria-label="Choose an emoji"
          onBlur={() => setCapturing(undefined)}
          onInput={(event) => {
            const value = event.currentTarget.value.trim();
            const target = capturing;
            setCapturing(undefined);
            if (singleEmoji.test(value) && target.dot === selectedRef.current)
              react(target.dot, target.message, value);
          }}
        />
      ) : null}
      {viewer ? (
        <div
          className="viewer"
          role="dialog"
          aria-label="Image"
          onClick={() => setViewer(undefined)}
        >
          <img src={viewer} alt="" />
        </div>
      ) : null}
      {confirm ? (
        <div className="modal" role="alertdialog">
          <div className="modal-box">
            <p>{confirm.text}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  confirm.run();
                  setConfirm(undefined);
                }}
              >
                {confirm.action}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          {toast.text}
          {toast.undo ? (
            <button
              type="button"
              onClick={() => {
                // Cleared first, so a toast the undo shows, saying it's waiting, stays.
                setToast(undefined);
                toast.undo?.();
              }}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** Keeps the newest sends when more pile up than any chat could show as pending. */
const keepSentLimit = (sent: Map<string, Sent>) =>
  sent.size <= sentLimit
    ? sent
    : new Map([...sent].toSorted(([, a], [, b]) => b.at - a.at).slice(0, sentLimit));

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The key of the list row holding a node, when it's in this list. */
const rowKey = (list: HTMLElement | null, node: Node | null | undefined) => {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>("[data-key]");
  return row && list?.contains(row) ? row.dataset.key : undefined;
};

/** A send's captured quote, text and image previews, shown dimmed until the dot has it. */
const SentPreview = ({ dot, sent }: { dot: string; sent: Captured }) => (
  <>
    {sent.quote ? (
      <div className="quote">
        {sent.quote.author === "owner" ? "You" : dot}: {sent.quote.text}
      </div>
    ) : null}
    {sent.text ? (
      <div className="bubble">
        <div className="plain">{sent.text}</div>
      </div>
    ) : null}
    {sent.images.length ? (
      <div className="thumbs">
        {sent.images.map((image, index) => (
          <LocalThumb key={index} className="pending-thumb" image={image} />
        ))}
      </div>
    ) : null}
  </>
);

const MessageList = ({
  dot,
  rows,
  conversation,
  delivered,
  busy,
  blocked,
  changing,
  olderError,
  keep,
  onMenu,
  onOpenImage,
  onOlder,
  onLatest,
  onRestore,
  unconfirmed,
  onRetry,
  onPending,
  onCopyText,
  onShareText,
  onForget,
}: {
  dot: string;
  rows: Row[];
  conversation: Conversation;
  delivered: string | undefined;
  busy: boolean;
  blocked: (id: string) => boolean;
  changing: ReadonlySet<string>;
  olderError: string | undefined;
  keep: RefObject<ReadonlySet<string>>;
  onMenu: (menu: Menu) => void;
  onOpenImage: (url: string) => void;
  onOlder: () => Promise<void>;
  onLatest: () => void;
  onRestore: (message: MessageView) => void;
  unconfirmed: (id: string) => boolean;
  onRetry: (message: MessageView) => void;
  onPending: (pending: PendingView, change: "steer" | "cancel") => void;
  onCopyText: (text: string) => void;
  onShareText: (text: string) => void;
  onForget: (attempt: Attempt) => void;
}) => {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [latest, setLatest] = useState(false);
  const loading = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The rows a selection starts and ends in, by key, so prepends and polls can't shift it; every
  // row between them stays rendered, and history trimming keeps their messages.
  const selection = useRef<[string, string] | undefined>(undefined);

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    const span = selection.current;
    if (span) {
      const at = span.map((key) => rowsRef.current.findIndex((row) => row.key === key));
      const [from, to] = [Math.min(...at), Math.max(...at)];
      if (from >= 0) for (let index = from; index <= to; index++) indexes.add(index);
    }
    return [...indexes].filter((index) => index < range.count).toSorted((a, b) => a - b);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => rows[index]?.key ?? index,
    rangeExtractor,
    // Older pages go above without moving what's being read; new rows follow at the bottom.
    anchorTo: "end",
    followOnAppend: true,
  });

  useEffect(() => {
    const update = () => {
      const current = document.getSelection();
      const anchor = rowKey(scroller.current, current?.anchorNode);
      const focus = rowKey(scroller.current, current?.focusNode);
      selection.current =
        current && !current.isCollapsed && anchor !== undefined && focus !== undefined
          ? [anchor, focus]
          : undefined;
      const ids = new Set<string>();
      if (selection.current) {
        const at = selection.current.map((key) =>
          rowsRef.current.findIndex((row) => row.key === key),
        );
        for (let index = Math.min(...at); index >= 0 && index <= Math.max(...at); index++) {
          const row = rowsRef.current[index];
          if (row?.kind === "message") ids.add(row.message.id);
        }
      }
      keep.current = ids;
    };
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      keep.current = new Set();
    };
  }, [keep]);

  // A chat opens at its newest message.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || !rows.length) return;
    opened.current = true;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  // Loads the next older page, one at a time, rendering again once each settles to check the fill.
  const [, setLoads] = useState(0);
  const older = () => {
    if (!conversation.next || olderError || loading.current) return;
    loading.current = true;
    void onOlder().finally(() => {
      loading.current = false;
      setLoads((count) => count + 1);
    });
  };

  // A page that doesn't fill the list can't be scrolled to load more, such as an empty one past a
  // run of tool calls, or one whose messages are all deleted: older pages load on their own, up
  // to a bound, and Load older stays offered.
  const fills = useRef(0);
  const [short, setShort] = useState(false);
  // After every render: measuring rows changes the height without changing any input.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const unfilled = element.scrollHeight - element.clientHeight < 300;
    setShort(unfilled);
    if (!unfilled) fills.current = 0;
    if (!unfilled || fills.current >= autoFillLimit || !conversation.next || olderError) return;
    if (loading.current) return;
    fills.current++;
    older();
  });

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setLatest(!atBottom.current || conversation.detached);
    if (element.scrollTop < 300 && conversation.next && !olderError && !loading.current) {
      fills.current = 0;
      older();
    }
  };

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={onScroll}
      data-messages
      data-count={conversation.messages.length}
      data-first={conversation.messages[0]?.id}
      data-detached={conversation.detached ? "" : undefined}
    >
      {olderError ? (
        <div className="older-error" role="status" data-older-error>
          Couldn't load older messages: {olderError}
          {conversation.next ? (
            <button type="button" onClick={() => void onOlder()}>
              Try again
            </button>
          ) : null}
          <button type="button" onClick={onLatest}>
            Back to latest
          </button>
        </div>
      ) : short && conversation.next ? (
        <div className="older-more">
          <button
            type="button"
            data-load-older
            onClick={() => {
              fills.current = 0;
              older();
            }}
          >
            Load older messages
          </button>
        </div>
      ) : null}
      <div className="messages-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-key={row.key}
              ref={virtualizer.measureElement}
              className="row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "message" ? (
                <MessageRow
                  dot={dot}
                  message={row.message}
                  delivered={row.message.id === delivered}
                  blocked={blocked(row.message.id)}
                  onMenu={onMenu}
                  onOpenImage={onOpenImage}
                  onRestore={onRestore}
                  onRetry={unconfirmed(row.message.id) ? () => onRetry(row.message) : undefined}
                />
              ) : row.kind === "pending" ? (
                <PendingRow
                  dot={dot}
                  pending={row.pending}
                  sent={row.sent}
                  changing={changing.has(row.pending.id)}
                  onPending={onPending}
                  onCopyText={onCopyText}
                  onShareText={onShareText}
                />
              ) : (
                <div className="message owner pending" data-attempt-unknown>
                  {row.sent ? <SentPreview dot={dot} sent={row.sent.captured} /> : null}
                  <div className="status warning">
                    open-dot hasn't confirmed a message sent at {time(row.attempt.createdAt)}. It
                    won't be sent again; the app keeps checking.
                    <button type="button" onClick={() => onForget(row.attempt)}>
                      Stop tracking
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {busy ? <div className="typing">{dot} is working…</div> : null}
      {latest ? (
        <button
          type="button"
          className="latest"
          data-latest
          onClick={() => {
            if (conversation.detached) onLatest();
            else virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
            atBottom.current = true;
          }}
        >
          {conversation.detached ? "Back to latest" : "Latest ↓"}
        </button>
      ) : null}
    </div>
  );
};

const PendingRow = ({
  dot,
  pending,
  sent,
  changing,
  onPending,
  onCopyText,
  onShareText,
}: {
  dot: string;
  pending: PendingView;
  sent: Sent | undefined;
  changing: boolean;
  onPending: (pending: PendingView, change: "steer" | "cancel") => void;
  onCopyText: (text: string) => void;
  onShareText: (text: string) => void;
}) => {
  const actions = pendingActions(pending);
  const captured = sent?.captured;
  return (
    <div className="message owner pending" data-pending={pending.status} data-id={pending.id}>
      {captured ? <SentPreview dot={dot} sent={captured} /> : null}
      <div className="status">
        {pendingLabel[pending.status]}
        {actions.sendNow ? (
          <button
            type="button"
            disabled={changing}
            title="Join the dot's running turn at its next step instead of waiting for it to end"
            onClick={() => onPending(pending, "steer")}
          >
            Send now
          </button>
        ) : null}
        {actions.cancel ? (
          <button
            type="button"
            disabled={changing}
            title="Withdraw this message before the dot gets it"
            onClick={() => onPending(pending, "cancel")}
          >
            Cancel
          </button>
        ) : null}
        {captured?.text ? (
          <button type="button" onClick={() => onCopyText(captured.text)}>
            Copy
          </button>
        ) : null}
        {captured?.text && !captured.images.length ? (
          <button type="button" onClick={() => onShareText(captured.text)}>
            Share…
          </button>
        ) : null}
        {captured?.images.length ? (
          <span className="note">Its images copy and share once delivered.</span>
        ) : null}
      </div>
    </div>
  );
};

const MessageRow = ({
  dot,
  message,
  delivered,
  blocked,
  onMenu,
  onOpenImage,
  onRestore,
  onRetry,
}: {
  dot: string;
  message: MessageView;
  delivered: boolean;
  blocked: boolean;
  onMenu: (menu: Menu) => void;
  onOpenImage: (url: string) => void;
  onRestore: (message: MessageView) => void;
  // Only while the answer to the owner's last change was lost.
  onRetry?: (() => void) | undefined;
}) => {
  const open = (x: number, y: number) => {
    if (!blocked && !message.hidden) onMenu({ message, x, y });
  };
  const reactions = message.reactions.filter((reaction) => reaction.emoji);
  return (
    <div
      className={`message ${message.kind} ${message.hidden ? "hidden" : ""}`}
      data-message={message.id}
      data-kind={message.kind}
      data-blocked={blocked ? "" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        open(event.clientX, event.clientY);
      }}
    >
      {message.kind === "peer" ? (
        <div className="from">From {message.peer ?? "another dot"}</div>
      ) : null}
      {message.kind === "notice" ? <div className="from">Notice from open-dot</div> : null}
      {message.quote ? (
        <div className="quote">
          {message.quote.author === "owner" ? "You" : dot}: {message.quote.text}
        </div>
      ) : null}
      {message.feed ? <div className="feed-card">{message.feed.title}</div> : null}
      <div className="bubble">
        {message.kind === "owner" ? (
          message.text ? (
            <div className="plain">{message.text}</div>
          ) : null
        ) : message.text ? (
          <Markdown text={message.text} />
        ) : null}
        {message.tools.length ? (
          <div className="tools">
            {message.tools.map((tool, index) => (
              <span key={index} className="tool">
                {tool}
              </span>
            ))}
          </div>
        ) : null}
        {message.attachments.length ? (
          <div className="thumbs">
            {message.attachments.map((attachment) =>
              isImageType(attachment.mime) ? (
                <Thumb
                  key={attachment.index}
                  dot={dot}
                  message={message}
                  index={attachment.index}
                  name={fileName(attachment)}
                  onOpen={onOpenImage}
                />
              ) : (
                <span
                  key={attachment.index}
                  className="attachment-chip"
                  title={fileName(attachment)}
                >
                  📄 {fileName(attachment)}
                </span>
              ),
            )}
          </div>
        ) : null}
      </div>
      {reactions.length ? (
        <div className="reactions">
          {reactions.map((reaction) => (
            <span
              key={reaction.actor}
              className={`reaction ${reaction.actor}`}
              title={reaction.actor === "owner" ? "You" : dot}
            >
              {reaction.emoji}
            </span>
          ))}
        </div>
      ) : null}
      <div className="meta">
        <span>{time(message.time)}</span>
        {delivered ? <span className="delivered">Delivered</span> : null}
        {onRetry ? (
          <span className="unconfirmed" data-unconfirmed>
            Not confirmed yet{" "}
            <button
              type="button"
              title="open-dot didn't answer your last change to this message. Ask again for the same change."
              onClick={onRetry}
            >
              Try again
            </button>
          </span>
        ) : null}
        {message.hidden ? (
          <button type="button" disabled={blocked} onClick={() => onRestore(message)}>
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="more"
            aria-label="Message actions"
            aria-haspopup="menu"
            disabled={blocked}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              open(box.left, box.bottom);
            }}
          >
            ⋯
          </button>
        )}
      </div>
    </div>
  );
};

const tapbackNames: Record<string, string> = {
  "❤️": "Heart",
  "👍": "Thumbs Up",
  "👎": "Thumbs Down",
  "😂": "Ha Ha",
  "‼️": "Exclamation Marks",
  "❓": "Question Mark",
};

const MessageMenu = ({
  menu,
  dot,
  recent,
  blocked,
  onClose,
  onReact,
  onEmoji,
  onDetails,
  onReply,
  onCopy,
  onShare,
  onDelete,
}: {
  menu: Menu;
  dot: string;
  recent: string[];
  blocked: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onEmoji: () => void;
  onDetails: () => void;
  onReply: () => void;
  onCopy: () => void;
  onShare: () => void;
  onDelete: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus moves into the menu once when it opens, and returns where it was when it closes; polls
  // re-rendering the menu never move it.
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.querySelector<HTMLElement>("[role^='menuitem']:not(:disabled)")?.focus();
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? []),
    ];
    const active = document.activeElement;
    const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const move: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowRight: at + 1,
      ArrowUp: at - 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: items.length - 1,
    };
    const target = move[event.key];
    if (target === undefined || !items.length) return;
    event.preventDefault();
    items[(target + items.length) % items.length]?.focus();
  };
  const { message } = menu;
  const reactable = canReact(message) && !blocked;
  const mine = reactionOf(message, "owner");
  const row = recentTapbacks(recent);
  const unlisted = unlistedTapback(mine, row);
  const reacted = message.reactions.some((reaction) => reaction.emoji);
  const repliable = message.kind === "owner" || message.kind === "dot";
  const content = message.text !== "" || message.attachments.some((item) => isImageType(item.mime));
  const style = {
    left: Math.min(menu.x, window.innerWidth - 260),
    top: Math.min(menu.y, window.innerHeight - 360),
  };
  const tapback = (emoji: string, name: string) => (
    <button
      key={emoji}
      type="button"
      role="menuitemradio"
      aria-checked={mine === emoji}
      aria-label={mine === emoji ? `${name}, selected. Remove your Tapback` : `${name} Tapback`}
      title={mine === emoji ? `Remove your ${name}` : name}
      className={mine === emoji ? "chosen" : ""}
      disabled={!reactable}
      onClick={() => onReact(emoji)}
    >
      {emoji}
    </button>
  );
  const reasons = [
    blocked ? "Waiting for saved message state before another change." : undefined,
    message.kind === "dot" ? undefined : `Tapbacks are only for ${dot}'s messages.`,
    repliable ? undefined : `Reply is only for your messages and ${dot}'s.`,
    content ? undefined : "There's no text or image to copy or share.",
  ].filter((reason) => reason !== undefined);
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div
        className="menu"
        role="menu"
        aria-label="Message actions"
        ref={ref}
        style={style}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        {menu.details ? (
          <div className="details">
            {reacted
              ? message.reactions
                  .filter((reaction) => reaction.emoji)
                  .map((reaction) => (
                    <div key={reaction.actor}>
                      {reaction.emoji} {reaction.actor === "owner" ? "You" : dot}
                    </div>
                  ))
              : "No Tapbacks yet."}
          </div>
        ) : null}
        <div className="emoji-row" role="group" aria-label="Tapbacks">
          {tapbacks.map((emoji) => tapback(emoji, tapbackNames[emoji] ?? emoji))}
        </div>
        <div className="emoji-row" role="group" aria-label="More Tapbacks">
          {row.map((emoji) => tapback(emoji, emoji))}
          <button
            type="button"
            role="menuitem"
            aria-label="Choose any emoji as a Tapback"
            disabled={!reactable}
            onClick={onEmoji}
          >
            ☺︎…
          </button>
        </div>
        {unlisted ? (
          <button
            type="button"
            role="menuitemradio"
            aria-checked
            aria-label={`${unlisted}, selected. Remove your Tapback`}
            data-unlisted-tapback
            disabled={!reactable}
            onClick={() => onReact(unlisted)}
          >
            Your Tapback: {unlisted}
          </button>
        ) : null}
        <button type="button" role="menuitem" disabled={!reacted} onClick={onDetails}>
          Tapback details
        </button>
        <button type="button" role="menuitem" disabled={!repliable} onClick={onReply}>
          Reply
        </button>
        <button type="button" role="menuitem" disabled={!content} onClick={onCopy}>
          Copy
        </button>
        <button type="button" role="menuitem" disabled={!content} onClick={onShare}>
          Share…
        </button>
        <button
          type="button"
          role="menuitem"
          className="danger"
          disabled={blocked}
          onClick={onDelete}
        >
          Delete
        </button>
        {reasons.map((reason) => (
          <div key={reason} className="menu-note">
            {reason}
          </div>
        ))}
      </div>
    </div>
  );
};

const Workers = ({
  dot,
  onConfirm,
  onToast,
}: {
  dot: DotView;
  onConfirm: (confirm: { text: string; action: string; run: () => void }) => void;
  onToast: (toast: Toast) => void;
}) => {
  const [busy, setBusy] = useState(new Set<number>());
  if (!dot.workers.length && !dot.sessions.length) return null;
  const opened = (result: Result<{ opened: boolean; command?: string; error?: string }>) => {
    if (!result.ok) onToast({ text: result.error });
    else if (!result.value.opened)
      onToast({
        text: `Couldn't open a terminal${result.value.command ? "; the command is on the clipboard" : ""}.`,
      });
  };
  const stop = (id: number) => {
    setBusy((current) => new Set(current).add(id));
    void bridge.stopWorker(id).then((result) => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (!result.ok)
        onToast({
          text: result.lost
            ? "Couldn't confirm the stop. It may have stopped; the list shows what open-dot has."
            : `Not stopped. ${result.error}`,
        });
    });
  };
  const state = (needs: string[], waiting: string[], fallback: string) =>
    needs.length ? (
      <span className="needs" data-needs>
        Needs you
      </span>
    ) : waiting.length ? (
      <span className="handling">{dot.name} is handling it</span>
    ) : (
      <span>{fallback}</span>
    );
  return (
    <div className="workers">
      {dot.workers.map((worker) => {
        const actions = workerActions(worker.state);
        return (
          <div key={worker.id} className="worker" data-worker={worker.id} data-state={worker.state}>
            <span className="worker-task">{worker.task}</span>
            {state(
              worker.needs,
              worker.waiting,
              worker.state === "stopping" ? "stopping, not confirmed" : worker.state,
            )}
            {actions.open ? (
              <button type="button" onClick={() => void bridge.openWorker(worker.id).then(opened)}>
                Open
              </button>
            ) : null}
            {actions.stop ? (
              <button
                type="button"
                disabled={busy.has(worker.id)}
                onClick={() =>
                  onConfirm({
                    text: `Stop this worker? ${worker.task}`,
                    action: "Stop",
                    run: () => stop(worker.id),
                  })
                }
              >
                {worker.state === "stopping" ? "Stop again" : "Stop"}
              </button>
            ) : null}
          </div>
        );
      })}
      {dot.sessions.map((item) => (
        <div key={item.sessionID} className="worker" data-session={item.sessionID}>
          <span className="worker-task">{item.title ?? item.sessionID}</span>
          {state(item.needs, item.waiting, item.source)}
          <button type="button" onClick={() => void bridge.openRequest(item.request).then(opened)}>
            Open
          </button>
        </div>
      ))}
    </div>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
