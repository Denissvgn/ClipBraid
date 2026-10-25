/** Half-open source selection mapped to the output timeline, in seconds. */
export interface AudioSelection {
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
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
  source.buffer = selected;
  source.connect(context.destination);
  source.start(window.when, (window.first - retained.first) / buffer.sampleRate, window.duration);
  return source;
}
