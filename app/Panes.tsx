/** @jsxImportSource react */
// A dot's Library and the daemon's Health. Export only saves a copy where the owner chooses, never
// previewing or opening it. Health repairs nothing; its OpenCode server controls run only when the
// owner clicks them, and main asks first before Restart and Stop.
import { useCallback, useEffect, useState } from "react";
import type {
  Artifact,
  DotUsage,
  HealthCheck,
  HealthReport,
  ServiceAction,
  ServiceView,
} from "./bridge";
import { ago } from "./surfaces";
import { bridge, bytes } from "./ui";

const kinds: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "application/pdf": "PDF",
};

const available = (artifact: Artifact) =>
  artifact.status === "present" || artifact.status === "verified";

const statusText = (artifact: Artifact) =>
  available(artifact)
    ? undefined
    : artifact.status === "missing"
      ? "Missing: its saved copy is gone, so it can't be exported."
      : "Corrupt: its saved copy no longer matches, so it can't be exported.";

export const Library = ({ dot }: { dot: string }) => {
  const [rows, setRows] = useState<Artifact[]>();
  const [older, setOlder] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(new Set<number>());
  const [notices, setNotices] = useState(new Map<number, string>());

  useEffect(() => {
    let live = true;
    setRows(undefined);
    void bridge.call("library", dot, null).then((result) => {
      if (!live) return;
      if (!result.ok) return setError(result.error);
      setError(undefined);
      setRows(result.value.artifacts);
      setOlder(result.value.next);
    });
    return () => {
      live = false;
    };
  }, [dot]);

  const loadOlder = async () => {
    if (older === null || loading) return;
    const cursor = older;
    setLoading(true);
    const result = await bridge.call("library", dot, cursor);
    setLoading(false);
    if (!result.ok) return setError(result.error);
    setRows((current) => {
      const known = new Set((current ?? []).map((row) => row.id));
      return [...(current ?? []), ...result.value.artifacts.filter((row) => !known.has(row.id))];
    });
    setOlder(result.value.next);
  };

  const exportOne = async (artifact: Artifact) => {
    if (exporting.has(artifact.id)) return;
    setExporting((current) => new Set(current).add(artifact.id));
    const result = await bridge.exportArtifact(dot, artifact);
    setExporting((current) => {
      const next = new Set(current);
      next.delete(artifact.id);
      return next;
    });
    const notice = result.ok
      ? result.value.saved
        ? `Saved a copy of ${artifact.name}. It wasn't opened.`
        : ""
      : `Not exported: ${result.error}`;
    setNotices((current) => {
      const next = new Map(current);
      if (notice) next.set(artifact.id, notice);
      else next.delete(artifact.id);
      return next;
    });
  };

  return (
    <div className="pane library" aria-label={`${dot}'s Library`} data-pane="library">
      <header className="pane-head">
        <h2>Library</h2>
      </header>
      <div className="pane-body">
        {error ? (
          <div className="item-error" role="alert" data-library-error>
            {error}
          </div>
        ) : null}
        {rows === undefined ? (
          error ? null : (
            <p className="empty-line">Loading…</p>
          )
        ) : rows.length === 0 && !error ? (
          <p className="empty-line">
            No deliverables yet. A dot adds one from its workers with dot_library_add.
          </p>
        ) : null}
        <ul className="items">
          {(rows ?? []).map((artifact) => (
            <li key={artifact.id} className="item" data-artifact={artifact.id}>
              <div className="item-line">
                <span className="item-title">{artifact.name}</span>
                <button
                  type="button"
                  title="Save a copy where you choose. It isn't opened."
                  aria-label={`Export ${artifact.name}`}
                  disabled={exporting.has(artifact.id) || !available(artifact)}
                  onClick={() => void exportOne(artifact)}
                >
                  {exporting.has(artifact.id) ? "Exporting…" : "Export…"}
                </button>
              </div>
              <div className="note">
                {kinds[artifact.mime] ?? "Text"} · {bytes(artifact.size)}
                {artifact.worker === null ? "" : ` · worker #${artifact.worker}`} · added{" "}
                {ago(artifact.createdAt)}
              </div>
              {statusText(artifact) ? <div className="warn">{statusText(artifact)}</div> : null}
              {notices.get(artifact.id) ? (
                <div className="notice" role="status">
                  {notices.get(artifact.id)}
                </div>
              ) : null}
              <details>
                <summary>Details</summary>
                <div className="mono">SHA-256 {artifact.sha256}</div>
              </details>
            </li>
          ))}
        </ul>
        {older !== null && rows ? (
          <button type="button" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? "Loading…" : "Load older"}
          </button>
        ) : null}
      </div>
    </div>
  );
};

const healthLabels: Record<string, string> = {
  healthy: "Healthy",
  stale: "Stale",
  failed: "Failed",
  not_configured: "Not set up",
  disabled: "Off",
};

export const healthTimes = (report: HealthReport, now = Date.now()) => {
  const checked = `Checked ${ago(report.checkedAt, now)}`;
  if (report.sampledAt !== undefined)
    return `${checked} · database sampled ${ago(report.sampledAt, now)}`;
  switch (report.sampleUnavailable) {
    case "missing":
      return `${checked} · no database sample yet`;
    case "expired":
      return `${checked} · database sample too old`;
    case "failed":
      return `${checked} · database sample failed`;
    default:
      return `${checked} · no database sample`;
  }
};

const HealthRow = ({ check }: { check: HealthCheck }) => (
  <li className="item" data-health={check.id}>
    <div className="item-line">
      <span className="item-title">{check.id}</span>
      <span className={`health-status ${check.status}`}>
        {healthLabels[check.status] ?? "Unknown"}
      </span>
    </div>
    <div className="note">{check.summary}</div>
    {check.lastSuccessAt === undefined ? null : (
      <div className="note">Last success {ago(check.lastSuccessAt)}</div>
    )}
    {check.nextStep ? <div>Next: {check.nextStep}</div> : null}
  </li>
);

const serverStates = { running: "Running", stopped: "Stopped", unknown: "Not known" } as const;
const serverBusy = { start: "Starting…", restart: "Restarting…", stop: "Stopping…" } as const;

/** OpenCode's background server, with the owner's Start, Restart… and Stop…. */
const OpenCodeServer = () => {
  const [view, setView] = useState<ServiceView>();
  const [error, setError] = useState<string>();

  const run = useCallback(async (action: ServiceAction) => {
    const result = await bridge.opencode(action);
    if (!result.ok) return setError(result.error);
    setError(undefined);
    setView(result.value);
  }, []);

  useEffect(() => {
    void run("status");
    return bridge.onEvent((event) => {
      if (event.kind === "opencode") setView(event.view);
    });
  }, [run]);

  const busy = view?.busy ?? null;
  return (
    <section className="pane-section" aria-label="OpenCode server" data-section="opencode">
      <h3>OpenCode server</h3>
      <div className="item-line">
        <span data-opencode-state={view?.state ?? "loading"}>
          {busy
            ? serverBusy[busy]
            : view
              ? `${serverStates[view.state]}${view.url ? ` at ${view.url}` : ""}`
              : "Checking…"}
        </span>
        {view?.checkedAt ? <span className="note">checked {ago(view.checkedAt)}</span> : null}
      </div>
      {view?.problem && !busy ? <div className="note">{view.problem}</div> : null}
      <div className="pane-tools">
        <button
          type="button"
          disabled={!view || busy !== null || view.state === "running"}
          onClick={() => void run("start")}
        >
          Start
        </button>
        <button
          type="button"
          disabled={!view || busy !== null || view.state === "stopped"}
          onClick={() => void run("restart")}
        >
          Restart…
        </button>
        <button
          type="button"
          className="danger"
          disabled={!view || busy !== null || view.state === "stopped"}
          onClick={() => void run("stop")}
        >
          Stop…
        </button>
      </div>
      <p className="note">
        Restart and Stop interrupt every running session, your dots and their workers included.
        open-dot never runs these on its own, and reconnects once OpenCode is back.
      </p>
      {error ? (
        <div className="item-error" role="alert">
          {error}
        </div>
      ) : null}
      {view?.last ? (
        <div data-opencode-last={view.last.ok ? "ok" : "failed"}>
          <div className="note">
            {`${view.last.action[0]?.toUpperCase()}${view.last.action.slice(1)} ${view.last.ok ? "finished" : "failed"} ${ago(view.last.at)}`}
          </div>
          {view.last.output ? <pre className="command-output">{view.last.output}</pre> : null}
        </div>
      ) : null}
    </section>
  );
};

const tokens = (n: number) => n.toLocaleString();

/** The dot's model steps per day this week, with each day's cache hit ratio, and its alarm. */
const PromptCache = ({
  usage,
  error,
}: {
  usage: DotUsage | undefined;
  error: string | undefined;
}) => (
  <section className="pane-section" aria-label="Prompt cache" data-section="cache">
    <h3>Prompt cache</h3>
    {error ? (
      <div className="item-error" role="alert">
        {error}
      </div>
    ) : null}
    {usage?.alarm ? (
      <div className="item-error" role="alert" data-cache-alarm>
        This dot's latest {usage.streak} steps after a turn's first each wrote more to the cache
        than they read, so its conversation is cached again on every step. An OpenCode upgrade may
        have changed how cache hints are ordered.
      </div>
    ) : null}
    {usage && !usage.days.length ? (
      <p className="note">
        {usage.counting
          ? "No model step recorded this week."
          : "Steps count from when the daemon first read this conversation to its end."}
      </p>
    ) : null}
    {usage?.days.length ? (
      <ul className="items">
        {usage.days.map((day) => (
          <li className="item" key={day.day} data-usage-day={day.day}>
            <div className="item-line">
              <span className="item-title">{new Date(day.day).toLocaleDateString()}</span>
              <span>
                {day.hitPercent === null || day.hitPercent === undefined
                  ? "No prompt tokens"
                  : `${day.hitPercent}% from cache`}
              </span>
            </div>
            <div className="note">
              {`${day.steps} steps: ${tokens(day.cacheRead)} read from cache, ${tokens(day.cacheWrite)} written, ${tokens(day.input)} uncached; ${tokens(day.output)} output, ${tokens(day.reasoning)} reasoning`}
            </div>
          </li>
        ))}
      </ul>
    ) : null}
  </section>
);

export const Health = ({ dot }: { dot: string }) => {
  const [report, setReport] = useState<HealthReport>();
  const [usage, setUsage] = useState<DotUsage>();
  const [usageError, setUsageError] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    const [result, steps] = await Promise.all([
      bridge.call("health"),
      bridge.call("usage", dot),
      bridge.opencode("status"),
    ]);
    setLoading(false);
    if (steps.ok) {
      setUsageError(undefined);
      setUsage(steps.value);
    } else setUsageError(steps.error);
    if (!result.ok) return setError(result.error);
    setError(undefined);
    setReport(result.value);
  }, [dot]);

  useEffect(() => void check(), [check]);

  return (
    <div className="pane health" aria-label="Health" data-pane="health">
      <header className="pane-head">
        <h2>Health</h2>
        <div className="pane-tools">
          <button type="button" disabled={loading} onClick={() => void check()}>
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>
      </header>
      <div className="pane-body">
        <OpenCodeServer />
        <PromptCache usage={usage} error={usageError} />
        <p className="note">The same report as open-dot doctor. Nothing here repairs anything.</p>
        {error ? (
          <div className="item-error" role="alert">
            {error}
          </div>
        ) : null}
        {report ? <p className="note">{healthTimes(report)}</p> : null}
        <ul className="items">
          {(report?.checks ?? []).map((item) => (
            <HealthRow key={item.id} check={item} />
          ))}
        </ul>
      </div>
    </div>
  );
};
