import type { ExportState } from "./exportJob";
import { createJobReport } from "./diagnostics";

export function exportStage(state: Pick<ExportState, "phase" | "cancellable">): string {
  return ({ idle: "Ready to export", preparing: "Preparing media", rendering: "Rendering video and mixing audio",
    muxing: "Preparing the video file", saving: "Preparing download", cancelling: "Stopping export",
    cleaning: "Releasing media", cancelled: "Export cancelled", complete: "Video handed to your browser or host",
    failed: "Couldn’t export this video" })[state.phase];
}

export function exportRecovery(state: Pick<ExportState, "failure" | "cleanupComplete"> & Partial<Pick<ExportState, "result">>) {
  const category = state.failure?.category;
  if (!state.cleanupComplete) return { retry: false, message: "Media cleanup has not finished. Save your project, then reload this page before another export." };
  if (state.result) return { retry: false, message: "The video handoff was confirmed before a later step failed. Check your downloads or host files before exporting again; avoid creating a duplicate." };
  if (category === "asset") return { retry: false, message: "Check this clip’s trim and original file. Relink or replace it; convert unsupported media to a format this browser can decode. All clips must pass the media check." };
  if (category === "size-limit") return { retry: false, message: "The video exceeds the delivery limit. Choose Draft or shorten the timeline, then export again." };
  if (category === "unsupported") return { retry: false, message: "This browser or host does not support the requested export or save action. Save your project and open it in a supported Chromium browser." };
  if (category === "denied") return { retry: true, message: "Allow downloads in your browser or host settings, then retry the export." };
  if (state.failure?.deliveryMayHaveStarted) return { retry: true, message: "Your browser or host did not confirm the handoff. Check your downloads or host files before retrying; a file may already exist." };
  if (category === "cancelled") return { retry: true, message: "The save was cancelled. You can keep editing or retry the export." };
  return { retry: true, message: "Retry the export. If it fails again, choose Draft or enable Compatibility render. Save your project before reloading the page." };
}

export function mediaRecovery(category: string): string {
  return ({ denied: "Allow file or microphone access in your browser or host settings, then try again.",
    unsupported: "Choose supported media or open the project in a Chromium browser; this host cannot perform the requested action.",
    "size-limit": "Choose a smaller file or shorter recording and try again.",
    cancelled: "You can continue editing or try the action again.",
    unknown: "Check the host’s files or recording controls before retrying; the action may have started.",
    rejected: "Check the selected file and host permissions, then try again.",
    project: "Choose a JSON project saved by a compatible editor, or recover an earlier local revision. A project from a newer format requires a compatible editor version.",
    relink: "Check the selected clip’s trim and choose its complete original file, then try again.",
    transport: "Check the host connection and permissions, then try again." } as Record<string, string>)[category]
    ?? "Check the selected file and try again.";
}

export function mediaNoticeTitle(category: string): string {
  return ({ cancelled: "Action cancelled.", denied: "Access needed.", unsupported: "Action unavailable here.",
    "size-limit": "File too large.", project: "Project could not be opened.", relink: "Original file could not be relinked.",
    unknown: "The outcome is unconfirmed.", rejected: "The action was declined.", transport: "The action could not finish." } as Record<string, string>)[category]
    ?? "The action could not finish.";
}

/** Copy only machine evidence; raw errors, filenames and media remain in opt-in local details. */
export function copyableJobDetails(state: ExportState): string {
  return JSON.stringify(createJobReport(state), null, 2);
}
