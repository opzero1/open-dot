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
  Fence,
  grantRemaining,
  memoryChange,
  memoryFailure,
  nextRunLine,
  sourceSummary,
  supervisionTimes,
} from "./surfaces";
import { type AskOwner, bridge, Section, when } from "./ui";

const triggerReasons = [
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "comment",
  "author",
];
const statuses = ["active", "done", "dropped"];

const short = (text: string, limit = 200) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

type Fields = { goal: string; nextAction: string; status: string };

interface Kept {
  edits: Map<string, string>;
  fields: Map<number, { original: Fields; edited: Fields }>;
  rejected: Map<string, { mine: string; current: string }>;
}

// Unsent edits per dot, kept while the window lives so switching panes or dots doesn't drop them.
const kept = new Map<string, Kept>();

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
  const [busy, setBusy] = useState(new Set<string>());
  const [rowErrors, setRowErrors] = useState(new Map<string, string>());
  const initial = kept.get(dot) ?? { edits: new Map(), fields: new Map(), rejected: new Map() };
  const [edits, setEdits] = useState(initial.edits);
  const [fields, setFields] = useState(initial.fields);
  const [rejected, setRejected] = useState(initial.rejected);
  useEffect(() => {
    kept.set(dot, { edits, fields, rejected });
  }, [dot, edits, fields, rejected]);

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
    setMemory(undefined);
    void read();
    const timer = setInterval(() => void read(), 20_000);
    return () => clearInterval(timer);
  }, [read, key]);

  const setRowError = (row: string, text: string | undefined) =>
    setRowErrors((current) => {
      const next = new Map(current);
      if (text) next.set(row, text);
      else next.delete(row);
      return next;
    });

  /**
   * Sends one change once. Reads out meanwhile are dropped, and one read follows. A 409 shows
   * the value now beside what the owner tried; nothing is retried.
   */
  const mutate = async (
    row: string,
    work: () => Promise<Reply<unknown>>,
    rejectedText?: { mine: string; current: (value: unknown) => string | undefined },
  ) => {
    if (busy.has(row)) return false;
    const at = keyRef.current;
    fence.current.advance(at);
    setBusy((current) => new Set(current).add(row));
    const result = await work();
    fence.current.advance(at);
    setBusy((current) => {
      const next = new Set(current);
      next.delete(row);
      return next;
    });
    if (result.ok) setRowError(row, undefined);
    else {
      setRowError(row, memoryFailure(result));
      const current = result.status === 409 ? rejectedText?.current(result.current) : undefined;
      if (rejectedText && current !== undefined)
        setRejected((known) => new Map(known).set(row, { mine: rejectedText.mine, current }));
    }
    void read();
    return result.ok;
  };

  const edit = (row: string, text: string | undefined) =>
    setEdits((current) => {
      const next = new Map(current);
      if (text === undefined) next.delete(row);
      else next.set(row, text);
      return next;
    });

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
          <button
            type="button"
            onClick={() =>
              setRejected((current) => {
                const next = new Map(current);
                next.delete(row);
                return next;
              })
            }
          >
            Discard rejected edit
          </button>
        </div>
      ) : null}
    </>
  );

  /** A text row's editor: Save sends the text with the version it started from. */
  const textEditor = (row: string, label: string, save: (text: string) => void) => {
    const text = edits.get(row);
    if (text === undefined) return null;
    return (
      <div className="editor">
        <textarea
          aria-label={label}
          value={text}
          onChange={(event) => edit(row, event.target.value)}
        />
        <div className="item-actions">
          <button type="button" onClick={() => edit(row, undefined)}>
            Cancel
          </button>
          <button
            type="button"
            className="send"
            disabled={busy.has(row) || !text.trim()}
            onClick={() => save(text.trim())}
          >
            {busy.has(row) ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const saveText = (
    row: string,
    original: string,
    text: string,
    work: () => Promise<Reply<unknown>>,
  ) => {
    if (text === original) return edit(row, undefined);
    void mutate(row, work, { mine: text, current: textOf }).then((ok) => {
      // A refused edit stays beside the value now; the editor closes either way.
      edit(row, undefined);
      if (ok)
        setRejected((current) => {
          const next = new Map(current);
          next.delete(row);
          return next;
        });
    });
  };

  // Notes.

  const [sources, setSources] = useState(new Map<number, string>());
  const [newNote, setNewNote] = useState("");

  const toggleSource = async (note: MemoryNote) => {
    if (sources.has(note.id)) {
      setSources((current) => {
        const next = new Map(current);
        next.delete(note.id);
        return next;
      });
      return;
    }
    const result = await bridge.call("noteSource", dot, note.id);
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
        {textEditor(row, "Note", (text) =>
          saveText(row, note.text, text, () =>
            bridge.call("editNote", dot, note.id, note.version, text),
          ),
        )}
        <div className="item-actions">
          <button type="button" onClick={() => edit(row, note.text)}>
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
      <div className="item-title">
        Run #{run.id} · {run.state}
      </div>
      <div className="note">
        Due {when(run.dueAt)} · claimed {when(run.claimedAt)}
        {run.turn?.endedAt ? ` · ended ${when(run.turn.endedAt)}` : ""}
      </div>
      {run.turn?.error ? <div className="note">{run.turn.error}</div> : null}
      {run.result ? (
        <>
          <div className="note">The start of the dot's last reply in that turn, as its data:</div>
          <pre className="source">{run.result.text}</pre>
        </>
      ) : null}
      {run.workers.length ? (
        <div className="note">
          Workers: {run.workers.map((worker) => `#${worker.id} ${worker.state}`).join(", ")}
          {run.withheldWorkers ? ` and ${run.withheldWorkers} more` : ""}
        </div>
      ) : null}
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
    const editing = fields.get(row.id);
    const shownRuns = runs.get(row.id);
    const setEdited = (change: Partial<Fields>) =>
      setFields((current) => {
        const known = current.get(row.id);
        return known
          ? new Map(current).set(row.id, { ...known, edited: { ...known.edited, ...change } })
          : current;
      });
    const close = () =>
      setFields((current) => {
        const next = new Map(current);
        next.delete(row.id);
        return next;
      });
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
              value={editing.edited.goal}
              onChange={(event) => setEdited({ goal: event.target.value })}
            />
            <textarea
              aria-label="Next action"
              value={editing.edited.nextAction}
              onChange={(event) => setEdited({ nextAction: event.target.value })}
            />
            <select
              aria-label="Status"
              value={editing.edited.status}
              onChange={(event) => setEdited({ status: event.target.value })}
            >
              {statuses.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
            <div className="item-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="send"
                disabled={busy.has(id)}
                onClick={() => {
                  // Only the fields the owner changed, so one the dot changed meanwhile stays.
                  const change = changedFields(editing.original, editing.edited);
                  if (!Object.keys(change).length) return close();
                  void mutate(
                    id,
                    () => bridge.call("editResponsibility", dot, row.id, row.version, change),
                    {
                      mine: Object.entries(change)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join("\n"),
                      current: fieldsOf,
                    },
                  ).then(close);
                }}
              >
                {busy.has(id) ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="item-actions">
          <button
            type="button"
            onClick={() => {
              const original = { goal: row.goal, nextAction: row.nextAction, status: row.status };
              setFields((current) => new Map(current).set(row.id, { original, edited: original }));
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
    const editing = edits.get(row);
    const repeat = `reminder-every:${reminder.id}`;
    const every = (edits.get(repeat) ?? "").trim();
    // Empty repeats never; otherwise whole minutes, as the daemon takes them.
    const everyMinutes = every === "" ? null : /^\d+$/.test(every) ? Number(every) : Number.NaN;
    const everyValid =
      everyMinutes === null ||
      (Number.isSafeInteger(everyMinutes) && everyMinutes >= 1 && everyMinutes <= 525_600);
    return (
      <li key={reminder.id} className="item" data-reminder={reminder.id}>
        <div className="item-text">{reminder.text}</div>
        <div className="note">
          Due {when(reminder.dueAt)}
          {reminder.everyMinutes ? ` · every ${reminder.everyMinutes} minutes` : ""} ·{" "}
          {reminder.state}
        </div>
        {rowState(row)}
        {editing !== undefined ? (
          <div className="editor">
            <label>
              Due{" "}
              <input
                type="datetime-local"
                value={editing}
                onChange={(event) => edit(row, event.target.value)}
              />
            </label>
            <label>
              Repeat every{" "}
              <input
                inputMode="numeric"
                size={7}
                aria-invalid={!everyValid}
                value={edits.get(repeat) ?? ""}
                onChange={(event) => edit(repeat, event.target.value)}
              />{" "}
              minutes (empty for once)
            </label>
            <div className="item-actions">
              <button
                type="button"
                onClick={() => {
                  edit(row, undefined);
                  edit(repeat, undefined);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="send"
                disabled={busy.has(row) || Number.isNaN(new Date(editing).getTime()) || !everyValid}
                onClick={() => {
                  const dueAt = new Date(editing).getTime();
                  // Only what changed goes, against the version the edit started from.
                  const change: { dueAt?: number; everyMinutes?: number | null } = {};
                  // The field shows whole minutes, so an untouched time keeps its seconds.
                  if (editing !== local(reminder.dueAt)) change.dueAt = dueAt;
                  if (everyMinutes !== reminder.everyMinutes) change.everyMinutes = everyMinutes;
                  edit(row, undefined);
                  edit(repeat, undefined);
                  if (Object.keys(change).length)
                    void mutate(row, () =>
                      bridge.call("editReminder", dot, reminder.id, reminder.version, change),
                    );
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : null}
        <div className="item-actions">
          <button
            type="button"
            onClick={() => {
              edit(row, local(reminder.dueAt));
              edit(repeat, reminder.everyMinutes === null ? "" : String(reminder.everyMinutes));
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
  const [newObservation, setNewObservation] = useState("");

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
        {textEditor(row, "Observation", (text) =>
          saveText(row, observation.text, text, () =>
            bridge.call("editObservation", dot, observation.id, observation.version, text),
          ),
        )}
        <div className="item-actions">
          <button type="button" onClick={() => edit(row, observation.text)}>
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
                            void bridge
                              .call("observationSource", dot, observation.id, source.messageID)
                              .then((result) =>
                                setOpened((current) =>
                                  new Map(current).set(at, result.ok ? result.value : result.error),
                                ),
                              );
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

  // Recall: notes, archived messages and observations matching the owner's words.

  const [query, setQuery] = useState("");
  const [recall, setRecall] = useState<Recall & { offset: number }>();
  const [recallError, setRecallError] = useState<string>();
  const [zoom, setZoom] = useState(new Map<string, Archived | string>());

  const search = async (offset: number) => {
    const words = (offset ? recall?.query : query.trim()) ?? "";
    if (!words) return;
    const at = keyRef.current;
    const result = await bridge.call("recall", dot, words, offset);
    if (keyRef.current !== at) return;
    if (!result.ok) return setRecallError(result.error);
    setRecallError(undefined);
    setRecall((current) =>
      offset && current
        ? { ...result.value, offset, results: [...current.results, ...result.value.results] }
        : { ...result.value, offset },
    );
  };

  const readArchived = async (message: string, offset: number) => {
    const result = await bridge.call("archived", dot, message, offset);
    setZoom((current) => {
      const known = current.get(message);
      const next = new Map(current);
      if (!result.ok) next.set(message, result.error);
      else if (offset && typeof known === "object")
        next.set(message, { ...result.value, text: known.text + result.value.text });
      else next.set(message, result.value);
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
  const [draft, setDraft] = useState<{
    responsibility: string;
    repository: string;
    reasons: string[];
    task: string;
  }>();

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
    void mutate("trigger:new", () =>
      bridge.call("createTrigger", dot, {
        responsibility,
        repository: draft.repository.trim(),
        reasons: draft.reasons,
        task: draft.task.trim(),
      }),
    ).then((ok) => {
      if (ok) setDraft(undefined);
    });
  };

  if (!memory)
    return (
      <div className="pane memory" aria-label={`${dot}'s memory`} data-pane="memory">
        <header className="pane-head">
          <h2>Memory</h2>
        </header>
        {error ? <div className="banner">{error}</div> : <p className="empty-line">Loading…</p>}
      </div>
    );

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
          onSubmit={(event) => {
            event.preventDefault();
            void search(0);
          }}
        >
          <input
            aria-label={`Search ${dot}'s memory`}
            placeholder="Search notes, observations and archived messages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={!query.trim()}>
            Search
          </button>
          {recall ? (
            <button type="button" onClick={() => setRecall(undefined)}>
              Clear
            </button>
          ) : null}
        </form>
        {recallError ? <div className="item-error">{recallError}</div> : null}
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
              <button type="button" onClick={() => void search(recall.next ?? 0)}>
                More results
              </button>
            ) : null}
          </Section>
        ) : null}

        <Section title="Notes" id="notes">
          <ul className="items">{memory.notes.map(noteRow)}</ul>
          <form
            className="field-row"
            onSubmit={(event) => {
              event.preventDefault();
              const text = newNote.trim();
              if (!text) return;
              void mutate("note:new", () => bridge.call("addNote", dot, text)).then((ok) => {
                if (ok) setNewNote("");
              });
            }}
          >
            <input
              aria-label="New note"
              placeholder="Add a note"
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
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
                (ok) => {
                  if (ok) setNewObservation("");
                },
              );
            }}
          >
            <input
              aria-label="New observation"
              placeholder="Add an observation"
              value={newObservation}
              onChange={(event) => setNewObservation(event.target.value)}
            />
            <button type="submit" disabled={!newObservation.trim()}>
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

        <Section title="Worker requests and answers" id="requests">
          {requestsError ? <div className="item-error">{requestsError}</div> : null}
          {requests ? (
            <>
              {!requests.rows.length ? <p className="note">None.</p> : null}
              <ul className="items">
                {requests.rows.map((request) => (
                  <li key={request.id} className="item" data-request={request.id}>
                    <div className="item-title">
                      {request.title} · {request.kind} · {request.state}
                      {request.needsYou ? " · needs you" : ""}
                    </div>
                    {request.summary ? <div className="note">{request.summary}</div> : null}
                    {request.reason ? <div className="note">{request.reason}</div> : null}
                    <div className="note">{when(request.createdAt)}</div>
                    <details>
                      <summary>Details</summary>
                      <div className="mono">OpenCode request {request.requestID}</div>
                      <div className="note">What was asked, as the worker's data:</div>
                      <pre className="source">{request.detailText}</pre>
                      <div className="note">The dot's complete answer:</div>
                      <pre className="source">{request.answerText ?? "None"}</pre>
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
