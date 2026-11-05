/** @jsxImportSource react */
// What the window's panes share: the bridge, the one dialog and a section heading.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Bridge, DraftImage } from "./bridge";
import { IconButton } from "./icons";
export { Icon, IconButton } from "./icons";

const loaded = globalThis.openDot;
if (!loaded) throw new Error("The app's preload didn't load.");
export const bridge: Bridge = loaded;

export const ExecutionDetails = ({
  children,
  failed = false,
}: {
  children: ReactNode;
  failed?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="execution-details">
      <IconButton
        icon="info"
        label="Execution details"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {failed ? (
        <span className="warning" role="status">
          Execution failed
        </span>
      ) : null}
      {open ? <div className="execution-content">{children}</div> : null}
    </div>
  );
};

/** A question for the owner. The first button is safe; a button without `run` only closes. */
export interface Ask {
  role?: "dialog" | "alertdialog";
  title: string;
  text?: string | undefined;
  buttons: { label: string; danger?: boolean; run?: () => void }[];
}

export type AskOwner = (ask: Ask) => void;

export const Dialog = ({ ask, onClose }: { ask: Ask; onClose: () => void }) => {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), [ask]);
  return (
    <div
      className="modal"
      role={ask.role ?? "alertdialog"}
      aria-modal="true"
      aria-label={ask.title}
    >
      <div
        className="modal-box"
        onKeyDown={(event) => {
          if (event.key === "Tab" && ask.role === "dialog" && ask.buttons.length === 1) {
            event.preventDefault();
            first.current?.focus();
          }
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

/** A local image's preview, released when it leaves the screen; with `onOpen`, a button. */
export const LocalThumb = ({
  image,
  className,
  onRemove,
  onOpen,
}: {
  image: DraftImage;
  className: string;
  onRemove?: () => void;
  onOpen?: (opener: HTMLButtonElement) => void;
}) => {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mime })),
    [image],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <span className={className}>
      {onOpen ? (
        <button
          type="button"
          className="thumb-open"
          aria-label={`Preview ${image.name}`}
          title={`Preview ${image.name}`}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <img src={url} alt="" />
        </button>
      ) : (
        <img src={url} alt={image.name} title={image.name} />
      )}
      {onRemove ? (
        <IconButton icon="close" label={`Remove ${image.name}`} onClick={onRemove} />
      ) : null}
    </span>
  );
};
