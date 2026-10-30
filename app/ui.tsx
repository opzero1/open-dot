/** @jsxImportSource react */
// What the window's panes share: the bridge, the one dialog and a section heading.
import { type ReactNode, useEffect, useRef } from "react";
import type { Bridge } from "./bridge";

const loaded = globalThis.openDot;
if (!loaded) throw new Error("The app's preload didn't load.");
export const bridge: Bridge = loaded;

/**
 * A question for the owner. The first button is the safe one, which Escape and Return pick; a
 * button without `run` only closes.
 */
export interface Ask {
  title: string;
  text?: string | undefined;
  buttons: { label: string; danger?: boolean; run?: () => void }[];
}

export type AskOwner = (ask: Ask) => void;

export const Dialog = ({ ask, onClose }: { ask: Ask; onClose: () => void }) => {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), [ask]);
  return (
    <div className="modal" role="alertdialog" aria-modal="true" aria-label={ask.title}>
      <div
        className="modal-box"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <p className="modal-title">{ask.title}</p>
        {ask.text ? <p className="modal-text">{ask.text}</p> : null}
        <div className="modal-actions">
          {ask.buttons.map((button, index) => (
            <button
              key={button.label}
              ref={index === 0 ? first : undefined}
              type="button"
              className={button.danger ? "danger" : undefined}
              onClick={() => {
                onClose();
                button.run?.();
              }}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export const Section = ({
  title,
  note,
  children,
  id,
}: {
  title: string;
  note?: string | undefined;
  children: ReactNode;
  id?: string;
}) => (
  <section className="pane-section" aria-label={title} data-section={id}>
    <h3>{title}</h3>
    {note ? <p className="note">{note}</p> : null}
    {children}
  </section>
);

export const when = (time: number) =>
  new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
