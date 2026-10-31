/** @jsxImportSource react */
// Request cards: each permission request or question waiting for the owner, from a dot's own
// session or one its workers escalated, shown in that dot's chat and in one Needs you list. An
// answer goes once, through main, to the daemon, which checks it again and alone sends it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingPage, Reply, RequestCard } from "./bridge";
import {
  type CardAnswer,
  cardDetail,
  cardOrigin,
  cardsFence,
  cardStatus,
  type FormField,
  type FormValues,
  formAnswer,
  initialValues,
  shownFields,
} from "./surfaces";
import { type AskOwner, bridge } from "./ui";

interface Draft {
  revision: string;
  values: FormValues;
  // Custom text typed for a choice field, apart from its options.
  custom: Record<string, string>;
  message: string;
  rejecting: boolean;
}

export interface Requests {
  cards: RequestCard[];
  error: string | null;
  more: boolean;
  // Requests with an answer whose outcome main hasn't seen yet: read-only until it has.
  checking: ReadonlySet<number>;
  sending: ReadonlySet<number>;
  notes: ReadonlyMap<number, string>;
  draft: (card: RequestCard) => Draft;
  setDraft: (card: RequestCard, change: Partial<Draft>) => void;
  answer: (card: RequestCard, chosen: CardAnswer) => void;
  // The card as the latest read shows it, for a check after a dialog closes.
  current: (id: number) => RequestCard | undefined;
  refresh: () => void;
}

const pagesPerRead = 10;

const freshDraft = (card: RequestCard): Draft => {
  const detail = cardDetail(card);
  return {
    revision: card.revision,
    values: detail.kind === "question" ? initialValues(detail.fields) : {},
    custom: {},
    message: "",
    rejecting: false,
  };
};

/**
 * The owner's cards, read every two seconds, every page of them up to a thousand, with drafts
 * and locks shared by every place a card shows. A read that started before a later one landed is
 * dropped, and a failed read keeps the last cards with a note that they may be out of date.
 */
export const useRequests = (): Requests => {
  const [cards, setCards] = useState<RequestCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [checking, setChecking] = useState<ReadonlySet<number>>(new Set());
  const [sending, setSending] = useState<ReadonlySet<number>>(new Set());
  const [notes, setNotes] = useState<ReadonlyMap<number, string>>(new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<number, Draft>>(new Map());
  const fence = useRef(cardsFence());
  const latest = useRef<RequestCard[]>([]);
  const locks = useRef(new Set<number>());
  const reading = useRef(false);

  const note = (id: number, text: string | null) =>
    setNotes((known) => {
      const next = new Map(known);
      if (text === null) next.delete(id);
      else next.set(id, text);
      return next;
    });

  // Saved answers whose outcome was lost: their receipts settle them, and nothing is posted again.
  const reconcile = useCallback(async () => {
    const records = await bridge.call("answerRecords");
    if (!records.ok) return;
    const open = new Set<number>();
    for (const record of records.value) {
      const receipt = await bridge.call("requestReceipt", record.dot, record.request);
      if (!receipt.ok) {
        if (receipt.status === 404) await bridge.call("answerSettle", record.attemptID);
        else open.add(record.request);
        continue;
      }
      // Unsaved means the post never landed; a saved one is the daemon's to settle now, and its
      // card shows how it stands.
      const attempt = receipt.value.attempts.find((item) => item.id === record.attemptID);
      await bridge.call("answerSettle", record.attemptID);
      if (attempt?.state === "unknown")
        note(record.request, "OpenCode didn't confirm your answer, and it won't be sent again.");
    }
    setChecking(open);
  }, []);

  const poll = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const generation = fence.current.begin();
    try {
      await reconcile();
      const read: RequestCard[] = [];
      let after: number | null = null;
      let pages = 0;
      for (;;) {
        const page: Reply<PendingPage> = await bridge.call("pendingRequests", null, after);
        if (!page.ok) {
          if (fence.current.land(generation)) setError(page.error);
          return;
        }
        read.push(...page.value.requests);
        pages++;
        after = page.value.next ?? null;
        if (after === null || pages >= pagesPerRead) break;
      }
      if (!fence.current.land(generation)) return;
      latest.current = read;
      setCards(read);
      setMore(after !== null);
      setError(null);
      setDrafts((known) => {
        const kept = new Map<number, Draft>();
        for (const card of read) {
          const draft = known.get(card.id);
          if (draft && draft.revision === card.revision) kept.set(card.id, draft);
        }
        return kept;
      });
    } finally {
      reading.current = false;
    }
  }, [reconcile]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => clearInterval(timer);
  }, [poll]);

  const draft = (card: RequestCard) => {
    const known = drafts.get(card.id);
    return known && known.revision === card.revision ? known : freshDraft(card);
  };

  const setDraft = (card: RequestCard, change: Partial<Draft>) =>
    setDrafts((known) => {
      const current = known.get(card.id);
      const base = current && current.revision === card.revision ? current : freshDraft(card);
      return new Map(known).set(card.id, { ...base, ...change });
    });

  const answer = (card: RequestCard, chosen: CardAnswer) => {
    // A double click, or the same card in the chat and in Needs you, sends once.
    if (locks.current.has(card.id) || checking.has(card.id) || !card.boundSessionID) return;
    locks.current.add(card.id);
    setSending(new Set(locks.current));
    note(card.id, null);
    void bridge
      .call(
        "answerRequest",
        card.dot,
        card.id,
        card.boundSessionID,
        card.revision,
        chosen.answer,
        chosen.confirmedAlways,
      )
      .then((result) => {
        if (result.ok) note(card.id, "Sent to open-dot, which checks it again and sends it once.");
        else if (result.lost)
          note(
            card.id,
            "The answer's outcome isn't known yet. open-dot won't send it again; the app checks its receipt.",
          );
        else note(card.id, result.error);
      })
      .finally(() => {
        locks.current.delete(card.id);
        setSending(new Set(locks.current));
        void poll();
      });
  };

  return {
    cards,
    error,
    more,
    checking,
    sending,
    notes,
    draft,
    setDraft,
    answer,
    current: (id) => latest.current.find((item) => item.id === id),
    refresh: () => void poll(),
  };
};

const opened = (result: { ok: boolean; error?: string; value?: { opened: boolean } }) =>
  result.ok ? (result.value?.opened ? null : "Couldn't open a terminal.") : (result.error ?? null);

/** A list of cards: one dot's in its chat, or every dot's in Needs you. */
export const RequestList = ({
  requests,
  cards,
  ask,
  title,
}: {
  requests: Requests;
  cards: readonly RequestCard[];
  ask: AskOwner;
  title: string;
}) => {
  return (
    <section className="request-list" aria-label={title} data-requests>
      <h2 className="request-heading">
        {title} {cards.length ? `(${cards.length})` : ""}
        {requests.error ? (
          <span className="stale" title={requests.error}>
            {" "}
            Not up to date
          </span>
        ) : null}
      </h2>
      {cards.map((card) => (
        <RequestCardView key={card.id} card={card} requests={requests} ask={ask} />
      ))}
      {requests.more ? (
        <p className="request-more">More requests wait than the app reads at once.</p>
      ) : null}
    </section>
  );
};

const RequestCardView = ({
  card,
  requests,
  ask,
}: {
  card: RequestCard;
  requests: Requests;
  ask: AskOwner;
}) => {
  const detail = cardDetail(card);
  const draft = requests.draft(card);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = requests.sending.has(card.id) || requests.checking.has(card.id);
  const live = card.actionable && !busy && card.boundSessionID !== null;
  const status = cardStatus(card);
  const terminal = async () => setProblem(opened(await bridge.openRequest(card.id)));
  const send = (chosen: CardAnswer) => {
    setProblem(null);
    requests.answer(card, chosen);
  };
  const always = () => {
    if (detail.kind !== "permission") return;
    const revision = card.revision;
    ask({
      title: `Always allow ${detail.action}?`,
      text: `OpenCode saves an approval for ${
        detail.save.length ? detail.save.join(", ") : detail.resources.join(", ")
      } and won't ask again. That saved approval may also apply in other sessions, not just this ${
        card.source === "dot" ? "dot" : "worker"
      }.`,
      buttons: [
        { label: "Cancel" },
        {
          label: "Always allow",
          danger: true,
          // The confirmation holds only for the request the owner read.
          run: () => {
            const now = requests.current(card.id);
            if (now?.revision !== revision || !now.actionable) {
              setProblem("The request changed, so nothing was sent.");
              return;
            }
            send({ answer: { decision: "always" }, confirmedAlways: true });
          },
        },
      ],
    });
  };
  return (
    <article
      className="request-card"
      data-request={card.id}
      data-actionable={live ? "" : undefined}
      aria-label={`${card.kind === "permission" ? "Permission request" : "Question"} from ${cardOrigin(card)}`}
    >
      <header className="request-head">
        <span className="request-kind">
          {card.kind === "permission" ? "Permission" : "Question"}
        </span>
        <span className="request-origin">{cardOrigin(card)}</span>
        <span className="request-title">{card.title}</span>
      </header>
      <p className="request-directory">{card.directory}</p>
      {detail.kind === "permission" ? (
        <div className="request-body">
          <p className="request-action">{detail.action}</p>
          {detail.message ? <p className="request-message">{detail.message}</p> : null}
          <ul className="request-resources">
            {detail.resources.map((resource, index) => (
              <li key={index}>
                <code>{resource}</code>
              </li>
            ))}
          </ul>
          {detail.save.length ? (
            <p className="request-save">
              Always saves: <code>{detail.save.join(", ")}</code>
            </p>
          ) : null}
        </div>
      ) : detail.kind === "question" ? (
        <QuestionForm
          title={detail.title}
          fields={detail.fields}
          values={draft.values}
          custom={draft.custom}
          disabled={!live}
          onChange={(values, custom) => requests.setDraft(card, { values, custom })}
        />
      ) : (
        <p className="request-message">This request can only be answered in its terminal.</p>
      )}
      {status ? <p className="request-status">{status}</p> : null}
      {requests.checking.has(card.id) ? (
        <p className="request-status">Checking your earlier answer…</p>
      ) : null}
      {requests.notes.get(card.id) ? (
        <p className="request-status" role="status">
          {requests.notes.get(card.id)}
        </p>
      ) : null}
      {problem ? (
        <p className="request-status" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="request-actions">
        {live && detail.kind === "permission" && !draft.rejecting ? (
          <>
            <button
              type="button"
              data-answer="once"
              onClick={() => send({ answer: { decision: "once" }, confirmedAlways: false })}
            >
              Allow once
            </button>
            <button type="button" data-answer="always" onClick={always}>
              Always…
            </button>
            <button
              type="button"
              data-answer="reject"
              onClick={() => requests.setDraft(card, { rejecting: true })}
            >
              Reject…
            </button>
          </>
        ) : null}
        {live && detail.kind === "permission" && draft.rejecting ? (
          <>
            <input
              type="text"
              aria-label="Why, optionally"
              placeholder="Why (optional)"
              maxLength={2000}
              value={draft.message}
              onChange={(event) => requests.setDraft(card, { message: event.target.value })}
            />
            <button
              type="button"
              data-answer="reject-send"
              onClick={() => {
                const message = draft.message.trim();
                send({
                  answer: message ? { decision: "reject", message } : { decision: "reject" },
                  confirmedAlways: false,
                });
              }}
            >
              Reject
            </button>
            <button type="button" onClick={() => requests.setDraft(card, { rejecting: false })}>
              Cancel
            </button>
          </>
        ) : null}
        {live && detail.kind === "question" ? (
          <>
            <button
              type="button"
              data-answer="submit"
              onClick={() => {
                const built = formAnswer(detail.fields, merged(detail.fields, draft));
                if ("error" in built) setProblem(built.error);
                else
                  send({
                    answer: { decision: "reply", answer: built.answer },
                    confirmedAlways: false,
                  });
              }}
            >
              Submit
            </button>
            <button
              type="button"
              data-answer="decline"
              onClick={() => send({ answer: { decision: "cancel" }, confirmedAlways: false })}
            >
              Decline
            </button>
          </>
        ) : null}
        <button type="button" data-open-request={card.id} onClick={() => void terminal()}>
          Open in terminal
        </button>
      </div>
    </article>
  );
};

/** The values with each choice field's typed custom text in place of its "Other" choice. */
const merged = (fields: readonly FormField[], draft: Draft): FormValues => {
  const values = { ...draft.values };
  for (const item of fields) {
    const typed = draft.custom[item.key]?.trim();
    if (item.type === "string" && item.options && values[item.key] === otherChoice)
      values[item.key] = typed ?? "";
    if (item.type === "multiselect" && typed) values[item.key] = [...list(values[item.key]), typed];
  }
  return values;
};

const otherChoice = "\u0000other";

const list = (value: FormValues[string]) => (Array.isArray(value) ? value : []);
const typed = (value: FormValues[string]) => (typeof value === "string" ? value : "");

const QuestionForm = ({
  title,
  fields,
  values,
  custom,
  disabled,
  onChange,
}: {
  title: string;
  fields: readonly FormField[];
  values: FormValues;
  custom: Record<string, string>;
  disabled: boolean;
  onChange: (values: FormValues, custom: Record<string, string>) => void;
}) => {
  const set = (key: string, value: FormValues[string]) =>
    onChange({ ...values, [key]: value }, custom);
  const type = (key: string, text: string) => onChange(values, { ...custom, [key]: text });
  return (
    <fieldset className="request-form" disabled={disabled}>
      <legend>{title}</legend>
      {shownFields(fields, values).map((item) => {
        const label = item.title ?? item.key;
        const id = `field-${item.key}`;
        return (
          <div key={item.key} className="request-field">
            {item.description ? <p className="request-description">{item.description}</p> : null}
            {item.type === "string" && item.options ? (
              <div role="radiogroup" aria-label={label}>
                <span className="request-label">
                  {label}
                  {item.required ? " *" : ""}
                </span>
                {[
                  ...item.options,
                  ...(item.custom ? [{ value: otherChoice, label: "Other" }] : []),
                ].map((option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name={id}
                      checked={values[item.key] === option.value}
                      onChange={() => set(item.key, option.value)}
                    />{" "}
                    {option.label}
                  </label>
                ))}
                {item.custom && values[item.key] === otherChoice ? (
                  <input
                    type="text"
                    aria-label={`${label}: your answer`}
                    value={custom[item.key] ?? ""}
                    onChange={(event) => type(item.key, event.target.value)}
                  />
                ) : null}
              </div>
            ) : item.type === "string" ? (
              <label>
                <span className="request-label">
                  {label}
                  {item.required ? " *" : ""}
                </span>
                <input
                  type="text"
                  placeholder={item.placeholder}
                  value={typed(values[item.key])}
                  onChange={(event) => set(item.key, event.target.value)}
                />
              </label>
            ) : item.type === "number" || item.type === "integer" ? (
              <label>
                <span className="request-label">
                  {label}
                  {item.required ? " *" : ""}
                </span>
                <input
                  type="number"
                  step={item.type === "integer" ? 1 : "any"}
                  min={item.minimum}
                  max={item.maximum}
                  value={typeof values[item.key] === "number" ? String(values[item.key]) : ""}
                  onChange={(event) =>
                    set(
                      item.key,
                      event.target.value === "" ? undefined : Number(event.target.value),
                    )
                  }
                />
              </label>
            ) : item.type === "boolean" ? (
              <label>
                <input
                  type="checkbox"
                  checked={values[item.key] === true}
                  onChange={(event) => set(item.key, event.target.checked)}
                />{" "}
                {label}
              </label>
            ) : (
              <div role="group" aria-label={label}>
                <span className="request-label">
                  {label}
                  {item.required ? " *" : ""}
                </span>
                {item.options.map((option) => {
                  const chosen = list(values[item.key]);
                  return (
                    <label key={option.value}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(option.value)}
                        onChange={(event) =>
                          set(
                            item.key,
                            event.target.checked
                              ? [...chosen, option.value]
                              : chosen.filter((value) => value !== option.value),
                          )
                        }
                      />{" "}
                      {option.label}
                    </label>
                  );
                })}
                {item.custom ? (
                  <input
                    type="text"
                    aria-label={`${label}: another choice`}
                    placeholder="Another choice"
                    value={custom[item.key] ?? ""}
                    onChange={(event) => type(item.key, event.target.value)}
                  />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
};
