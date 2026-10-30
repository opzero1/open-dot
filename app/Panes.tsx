/** @jsxImportSource react */
// A dot's Library and the daemon's Health: read-only views. Export only saves a copy where the
// owner chooses, never previewing or opening it, and nothing here repairs or restarts anything.
import { useCallback, useEffect, useState } from "react";
import type { Artifact, HealthCheck, HealthReport } from "./bridge";
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

export const Health = () => {
  const [report, setReport] = useState<HealthReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    const result = await bridge.call("health");
    setLoading(false);
    if (!result.ok) return setError(result.error);
    setError(undefined);
    setReport(result.value);
  }, []);

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
