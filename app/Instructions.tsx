/** @jsxImportSource react */
// One dot's AGENTS.md editor. The draft lives in the window's state, so it survives switching
// dots and panes; nothing discards it without asking, and nothing is saved or retried on its own.
import { useEffect } from "react";
import { type InstructionsState, instructionsLimit, instructionsTiming } from "./surfaces";
import { type AskOwner, bridge } from "./ui";

export const Instructions = ({
  dot,
  state,
  ask,
  onChange,
}: {
  dot: string;
  state: InstructionsState;
  ask: AskOwner;
  /** Called after every change of the editor's state, to render it and count unsaved drafts. */
  onChange: () => void;
}) => {
  const read = async (discarding: boolean) => {
    if (!state.beginRead(discarding)) return;
    onChange();
    state.finishRead(await bridge.call("instructions", dot));
    onChange();
  };

  useEffect(() => {
    if (!state.base && !state.busy) void read(false);
    // Loads once per dot; a loaded draft is never replaced without the owner asking.
  }, [dot, state]);

  const save = async (overwrite: boolean) => {
    const request = state.beginSave(overwrite);
    onChange();
    if (!request) return;
    state.finish(await bridge.call("saveInstructions", dot, request.content, request.revision));
    onChange();
  };

  const revert = async () => {
    const revision = state.beginRevert();
    onChange();
    if (!revision) return;
    state.finish(await bridge.call("revertInstructions", dot, revision));
    onChange();
  };

  const reload = () => {
    if (!state.dirty) {
      void read(false);
      return;
    }
    ask({
      title: "Discard your changes and reload?",
      text: "The editor loads AGENTS.md as it is now.",
      buttons: [
        { label: "Cancel" },
        { label: "Discard and Reload", danger: true, run: () => void read(true) },
      ],
    });
  };

  const busy = state.busy?.kind;
  const size = state.bytes;
  return (
    <div
      className="pane instructions"
      aria-label={`${dot}'s instructions`}
      data-pane="instructions"
    >
      <header className="pane-head">
        <h2>Instructions</h2>
        <div className="pane-tools">
          {state.tooLarge ? (
            <span className="warn">Over 64 KiB; shorten it to save.</span>
          ) : state.dirty ? (
            <span className="warn" data-unsaved>
              Unsaved changes
            </span>
          ) : null}
          <button type="button" disabled={!!busy} onClick={reload}>
            Reload
          </button>
          <button
            type="button"
            disabled={!state.canRevert}
            title="Put back the version before the last save"
            onClick={() =>
              ask({
                title: `Revert ${dot}'s instructions to the previous version?`,
                text: "Up to 10 earlier versions are kept. The text now becomes the newest one.",
                buttons: [{ label: "Cancel" }, { label: "Revert", run: () => void revert() }],
              })
            }
          >
            {busy === "reverting" ? "Reverting…" : "Revert"}
          </button>
          <button
            type="button"
            disabled={!state.dirty || !!busy}
            onClick={() =>
              ask({
                title: `Discard your changes to ${dot}'s instructions?`,
                text: "The editor goes back to the text you loaded.",
                buttons: [
                  { label: "Keep Editing" },
                  {
                    label: "Discard",
                    danger: true,
                    run: () => {
                      state.discard();
                      onChange();
                    },
                  },
                ],
              })
            }
          >
            Cancel
          </button>
          <button
            type="button"
            className="send"
            disabled={!state.canSave}
            onClick={() => void save(false)}
          >
            {busy === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      <p className="note">{instructionsTiming}</p>
      {state.error ? (
        <div className="item-error" role="alert" data-instructions-error>
          {state.error}
        </div>
      ) : null}
      {state.notice ? (
        <div className="notice" role="status">
          {state.notice}
        </div>
      ) : null}
      {state.conflict ? (
        <div className="conflict">
          <details open>
            <summary>The file as it is now</summary>
            <pre className="conflict-text">{state.conflict.content}</pre>
          </details>
          <div className="item-actions">
            <button
              type="button"
              title="Drop your edits and load the file as it is now"
              disabled={!!busy}
              onClick={() => void read(true)}
            >
              Reload
            </button>
            {state.conflictFromRevert ? null : (
              <button
                type="button"
                className="danger"
                title="Save your text over it. Its current text is kept as an earlier version for Revert."
                disabled={!state.canOverwrite}
                onClick={() => void save(true)}
              >
                Overwrite
              </button>
            )}
          </div>
        </div>
      ) : null}
      {state.base ? (
        <textarea
          className="instructions-editor"
          aria-label={`${dot}'s AGENTS.md`}
          value={state.draft}
          readOnly={!!busy}
          spellCheck={false}
          onChange={(event) => {
            if (state.edit(event.target.value)) onChange();
          }}
          onKeyDown={(event) => {
            if (event.metaKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              if (state.canSave) void save(false);
            }
          }}
        />
      ) : (
        <p className="empty-line">{busy === "loading" ? "Loading…" : "Not loaded."}</p>
      )}
      <p className="note">
        {Math.ceil(size / 1024)} of {instructionsLimit / 1024} KiB
      </p>
    </div>
  );
};
