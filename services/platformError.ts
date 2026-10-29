export type PlatformCategory = "cancelled" | "denied" | "unsupported" | "transport" | "unknown" | "rejected" | "size-limit" | "media";
export class PlatformError extends Error {
  constructor(message: string, readonly category: PlatformCategory, readonly deliveryMayHaveStarted = false) {
    super(message); this.name = category === "cancelled" ? "AbortError" : "PlatformError";
  }
}
export function platformFailure(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const category = (error as {category?: PlatformCategory})?.category;
  if (category && ["cancelled","denied","unsupported","transport","unknown","rejected","size-limit","media"].includes(category))
    return new PlatformError(String(error), category, (error as {deliveryMayHaveStarted?:boolean}).deliveryMayHaveStarted ?? false);
  const name = (error as { name?: string })?.name;
  const classified = name === "AbortError" ? "cancelled" : ["NotAllowedError", "SecurityError"].includes(name ?? "") ? "denied" :
    ["NotSupportedError", "NotFoundError", "OverconstrainedError"].includes(name ?? "") ? "unsupported" : "transport";
  return new PlatformError(String(error), classified);
}
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason?.name === "TimeoutError" ? new PlatformError("Platform action timed out.", "transport") : new PlatformError("Action cancelled.", "cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal?.removeEventListener("abort", abort); if (signal?.aborted) { late?.(value); abort(); } else resolve(value); },
      error => { signal?.removeEventListener("abort", abort); reject(platformFailure(error)); });
    if (signal?.aborted) abort();
  });
}
