/** @jsxImportSource react */
// The feed: unread items from GitHub, Linear and Slack, oldest first. Each can be opened,
// dismissed or replied to: a reply sends one message per picked dot, each once, by its saved ID.
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
  FeedState,
  feedPrompts,
  type ReplyOutcome,
  shortAgo,
  sourceNames,
  unsentRecipients,
} from "./surfaces";
import { bridge } from "./ui";

interface ReplyBox {
  item: FeedItem;
  dots: string[];
  text: string;
  images: DraftImage[];
  sending: boolean;
  problems: { dot: string; error: string }[];
}

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
  const render = () => setTick((tick) => tick + 1);
  const [remaining, setRemaining] = useState(0);
  const [handedOff, setHandedOff] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [reply, setReply] = useState<ReplyBox>();
  const replyRef = useRef(reply);
  replyRef.current = reply;

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
  }, []);

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

  const startReply = (item: FeedItem) =>
    setReply((current) =>
      current?.item.id === item.id
        ? current
        : {
            item,
            dots: (selected ?? dots[0]?.name) ? [selected ?? dots[0]?.name ?? ""] : [],
            text: "",
            images: [],
            sending: false,
            problems: [],
          },
    );

  const attach = async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const box = replyRef.current;
      if (!box || box.sending) return;
      if (box.images.length >= imageLimits.count) return;
      if (file.size === 0 || file.size > imageLimits.bytes) continue;
      const result = await bridge.ingest({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      });
      if (!result.ok) continue;
      setReply((current) =>
        current && !current.sending && current.images.length < imageLimits.count
          ? { ...current, images: [...current.images, result.value] }
          : current,
      );
    }
  };

  /**
   * Captures the recipients, text, images and item once, then sends one message to each dot in
   * turn. A dot whose send was saved, or whose outcome is unknown and is being reconciled by its
   * ID, is never sent this reply again; one that was refused stays picked to try again.
   */
  const send = async () => {
    const box = replyRef.current;
    if (!box || box.sending) return;
    const text = box.text.trim();
    if (!text || !box.dots.length) return;
    const captured = { item: box.item.id, text, images: [...box.images], dots: [...box.dots] };
    setReply({ ...box, sending: true, problems: [] });
    const outcomes = new Map<string, ReplyOutcome>();
    const problems: { dot: string; error: string }[] = [];
    for (const dot of captured.dots) {
      const sessionID = await sessionFor(dot);
      if (!sessionID) {
        outcomes.set(dot, "refused");
        problems.push({ dot, error: "its conversation couldn't be read, so nothing was sent." });
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
      if (result.outcome === "saved") outcomes.set(dot, "saved");
      else if (result.outcome === "unknown") {
        outcomes.set(dot, "unknown");
        problems.push({
          dot,
          error: "open-dot didn't confirm it. Its chat checks by ID and won't send it again.",
        });
      } else {
        outcomes.set(dot, "refused");
        problems.push({ dot, error: result.error });
      }
      onSent(dot);
    }
    const unsent = unsentRecipients(captured.dots, outcomes);
    if (!problems.length) setReply(undefined);
    else
      setReply((current) =>
        current
          ? {
              ...current,
              sending: false,
              problems,
              // Unsent content stays to try again; only dots that got nothing stay picked.
              dots: unsent,
              ...(unsent.length ? {} : { text: "", images: [] }),
            }
          : current,
      );
    void refresh();
    const first = captured.dots.find((dot) => outcomes.get(dot) === "saved");
    if (first && !problems.length) onOpenChat(first);
  };

  const items = state.current.items;
  const overflow = state.current.overflow;
  const more = remaining + overflow;

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
                {reply?.item.id === item.id ? (
                  <ReplyEditor
                    box={reply}
                    dots={dots}
                    onChange={(change) =>
                      setReply((current) =>
                        current && !current.sending ? change(current) : current,
                      )
                    }
                    onAttach={(files) => void attach(files)}
                    onSend={() => void send()}
                    onCancel={() => setReply(undefined)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {more > 0 ? <p className="note">More unread items will appear on refresh.</p> : null}
        {handedOff.length ? (
          <details className="handed-off">
            <summary>Handed off ({handedOff.length})</summary>
            <ul>
              {handedOff.map((item) => (
                <li key={item.id} data-handed-off={item.id}>
                  <span className="feed-title">{item.title}</span>{" "}
                  <span className="note">→ {(item.handedTo ?? []).join(", ")}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
};

const imageFiles = (list: FileList) => [...list].filter((file) => file.type.startsWith("image/"));

const ReplyEditor = ({
  box,
  dots,
  onChange,
  onAttach,
  onSend,
  onCancel,
}: {
  box: ReplyBox;
  dots: DotView[];
  onChange: (change: (box: ReplyBox) => ReplyBox) => void;
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
  return (
    <div
      className="reply-box"
      role="group"
      aria-label="Reply"
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
              onChange={() =>
                onChange((current) => ({
                  ...current,
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
          onClick={() => onChange((current) => ({ ...current, text: feedPrompts.start }))}
        >
          Start on it
        </button>
        <button
          type="button"
          disabled={box.sending}
          onClick={() => onChange((current) => ({ ...current, text: feedPrompts.context }))}
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
          onChange((current) => ({ ...current, text }));
        }}
        onPaste={onPaste}
      />
      {box.images.length ? (
        <div className="draft-images">
          {box.images.map((image, index) => (
            <span key={index} className="draft-chip">
              {image.name}
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                disabled={box.sending}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    images: current.images.filter((other) => other !== image),
                  }))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {box.problems.length ? (
        <div className="item-error" role="alert" data-reply-problems>
          {box.problems.map((problem) => (
            <div key={problem.dot}>
              {problem.dot}: {problem.error}
            </div>
          ))}
        </div>
      ) : null}
      <div className="item-actions">
        <button type="button" onClick={onCancel} disabled={box.sending}>
          Cancel
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
