/** @jsxImportSource react */
// What the window's panes share: the bridge, the one dialog and a section heading.
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef } from "react";
import type { Bridge, DraftImage } from "./bridge";

const loaded = globalThis.openDot;
if (!loaded) throw new Error("The app's preload didn't load.");
export const bridge: Bridge = loaded;

const icons = {
  inbox: "m3 14 3-10h12l3 10v6H3zM3 14h5l2 3h4l2-3h5",
  send: "M12 19V5m-6 6 6-6 6 6",
  close: "m6 6 12 12M6 18 18 6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  open: "M14 4h6v6m0-6L10 14M10 4H4v16h16v-6",
  reply: "m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7",
  reload: "M20 5v6h-6m6 0a8 8 0 1 0-2 7",
  save: "m5 12 4 4L19 6",
  progress: "M20 12a8 8 0 1 1-8-8",
  down: "M12 5v14m-6-6 6 6 6-6",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
};

export const Icon = ({ icon }: { icon: keyof typeof icons }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={icons[icon]} />
  </svg>
);

export const IconButton = ({
  icon,
  label,
  className = "",
  title = label,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  icon: keyof typeof icons;
  label: string;
}) => (
  <button
    {...props}
    type={type}
    className={`icon-button ${className}`}
    aria-label={label}
    title={title}
  >
    <Icon icon={icon} />
    <span className="sr-only">{label}</span>
  </button>
);

/**
 * A question for the owner. The first button is the safe one, which Escape and Return pick; a
 * button without `run` only closes.
 */
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

/** A local image's preview, released when it leaves the screen. */
export const LocalThumb = ({
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
        <IconButton icon="close" label={`Remove ${image.name}`} onClick={onRemove} />
      ) : null}
    </span>
  );
};
