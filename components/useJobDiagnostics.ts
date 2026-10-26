import { useEffect, useRef, useState } from "react";
import type { ExportState } from "../services/exportJob";
import { createJobReport, DiagnosticHistory, type JobReport } from "../services/diagnostics";

export function useJobDiagnostics(state: ExportState) {
  const history = useRef<DiagnosticHistory | null>(null);
  const latest = useRef(state); latest.current = state;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ignoredJob = useRef<string | null>(null);
  const [reports, setReports] = useState<JobReport[]>([]);
  const [warning, setWarning] = useState("");
  const problem = () => setWarning("Diagnostic history could not be saved on this device. You can still copy the current job’s diagnostics.");
  const persist = () => {
    const report = createJobReport(latest.current);
    if (!report || !history.current || report.jobId === ignoredJob.current) return;
    try { setReports(history.current.record(report)); setWarning(""); }
    catch { problem(); }
  };
  useEffect(() => {
    try { history.current = new DiagnosticHistory(window.localStorage); setReports(history.current.read()); }
    catch { problem(); }
    const flush = () => { clearTimeout(timer.current); timer.current = undefined; persist(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  useEffect(() => {
    if (!state.jobId) return;
    if (!state.active) { clearTimeout(timer.current); timer.current = undefined; persist(); }
    else if (!timer.current) timer.current = setTimeout(() => { timer.current = undefined; persist(); }, 1000);
  }, [state]);
  const clear = () => {
    if (!history.current) { problem(); return; }
    try { history.current.clear(); ignoredJob.current = latest.current.jobId; clearTimeout(timer.current); timer.current = undefined; setReports([]); setWarning(""); }
    catch { problem(); }
  };
  return { reports, warning, clear };
}
