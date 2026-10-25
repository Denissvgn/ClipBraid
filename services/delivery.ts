import { Flow, isHostedFlow } from "../platform";
export type DeliveryOutcome = "download-started" | "host-accepted";
export type DeliveryCategory = "rejected" | "cancelled" | "denied" | "unsupported" | "transport" | "unknown" | "size-limit";
export class DeliveryError extends Error {
  constructor(message: string, readonly category: DeliveryCategory, readonly deliveryMayHaveStarted = false) {
    super(message); this.name = category === "cancelled" ? "AbortError" : "DeliveryError";
  }
}
export function deliveryFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const name = (error as { name?: string })?.name;
  const category = name === "AbortError" ? "cancelled" : name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotSupportedError" ? "unsupported" : "transport";
  return new DeliveryError(String(error), category, category === "transport");
}
export async function deliverVideo(payload: { base64: string; mimeType: string; name: string; signal?: AbortSignal }): Promise<{ outcome: DeliveryOutcome }> {
  try {
    payload.signal?.throwIfAborted();
    const response = await Flow.save(payload);
    if (response === false) throw new DeliveryError("Save adapter rejected the video.", "rejected");
    if (response === true) return { outcome: isHostedFlow() ? "host-accepted" : "download-started" };
    if (response && typeof response === "object") {
      const value = response as { accepted?: unknown; cancelled?: unknown; outcome?: unknown };
      if (value.cancelled === true || value.outcome === "cancelled") throw new DeliveryError("Save was cancelled.", "cancelled");
      if (value.accepted === true || value.outcome === "host-accepted") return { outcome: "host-accepted" };
      if (value.outcome === "download-started") return { outcome: "download-started" };
    }
    throw new DeliveryError("The save adapter did not acknowledge delivery; a save may have started.", "unknown", true);
  } catch (error) { throw deliveryFailure(error); }
}
