import React, { useEffect, useMemo, useState } from "react";
import { useModalDialog } from "./useModalDialog";
import {
  getEvents,
  subscribeEvents,
} from "../services/journalService";
import { Icon } from "./Icon";
import type { JobReport } from "../services/diagnostics";
import { historicalReport } from "../services/reportPolicy.mjs";
export const JournalViewer: React.FC<{
  reports: JobReport[];
  warning: string;
  onClear(): void;
  currentJobId: string | null;
  currentReport: JobReport | null;
  onClose: () => void;
}> = ({ reports, warning, onClear, currentJobId, currentReport, onClose }) => {
  const dialog = useModalDialog();
  const [tab, setTab] = useState<"events" | "exports">("events");
  const [copyStatus, setCopyStatus] = useState("");
  const shown = (currentReport ? [currentReport, ...reports.filter(report => report.jobId !== currentReport.jobId)] : reports)
    .map(report => historicalReport(report, currentJobId));
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeEvents(() => setTick((value) => value + 1)), []);
  const events = useMemo(
    () =>
      getEvents()
        .reverse()
        .filter((event) =>
          `${event.kind} ${event.msg}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [tick, query],
  );
  return (
    <dialog
      ref={dialog}
      className="diagnostics-dialog"
      onCancel={onClose}
      aria-labelledby="diagnostics-title"
    >
      <div className="inspector-heading">
        <h2 id="diagnostics-title">Session details</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close diagnostics"
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="helper-text">
        Technical events from this session. These are not proof that a file was
        saved on your device.
      </p>
      <div className="segmented">
        <button
          onClick={() => setTab("events")}
          aria-pressed={tab === "events"}
        >
          System events
        </button>
          <button
            onClick={() => setTab("exports")}
            aria-pressed={tab === "exports"}
          >
            Export history
          </button>
      </div>
      {tab === "events" && <label className="diagnostics-filter" htmlFor="diagnostics-filter">
        Filter events
        <input
          id="diagnostics-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>}
      <div className="diagnostics-list">
        {tab === "events" ? (
          events.length ? (
            <ol>
              {events.map((event, index) => (
                <li key={`${event.at}-${index}`} data-kind={event.kind}>
                  <time>{event.clock}</time>
                  <span>{event.msg}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No matching events in this session.</p>
          )
        ) : (
          <>
            <p>Up to 10 saved summaries on this device, plus the current session’s report. Filenames, paths and media are omitted. Clearing history removes saved copies; current session details remain available until reload.</p>
            {warning && <p role="alert">{warning}</p>}
            <button className="button secondary" onClick={onClear}>Clear export history</button>
            {!reports.length && <p>No saved export summaries.</p>}
            {shown.map(report => <details key={report.jobId} data-diagnostic-job={report.jobId} data-diagnostic-outcome={report.outcome}>
              <summary>{report.outcome === "unknown" && report.warnings.includes("previous-session-unobserved") ? "Unobserved outcome" :
                ({running:"Running now",failed:"Export failed",cancelled:"Export cancelled",unknown:"Outcome unknown",aborted:"Observation stopped","download-started":"Download started","host-accepted":"Host accepted"})[report.outcome]} · {report.updatedAt ?? "Time unavailable"}</summary>
              {report.warnings.includes("previous-session-unobserved") && <p>{report.outcome === "unknown" ? "This saved checkpoint has no terminal outcome. It may have stopped or belong to another tab." : "This checkpoint records the outcome, but final cleanup was not observed."}</p>}
              <label>{report.jobId === currentReport?.jobId ? "Current job diagnostics" : "Saved job diagnostics"}<textarea readOnly rows={8} value={JSON.stringify(report, null, 2)} /></label>
              <button className="button secondary" onClick={async event => {
                const field = event.currentTarget.parentElement?.querySelector("textarea");
                try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopyStatus("Diagnostics copied."); }
                catch {
                  field?.focus(); field?.select();
                  setCopyStatus("Copy is unavailable. Select the report and use your device’s copy command.");
                }
              }}>{report.jobId === currentReport?.jobId ? "Copy current diagnostics" : "Copy saved diagnostics"}</button>
            </details>)}
            <p role="status">{copyStatus}</p>
          </>
        )}
      </div>
    </dialog>
  );
};
