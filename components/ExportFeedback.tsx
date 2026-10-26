import React, { useRef, useState } from "react";
import type { ExportState } from "../services/exportJob";
import { copyableJobDetails, exportRecovery, exportStage } from "../services/exportFeedback";
import { Icon } from "./Icon";

export const ExportFeedback: React.FC<{
  state: ExportState; assetName?: string; onCancel(): void; onRetry(): void; onClose(): void;
  onSaveProject(): void; onInspect?: () => void;
}> = ({ state, assetName, onCancel, onRetry, onClose, onSaveProject, onInspect }) => {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const failed = state.phase === "failed", recovery = exportRecovery(state);
  const details = copyableJobDetails(state);
  const copy = async () => {
    try { await navigator.clipboard.writeText(details); setCopyStatus("Diagnostics copied."); }
    catch { field.current?.focus(); field.current?.select(); setCopyStatus("Copy is unavailable here. The report is selected; use your device’s copy command."); }
  };
  return <div className="export-overlay" data-export-job={state.jobId} data-export-phase={state.phase}
    role={failed ? "alert" : undefined}>
    <div className="export-message">
      <Icon name={failed ? "alert" : "video"} size={32} />
      <h2 aria-live="polite">{exportStage(state)}</h2>
      {failed ? <>
        {assetName && <p>Could not use “{assetName}”.</p>}
        <p>{recovery.message}</p>
        <div className="feedback-actions">
          {onInspect && <button className="button secondary" onClick={onInspect}>Inspect clip</button>}
          {recovery.retry && <button className="button primary" onClick={onRetry}>Retry export</button>}
          {!state.cleanupComplete && <button className="button primary" onClick={onSaveProject}>Save project</button>}
          <button className="button secondary" onClick={onClose}>Back to editing</button>
        </div>
      </> : <>
        <p>{Math.round(state.progress)}% of export processing</p>
        <progress max="100" value={state.progress} aria-label="Video export progress" />
        <button className="button secondary" onClick={onCancel} disabled={!state.cancellable}>Cancel export</button>
        <p>{state.phase === "cancelling" || state.phase === "cleaning" ? "Waiting for media resources to close…"
          : !state.cancellable ? "Waiting for your browser or host to confirm the handoff. A download may have started." : "You can cancel and keep editing."}</p>
      </>}
      <details className="technical-details">
        <summary>Technical details</summary>
        <p>Job: {state.jobId}<br />Build: {state.buildId}</p>
        <label>Copyable job diagnostics<textarea ref={field} readOnly value={details} rows={5} /></label>
        <button className="button secondary" onClick={() => void copy()}>Copy diagnostics</button>
        <p role="status">{copyStatus}</p>
        <div className="export-log">{state.error && <p>{state.error}</p>}{state.logs.map((log, index) => <p key={index}>{log}</p>)}</div>
      </details>
    </div>
  </div>;
};
