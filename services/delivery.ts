import { Flow, isHostedFlow } from "../platform";
export type DeliveryOutcome = "download-started" | "host-accepted";
export type DeliveryCategory = "rejected" | "cancelled" | "denied" | "unsupported" | "transport" | "unknown" | "size-limit";
export const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
export const MAX_VIDEO_BASE64_CHARS = 128 * 1024 * 1024;
export class DeliveryError extends Error {
  constructor(message: string, readonly category: DeliveryCategory, readonly deliveryMayHaveStarted = false) {
    super(message); this.name = category === "cancelled" ? "AbortError" : "DeliveryError";
  }
}
export function deliveryFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const name = (error as { name?: string })?.name;
  const advertised = (error as { category?: DeliveryCategory })?.category;
  if (advertised && ["cancelled","denied","unsupported","transport","unknown","rejected","size-limit"].includes(advertised))
    return new DeliveryError(String(error), advertised, (error as {deliveryMayHaveStarted?:boolean}).deliveryMayHaveStarted ?? ["unknown","transport"].includes(advertised));
  const category = name === "AbortError" ? "cancelled" : name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotSupportedError" ? "unsupported" : "transport";
  return new DeliveryError(String(error), category, category === "transport");
}
export function videoDeliveryLimits() {
  const capabilities = Flow.capabilities;
  const limit = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new DeliveryError("The host advertised an invalid video delivery limit.", "unsupported");
    return Math.min(fallback, value);
  };
  return { bytes: limit(capabilities?.maxSaveBytes, MAX_VIDEO_BYTES), base64Chars: limit(capabilities?.maxBase64Chars, MAX_VIDEO_BASE64_CHARS) };
}
export function assertVideoSize(bytes: number, base64Chars = 4 * Math.ceil(bytes / 3)) {
  const limits = videoDeliveryLimits();
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(base64Chars) || base64Chars < 4 ||
    bytes > limits.bytes || base64Chars > limits.base64Chars)
    throw new DeliveryError(`Video exceeds the delivery limit (${(limits.bytes / 1048576).toFixed(1)} MiB video, ${(limits.base64Chars / 1048576).toFixed(1)} MiB base64). Choose a lower profile or shorter timeline.`, "size-limit");
}
export async function deliverVideo(payload: { base64: string; mimeType: string; name: string; signal?: AbortSignal }): Promise<{ outcome: DeliveryOutcome }> {
  try {
    payload.signal?.throwIfAborted();
    assertVideoSize(Math.floor(payload.base64.length * 3 / 4) - (payload.base64.endsWith("==") ? 2 : payload.base64.endsWith("=") ? 1 : 0), payload.base64.length);
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
