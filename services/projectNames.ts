/** Preserve a chosen basename while making the download suggestion portable. */
export function normalizeProjectFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const name = value.split(/[\\/]/).at(-1)!.trim().replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/, "");
  if (!name) return null;
  const extension = /\.json$/i.test(name) ? name.slice(-5) : ".json";
  let stem = (/\.json$/i.test(name) ? name.slice(0, -5) : name).replace(/[. ]+$/, "");
  if (!stem) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  let bounded = "", bytes = extension.length;
  const encoder = new TextEncoder();
  for (const char of stem) {
    const size = encoder.encode(char).length;
    if (bytes + size > 240) break;
    bounded += char; bytes += size;
  }
  return bounded ? `${bounded}${extension}` : null;
}
