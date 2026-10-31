/** @jsxImportSource react */
// A dot's memory as the daemon has it: notes, responsibilities and their runs, reminders, the
// observed ledger, supervision, grants, worker requests and feed triggers. Every change names the
// version it started from and sends only what the owner changed; a refused or unconfirmed change
// is shown, never retried. A read begun before a change, or for another session or page, is
// dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArchiveStatus,
  Archived,
  FeedTrigger,
  Memory as MemoryData,
  MemoryNote,
  MemoryReminder,
  MemoryResponsibility,
  NoteSearch,
  OwnerAction,
  OwnerFact,
  OwnerMemory,
  OwnerMutation,
  Observation,
  Recall,
  Reply,
  RequestAudit,
  RunView,
  SourceText,
  Supervision,
  TriggerPreview,
} from "./bridge";
import {
  changedFields,
  Drafts,
  Fence,
  grantRemaining,
  type SearchTicket,
  Searches,
  memoryChange,
  memoryFailure,
  nextRunLine,
  ownerActionWords,
  ownerFailure,
  ownerOrphans,
  ownerOutcome,
  requestAsked,
  requestAttempts,
  requestLine,
  requestTimes,
  runAttribution,
  runTitle,
  runUnresolved,
  runWorkerLine,
  runWorkersNotes,
  sourceSummary,
  supervisionTimes,
  triggerReasons,
} from "./surfaces";
import { type AskOwner, bridge, Section, when } from "./ui";

const statuses = ["active", "done", "dropped"];

const short = (text: string, limit = 200) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

type Fields = { goal: string; nextAction: string; status: string };
type ReminderFields = { due: string; every: string };
type TriggerDraft = { responsibility: string; repository: string; reasons: string[]; task: string };

interface Kept {
  texts: Drafts<string>;
  fields: Drafts<Fields>;
  reminders: Drafts<ReminderFields>;
  rejected: Map<string, { mine: string; current: string }>;
  /** Unsent new rows. Only Cancel, or the daemon confirming the text as it was sent, clears one. */
  creating: { note: string; observation: string; trigger?: TriggerDraft | undefined };
  /** Rows whose change is out now. A pane opened again meanwhile refuses another send of them. */
  sending: Set<string>;
  /** What the daemon last said about a row's change, so an answer after a reopen still shows. */
  errors: Map<string, string>;
  /** Each open pane of the dot, to draw again when any of this changes, and read after a change. */
  panes: Set<(changed: boolean) => void>;
}

// Unsent edits and new rows per dot, kept while the window lives so switching panes, dots or
// sessions doesn't drop them. Each edit keeps the version it started from.
const kept = new Map<string, Kept>();

const keptFor = (dot: string) => {
  let known = kept.get(dot);
  if (!known) {
    known = {
      texts: new Drafts(),
      fields: new Drafts(),
      reminders: new Drafts(),
      rejected: new Map(),
      creating: { note: "", observation: "" },
      sending: new Set(),
      errors: new Map(),
      panes: new Set(),
    };
    kept.set(dot, known);
  }
  return known;
};

const textOf = (value: unknown) =>
  typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
    ? value.text
    : undefined;

const fieldsOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const parts = Object.entries(value).flatMap(([key, field]) =>
    ["goal", "nextAction", "status"].includes(key) ? [`${key}: ${String(field)}`] : [],
  );
  return parts.length ? parts.join("\n") : undefined;
};

/** A reminder's time and repeat as a conflict shows them. */
const reminderLine = (dueAt: number | null, everyMinutes: number | null | undefined) =>
  [
    dueAt === null ? undefined : `due: ${when(dueAt)}`,
    everyMinutes === undefined
      ? undefined
      : `repeat: ${everyMinutes === null ? "once" : `every ${everyMinutes} minutes`}`,
  ]
    .filter(Boolean)
    .join("\n");

const local = (time: number) =>
  new Date(time - new Date(time).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export const Memory = ({ dot, ask }: { dot: string; ask: AskOwner }) => {
  const fence = useRef(new Fence());
  // The window remounts this pane for each session of the dot, as Start Fresh makes, so a read
  // or page begun for one session never shows in another.
  const key = dot;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [memory, setMemory] = useState<MemoryData>();
  const [archive, setArchive] = useState<ArchiveStatus>();
  const [error, setError] = useState<string>();
  const drafts = keptFor(dot);
  const busy = drafts.sending;
  const rowErrors = drafts.errors;
  const [, setTick] = useState(0);
  // Draws every open pane of the dot, so a change settling after a reopen shows in the new one.
  const render = () => {
    for (const draw of drafts.panes) draw(false);
  };
  const rejected = drafts.rejected;
  const setRejected = (row: string, value: { mine: string; current: string } | undefined) => {
    if (value) rejected.set(row, value);
    else rejected.delete(row);
    render();
  };

  const read = useCallback(async () => {
    const at = keyRef.current;
    const generation = fence.current.current(at);
    const [result, status] = await Promise.all([
      bridge.call("memory", dot),
      bridge.call("archiveStatus", dot),
    ]);
    if (keyRef.current !== at || !fence.current.holds(at, generation)) return;
    if (!result.ok) return setError(`Not up to date: ${result.error}`);
    setError(undefined);
    setMemory(result.value);
    if (status.ok) setArchive(status.value);
  }, [dot]);

  useEffect(() => {
    const draw = (changed: boolean) => {
      setTick((tick) => tick + 1);
      if (changed) void read();
    };
    drafts.panes.add(draw);
    return () => {
      drafts.panes.delete(draw);
    };
  }, [drafts, read]);

  useEffect(() => {
    setMemory(undefined);
    void read();
    const timer = setInterval(() => void read(), 20_000);
    return () => clearInterval(timer);
  }, [read, key]);

  const setRowError = (row: string, text: string | undefined) => {
    if (text) rowErrors.set(row, text);
    else rowErrors.delete(row);
    render();
  };

  /**
   * Sends one change once. Reads out meanwhile are dropped, and one read follows. A 409 shows
   * the value now beside what the owner tried; nothing is retried. Answers what the daemon said
   * and whether a conflict is shown.
   */
  const mutate = async (
    row: string,
    work: () => Promise<Reply<unknown>>,
    rejectedText?: { mine: string; current: (value: unknown) => string | undefined },
  ) => {
    // Checked and taken at once, before any await, and kept with the dot's drafts rather than this
    // pane, so neither a second press nor a pane opened again meanwhile sends the row twice.
    if (busy.has(row)) return { result: undefined, conflict: false };
    busy.add(row);
    render();
    const at = keyRef.current;
    fence.current.advance(at);
    recalls.current.changed();
    noteSearches.current.changed();
    let result: Reply<unknown>;
    try {
      result = await work();
    } catch {
      result = { ok: false, error: "No answer. Nothing was retried.", lost: true };
    }
    busy.delete(row);
    fence.current.advance(at);
    recalls.current.changed();
    noteSearches.current.changed();
    let conflict = false;
    if (result.ok) setRowError(row, undefined);
    else {
      setRowError(row, memoryFailure(result));
      const current = result.status === 409 ? rejectedText?.current(result.current) : undefined;
      if (rejectedText && current !== undefined) {
        conflict = true;
        setRejected(row, { mine: rejectedText.mine, current });
      }
    }
    // Sources and search results opened before the change may no longer be what's saved.
    setOpened(new Map());
    setSources(new Map());
    setZoom(new Map());
    // Older observed pages may hold the row as it was; Load older reads them again.
    setOlder(undefined);
    if (keyRef.current === at) {
      void recallRun(recalls.current.rerun());
      void noteSearchRun(noteSearches.current.rerun());
    }
    // Whichever pane of the dot is open now reads what the change left.
    for (const draw of drafts.panes) draw(true);
    return { result, conflict };
  };

  /** Ends a save of a draft: confirmed or shown as a conflict ends it, anything else keeps it. */
  const settle = <T,>(
    store: Drafts<T>,
    row: string,
    outcome: { result: Reply<unknown> | undefined; conflict: boolean },
  ) => {
    if (outcome.result && store.finish(row, outcome.result, outcome.conflict) === "saved")
      setRejected(row, undefined);
    render();
  };

  const rowState = (row: string) => (
    <>
      {rowErrors.get(row) ? (
        <div className="item-error" role="alert" data-row-error={row}>
          {rowErrors.get(row)}
        </div>
      ) : null}
      {rejected.get(row) ? (
        <div className="conflict" data-rejected={row}>
          <div className="note">Your rejected edit (not saved)</div>
          <pre className="conflict-text">{rejected.get(row)?.mine}</pre>
          <div className="note">As it is now</div>
          <pre className="conflict-text">{rejected.get(row)?.current}</pre>
          <button type="button" onClick={() => setRejected(row, undefined)}>
            Discard rejected edit
          </button>
        </div>
      ) : null}
    </>
  );

  /**
   * A text row's editor. Save sends the text with the version the edit started from, however the
   * row changed since; the editor takes no typing while its save is out.
   */
  const textEditor = (
    row: string,
    label: string,
    save: (version: number, text: string) => Promise<Reply<unknown>>,
  ) => {
    const draft = drafts.texts.get(row);
    if (!draft) return null;
    const sending = draft.sending !== undefined;
    return (
      <div className="editor" data-editing={row}>
        <textarea
          aria-label={label}
          value={draft.edited}
          readOnly={sending}
          onChange={(event) => {
            if (drafts.texts.edit(row, event.target.value)) render();
          }}
        />
        <div className="item-actions">
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              drafts.texts.cancel(row);
              render();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="send"
            disabled={sending || busy.has(row) || !draft.edited.trim()}
            onClick={() => {
              const text = draft.edited.trim();
              if (text === draft.original) {
                drafts.texts.cancel(row);
                return render();
              }
              const sent = drafts.texts.begin(row);
              if (!sent) return;
              render();
              void mutate(row, () => save(sent.version, text), {
                mine: text,
                current: textOf,
              }).then((outcome) => settle(drafts.texts, row, outcome));
            }}
          >
            {sending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  /** Starts editing a text row, or goes back to its kept draft. */
  const editText = (row: string, version: number, text: string) => {
    drafts.texts.start(row, version, text);
    render();
  };

  // Notes.

  const [sources, setSources] = useState(new Map<number, string>());
  const creating = drafts.creating;
  const create = (change: Partial<Kept["creating"]>) => {
    Object.assign(creating, change);
    render();
  };
  const newNote = creating.note;

  const toggleSource = async (note: MemoryNote) => {
    if (sources.has(note.id)) {
      setSources((current) => {
        const next = new Map(current);
        next.delete(note.id);
        return next;
      });
      return;
    }
    const at = keyRef.current;
    const generation = fence.current.current(at);
    const result = await bridge.call("noteSource", dot, note.id);
    if (keyRef.current !== at || !fence.current.holds(at, generation)) return;
    const text = result.ok
      ? `${sourceSummary(result.value, dot)}${result.value.message ? `\n\n${result.value.message.text}` : ""}`
      : `Source unavailable: ${result.error}`;
    setSources((current) => new Map(current).set(note.id, text));
  };

  const noteRow = (note: MemoryNote) => {
    const row = `note:${note.id}`;
    return (
      <li key={note.id} className="item" data-note={note.id}>
        <div className="item-text">{note.text}</div>
        <div className="note">{memoryChange(note.updatedAt, note.updatedBy, dot)}</div>
        {rowState(row)}
        {textEditor(row, "Note", (version, text) =>
          bridge.call("editNote", dot, note.id, version, text),
        )}
        <div className="item-actions">
          <button type="button" onClick={() => editText(row, note.version, note.text)}>
            Edit
          </button>
          <button type="button" onClick={() => void toggleSource(note)}>
            {sources.has(note.id) ? "Hide source" : "Source"}
          </button>
          <button
            type="button"
            disabled={busy.has(row)}
            onClick={() =>
              ask({
                title: "Delete this note?",
                text: `${dot} won't see it in its memory any more: ${short(note.text)}`,
                buttons: [
                  { label: "Cancel" },
                  {
                    label: "Delete",
                    danger: true,
                    run: () =>
                      void mutate(row, () => bridge.call("deleteNote", dot, note.id, note.version)),
                  },
                ],
              })
            }
          >
            Delete…
          </button>
        </div>
        {sources.has(note.id) ? <pre className="source">{sources.get(note.id)}</pre> : null}
      </li>
    );
  };

  // Responsibilities and their runs.

  const [runs, setRuns] = useState(
    new Map<number, { runs: RunView[]; next: number | null; error?: string }>(),
  );
  const [evidence, setEvidence] = useState(new Map<string, string>());

  const loadRuns = async (id: number, before: number | null) => {
    const at = keyRef.current;
    const result = await bridge.call("runs", dot, id, before);
    if (keyRef.current !== at) return;
    setRuns((current) => {
      const known = current.get(id);
      // An older page counts only while the list still ends where it began.
      if (before !== null && known?.next !== before) return current;
      const next = new Map(current);
      if (!result.ok)
        next.set(id, { runs: known?.runs ?? [], next: known?.next ?? null, error: result.error });
      else
        next.set(id, {
          runs:
            before === null ? result.value.runs : [...(known?.runs ?? []), ...result.value.runs],
          next: result.value.next,
        });
      return next;
    });
  };

  const toggleEvidence = async (run: RunView, message: string) => {
    const at = `${run.id}:${message}`;
    if (evidence.has(at)) {
      setEvidence((current) => {
        const next = new Map(current);
        next.delete(at);
        return next;
      });
      return;
    }
    const result = await bridge.message(dot, message, run.sessionID);
    const text = result.ok ? result.value.text : `Unavailable: ${result.error}`;
    setEvidence((current) => new Map(current).set(at, text));
  };

  const runRow = (run: RunView) => (
    <li key={run.id} className="item" data-run={run.id}>
      <div className={`item-title${runUnresolved(run) ? " unresolved" : ""}`}>
        Run #{run.id} · {runTitle(run)}
      </div>
      <div className="note">
        Due {when(run.dueAt)} · claimed {when(run.claimedAt)}
        {run.turn?.endedAt ? ` · ended ${when(run.turn.endedAt)}` : ""}
      </div>
      {run.turn?.error ? <div className="note">{run.turn.error}</div> : null}
      {runAttribution(run) ? <div className="note">{runAttribution(run)}</div> : null}
      {run.result ? (
        <>
          <div className="note">The start of the dot's last reply in that turn, as its data:</div>
          <pre className="source">{run.result.text}</pre>
        </>
      ) : null}
      {run.workers.map((worker) => (
        <div key={worker.id} className="note">
          {runWorkerLine(worker)}
        </div>
      ))}
      {runWorkersNotes(run).map((line) => (
        <div key={line} className="note">
          {line}
        </div>
      ))}
      <div className="item-actions">
        {[
          ["prompt", run.messageID] as const,
          ...(run.result ? [["result", run.result.messageID] as const] : []),
        ].map(([title, message]) => (
          <button key={title} type="button" onClick={() => void toggleEvidence(run, message)}>
            {evidence.has(`${run.id}:${message}`) ? `Hide ${title}` : `Show ${title}`}
          </button>
        ))}
      </div>
      {[run.messageID, run.result?.messageID].map((message) =>
        message && evidence.has(`${run.id}:${message}`) ? (
          <pre key={message} className="source">
            {evidence.get(`${run.id}:${message}`)}
          </pre>
        ) : null,
      )}
    </li>
  );

  const responsibilityRow = (row: MemoryResponsibility) => {
    const id = `responsibility:${row.id}`;
    const editing = drafts.fields.get(id);
    const sending = editing?.sending !== undefined;
    const shownRuns = runs.get(row.id);
    const setEdited = (change: Partial<Fields>) => {
      if (editing && drafts.fields.edit(id, { ...editing.edited, ...change })) render();
    };
    const close = () => {
      drafts.fields.cancel(id);
      render();
    };
    return (
      <li key={row.id} className="item" data-responsibility={row.id}>
        <div className="item-title">
          #{row.id} {row.goal}
        </div>
        <div>Next: {row.nextAction}</div>
        <div className="note">
          {row.status} · {memoryChange(row.updatedAt, row.updatedBy, dot)}
        </div>
        {nextRunLine(row) ? <div className="note">{nextRunLine(row)}</div> : null}
        {rowState(id)}
        {editing ? (
          <div className="editor">
            <input
              aria-label="Goal"
              readOnly={sending}
              value={editing.edited.goal}
              onChange={(event) => setEdited({ goal: event.target.value })}
            />
            <textarea
              aria-label="Next action"
              readOnly={sending}
              value={editing.edited.nextAction}
              onChange={(event) => setEdited({ nextAction: event.target.value })}
            />
            <select
              aria-label="Status"
              disabled={sending}
              value={editing.edited.status}
              onChange={(event) => setEdited({ status: event.target.value })}
            >
              {statuses.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
            <div className="item-actions">
              <button type="button" disabled={sending} onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="send"
                disabled={sending || busy.has(id)}
                onClick={() => {
                  // Only the fields the owner changed since the edit began, against the version
                  // it began from, so one the dot changed meanwhile stays or conflicts.
                  const change = changedFields(editing.original, editing.edited);
                  if (!Object.keys(change).length) return close();
                  const sent = drafts.fields.begin(id);
                  if (!sent) return;
                  render();
                  void mutate(
                    id,
                    () => bridge.call("editResponsibility", dot, row.id, sent.version, change),
                    {
                      mine: Object.entries(change)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join("\n"),
                      current: fieldsOf,
                    },
                  ).then((outcome) => settle(drafts.fields, id, outcome));
                }}
              >
                {sending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="item-actions">
          <button
            type="button"
            onClick={() => {
              const original = { goal: row.goal, nextAction: row.nextAction, status: row.status };
              drafts.fields.start(id, row.version, original);
              render();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              if (shownRuns)
                setRuns((current) => {
                  const next = new Map(current);
                  next.delete(row.id);
                  return next;
                });
              else void loadRuns(row.id, null);
            }}
          >
            {shownRuns ? "Hide runs" : "Show runs"}
          </button>
        </div>
        {shownRuns ? (
          <div className="runs">
            {shownRuns.error ? <div className="item-error">{shownRuns.error}</div> : null}
            {!shownRuns.runs.length && !shownRuns.error ? (
              <p className="note">No runs yet.</p>
            ) : null}
            <ul className="items">{shownRuns.runs.map(runRow)}</ul>
            {shownRuns.next !== null ? (
              <button type="button" onClick={() => void loadRuns(row.id, shownRuns.next)}>
                Load older
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  // Reminders.

  const reminderRow = (reminder: MemoryReminder) => {
    const row = `reminder:${reminder.id}`;
    const editing = drafts.reminders.get(row);
    const sending = editing?.sending !== undefined;
    const every = (editing?.edited.every ?? "").trim();
    // Empty repeats never; otherwise whole minutes, as the daemon takes them.
    const everyMinutes = every === "" ? null : /^\d+$/.test(every) ? Number(every) : Number.NaN;
    const everyValid =
      everyMinutes === null ||
      (Number.isSafeInteger(everyMinutes) && everyMinutes >= 1 && everyMinutes <= 525_600);
    const setEdited = (change: Partial<ReminderFields>) => {
      if (editing && drafts.reminders.edit(row, { ...editing.edited, ...change })) render();
    };
    return (
      <li key={reminder.id} className="item" data-reminder={reminder.id}>
        <div className="item-text">{reminder.text}</div>
        <div className="note">
          Due {when(reminder.dueAt)}
          {reminder.everyMinutes ? ` · every ${reminder.everyMinutes} minutes` : ""} ·{" "}
          {reminder.state}
        </div>
        {rowState(row)}
        {editing ? (
          <div className="editor">
            <label>
              Due{" "}
              <input
                type="datetime-local"
                readOnly={sending}
                value={editing.edited.due}
                onChange={(event) => setEdited({ due: event.target.value })}
              />
            </label>
            <label>
              Repeat every{" "}
              <input
                inputMode="numeric"
                size={7}
                readOnly={sending}
                aria-invalid={!everyValid}
                value={editing.edited.every}
                onChange={(event) => setEdited({ every: event.target.value })}
              />{" "}
              minutes (empty for once)
            </label>
            <div className="item-actions">
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  drafts.reminders.cancel(row);
                  render();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="send"
                disabled={
                  sending ||
                  busy.has(row) ||
                  Number.isNaN(new Date(editing.edited.due).getTime()) ||
                  !everyValid
                }
                onClick={() => {
                  // Only what the owner changed since the edit began, against the version it
                  // began from. The field shows whole minutes, so an untouched time keeps its
                  // seconds.
                  const { original, edited } = editing;
                  const change: { dueAt?: number; everyMinutes?: number | null } = {};
                  if (edited.due !== original.due) change.dueAt = new Date(edited.due).getTime();
                  if (edited.every.trim() !== original.every) change.everyMinutes = everyMinutes;
                  if (!Object.keys(change).length) {
                    drafts.reminders.cancel(row);
                    return render();
                  }
                  const sent = drafts.reminders.begin(row);
                  if (!sent) return;
                  render();
                  void mutate(
                    row,
                    () => bridge.call("editReminder", dot, reminder.id, sent.version, change),
                    {
                      mine: reminderLine(change.dueAt ?? null, change.everyMinutes),
                      current: (value) =>
                        typeof value === "object" &&
                        value !== null &&
                        "dueAt" in value &&
                        typeof value.dueAt === "number"
                          ? reminderLine(
                              value.dueAt,
                              "everyMinutes" in value && typeof value.everyMinutes === "number"
                                ? value.everyMinutes
                                : null,
                            )
                          : undefined,
                    },
                  ).then((outcome) => settle(drafts.reminders, row, outcome));
                }}
              >
                {sending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="item-actions">
          <button
            type="button"
            onClick={() => {
              drafts.reminders.start(row, reminder.version, {
                due: local(reminder.dueAt),
                every: reminder.everyMinutes === null ? "" : String(reminder.everyMinutes),
              });
              render();
            }}
          >
            Change time
          </button>
          <button
            type="button"
            disabled={busy.has(row)}
            onClick={() =>
              ask({
                title: "Cancel this reminder?",
                text: `It won't go off${reminder.everyMinutes === null ? "" : " again"}: ${short(reminder.text)}`,
                buttons: [
                  { label: "Keep It" },
                  {
                    label: "Cancel Reminder",
                    danger: true,
                    run: () =>
                      void mutate(row, () =>
                        bridge.call("cancelReminder", dot, reminder.id, reminder.version),
                      ),
                  },
                ],
              })
            }
          >
            Cancel…
          </button>
        </div>
      </li>
    );
  };

  // The observed ledger.

  const [older, setOlder] = useState<{ rows: Observation[]; next: number | null }>();
  const [opened, setOpened] = useState(new Map<string, SourceText | string>());
  const newObservation = creating.observation;

  useEffect(() => setOlder(undefined), [key]);

  const loadOlderObservations = async () => {
    const before = older ? older.next : (memory?.observationsNext ?? null);
    if (before === null) return;
    const at = keyRef.current;
    const generation = fence.current.current(at);
    const result = await bridge.call("observations", dot, before);
    if (keyRef.current !== at || !fence.current.holds(at, generation)) return;
    if (!result.ok) return setRowError("observations", result.error);
    setOlder((current) =>
      (current ? current.next : (memory?.observationsNext ?? null)) === before
        ? {
            rows: [...(current?.rows ?? []), ...result.value.observations],
            next: result.value.next,
          }
        : current,
    );
  };

  const deleteArchived = (message: string, row: string) =>
    ask({
      title: "Delete this message from the archive?",
      text: "dot_recall, automatic recall and dot_zoom won't find it again, and open-dot never copies it back. OpenCode's own history of the conversation keeps it.",
      buttons: [
        { label: "Cancel" },
        {
          label: "Delete",
          danger: true,
          run: () => void mutate(row, () => bridge.call("deleteArchived", dot, message)),
        },
      ],
    });

  const observationRow = (observation: Observation) => {
    const row = `observation:${observation.id}`;
    return (
      <li key={observation.id} className="item" data-observation={observation.id}>
        <div className="note">
          {observation.kind} · {observation.topic}
        </div>
        <div className="item-text">{observation.text}</div>
        <div className="note">
          {memoryChange(observation.updatedAt, observation.updatedBy, dot)}
        </div>
        {rowState(row)}
        {textEditor(row, "Observation", (version, text) =>
          bridge.call("editObservation", dot, observation.id, version, text),
        )}
        <div className="item-actions">
          <button
            type="button"
            onClick={() => editText(row, observation.version, observation.text)}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy.has(row)}
            onClick={() => {
              const forget = (withSources: boolean) => () =>
                void mutate(row, () =>
                  bridge.call(
                    "forgetObservation",
                    dot,
                    observation.id,
                    observation.version,
                    withSources,
                  ),
                );
              ask({
                title: "Forget this observation?",
                text: `It leaves the ledger. The observer won't note it again from the messages it came from or with the same text under any topic, but may if you say it again in a new message. To erase it completely, forget it and delete its source messages. Forget keeps the archived messages it came from, so recall may still surface what they said; Forget and Delete Sources deletes them from the archive too: ${short(observation.text)}`,
                buttons: [
                  { label: "Cancel" },
                  { label: "Forget", danger: true, run: forget(false) },
                  { label: "Forget and Delete Sources", danger: true, run: forget(true) },
                ],
              });
            }}
          >
            Forget…
          </button>
        </div>
        {observation.sources.length ? (
          <details>
            <summary>Sources ({observation.sources.length})</summary>
            <ul className="items">
              {observation.sources.map((source) => {
                const at = `${observation.id}:${source.messageID}`;
                const shown = opened.get(at);
                return (
                  <li key={source.messageID} className="item">
                    <div className="note">
                      {source.missing
                        ? "Gone from the archive."
                        : `${source.from ?? ""} ${source.date ?? ""}`}
                    </div>
                    {source.excerpt ? <div className="item-text">{source.excerpt}</div> : null}
                    {source.missing ? null : (
                      <div className="item-actions">
                        <button
                          type="button"
                          onClick={() => {
                            if (shown !== undefined)
                              return setOpened((current) => {
                                const next = new Map(current);
                                next.delete(at);
                                return next;
                              });
                            const opening = keyRef.current;
                            const generation = fence.current.current(opening);
                            void bridge
                              .call("observationSource", dot, observation.id, source.messageID)
                              .then((result) => {
                                if (
                                  keyRef.current !== opening ||
                                  !fence.current.holds(opening, generation)
                                )
                                  return;
                                setOpened((current) =>
                                  new Map(current).set(at, result.ok ? result.value : result.error),
                                );
                              });
                          }}
                        >
                          {shown === undefined ? "Open" : "Close"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            deleteArchived(source.messageID, `archive:${source.messageID}`)
                          }
                        >
                          Delete from Archive…
                        </button>
                      </div>
                    )}
                    {shown !== undefined ? (
                      <pre className="source">
                        {typeof shown === "string"
                          ? shown
                          : `${shown.text}${shown.truncated ? "\n…" : ""}`}
                      </pre>
                    ) : null}
                    {rowState(`archive:${source.messageID}`)}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </li>
    );
  };

  // Recall: notes, archived messages and observations matching the owner's words; and Search
  // notes, the notes alone. A search begun before or during a change is dropped and runs again.

  const [query, setQuery] = useState("");
  const recalls = useRef(new Searches<Recall>());
  const [noteQuery, setNoteQuery] = useState("");
  const noteSearches = useRef(new Searches<NoteSearch>());
  const [zoom, setZoom] = useState(new Map<string, Archived | string>());

  const recallRun = async (ticket: SearchTicket | undefined) => {
    if (!ticket) return render();
    render();
    const result = await bridge.call("recall", dot, ticket.query, ticket.offset);
    if (
      recalls.current.finish(ticket, result, (shown, page) => ({
        ...page,
        results: [...shown.results, ...page.results],
      }))
    )
      render();
  };

  const noteSearchRun = async (ticket: SearchTicket | undefined) => {
    if (!ticket) return render();
    render();
    const result = await bridge.call("searchNotes", dot, ticket.query);
    if (noteSearches.current.finish(ticket, result)) render();
  };

  const readArchived = async (message: string, offset: number) => {
    const at = keyRef.current;
    const generation = fence.current.current(at);
    const result = await bridge.call("archived", dot, message, offset);
    if (keyRef.current !== at || !fence.current.holds(at, generation)) return;
    setZoom((current) => {
      const known = current.get(message);
      const next = new Map(current);
      if (!result.ok) next.set(message, result.error);
      else if (offset && typeof known === "object" && known.next === offset)
        next.set(message, { ...result.value, text: known.text + result.value.text });
      else if (!offset) next.set(message, result.value);
      return next;
    });
  };

  // Supervision, grants, requests and triggers.

  const supervisionRow = (binding: Supervision) => {
    const row = `supervision:${binding.id}`;
    const mode = binding.mode === "send" ? "watch and send" : "watch only";
    const requested = binding.state === "requested";
    return (
      <li key={binding.id} className="item" data-supervision={binding.id}>
        <div className="item-title">
          {binding.sessionID} in {binding.directory}
        </div>
        <div className="note">
          {requested ? "Waiting for you" : "Active"}, {mode}, busy alert after {binding.busyMinutes}{" "}
          min
        </div>
        <div className="note">{supervisionTimes(binding)}</div>
        {rowState(row)}
        <div className="item-actions">
          {requested ? (
            <button
              type="button"
              disabled={busy.has(row)}
              onClick={() =>
                ask({
                  title: `Let ${dot} ${mode} this session?`,
                  text: `${binding.sessionID} in ${binding.directory}. ${dot} will hear when it finishes a turn, fails, waits for a permission or question, or runs over ${binding.busyMinutes} minutes${binding.mode === "send" ? ", and may write messages into it" : ""}.`,
                  buttons: [
                    { label: "Cancel" },
                    {
                      label: "Approve",
                      run: () =>
                        void mutate(row, () => bridge.call("approveWatch", dot, binding.id)),
                    },
                  ],
                })
              }
            >
              Approve…
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy.has(row)}
            onClick={() =>
              ask({
                title: requested
                  ? "Decline this request?"
                  : `Stop ${dot} supervising this session?`,
                text: `${binding.sessionID} in ${binding.directory}. Only you can bind it again.`,
                buttons: [
                  { label: "Cancel" },
                  {
                    label: requested ? "Decline" : "Revoke",
                    danger: true,
                    run: () => void mutate(row, () => bridge.call("endWatch", dot, binding.id)),
                  },
                ],
              })
            }
          >
            {requested ? "Decline…" : "Revoke…"}
          </button>
        </div>
      </li>
    );
  };

  const [requests, setRequests] = useState<{ rows: RequestAudit[]; next: number | null }>();
  const [requestsError, setRequestsError] = useState<string>();
  useEffect(() => setRequests(undefined), [key]);

  const loadRequests = async (before: number | null) => {
    const at = keyRef.current;
    const result = await bridge.call("requests", dot, before);
    if (keyRef.current !== at) return;
    if (!result.ok) return setRequestsError(result.error);
    setRequestsError(undefined);
    setRequests((current) =>
      before === null
        ? { rows: result.value.requests, next: result.value.next }
        : current?.next === before
          ? { rows: [...current.rows, ...result.value.requests], next: result.value.next }
          : current,
    );
  };

  const [previews, setPreviews] = useState(new Map<number, TriggerPreview | string>());
  const draft = creating.trigger;
  const setDraft = (trigger: TriggerDraft | undefined) => create({ trigger });

  const triggerText = (trigger: FeedTrigger) => {
    const goal = memory?.responsibilities.find((row) => row.id === trigger.responsibility)?.goal;
    return `When GitHub activity in ${trigger.repository} for ${trigger.reasons.join(", ")} reaches your feed, ${dot} is woken in its conversation ${trigger.sessionID} about responsibility #${trigger.responsibility}${goal ? ` (${goal})` : ""} with this instruction, sent unchanged:\n\n${trigger.task}\n\nEach event's title and details go with it as GitHub's data, never as instructions. Activity already in the feed is recorded without waking. At most 3 wakes an hour, 5 events each; the rest are skipped and listed here. Revision ${trigger.revision.slice(0, 12)}.`;
  };

  const triggerRow = (trigger: FeedTrigger) => {
    const row = `trigger:${trigger.id}`;
    const preview = previews.get(trigger.id);
    const resume = trigger.state === "paused";
    return (
      <li key={trigger.id} className="item" data-trigger={trigger.id}>
        <div className="item-title">
          {trigger.repository} · {trigger.state}
        </div>
        <div className="note">
          {trigger.reasons.join(", ")} · responsibility #{trigger.responsibility}
        </div>
        <pre className="source">{trigger.task}</pre>
        {trigger.lastWake ? (
          <div className="note">
            Last wake {when(trigger.lastWake.at)} with {trigger.lastWake.events.length} events ·{" "}
            {trigger.lastWake.delivery === "admitted"
              ? "OpenCode has it"
              : trigger.lastWake.delivery}
          </div>
        ) : null}
        {trigger.skippedCount ? (
          <details>
            <summary>Skipped ({trigger.skippedCount})</summary>
            <ul>
              {trigger.skipped.map((skip, index) => (
                <li key={index} className="note">
                  {when(skip.at)} {skip.event.title}
                  {skip.reason ? `: ${skip.reason}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {rowState(row)}
        <div className="item-actions">
          {trigger.state === "draft" || trigger.state === "paused" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (preview !== undefined)
                    return setPreviews((current) => {
                      const next = new Map(current);
                      next.delete(trigger.id);
                      return next;
                    });
                  void bridge
                    .call("previewTrigger", dot, trigger.id)
                    .then((result) =>
                      setPreviews((current) =>
                        new Map(current).set(trigger.id, result.ok ? result.value : result.error),
                      ),
                    );
                }}
              >
                {preview === undefined ? "Preview" : "Hide Preview"}
              </button>
              <button
                type="button"
                disabled={busy.has(row)}
                onClick={() =>
                  ask({
                    title: resume ? "Resume this feed trigger?" : "Enable this feed trigger?",
                    text: triggerText(trigger),
                    buttons: [
                      { label: "Cancel" },
                      {
                        label: resume ? "Resume" : "Enable",
                        run: () =>
                          void mutate(row, () =>
                            bridge.call("enableTrigger", dot, trigger.id, trigger.revision),
                          ),
                      },
                    ],
                  })
                }
              >
                {resume ? "Resume…" : "Enable…"}
              </button>
            </>
          ) : null}
          {trigger.state === "active" ? (
            <button
              type="button"
              disabled={busy.has(row)}
              onClick={() =>
                ask({
                  title: "Pause this feed trigger?",
                  text: "Wakes not yet sent are cancelled. Activity while it's paused never runs, even after you resume it.",
                  buttons: [
                    { label: "Cancel" },
                    {
                      label: "Pause",
                      run: () =>
                        void mutate(row, () => bridge.call("pauseTrigger", dot, trigger.id)),
                    },
                  ],
                })
              }
            >
              Pause…
            </button>
          ) : null}
          {trigger.state === "revoked" ? null : (
            <button
              type="button"
              disabled={busy.has(row)}
              onClick={() =>
                ask({
                  title:
                    trigger.state === "draft" ? "Discard this draft?" : "Revoke this feed trigger?",
                  text: "Wakes not yet sent are cancelled. To use it again, create a new trigger.",
                  buttons: [
                    { label: "Cancel" },
                    {
                      label: trigger.state === "draft" ? "Discard" : "Revoke",
                      danger: true,
                      run: () =>
                        void mutate(row, () => bridge.call("revokeTrigger", dot, trigger.id)),
                    },
                  ],
                })
              }
            >
              {trigger.state === "draft" ? "Discard…" : "Revoke…"}
            </button>
          )}
        </div>
        {preview !== undefined ? (
          <div className="preview" data-preview={trigger.id}>
            {typeof preview === "string" ? (
              <div className="item-error">{preview}</div>
            ) : (
              <>
                <div className="note">
                  {preview.matches.length} of {preview.total} recent feed items match.
                </div>
                <ul>
                  {preview.matches.map((match, index) => (
                    <li key={index} className="note">
                      {match.event.title} · {match.outcome}
                      {match.reason ? `: ${match.reason}` : ""}
                    </li>
                  ))}
                </ul>
                {preview.wake ? <pre className="source">{preview.wake}</pre> : null}
              </>
            )}
          </div>
        ) : null}
      </li>
    );
  };

  const saveDraft = () => {
    if (!draft) return;
    const responsibility = Number(draft.responsibility);
    if (!Number.isSafeInteger(responsibility) || !draft.repository.trim() || !draft.reasons.length)
      return;
    const sent = draft;
    void mutate("trigger:new", () =>
      bridge.call("createTrigger", dot, {
        responsibility,
        repository: draft.repository.trim(),
        reasons: draft.reasons,
        task: draft.task.trim(),
      }),
    ).then(({ result }) => {
      // Only the draft as it was sent goes; one changed meanwhile stays.
      if (result?.ok && creating.trigger === sent) setDraft(undefined);
    });
  };

  if (!memory)
    return (
      <div className="pane memory" aria-label={`${dot}'s memory`} data-pane="memory">
        <header className="pane-head">
          <h2>Memory</h2>
        </header>
        {error ? <div className="banner">{error}</div> : <p className="empty-line">Loading…</p>}
        {/* Shared by every dot, so it doesn't wait for this dot's memory. */}
        <div className="pane-body">
          <OwnerFacts ask={ask} />
        </div>
      </div>
    );

  const recall = recalls.current.shown?.value;
  const noteSearch = noteSearches.current.shown?.value;
  const observations = [...(memory.observations ?? []), ...(older?.rows ?? [])];
  const observationsNext = older ? older.next : (memory.observationsNext ?? null);

  return (
    <div className="pane memory" aria-label={`${dot}'s memory`} data-pane="memory">
      <header className="pane-head">
        <h2>Memory</h2>
        <div className="pane-tools">
          {error ? (
            <span className="stale" title={error}>
              Not up to date
            </span>
          ) : null}
        </div>
      </header>
      <div className="pane-body">
        <form
          className="field-row"
          role="search"
          aria-label="Recall"
          onSubmit={(event) => {
            event.preventDefault();
            void recallRun(recalls.current.start(query));
          }}
        >
          <input
            aria-label={`Recall from ${dot}'s memory`}
            placeholder="Recall notes, observations and archived messages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={!query.trim()}>
            Recall
          </button>
          {recall || recalls.current.searching ? (
            <button
              type="button"
              onClick={() => {
                recalls.current.clear();
                render();
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
        {recalls.current.error ? (
          <div className="item-error">Search failed. {recalls.current.error}</div>
        ) : null}
        {recall ? (
          <Section title="Results" id="recall">
            {!recall.archive ? (
              <p className="note">
                The archive is off, so only notes and observations are searched.
              </p>
            ) : null}
            {!recall.results.length ? <p className="note">Nothing matches.</p> : null}
            <ul className="items">
              {recall.results.map((result, index) => (
                <li key={index} className="item" data-recall={result.kind}>
                  {result.kind === "note" ? (
                    <>
                      <div className="note">Note #{result.note}</div>
                      <div className="item-text">{result.snippet}</div>
                    </>
                  ) : result.kind === "observed" ? (
                    <>
                      <div className="note">Observed{result.topic ? ` · ${result.topic}` : ""}</div>
                      <div className="item-text">{result.text}</div>
                    </>
                  ) : (
                    <>
                      <div className="note">
                        {result.from} · {result.date}
                      </div>
                      <div className="item-text">{result.snippet}</div>
                      <div className="item-actions">
                        <button
                          type="button"
                          onClick={() =>
                            zoom.has(result.message)
                              ? setZoom((current) => {
                                  const next = new Map(current);
                                  next.delete(result.message);
                                  return next;
                                })
                              : void readArchived(result.message, 0)
                          }
                        >
                          {zoom.has(result.message) ? "Close" : "Open"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            deleteArchived(result.message, `archive:${result.message}`)
                          }
                        >
                          Delete from Archive…
                        </button>
                      </div>
                      {(() => {
                        const shown = zoom.get(result.message);
                        if (shown === undefined) return null;
                        if (typeof shown === "string")
                          return <div className="item-error">{shown}</div>;
                        return (
                          <>
                            <pre className="source">{shown.text}</pre>
                            {shown.next !== null ? (
                              <button
                                type="button"
                                onClick={() => void readArchived(result.message, shown.next ?? 0)}
                              >
                                More
                              </button>
                            ) : null}
                          </>
                        );
                      })()}
                      {rowState(`archive:${result.message}`)}
                    </>
                  )}
                </li>
              ))}
            </ul>
            {recall.next !== null ? (
              <button type="button" onClick={() => void recallRun(recalls.current.more())}>
                More results
              </button>
            ) : null}
          </Section>
        ) : null}

        <OwnerFacts ask={ask} />

        <Section title="Notes" id="notes">
          <form
            className="field-row"
            role="search"
            aria-label="Search notes"
            onSubmit={(event) => {
              event.preventDefault();
              void noteSearchRun(noteSearches.current.start(noteQuery));
            }}
          >
            <input
              aria-label={`Search ${dot}'s notes`}
              placeholder="Search notes"
              value={noteQuery}
              onChange={(event) => setNoteQuery(event.target.value)}
            />
            <button type="submit" disabled={!noteQuery.trim()}>
              Search notes
            </button>
            {noteSearch || noteSearches.current.searching ? (
              <button
                type="button"
                onClick={() => {
                  noteSearches.current.clear();
                  render();
                }}
              >
                Clear
              </button>
            ) : null}
          </form>
          {noteSearches.current.error ? (
            <div className="item-error">Search failed. {noteSearches.current.error}</div>
          ) : null}
          {noteSearch ? (
            <div data-note-search aria-live="polite">
              {!noteSearch.results.length ? (
                <p className="note">No note has every word of “{noteSearch.query}”.</p>
              ) : null}
              <ul className="items">
                {noteSearch.results.map((match) => (
                  <li key={match.id} className="item" data-note-match={match.id}>
                    <div className="note">
                      Note #{match.id} · {memoryChange(match.updatedAt, match.updatedBy, dot)}
                    </div>
                    <div className="item-text">{match.snippet}</div>
                  </li>
                ))}
              </ul>
              {noteSearch.more ? (
                <p className="note">More notes match; add words to narrow it.</p>
              ) : null}
            </div>
          ) : null}
          <ul className="items">{memory.notes.map(noteRow)}</ul>
          <form
            className="field-row"
            onSubmit={(event) => {
              event.preventDefault();
              const text = newNote.trim();
              if (!text) return;
              void mutate("note:new", () => bridge.call("addNote", dot, text)).then(
                ({ result }) => {
                  if (result?.ok && creating.note.trim() === text) create({ note: "" });
                },
              );
            }}
          >
            <input
              aria-label="New note"
              placeholder="Add a note"
              value={newNote}
              onChange={(event) => create({ note: event.target.value })}
            />
            <button type="submit" disabled={!newNote.trim() || busy.has("note:new")}>
              Add
            </button>
          </form>
          {rowState("note:new")}
        </Section>

        <Section title="Responsibilities" id="responsibilities">
          {!memory.responsibilities.length ? <p className="note">None.</p> : null}
          <ul className="items">{memory.responsibilities.map(responsibilityRow)}</ul>
        </Section>

        <Section
          title="Observed"
          id="observed"
          note="What a background observer noted about this conversation. It may be wrong: edit or forget any row. The observer won't note a forgotten one again from the messages it came from or with the same text under any topic, but may if you say it again in a new message. To erase it completely, forget it and delete its source messages. To let the observer note a forgotten fact again, add its text as it was."
        >
          {archive?.observerStatus ? (
            <p className="note" data-budget>
              {archive.observerStatus.budgetNote}
            </p>
          ) : null}
          <ul className="items">{observations.map(observationRow)}</ul>
          {observationsNext !== null ? (
            <button type="button" onClick={() => void loadOlderObservations()}>
              Load older
            </button>
          ) : null}
          {rowState("observations")}
          <form
            className="field-row"
            onSubmit={(event) => {
              event.preventDefault();
              const text = newObservation.trim();
              if (!text) return;
              void mutate("observation:new", () => bridge.call("addObservation", dot, text)).then(
                ({ result }) => {
                  if (result?.ok && creating.observation.trim() === text)
                    create({ observation: "" });
                },
              );
            }}
          >
            <input
              aria-label="New observation"
              placeholder="Add an observation"
              value={newObservation}
              onChange={(event) => create({ observation: event.target.value })}
            />
            <button type="submit" disabled={!newObservation.trim() || busy.has("observation:new")}>
              Add
            </button>
          </form>
          {rowState("observation:new")}
        </Section>

        <Section title="Scheduled reminders" id="reminders">
          {!memory.reminders.length ? <p className="note">None.</p> : null}
          <ul className="items">{memory.reminders.map(reminderRow)}</ul>
        </Section>

        <Section title="Supervised sessions" id="supervisions">
          {!memory.supervisions?.length ? <p className="note">None.</p> : null}
          <ul className="items">{(memory.supervisions ?? []).map(supervisionRow)}</ul>
        </Section>

        <Section
          title="Grants"
          id="grants"
          note={`What ${dot} may approve for its workers. Only you make one, with open-dot grant add in a terminal.`}
        >
          <ul className="items">
            {(memory.grants ?? []).map((grant) => {
              const row = `grant:${grant.id}`;
              return (
                <li key={grant.id} className="item" data-grant={grant.id}>
                  <div className="item-title">{grant.summary}</div>
                  <div className="note">
                    {grant.operation} · {grantRemaining(grant)}
                  </div>
                  {rowState(row)}
                  <button
                    type="button"
                    disabled={busy.has(row)}
                    onClick={() =>
                      ask({
                        title: "Revoke this grant?",
                        text: `${dot} may no longer approve requests to ${grant.summary}. Only you can grant it again.`,
                        buttons: [
                          { label: "Cancel" },
                          {
                            label: "Revoke",
                            danger: true,
                            run: () =>
                              void mutate(row, () => bridge.call("revokeGrant", dot, grant.id)),
                          },
                        ],
                      })
                    }
                  >
                    Revoke…
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Requests and answers" id="requests">
          {requestsError ? <div className="item-error">{requestsError}</div> : null}
          {requests ? (
            <>
              {!requests.rows.length ? <p className="note">None.</p> : null}
              <ul className="items">
                {requests.rows.map((request) => (
                  <li key={request.id} className="item" data-request={request.id}>
                    <div className="item-title">{requestLine(request)}</div>
                    <div className="note">{request.title}</div>
                    {requestAsked(request) ? (
                      <div className="note" data-asked>
                        {requestAsked(request)}
                      </div>
                    ) : null}
                    {request.needsYou ? <div className="note">Needs you</div> : null}
                    {request.reason ? <div className="note">{request.reason}</div> : null}
                    <div className="note" data-request-times>
                      {requestTimes(request)}
                    </div>
                    <details>
                      <summary>Details</summary>
                      <div className="mono">OpenCode request {request.requestID}</div>
                      <div className="note">What was asked, as the worker's data:</div>
                      <pre className="source">{request.detailText}</pre>
                      <div className="note">The complete answer:</div>
                      <pre className="source">{request.answerText ?? "None"}</pre>
                      {requestAttempts(request).length ? (
                        <ul className="note" data-request-attempts>
                          {requestAttempts(request).map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ul>
              {requests.next !== null ? (
                <button type="button" onClick={() => void loadRequests(requests.next)}>
                  Load older
                </button>
              ) : null}
            </>
          ) : (
            <button type="button" onClick={() => void loadRequests(null)}>
              Show requests
            </button>
          )}
        </Section>

        <Section title="Feed triggers" id="triggers">
          <ul className="items">{(memory.triggers ?? []).map(triggerRow)}</ul>
          {draft ? (
            <div className="editor" aria-label="New feed trigger">
              <p className="note">
                Saving makes a draft for you to review and preview. Nothing runs until you enable
                it.
              </p>
              <select
                aria-label="Responsibility"
                value={draft.responsibility}
                onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })}
              >
                <option value="">Responsibility…</option>
                {memory.responsibilities
                  .filter((row) => row.status === "active")
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      #{row.id} {row.goal}
                    </option>
                  ))}
              </select>
              <input
                aria-label="Repository"
                placeholder="owner/repository"
                value={draft.repository}
                onChange={(event) => setDraft({ ...draft, repository: event.target.value })}
              />
              <fieldset>
                <legend>Reasons</legend>
                {triggerReasons.map((reason) => (
                  <label key={reason}>
                    <input
                      type="checkbox"
                      checked={draft.reasons.includes(reason)}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          reasons: draft.reasons.includes(reason)
                            ? draft.reasons.filter((other) => other !== reason)
                            : [...draft.reasons, reason],
                        })
                      }
                    />{" "}
                    {reason}
                  </label>
                ))}
              </fieldset>
              <textarea
                aria-label="Instruction"
                placeholder="What the dot should do when it's woken"
                value={draft.task}
                onChange={(event) => setDraft({ ...draft, task: event.target.value })}
              />
              {rowState("trigger:new")}
              <div className="item-actions">
                <button type="button" onClick={() => setDraft(undefined)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="send"
                  disabled={
                    busy.has("trigger:new") ||
                    !draft.responsibility ||
                    !draft.repository.trim() ||
                    !draft.reasons.length ||
                    !draft.task.trim()
                  }
                  onClick={saveDraft}
                >
                  Save draft
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() =>
                setDraft({ responsibility: "", repository: "", reasons: [], task: "" })
              }
            >
              New feed trigger…
            </button>
          )}
        </Section>
      </div>
    </div>
  );
};

// The owner's facts are shared by every dot, so their drafts, the one change out at a time and the
// read fence are global, never kept per selected dot: switching dots can't start a second save.
const ownerStore = {
  memory: undefined as OwnerMemory | undefined,
  error: undefined as string | undefined,
  drafts: new Drafts<string>(),
  adding: "",
  /** The row whose change is out; while set, no other owner fact change starts. */
  sending: undefined as string | undefined,
  fence: new Fence(),
  errors: new Map<string, string>(),
  rejected: new Map<string, { mine: string; current: string }>(),
  /** Saved changes whose answer was lost and that a read by ID didn't find landed. */
  unknown: [] as OwnerMutation[],
  panes: new Set<() => void>(),
};

const drawOwner = () => {
  for (const draw of ownerStore.panes) draw();
};

/** Reads the facts and settles each saved change whose outcome a read by its fact's ID shows. */
const readOwner = async () => {
  const generation = ownerStore.fence.current("owner");
  const [result, saved] = await Promise.all([
    bridge.call("ownerMemory"),
    bridge.call("ownerMutations"),
  ]);
  const unknown: OwnerMutation[] = [];
  for (const mutation of saved.ok ? saved.value : []) {
    const read = await bridge.call("ownerFact", mutation.factID);
    if (ownerOutcome(mutation, read) === "landed")
      void bridge.call("ownerSettle", mutation.mutationID);
    else unknown.push(mutation);
  }
  // A read begun before or during a change shows nothing; the change's end reads again.
  if (!ownerStore.fence.holds("owner", generation)) return;
  if (result.ok) {
    ownerStore.memory = result.value;
    ownerStore.error = undefined;
  } else ownerStore.error = `Not up to date: ${result.error}`;
  if (saved.ok) ownerStore.unknown = unknown;
  drawOwner();
};

/** Sends one change once; nothing is retried, and any later read shows what it left. */
const changeOwner = async (
  row: string,
  factID: string | null,
  action: OwnerAction,
  version: number,
  text: string | null,
) => {
  if (ownerStore.sending !== undefined) return undefined;
  ownerStore.sending = row;
  ownerStore.fence.advance("owner");
  drawOwner();
  let result: Reply<{ fact: OwnerFact }>;
  try {
    result = await bridge.call("ownerChange", factID, action, version, text);
  } catch {
    result = { ok: false, error: "No answer. Nothing was retried.", lost: true };
  }
  ownerStore.sending = undefined;
  ownerStore.fence.advance("owner");
  if (result.ok) ownerStore.errors.delete(row);
  else ownerStore.errors.set(row, ownerFailure(result));
  const current = result.ok ? undefined : result.current;
  if (
    !result.ok &&
    result.status === 409 &&
    text !== null &&
    current &&
    typeof current === "object"
  )
    ownerStore.rejected.set(row, {
      mine: text,
      current:
        "text" in current && typeof current.text === "string"
          ? current.text
          : "state" in current && (current.state === "rejected" || current.state === "deleted")
            ? `(${current.state}: no dot sees it)`
            : "(no longer pending or approved)",
    });
  void readOwner();
  return result;
};

const originLine = (fact: OwnerFact) =>
  fact.origin
    ? `Suggested by ${fact.origin.dot}, in session ${fact.origin.sessionID}, message ${fact.origin.messageID}.`
    : "Suggested by a dot.";

/** About you: facts every dot sees as the owner's own word, once the owner approves them. */
export const OwnerFacts = ({ ask }: { ask: AskOwner }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const draw = () => setTick((tick) => tick + 1);
    ownerStore.panes.add(draw);
    void readOwner();
    const timer = setInterval(() => void readOwner(), 20_000);
    return () => {
      ownerStore.panes.delete(draw);
      clearInterval(timer);
    };
  }, []);
  const { memory, drafts, sending } = ownerStore;
  const busy = sending !== undefined;

  const rowState = (row: string) => (
    <>
      {ownerStore.errors.get(row) ? (
        <div className="item-error" role="alert" data-row-error={row}>
          {ownerStore.errors.get(row)}
        </div>
      ) : null}
      {ownerStore.rejected.get(row) ? (
        <div className="conflict" data-rejected={row}>
          <div className="note">Your text (not saved)</div>
          <pre className="conflict-text">{ownerStore.rejected.get(row)?.mine}</pre>
          <div className="note">As it is now</div>
          <pre className="conflict-text">{ownerStore.rejected.get(row)?.current}</pre>
          <button
            type="button"
            onClick={() => {
              ownerStore.rejected.delete(row);
              drawOwner();
            }}
          >
            Discard your text
          </button>
        </div>
      ) : null}
    </>
  );

  /** Saves a draft with the version it started from; the editor takes no typing meanwhile. */
  const saveDraft = async (row: string, fact: OwnerFact, action: "approve" | "edit") => {
    const draft = drafts.begin(row);
    if (!draft) return;
    drawOwner();
    const result = await changeOwner(row, fact.id, action, draft.version, draft.edited);
    if (!result) {
      drafts.finish(row, { ok: false, error: "" }, false);
      return drawOwner();
    }
    drafts.finish(row, result, ownerStore.rejected.has(row));
    drawOwner();
  };

  const editor = (row: string, fact: OwnerFact, action: "approve" | "edit") => {
    const draft = drafts.get(row);
    if (!draft) return null;
    const out = draft.sending !== undefined;
    return (
      <div className="editor" data-editing={row}>
        <textarea
          aria-label={action === "approve" ? "Edit the suggestion before approving" : "Edit fact"}
          value={draft.edited}
          readOnly={out}
          maxLength={500}
          onChange={(event) => {
            if (drafts.edit(row, event.target.value)) drawOwner();
          }}
        />
        <div className="item-actions">
          <button
            type="button"
            disabled={out}
            onClick={() => {
              drafts.cancel(row);
              drawOwner();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !draft.edited.trim()}
            onClick={() => void saveDraft(row, fact, action)}
          >
            {action === "approve" ? "Approve this text for every dot" : "Save for every dot"}
          </button>
        </div>
      </div>
    );
  };

  const pending = memory?.pending ?? [];
  const approved = memory?.approved ?? [];
  // Text the owner typed for a fact that was rejected or deleted meanwhile, from any dot, CLI or
  // API: kept here until the owner discards it, and never restored or sent again on its own.
  const orphans = ownerOrphans(memory, [...drafts.rows.keys(), ...ownerStore.rejected.keys()]);
  const discard = (row: string) => {
    drafts.cancel(row);
    ownerStore.rejected.delete(row);
    ownerStore.errors.delete(row);
    drawOwner();
  };
  const orphanState = {
    rejected: "This fact was rejected meanwhile, so no dot sees it.",
    deleted: "This fact was deleted meanwhile, so no dot sees it.",
    missing: "This fact is no longer in your facts.",
  };
  return (
    <Section
      title="About you — shared with every dot"
      id="owner"
      note="Approved facts reach every dot as your own word, from its next request. A dot can only suggest one; a suggestion reaches no dot until you approve it. Notes and observations stay with their own dot."
    >
      {ownerStore.error ? <div className="banner">{ownerStore.error}</div> : null}
      {ownerStore.unknown.map((mutation) => (
        <div className="item-error" role="alert" key={mutation.mutationID} data-owner-unknown>
          {ownerActionWords[mutation.action]} may or may not have been saved: its answer was lost.
          It was not sent again; check the facts below.{" "}
          <button
            type="button"
            onClick={() => {
              void bridge.call("ownerSettle", mutation.mutationID).then(() => readOwner());
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
      {orphans.length ? (
        <>
          <h4>Your unsaved text</h4>
          <ul className="items">
            {orphans.map(({ row, factID, state }) => {
              const draft = drafts.get(row);
              const out = draft?.sending !== undefined;
              const texts = [draft?.edited, ownerStore.rejected.get(row)?.mine].filter(
                (text, index, all): text is string =>
                  text !== undefined && all.indexOf(text) === index,
              );
              return (
                <li key={row} className="item" data-owner-orphan={factID} data-state={state}>
                  <div className="note">
                    {orphanState[state]} Your text below wasn't saved and isn't sent again.
                  </div>
                  {ownerStore.errors.get(row) ? (
                    <div className="item-error" role="alert" data-row-error={row}>
                      {ownerStore.errors.get(row)}
                    </div>
                  ) : null}
                  {texts.map((text) => (
                    <div key={text}>
                      <pre className="conflict-text" data-owner-orphan-text>
                        {text}
                      </pre>
                      <div className="item-actions">
                        <button
                          type="button"
                          disabled={
                            out || ownerStore.adding.trim() !== "" || sending === "owner:new"
                          }
                          onClick={() => {
                            ownerStore.adding = text;
                            drawOwner();
                          }}
                        >
                          Put in Add a fact
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="item-actions">
                    <button type="button" disabled={out} onClick={() => discard(row)}>
                      Discard your text
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <h4>Suggested by dots</h4>
      {pending.length ? null : <p className="empty-line">No suggestions waiting.</p>}
      <ul className="items">
        {pending.map((fact) => {
          const row = `owner:${fact.id}`;
          const text = fact.text ?? "";
          return (
            <li key={fact.id} className="item" data-owner-pending={fact.id}>
              <div className="note">
                Untrusted suggestion, not evidence it's true. {originLine(fact)}
              </div>
              <div className="item-text">{text}</div>
              {drafts.get(row) ? (
                editor(row, fact, "approve")
              ) : (
                <div className="item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      ask({
                        title: "Approve for every dot?",
                        text: `Every dot will see this about you as your own word: ${text}`,
                        buttons: [
                          { label: "Cancel" },
                          {
                            label: "Approve",
                            run: () =>
                              void changeOwner(row, fact.id, "approve", fact.version, null),
                          },
                        ],
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      drafts.start(row, fact.version, text);
                      drawOwner();
                    }}
                  >
                    Edit and approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void changeOwner(row, fact.id, "reject", fact.version, null)}
                  >
                    Reject
                  </button>
                </div>
              )}
              {rowState(row)}
            </li>
          );
        })}
      </ul>
      <h4>Approved</h4>
      {approved.length ? null : <p className="empty-line">No approved facts.</p>}
      <ul className="items">
        {approved.map((fact) => {
          const row = `owner:${fact.id}`;
          const text = fact.text ?? "";
          return (
            <li key={fact.id} className="item" data-owner-approved={fact.id}>
              <div className="item-text">{text}</div>
              {drafts.get(row) ? (
                editor(row, fact, "edit")
              ) : (
                <div className="item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      drafts.start(row, fact.version, text);
                      drawOwner();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      ask({
                        title: "Delete this fact?",
                        text: `No dot will see it from its next request, and no dot can suggest it again: ${text}`,
                        buttons: [
                          { label: "Cancel" },
                          {
                            label: "Delete",
                            danger: true,
                            run: () => void changeOwner(row, fact.id, "delete", fact.version, null),
                          },
                        ],
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              )}
              {rowState(row)}
            </li>
          );
        })}
      </ul>
      <form
        className="editor"
        aria-label="Add a fact about you"
        onSubmit={(event) => {
          event.preventDefault();
          const text = ownerStore.adding;
          if (!text.trim()) return;
          void changeOwner("owner:new", null, "create", 0, text).then((result) => {
            // Only a confirmed add of the text as sent clears the field.
            if (result?.ok && ownerStore.adding === text) ownerStore.adding = "";
            drawOwner();
          });
        }}
      >
        <textarea
          aria-label="New fact about you, shared with every dot"
          value={ownerStore.adding}
          maxLength={500}
          readOnly={sending === "owner:new"}
          onChange={(event) => {
            ownerStore.adding = event.target.value;
            drawOwner();
          }}
        />
        <button type="submit" disabled={busy || !ownerStore.adding.trim()}>
          Add for every dot
        </button>
        {rowState("owner:new")}
      </form>
    </Section>
  );
};
