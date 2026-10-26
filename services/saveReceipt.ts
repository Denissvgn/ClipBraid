import { PlatformError } from "./platformError";
export type SaveOutcome = "download-started" | "host-accepted";

/** Conflicting or missing acknowledgements are uncertain, never success. */
export function saveReceipt(response: unknown, hosted: boolean): { outcome: SaveOutcome } {
  const unknown = () => new PlatformError("The save adapter did not acknowledge delivery; a save may have started.", "unknown", true);
  if (response === true) return { outcome: hosted ? "host-accepted" : "download-started" };
  if (response === false) throw new PlatformError("The save adapter rejected the file.", "rejected");
  if (!response || typeof response !== "object") throw unknown();
  const { accepted, cancelled, outcome } = response as { accepted?: unknown; cancelled?: unknown; outcome?: unknown };
  if ((accepted !== undefined && typeof accepted !== "boolean") || (cancelled !== undefined && typeof cancelled !== "boolean") ||
    (outcome !== undefined && !["host-accepted", "download-started", "cancelled", "rejected"].includes(outcome as string))) throw unknown();
  const success = outcome === "host-accepted" || outcome === "download-started";
  if ((accepted === false && success) || (accepted === true && (cancelled === true || outcome === "cancelled" || outcome === "rejected")) ||
    (cancelled === true && success) || (cancelled === false && outcome === "cancelled")) throw unknown();
  if (cancelled === true || outcome === "cancelled") throw new PlatformError("The save was cancelled.", "cancelled");
  if (accepted === false || outcome === "rejected") throw new PlatformError("The save adapter rejected the file.", "rejected");
  if (success) return { outcome: outcome as SaveOutcome };
  if (accepted === true) return { outcome: "host-accepted" };
  throw unknown();
}
