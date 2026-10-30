/** @jsxImportSource react */
// The feed: unread items from GitHub, Linear and Slack, oldest first. Each can be opened,
// dismissed or replied to: a reply sends one message per picked dot, each once, by its saved ID.
// Items handed off to dots can be replied to again.
import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DotView, DraftImage, FeedItem, Reply, SendResult } from "./bridge";
import { imageLimits } from "./chat";
import {
  type FeedReply,
  FeedReplies,
  FeedState,
  feedPrompts,
  shortAgo,
  sourceNames,
} from "./surfaces";
import { bridge, LocalThumb } from "./ui";

type ReplyBox = FeedReply<DraftImage>;

// Reply drafts and what each dot's send came to, kept while the window lives, so leaving the Feed,
// Escape or the item moving to Handed off never drops one.
const replies = new FeedReplies<DraftImage>();
let mounted = 0;

const dismissal = (result: Extract<Reply<unknown>, { ok: false }>) =>
  result.lost
    ? "Couldn't confirm the dismissal. It may have worked; the next refresh shows it."
    : result.error;

export const Feed = ({
  dots,
  selected,
  sessionFor,
  onSent,
  onOpenChat,
}: {
  dots: DotView[];
  selected: string | undefined;
  /** The dot's current session, as its chat has it or as the daemon says now. */
  sessionFor: (dot: string) => Promise<string | undefined>;
  onSent: (dot: string) => void;
  onOpenChat: (dot: string) => void;
}) => {
  const state = useRef(new FeedState());
  const [, setTick] = useState(0);
  const render = useCallback(() => setTick((tick) => tick + 1), []);
  const [remaining, setRemaining] = useState(0);
  const [handedOff, setHandedOff] = useState<FeedItem[]>([]);
  const [handedOpen, setHandedOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
    };
  }, []);

  /** Asks the daemon what became of each unknown reply send, by its ID; nothing is sent again. */
  const reconcile = useCallback(async () => {
    for (const { id, dot, attempt } of replies.unknown()) {
      const result = await bridge.reconcile(attempt);
      if (result.ok && replies.settle(id, dot, result.value)) render();
    }
  }, [render]);

  const refresh = useCallback(async () => {
    const poll = state.current.startPoll();
    const result = await bridge.call("feed");
    if (!state.current.isCurrent(poll)) return;
    if (!result.ok) {
      setError(`The feed isn't up to date: ${result.error}`);
      return;
    }
    setError(undefined);
    state.current.apply(poll, result.value.items);
    setRemaining(result.value.remaining);
    setHandedOff(result.value.handedOff);
    setLoaded(true);
    render();
    void reconcile();
  }, [render, reconcile]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const dismiss = async (item: FeedItem) => {
    state.current.dismiss([item.id]);
    render();
    const result = await bridge.call("dismiss", item.id);
    state.current.finish([item], new Set(result.ok ? [item.id] : []), () =>
      result.ok ? "" : dismissal(result),
    );
    render();
  };

  // Dismisses exactly the unread items shown now, in one request. Items that arrive meanwhile stay.
  const clearAll = async () => {
    const shown = state.current.items;
    if (!shown.length) return;
    const ids = shown.map((item) => item.id);
    state.current.dismiss(ids);
    render();
    const result = await bridge.call("dismissAll", ids);
    if (!result.ok) {
      const message = dismissal(result);
      state.current.finish(shown, new Set(), () => message);
    } else {
      const done = new Set(result.value.dismissed);
      const missing = new Set(result.value.missing);
      state.current.finish(shown, done, (id) =>
        missing.has(id) ? "There's no such feed item." : "The daemon didn't confirm this one.",
      );
    }
    render();
    if (remaining > 0) void refresh();
  };

  const startReply = (item: FeedItem) => {
    replies.open(item, selected ?? dots[0]?.name);
    render();
  };

  const attach = async (id: number, files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const box = replies.boxes.get(id);
      if (!box || box.sending) return;
      if (box.images.length >= imageLimits.count) return;
      if (file.size === 0 || file.size > imageLimits.bytes) continue;
      const result = await bridge.ingest({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      });
      if (!result.ok) continue;
      if (
        replies.change(id, (current) =>
          current.images.length < imageLimits.count
            ? { images: [...current.images, result.value] }
            : {},
        )
      )
        render();
    }
  };

  /**
   * Captures the recipients, their sessions, the text, the images and the item once, then sends
   * one message to each dot in turn. A dot whose send was saved, or whose outcome is unknown and is
   * reconciled by its ID, is never sent this reply again; one that refused stays picked.
   */
  const send = async (id: number) => {
    const captured = replies.begin(id);
    if (!captured) return;
    render();
    const sessions = new Map<string, string | undefined>();
    for (const dot of captured.dots) sessions.set(dot, await sessionFor(dot));
    for (const dot of captured.dots) {
      const sessionID = sessions.get(dot);
      if (!sessionID) {
        replies.record(id, dot, {
          outcome: "refused",
          error: "its conversation couldn't be read, so nothing was sent.",
        });
        render();
        continue;
      }
      let result: SendResult;
      try {
        result = await bridge.send({
          dot,
          sessionID,
          text: captured.text,
          feed: captured.item,
          images: captured.images,
        });
      } catch {
        result = { outcome: "unknown", id: "", error: "No answer." };
      }
      if (result.outcome === "saved") replies.record(id, dot, { outcome: "saved" });
      else if (result.outcome === "unknown")
        replies.record(id, dot, {
          outcome: "unknown",
          error: "open-dot didn't confirm it. It's checked by its ID and never sent again.",
          ...(result.id
            ? { attempt: { dot, sessionID, messageID: result.id, createdAt: Date.now() } }
            : {}),
        });
      else replies.record(id, dot, { outcome: "refused", error: result.error });
      onSent(dot);
      render();
    }
    const done = replies.end(id, captured.dots);
    render();
    void refresh();
    const first = captured.dots[0];
    if (done === "done" && first && mounted > 0) onOpenChat(first);
  };

  const items = state.current.items;
  const overflow = state.current.overflow;
  const more = remaining + overflow;
  const listed = new Set([...items, ...handedOff].map((item) => item.id));
  // Replies whose item left both lists, such as one dismissed elsewhere, still show.
  const elsewhere = [...replies.boxes.values()].filter((box) => !listed.has(box.item.id));

  const editor = (id: number) => {
    const box = replies.boxes.get(id);
    if (!box) return null;
    return (
      <ReplyEditor
        box={box}
        dots={dots}
        canPick={(dot) => replies.canPick(id, dot)}
        onChange={(change) => {
          if (replies.change(id, change)) render();
        }}
        onAttach={(files) => void attach(id, files)}
        onSend={() => void send(id)}
        onCancel={() => {
          if (replies.cancel(id)) render();
        }}
      />
    );
  };

  return (
    <div className="pane feed" aria-label="Feed" data-pane="feed">
      <header className="pane-head">
        <h2>Feed</h2>
        <div className="pane-tools">
          {items.length ? (
            <span className="count" data-feed-count>
              {more > 0 ? `${items.length} shown · at least ${more} more` : `${items.length}`}
            </span>
          ) : null}
          <button type="button" disabled={!items.length} onClick={() => void clearAll()}>
            Clear all
          </button>
        </div>
      </header>
      {error ? <div className="banner">{error}</div> : null}
      <div className="pane-body">
        {loaded && !items.length ? (
          <p className="empty-line">Nothing needs you right now.</p>
        ) : null}
        <ul className="feed-list">
          {items.map((item) => {
            const failure = state.current.errors.get(item.id);
            return (
              <li key={item.id} className="feed-item" data-feed-item={item.id}>
                <div className="feed-line">
                  <span className="feed-source">{sourceNames[item.source] ?? item.source}</span>
                  <span className="feed-reason">{item.reason}</span>
                  <span className="feed-time">{shortAgo(item.time)}</span>
                </div>
                <div className="feed-title">{item.title}</div>
                <div className="feed-context">{item.context}</div>
                {failure ? (
                  <div className="item-error" role="alert">
                    {failure}
                  </div>
                ) : null}
                <div className="item-actions">
                  {item.url ? (
                    <button type="button" onClick={() => void bridge.openLink(item.url ?? "")}>
                      Open
                    </button>
                  ) : null}
                  <button type="button" onClick={() => startReply(item)}>
                    Reply
                  </button>
                  <button
                    type="button"
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => void dismiss(item)}
                  >
                    Dismiss
                  </button>
                </div>
                {editor(item.id)}
              </li>
            );
          })}
        </ul>
        {more > 0 ? <p className="note">More unread items will appear on refresh.</p> : null}
        {handedOff.length ? (
          <details
            className="handed-off"
            open={handedOpen || handedOff.some((item) => replies.boxes.has(item.id))}
            onToggle={(event) => setHandedOpen(event.currentTarget.open)}
          >
            <summary>Handed off ({handedOff.length})</summary>
            <ul>
              {handedOff.map((item) => (
                <li key={item.id} data-handed-off={item.id}>
                  <span className="feed-title">{item.title}</span>{" "}
                  <span className="note">→ {(item.handedTo ?? []).join(", ")}</span>
                  <div className="item-actions">
                    {item.url ? (
                      <button type="button" onClick={() => void bridge.openLink(item.url ?? "")}>
                        Open
                      </button>
                    ) : null}
                    <button type="button" onClick={() => startReply(item)}>
                      Reply
                    </button>
                  </div>
                  {editor(item.id)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {elsewhere.length ? (
          <ul className="feed-list">
            {elsewhere.map((box) => (
              <li key={box.item.id} className="feed-item" data-feed-reply-only={box.item.id}>
                <div className="feed-title">{box.item.title}</div>
                <div className="note">No longer in the feed. Your reply is kept here.</div>
                {editor(box.item.id)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
};

const imageFiles = (list: FileList) => [...list].filter((file) => file.type.startsWith("image/"));

const outcomeWords = { saved: "Saved", unknown: "Not confirmed", refused: "Not sent" } as const;

const ReplyEditor = ({
  box,
  dots,
  canPick,
  onChange,
  onAttach,
  onSend,
  onCancel,
}: {
  box: ReplyBox;
  dots: DotView[];
  canPick: (dot: string) => boolean;
  onChange: (change: (box: ReplyBox) => Partial<ReplyBox>) => void;
  onAttach: (files: File[]) => void;
  onSend: () => void;
  onCancel: () => void;
}) => {
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = imageFiles(event.clipboardData.files);
    if (!images.length) return;
    event.preventDefault();
    onAttach(images);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onAttach(imageFiles(event.dataTransfer.files));
  };
  const picked = box.dots;
  const results = [...box.results];
  return (
    <div
      className="reply-box"
      role="group"
      aria-label={`Reply to ${box.item.title}`}
      data-reply={box.item.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <fieldset className="reply-dots" disabled={box.sending}>
        <legend>Send to</legend>
        {dots.map((dot) => (
          <label key={dot.name}>
            <input
              type="checkbox"
              checked={picked.includes(dot.name)}
              disabled={!canPick(dot.name)}
              onChange={() =>
                onChange((current) => ({
                  dots: current.dots.includes(dot.name)
                    ? current.dots.filter((name) => name !== dot.name)
                    : [...current.dots, dot.name],
                }))
              }
            />{" "}
            {dot.name}
          </label>
        ))}
      </fieldset>
      <div className="item-actions">
        <button
          type="button"
          disabled={box.sending}
          onClick={() => onChange(() => ({ text: feedPrompts.start }))}
        >
          Start on it
        </button>
        <button
          type="button"
          disabled={box.sending}
          onClick={() => onChange(() => ({ text: feedPrompts.context }))}
        >
          Use as context
        </button>
      </div>
      <textarea
        aria-label={picked.length ? `Prompt for ${picked.join(", ")}` : "Prompt"}
        placeholder={picked.length ? `Prompt for ${picked.join(", ")}` : "Pick a dot first"}
        title="Paste or drop images to attach them."
        value={box.text}
        readOnly={box.sending}
        onChange={(event) => {
          const text = event.target.value;
          onChange(() => ({ text }));
        }}
        onPaste={onPaste}
      />
      {box.images.length ? (
        <div className="draft-images">
          {box.images.map((image, index) => (
            <LocalThumb
              key={index}
              className="draft-thumb"
              image={image}
              {...(box.sending
                ? {}
                : {
                    onRemove: () =>
                      onChange((current) => ({
                        images: current.images.filter((other) => other !== image),
                      })),
                  })}
            />
          ))}
        </div>
      ) : null}
      {results.length ? (
        <ul className="reply-results" aria-live="polite" data-reply-results>
          {results.map(([dot, result]) => (
            <li key={dot} data-reply-result={dot} data-outcome={result.outcome}>
              {dot}: {outcomeWords[result.outcome]}
              {result.error ? `. ${result.error}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="item-actions">
        <button type="button" onClick={onCancel} disabled={box.sending}>
          {results.length ? "Discard" : "Cancel"}
        </button>
        <button
          type="button"
          className="send"
          disabled={box.sending || !picked.length || !box.text.trim()}
          onClick={onSend}
        >
          {box.sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
};
