import identity from "../brand.json";
/** Display identity and new-file defaults; schema/storage/integration IDs are independent. */
export const BRAND = Object.freeze(identity);
export const APP_VERSION = typeof __APP_VERSION__ === "undefined" ? "unqualified" : __APP_VERSION__;
export function defaultProjectFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 16);
  return `${BRAND.projectPrefix}_${stamp}.json`;
}
