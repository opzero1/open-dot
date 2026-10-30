/** @jsxImportSource react */
// The window: a sidebar of dots and the selected dot's chat. Drafts, unread marks and image blobs
// live only in this renderer's memory; the daemon owns every message.
import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
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
  Result,
} from "./bridge";
import {
  afterSend,
  applyIntents,
  backoff,
  canReact,
  capture,
  type Captured,
  type Conversation,
  deliveredID,
  type Draft,
  editDraft,
  emptyDraft,
  imageLimits,
  type Intent,
  mergeLatest,
  mergeOlder,
  pendingLabel,
  reactionOf,
  redoDraft,
  returnAction,
  sendOutcome,
  tapbacks,
  undoDraft,
  unreadSince,
} from "./chat";
import { Markdown } from "./Markdown";

const loaded = globalThis.openDot;
if (!loaded) throw new Error("The app's preload didn't load.");
const bridge: Bridge = loaded;

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

const useBlob = (key: string, load: () => Promise<Result<{ mime: string; data: Uint8Array }>>) => {
  const [url, setURL] = useState(() => blobs.get(key));
  useEffect(() => {
    let live = true;
    const known = blobs.get(key);
    if (known) setURL(known);
    else
      void load().then((result) => {
        if (live && result.ok) setURL(remember(key, result.value));
      });
    return () => {
      live = false;
    };
    // The key names exactly what load reads.
  }, [key]);
  return url;
};

const Avatar = ({ dot }: { dot: DotView }) => {
  const url = useBlob(`avatar:${dot.name}:${dot.avatar?.revision ?? "none"}`, () =>
    dot.avatar ? bridge.avatar(dot.name) : Promise.resolve({ ok: false, error: "none" }),
  );
  return url ? (
    <img className="avatar" src={url} alt="" />
  ) : (
    <span className="avatar placeholder">{dot.name.slice(0, 1).toUpperCase()}</span>
  );
};

const Thumb = ({
  dot,
  message,
  index,
  onOpen,
}: {
  dot: string;
  message: MessageView;
  index: number;
  onOpen: (url: string) => void;
}) => {
  const url = useBlob(`image:${dot}:${message.sessionID}:${message.id}:${index}`, () =>
    bridge.image(dot, message.id, message.sessionID, index),
  );
  return url ? (
    <button type="button" className="thumb" onClick={() => onOpen(url)} aria-label="Open image">
      <img src={url} alt="" />
    </button>
  ) : (
    <span className="thumb loading" />
  );
};

const DraftThumb = ({ image, onRemove }: { image: DraftImage; onRemove: () => void }) => {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mime })),
    [image],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <span className="draft-thumb">
      <img src={url} alt={image.name} />
      <button type="button" aria-label={`Remove ${image.name}`} onClick={onRemove}>
        ×
      </button>
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
  | { kind: "pending"; key: string; pending: PendingView; sent?: Captured | undefined }
  | { kind: "attempt"; key: string; attempt: Attempt };

const singleEmoji = /^\p{RGI_Emoji}$/v;

const App = () => {
  const [dots, setDots] = useState<DotView[]>([]);
  const [dotsError, setDotsError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [conversations, setConversations] = useState(new Map<string, Conversation>());
  const [readErrors, setReadErrors] = useState(new Map<string, string>());
  const [recent, setRecent] = useState<string[]>([]);
  const [intents, setIntents] = useState(new Map<string, Map<string, Intent>>());
  const [drafts, setDrafts] = useState(new Map<string, Draft>());
  const [seen, setSeen] = useState(new Map<string, string>());
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [sending, setSending] = useState(new Set<string>());
  const [sent, setSent] = useState(new Map<string, Captured>());
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<Menu>();
  const [viewer, setViewer] = useState<string>();
  const [toast, setToast] = useState<Toast>();
  const [confirm, setConfirm] = useState<{ text: string; action: string; run: () => void }>();
  const [capturing, setCapturing] = useState<{ dot: string; message: MessageView }>();
  const [shortcut, setShortcut] = useState(true);
  const [sendAnyway, setSendAnyway] = useState(false);
  const [composerError, setComposerError] = useState<string>();

  const conversation = selected ? conversations.get(selected) : undefined;
  const dot = dots.find((item) => item.name === selected);
  const draft = (selected && drafts.get(selected)) || emptyDraft();

  const setDraft = useCallback((name: string, change: (draft: Draft) => Draft) => {
    setDrafts((current) => new Map(current).set(name, change(current.get(name) ?? emptyDraft())));
  }, []);

  const showToast = useCallback((next: Toast) => {
    setToast(next);
    setTimeout(() => setToast((shown) => (shown === next ? undefined : shown)), 10_000);
  }, []);

  // Reads: the selected chat every second, dots every two, other chats every thirty.

  const failures = useRef(new Map<string, number>());
  const due = useRef(new Map<string, number>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dotsRef = useRef(dots);
  dotsRef.current = dots;

  const applyPage = useCallback((name: string, page: PageView) => {
    setConversations((current) => {
      const previous = current.get(name);
      if (previous && previous.sessionID !== page.sessionID) {
        // A new session: old actions, quotes and intents no longer apply; the draft text stays.
        setIntents((all) => {
          const next = new Map(all);
          next.delete(name);
          return next;
        });
        setDrafts((all) => {
          const kept = all.get(name);
          return kept?.quote ? new Map(all).set(name, { ...kept, quote: undefined }) : all;
        });
        setMenu(undefined);
        setCapturing(undefined);
      }
      return new Map(current).set(name, mergeLatest(previous, page));
    });
    setRecent(page.recentEmojis);
    setReadErrors((current) => {
      const next = new Map(current);
      if (page.refreshError) next.set(name, page.refreshError);
      else next.delete(name);
      return next;
    });
    setSeen((current) => {
      const last = page.messages.at(-1)?.id;
      // The first successful read is the baseline: nothing before it counts as unread.
      if (!last || (current.has(name) && !(name === selectedRef.current && document.hasFocus())))
        return current;
      return new Map(current).set(name, last);
    });
  }, []);

  const readChat = useCallback(
    async (name: string) => {
      const result = await bridge.messages(name);
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

  const refreshAttempts = useCallback(async () => {
    const known = await bridge.attempts();
    for (const attempt of known) await bridge.reconcile(attempt);
    setAttempts(await bridge.attempts());
  }, []);

  useEffect(() => {
    const run = { stopped: false };
    let dotsDue = 0;
    let dotFailures = 0;
    const tick = async () => {
      const now = Date.now();
      if (now >= dotsDue) {
        dotsDue = Infinity;
        const result = await bridge.dots();
        if (result.ok) {
          dotFailures = 0;
          dotsDue = Date.now() + 2000;
          setDots(result.value);
          setDotsError(undefined);
          setSelected((current) =>
            current && result.value.some((item) => item.name === current)
              ? current
              : result.value[0]?.name,
          );
          await refreshAttempts();
        } else {
          dotFailures++;
          dotsDue = Date.now() + backoff(dotFailures) * 1000;
          setDotsError(result.error);
        }
      }
    };
    const chats = async () => {
      const now = Date.now();
      const names = [
        ...new Set([selectedRef.current, ...dotsRef.current.map((item) => item.name)]),
      ];
      await Promise.all(
        names.map(async (name) => {
          if (!name || now < (due.current.get(name) ?? 0)) return;
          due.current.set(name, Infinity);
          await readChat(name);
          if (due.current.get(name) === Infinity)
            due.current.set(name, Date.now() + (name === selectedRef.current ? 1000 : 30_000));
        }),
      );
    };
    const loop = async () => {
      while (!run.stopped) {
        await Promise.all([tick(), chats()]).catch(() => {});
        await new Promise((done) => setTimeout(done, 250));
      }
    };
    void loop();
    return () => {
      run.stopped = true;
    };
  }, [readChat, refreshAttempts]);

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
          unreadSince(conversations.get(item.name)?.messages ?? [], seen.get(item.name)),
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
    const last = conversation?.messages.at(-1)?.id;
    if (selected && last && seen.get(selected) !== last && document.hasFocus())
      setSeen((current) => new Map(current).set(selected, last));
  }, [selected, conversation, seen]);

  const shown = useMemo(() => {
    if (!conversation || !selected) return [];
    return applyIntents(conversation.messages, intents.get(selected) ?? new Map()).messages;
  }, [conversation, intents, selected]);

  // Intents a read has shown are done.
  useEffect(() => {
    if (!conversation || !selected) return;
    const mine = intents.get(selected);
    if (!mine?.size) return;
    const { waiting } = applyIntents(conversation.messages, mine);
    if (waiting.size !== mine.size)
      setIntents((current) => new Map(current).set(selected, waiting));
  }, [conversation, intents, selected]);

  const blocked = (id: string) => intents.get(selected ?? "")?.has(id) ?? false;

  const intend = (name: string, message: MessageView, intent: Omit<Intent, "sessionID">) =>
    setIntents((current) => {
      const mine = new Map(current.get(name));
      mine.set(message.id, { ...mine.get(message.id), ...intent, sessionID: message.sessionID });
      return new Map(current).set(name, mine);
    });

  const dropIntent = (name: string, id: string) =>
    setIntents((current) => {
      const mine = new Map(current.get(name));
      mine.delete(id);
      return new Map(current).set(name, mine);
    });

  /** A change the daemon refused is dropped; a lost one stays shown until a read settles it. */
  const mutate = async (
    name: string,
    message: MessageView,
    intent: Omit<Intent, "sessionID">,
    call: () => Promise<Result<true>>,
  ) => {
    if (blocked(message.id)) return false;
    intend(name, message, intent);
    const result = await call();
    if (!result.ok && !result.lost) {
      dropIntent(name, message.id);
      showToast({ text: result.error });
    } else if (!result.ok)
      showToast({ text: "Couldn't confirm that change. It shows once open-dot does." });
    due.current.set(name, 0);
    return result.ok;
  };

  const react = (message: MessageView, emoji: string) => {
    if (!selected) return;
    const next = reactionOf(message, "owner") === emoji ? null : emoji;
    void mutate(selected, message, { emoji: next }, () =>
      bridge.react(selected, message.id, message.sessionID, next),
    );
    setMenu(undefined);
  };

  const hide = (message: MessageView, hidden: boolean) => {
    if (!selected) return;
    const name = selected;
    void mutate(name, message, { hidden }, () =>
      bridge.hide(name, message.id, message.sessionID, hidden),
    ).then((done) => {
      if (done && hidden)
        showToast({
          text: "Message deleted from the app.",
          undo: () => hide({ ...message, hidden: true }, false),
        });
    });
  };

  // The composer.

  const unknownHere = attempts.filter((attempt) => attempt.dot === selected);

  const send = async () => {
    if (!selected || !conversation || sending.has(selected)) return;
    const name = selected;
    const captured = capture(draft);
    if (!captured.text.trim() && !captured.images.length) return;
    if (unknownHere.length && !sendAnyway) {
      setComposerError(
        "An earlier message's delivery is still unknown. Check the conversation first, or choose Send anyway.",
      );
      return;
    }
    setComposerError(undefined);
    setSending((current) => new Set(current).add(name));
    const result = await bridge.send({
      dot: name,
      sessionID: conversation.sessionID,
      text: captured.text,
      ...(captured.quote ? { replyTo: captured.quote.id } : {}),
      images: captured.images,
    });
    setSending((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setSendAnyway(false);
    if (result.ok) {
      setSent((current) => new Map(current).set(result.value.id, captured));
      setDraft(name, (current) => afterSend(current, captured));
      due.current.set(name, 0);
      return;
    }
    // The draft stays either way; nothing is sent again on its own.
    setComposerError(
      sendOutcome(result) === "unknown"
        ? "open-dot didn't confirm this message. It may still arrive; the app is checking."
        : result.error,
    );
    setAttempts(await bridge.attempts());
  };

  const attach = async (name: string, files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const count = drafts.get(name)?.images.length ?? 0;
      if (count >= imageLimits.count) return setComposerError("Attach at most five images.");
      if (file.size === 0 || file.size > imageLimits.bytes)
        return setComposerError("Each image can be at most 10 MiB.");
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await bridge.ingest({ name: file.name, data });
      if (!result.ok) return setComposerError(result.error);
      setDraft(name, (current) =>
        current.images.length >= imageLimits.count
          ? current
          : { ...current, images: [...current.images, result.value] },
      );
    }
    setComposerError(undefined);
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
    for (const pending of conversation?.pending ?? [])
      if (!ids.has(pending.id))
        listed.push({
          kind: "pending",
          key: `p:${pending.id}`,
          pending,
          sent: sent.get(pending.id),
        });
    for (const attempt of unknownHere)
      listed.push({ kind: "attempt", key: `a:${attempt.messageID}`, attempt });
    return listed;
  }, [shown, showHidden, conversation, sent, unknownHere]);

  const delivered = conversation ? deliveredID(shown, conversation.pending) : undefined;

  const loadOlder = async () => {
    if (!selected || !conversation?.next) return;
    const name = selected;
    const result = await bridge.messages(name, conversation.next);
    if (result.ok)
      setConversations((current) => {
        const known = current.get(name);
        return known ? new Map(current).set(name, mergeOlder(known, result.value)) : current;
      });
  };

  const backToLatest = () => {
    if (!selected) return;
    setConversations((current) => {
      const next = new Map(current);
      next.delete(selected);
      return next;
    });
    due.current.set(selected, 0);
  };

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
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
              onMenu={setMenu}
              onOpenImage={setViewer}
              onOlder={loadOlder}
              onLatest={backToLatest}
              onRestore={(message) => hide(message, false)}
              onPending={(pending, change) => {
                void bridge.pending(dot.name, pending.id, change).then((result) => {
                  if (!result.ok) showToast({ text: result.error });
                  due.current.set(dot.name, 0);
                });
              }}
              onForget={(attempt) => {
                setConfirm({
                  text: "Stop tracking this message? open-dot never confirmed it, and it won't be sent again.",
                  action: "Stop tracking",
                  run: () => void bridge.forget(attempt.messageID).then(refreshAttempts),
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
                    <DraftThumb
                      key={index}
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
                <div className="composer-error">
                  {composerError}
                  {unknownHere.length ? (
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
      {menu && selected ? (
        <MessageMenu
          menu={menu}
          recent={recent}
          onClose={() => setMenu(undefined)}
          onReact={(emoji) => react(menu.message, emoji)}
          onEmoji={() => {
            setCapturing({ dot: selected, message: menu.message });
            setMenu(undefined);
          }}
          onDetails={() => setMenu({ ...menu, details: true })}
          onReply={() => {
            setDraft(selected, (current) => ({
              ...current,
              quote: {
                id: menu.message.id,
                author: menu.message.kind === "owner" ? "owner" : "dot",
                text: menu.message.text.slice(0, 240),
              },
            }));
            setMenu(undefined);
          }}
          onCopy={() => {
            void bridge
              .copyMessage(selected, menu.message.id, menu.message.sessionID)
              .then((result) => {
                if (!result.ok) showToast({ text: `Nothing was copied: ${result.error}` });
              });
            setMenu(undefined);
          }}
          onShare={() => {
            void bridge
              .shareMessage(selected, menu.message.id, menu.message.sessionID)
              .then((result) => {
                if (!result.ok) showToast({ text: result.error });
              });
            setMenu(undefined);
          }}
          onDelete={() => {
            const message = menu.message;
            setMenu(undefined);
            setConfirm({
              text: "Delete this message from the app? It stays in the dot's history and context.",
              action: "Delete",
              run: () => hide(message, true),
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
            if (singleEmoji.test(value) && target.dot === selected) react(target.message, value);
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
                toast.undo?.();
                setToast(undefined);
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

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The index of the list row holding a node, when it's in this list. */
const rowIndex = (list: HTMLElement | null, node: Node | null | undefined) => {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>("[data-index]");
  return row && list?.contains(row) ? Number(row.dataset.index) : undefined;
};

const MessageList = ({
  dot,
  rows,
  conversation,
  delivered,
  busy,
  blocked,
  onMenu,
  onOpenImage,
  onOlder,
  onLatest,
  onRestore,
  onPending,
  onForget,
}: {
  dot: string;
  rows: Row[];
  conversation: Conversation;
  delivered: string | undefined;
  busy: boolean;
  blocked: (id: string) => boolean;
  onMenu: (menu: Menu) => void;
  onOpenImage: (url: string) => void;
  onOlder: () => Promise<void>;
  onLatest: () => void;
  onRestore: (message: MessageView) => void;
  onPending: (pending: PendingView, change: "steer" | "cancel") => void;
  onForget: (attempt: Attempt) => void;
}) => {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [latest, setLatest] = useState(false);
  const loading = useRef(false);
  // Rows a selection spans stay rendered, so a selection across messages survives scrolling.
  const selection = useRef<[number, number] | undefined>(undefined);

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    const span = selection.current;
    if (span)
      for (let index = span[0]; index <= Math.min(span[1], span[0] + 300); index++)
        indexes.add(index);
    return [...indexes].filter((index) => index < range.count).toSorted((a, b) => a - b);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => rows[index]?.key ?? index,
    rangeExtractor,
  });

  useEffect(() => {
    const update = () => {
      const current = document.getSelection();
      const anchor = rowIndex(scroller.current, current?.anchorNode);
      const focus = rowIndex(scroller.current, current?.focusNode);
      selection.current =
        current && !current.isCollapsed && anchor !== undefined && focus !== undefined
          ? [Math.min(anchor, focus), Math.max(anchor, focus)]
          : undefined;
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  // New rows keep the view at the bottom when it was there.
  useLayoutEffect(() => {
    if (atBottom.current && rows.length)
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setLatest(!atBottom.current || conversation.detached);
    if (element.scrollTop < 300 && conversation.next && !loading.current) {
      loading.current = true;
      void onOlder().finally(() => {
        loading.current = false;
      });
    }
  };

  return (
    <div className="messages" ref={scroller} onScroll={onScroll} data-messages>
      <div className="messages-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
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
                />
              ) : row.kind === "pending" ? (
                <div className="message owner pending" data-pending={row.pending.status}>
                  <div className="bubble">
                    {row.sent?.text ? <div className="plain">{row.sent.text}</div> : null}
                    {row.sent?.images.length ? (
                      <div className="note">{row.sent.images.length} image(s)</div>
                    ) : null}
                  </div>
                  <div className="status">
                    {pendingLabel[row.pending.status]}
                    {row.pending.status !== "confirming" && row.pending.delivery !== "steer" ? (
                      <button type="button" onClick={() => onPending(row.pending, "steer")}>
                        Send now
                      </button>
                    ) : null}
                    {row.pending.status !== "confirming" ? (
                      <button type="button" onClick={() => onPending(row.pending, "cancel")}>
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="message owner pending" data-attempt-unknown>
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

const MessageRow = ({
  dot,
  message,
  delivered,
  blocked,
  onMenu,
  onOpenImage,
  onRestore,
}: {
  dot: string;
  message: MessageView;
  delivered: boolean;
  blocked: boolean;
  onMenu: (menu: Menu) => void;
  onOpenImage: (url: string) => void;
  onRestore: (message: MessageView) => void;
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
            {message.attachments.map((attachment) => (
              <Thumb
                key={attachment.index}
                dot={dot}
                message={message}
                index={attachment.index}
                onOpen={onOpenImage}
              />
            ))}
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
        {message.hidden ? (
          <button type="button" onClick={() => onRestore(message)}>
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="more"
            aria-label="Message actions"
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

const MessageMenu = ({
  menu,
  recent,
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
  recent: string[];
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
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const close = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  const { message } = menu;
  const reactable = canReact(message);
  const mine = reactionOf(message, "owner");
  const style = {
    left: Math.min(menu.x, window.innerWidth - 260),
    top: Math.min(menu.y, window.innerHeight - 320),
  };
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div
        className="menu"
        role="menu"
        ref={ref}
        style={style}
        onClick={(event) => event.stopPropagation()}
      >
        {menu.details ? (
          <div className="details">
            {message.reactions.filter((reaction) => reaction.emoji).length
              ? message.reactions
                  .filter((reaction) => reaction.emoji)
                  .map((reaction) => (
                    <div key={reaction.actor}>
                      {reaction.emoji} {reaction.actor === "owner" ? "You" : "The dot"}
                    </div>
                  ))
              : "No Tapbacks yet."}
          </div>
        ) : null}
        {reactable ? (
          <>
            <div className="emoji-row">
              {tapbacks.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className={mine === emoji ? "chosen" : ""}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="emoji-row">
              {recent.slice(0, 5).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className={mine === emoji ? "chosen" : ""}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              ))}
              <button type="button" role="menuitem" aria-label="More emoji" onClick={onEmoji}>
                ☺︎…
              </button>
            </div>
          </>
        ) : null}
        <button type="button" role="menuitem" onClick={onDetails}>
          Tapback details
        </button>
        {message.kind === "owner" || message.kind === "dot" ? (
          <button type="button" role="menuitem" onClick={onReply}>
            Reply
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={onCopy}>
          Copy
        </button>
        <button type="button" role="menuitem" onClick={onShare}>
          Share…
        </button>
        <button type="button" role="menuitem" className="danger" onClick={onDelete}>
          Delete
        </button>
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
  if (!dot.workers.length && !dot.sessions.length) return null;
  const opened = (result: Result<{ opened: boolean; command?: string; error?: string }>) => {
    if (!result.ok) onToast({ text: result.error });
    else if (!result.value.opened)
      onToast({
        text: `Couldn't open a terminal${result.value.command ? "; the command is on the clipboard" : ""}.`,
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
      {dot.workers.map((worker) => (
        <div key={worker.id} className="worker" data-worker={worker.id}>
          <span className="worker-task">{worker.task}</span>
          {state(worker.needs, worker.waiting, worker.state)}
          <button type="button" onClick={() => void bridge.openWorker(worker.id).then(opened)}>
            Open
          </button>
          {worker.state === "running" ? (
            <button
              type="button"
              onClick={() =>
                onConfirm({
                  text: `Stop this worker? ${worker.task}`,
                  action: "Stop",
                  run: () =>
                    void bridge.stopWorker(worker.id).then((result) => {
                      if (!result.ok) onToast({ text: result.error });
                    }),
                })
              }
            >
              Stop
            </button>
          ) : null}
        </div>
      ))}
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
