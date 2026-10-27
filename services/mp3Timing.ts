export interface Mp3Timing {
  sampleRate: number;
  delaySamples: number;
  paddingSamples: number;
  duration: number;
}

/** Read only a bounded raw-MP3 header. Container timestamps stay authoritative.
 * Xing/Info extensions identify encoder delay/padding; MP3 decoding contributes
 * another 529 leading samples. Unknown tags never get an invented correction.
 */
export async function mp3Timing(blob: Blob): Promise<Mp3Timing | null> {
  let offset = 0;
  const ascii = (bytes: Uint8Array, start: number, size: number) => String.fromCharCode(...bytes.subarray(start, start + size));
  for (let tags = 0; tags < 16; tags++) {
    const header = new Uint8Array(await blob.slice(offset, offset + 10).arrayBuffer());
    if (ascii(header, 0, 3) !== "ID3") break;
    if (header.length < 10 || ![2, 3, 4].includes(header[3]) || header.subarray(6, 10).some(value => value & 128)) return null;
    const size = header[6] * 2097152 + header[7] * 16384 + header[8] * 128 + header[9];
    offset += 10 + size + (header[3] === 4 && (header[5] & 16) ? 10 : 0);
    if (offset >= blob.size || tags === 15) return null;
  }
  const bytes = new Uint8Array(await blob.slice(offset, offset + 4096).arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 255 || (bytes[1] & 224) !== 224 || ((bytes[1] >> 1) & 3) !== 1) return null;
  const version = (bytes[1] >> 3) & 3, rateIndex = (bytes[2] >> 2) & 3, bitrateIndex = bytes[2] >> 4;
  if (version === 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const rates = version === 3 ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const frameSize = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex - 1] / sampleRate) + ((bytes[2] >> 1) & 1);
  const mono = (bytes[3] >> 6) === 3, sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  let start = 4 + sideInfo;
  if (!["Info", "Xing"].includes(ascii(bytes, start, 4)) && !(bytes[1] & 1)) start += 2;
  if (!["Info", "Xing"].includes(ascii(bytes, start, 4)) || frameSize > bytes.length || start + 12 > frameSize) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, frameSize);
  const flags = view.getUint32(start + 4), frames = flags & 1 ? view.getUint32(start + 8) : 0;
  if (flags & ~15 || !frames || frames > Math.ceil((blob.size - offset) / 24)) return null;
  let extension = start + 8;
  for (const [flag, size] of [[1, 4], [2, 4], [4, 100], [8, 4]]) if (flags & flag) extension += size;
  if (extension + 24 > frameSize || !["LAME", "Lavc", "Lavf"].includes(ascii(bytes, extension, 4))) return null;
  const encodedDelay = bytes[extension + 21] * 16 + (bytes[extension + 22] >> 4);
  const encodedPadding = (bytes[extension + 22] & 15) * 256 + bytes[extension + 23];
  const total = frames * (version === 3 ? 1152 : 576), duration = (total - encodedDelay - encodedPadding) / sampleRate;
  if (total <= encodedDelay + 529 || duration <= 0) return null;
  return { sampleRate, delaySamples: encodedDelay + 529, paddingSamples: Math.max(0, encodedPadding - 529), duration };
}
