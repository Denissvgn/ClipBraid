/** Half-open source selection mapped to the output timeline, in seconds. */
export interface AudioSelection {
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
}

/** One native-rate grain per track/batch avoids decoder-chunk boundary sums. */
export function combineAudioChunks(chunks: { timestamp: number; buffer: AudioBuffer }[]) {
  if (!chunks.length) return null;
  const ordered = [...chunks].sort((a, b) => a.timestamp - b.timestamp);
  const first = ordered[0], rate = first.buffer.sampleRate, channels = first.buffer.numberOfChannels;
  const positions = ordered.map(chunk => {
    if (chunk.buffer.sampleRate !== rate || chunk.buffer.numberOfChannels !== channels)
      throw new Error("Audio format changes inside a selected range; convert this source before exporting.");
    return Math.round((chunk.timestamp - first.timestamp) * rate);
  });
  const length = Math.max(...ordered.map((chunk, index) => positions[index] + chunk.buffer.length));
  if (!Number.isSafeInteger(length) || length <= 0 || length > rate * 10)
    throw new Error("Decoded audio range exceeds the bounded mixing window.");
  const buffer = new AudioBuffer({ length, sampleRate: rate, numberOfChannels: channels });
  ordered.forEach((chunk, index) => {
    for (let channel = 0; channel < channels; channel++)
      buffer.copyToChannel(chunk.buffer.getChannelData(channel), channel, positions[index]);
  });
  return { timestamp: first.timestamp, buffer };
}

/** Select sample timestamps inside the intersection, before any resampling. */
export function audioChunkWindow(
  timestamp: number,
  length: number,
  sampleRate: number,
  selection: AudioSelection,
): { first: number; end: number; when: number; duration: number } | null {
  const { sourceStart, sourceEnd, timelineStart, timelineEnd } = selection;
  const from = Math.max(timestamp, sourceStart, sourceStart - timelineStart);
  const to = Math.min(
    timestamp + length / sampleRate,
    sourceEnd,
    sourceStart + timelineEnd - timelineStart,
  );
  if (to <= from) return null;
  // Avoid adding/removing a frame solely due to floating point subtraction.
  const frameAt = (time: number) => {
    const frame = (time - timestamp) * sampleRate;
    const rounded = Math.round(frame);
    const tolerance = Math.max(
      1e-6,
      4 * Number.EPSILON * sampleRate * Math.max(Math.abs(time), Math.abs(timestamp)),
    );
    return Math.abs(frame - rounded) < tolerance ? rounded : Math.ceil(frame);
  };
  const first = Math.max(0, Math.min(length, frameAt(from)));
  const end = Math.max(first, Math.min(length, frameAt(to)));
  if (end === first) return null;
  const firstTime = timestamp + first / sampleRate;
  const duration = Math.min((end - first) / sampleRate, to - firstTime);
  if (duration <= 0) return null;
  return {
    first,
    end,
    when: Math.max(0, timelineStart + firstTime - sourceStart),
    duration,
  };
}

export function scheduleAudioChunk(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  timestamp: number,
  selection: AudioSelection,
  options: { gain?: number; destination?: AudioNode; onNode?: (node: AudioNode) => void } = {},
): AudioBufferSourceNode | undefined {
  const window = audioChunkWindow(
    timestamp,
    buffer.length,
    buffer.sampleRate,
    selection,
  );
  if (!window) return;
  const retained = audioChunkWindow(timestamp, buffer.length, buffer.sampleRate, {
    ...selection,
    timelineStart: 0,
    timelineEnd: selection.sourceEnd - selection.sourceStart,
  })!;
  let selected = buffer;
  if (retained.first !== 0 || retained.end !== buffer.length) {
    // Offset/duration alone let a resampler interpolate excluded neighbors.
    // Copy only boundary chunks; full chunks keep their existing buffers.
    selected = context.createBuffer(
      buffer.numberOfChannels,
      retained.end - retained.first,
      buffer.sampleRate,
    );
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      selected.copyToChannel(
        buffer.getChannelData(channel).subarray(retained.first, retained.end),
        channel,
      );
    }
  }
  const source = context.createBufferSource();
  options.onNode?.(source);
  source.buffer = selected;
  if (options.gain !== undefined && options.gain !== 1) {
    const gain = context.createGain();
    options.onNode?.(gain); gain.gain.value = options.gain;
    source.connect(gain); gain.connect(options.destination ?? context.destination);
  } else source.connect(options.destination ?? context.destination);
  const firstOutput = Math.ceil(window.when * context.sampleRate - 1e-6);
  const lastOutput = Math.ceil((window.when + window.duration) * context.sampleRate - 1e-6);
  if (lastOutput <= firstOutput) { source.disconnect(); return; }
  const when = firstOutput / context.sampleRate;
  const offset = Math.max(0, (window.first - retained.first) / buffer.sampleRate + when - window.when);
  source.start(when, offset,
    (lastOutput - firstOutput) / context.sampleRate);
  return source;
}
