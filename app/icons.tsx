/** @jsxImportSource react */
import type { ComponentProps } from "react";

const icons = {
  inbox: "m3 14 3-10h12l3 10v6H3zM3 14h5l2 3h4l2-3h5",
  send: "M12 19V5m-6 6 6-6 6 6",
  close: "m6 6 12 12M6 18 18 6",
  clearAll: "M3 5h18M3 10h11M3 15h7M3 20h7m12-7-7 7m0-7 7 7",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  open: "M14 4h6v6m0-6L10 14M10 4H4v16h16v-6",
  reply: "m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7",
  reload: "M20 5v6h-6m6 0a8 8 0 1 0-2 7",
  save: "m5 12 4 4L19 6",
  progress: "M20 12a8 8 0 1 1-8-8",
  stop: "M6 6h12v12H6z",
  terminal: "M3 4h18v16H3zM7 8l4 4-4 4m6 0h4",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 10v7m0-11v1",
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
