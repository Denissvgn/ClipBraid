import { test, expect } from "./harness.mjs";
import { openProbe } from "./fixtures.mjs";

async function prepareAudio(context) {
  const page = await openProbe(context);
  await page.evaluate(async () => {
    const { React, createRoot, AudioEngine } = window.testRuntime;
    const sampleRate = 48000, samples = sampleRate * 12;
    const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index++)
      view.setInt16(44 + index * 2, Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * 440 * index / sampleRate)), true);

    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const NativeAudio = window.Audio;
    const position = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    const rate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");
    const readiness = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState");
    const seeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "seeking");
    const output = new AudioContext(), analyser = output.createAnalyser();
    analyser.fftSize = 2048; analyser.connect(output.destination);
    let audio, observedOffset = 0, observedReadyState, observedSeeking;
    let playing = false, base = 1, anchor = performance.now();
    const writes = [], rates = [], events = [];
    const timeAt = () => base + (playing ? (performance.now() - anchor) / 1000 : 0);
    window.Audio = function (...args) {
      audio = new NativeAudio(...args);
      Object.defineProperty(audio, "currentTime", {
        configurable: true,
        get() {
          const value = position.get.call(this);
          return Math.max(0, value + (this.paused ? 0 : observedOffset));
        },
        set(value) {
          writes.push({ value, clock: timeAt(), wall: performance.now() });
          position.set.call(this, value);
        },
      });
      Object.defineProperty(audio, "playbackRate", {
        configurable: true, get() { return rate.get.call(this); },
        set(value) { rates.push(value); rate.set.call(this, value); },
      });
      // Fault injection changes observations, while decoding and all writes
      // continue through the native media element.
      Object.defineProperty(audio, "readyState", {
        configurable: true, get() { return observedReadyState ?? readiness.get.call(this); },
      });
      Object.defineProperty(audio, "seeking", {
        configurable: true, get() { return observedSeeking ?? seeking.get.call(this); },
      });
      for (const name of ["seeking", "seeked", "waiting", "playing"])
        audio.addEventListener(name, () => events.push({ name, wall: performance.now() }));
      output.createMediaElementSource(audio).connect(analyser);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    let props = {
      audioTracks: [{ id: "music", sourceId: "tone", name: "Continuous tone", startTime: 0,
        duration: 10, originalDuration: 12, trimStart: 0, trimEnd: 2 }],
      mediaAssets: [], sourceUrl: () => url, currentTime: 1, isPlaying: false, seekRevision: 0, timeAt,
    };
    const settle = (milliseconds = 50) => new Promise(resolve => setTimeout(resolve, milliseconds));
    const render = async (changes = {}) => {
      props = { ...props, ...changes };
      root.render(React.createElement(AudioEngine, props));
      await settle();
    };
    await render();
    if (audio.readyState < 1) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native tone metadata did not load")), 5000);
      audio.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      audio.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Native tone could not load")); }, { once: true });
    });
    await output.resume();
    window.audioContinuity = {
      writes, rates, events,
      render, settle,
      get audio() { return audio; },
      get props() { return props; },
      nativeTime: () => position.get.call(audio),
      timeAt,
      offset(value) { observedOffset = value; },
      observeState(readyState, isSeeking) { observedReadyState = readyState; observedSeeking = isSeeking; },
      async start() {
        anchor = performance.now(); playing = true;
        await render({ isPlaying: true, currentTime: base });
        const deadline = performance.now() + 5000;
        while ((audio.paused || audio.readyState < 3) && performance.now() < deadline) await settle(10);
        if (audio.paused || audio.readyState < 3) throw new Error("Native tone did not start");
      },
      async pause() {
        base = timeAt(); playing = false;
        await render({ isPlaying: false, currentTime: base });
      },
      async seek(value) {
        base = value; anchor = performance.now();
        await render({ currentTime: value, seekRevision: props.seekRevision + 1 });
      },
      pcm() {
        const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values);
        let energy = 0, crossings = 0;
        for (let index = 0; index < values.length; index++) {
          energy += values[index] ** 2;
          if (index && values[index - 1] <= 0 && values[index] > 0) crossings++;
        }
        return { rms: Math.sqrt(energy / values.length), frequency: crossings * output.sampleRate / values.length };
      },
      async close() {
        root.unmount(); host.remove(); await output.close(); URL.revokeObjectURL(url); window.Audio = NativeAudio;
      },
    };
  });
  return page;
}

for (const [name, offset, direction] of [["behind", -0.06, 1], ["ahead", 0.06, -1]]) {
  test(`small native audio drift ${name} the clock preserves continuous sound`, async ({ context }, info) => {
    const page = await prepareAudio(context);
    const result = await page.evaluate(async ({ offset }) => {
      const probe = window.audioContinuity;
      try {
        await probe.start(); await probe.settle(350);
        // Calibrate against this actual decoder's startup latency before
        // introducing a signed observation error of exactly 60 ms.
        probe.offset(probe.timeAt() - probe.nativeTime() + offset);
        probe.writes.length = 0; probe.rates.length = 0; probe.events.length = 0;
        const samples = [], observedRates = [], started = performance.now();
        while (performance.now() - started < 2600) {
          await probe.settle(25);
          observedRates.push(probe.audio.playbackRate);
          if (performance.now() - started > 400) samples.push(probe.pcm());
        }
        return { writes: [...probe.writes], rates: [...probe.rates], observedRates, events: [...probe.events], samples,
          drift: probe.timeAt() - probe.audio.currentTime, preservesPitch: probe.audio.preservesPitch,
          error: probe.audio.error?.message ?? null };
      } finally { await probe.close(); }
    }, { offset });
    await info.attach(`native-audio-${name}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.error).toBe(null);
    expect(result.writes.length).toBeLessThanOrEqual(1);
    expect(result.events.filter(event => event.name === "seeking").length).toBeLessThanOrEqual(1);
    expect(result.observedRates.some(rate => direction > 0 ? rate > 1 : rate < 1)).toBe(true);
    expect(result.observedRates.every(rate => rate >= 0.96 - 1e-6 && rate <= 1.04 + 1e-6)).toBe(true);
    expect(result.preservesPitch).toBe(true);
    expect(Math.abs(result.drift)).toBeLessThan(0.12);
    expect(result.samples.length).toBeGreaterThan(30);
    const audible = result.samples.filter(sample => sample.rms > 0.03 && sample.frequency > 380 && sample.frequency < 500);
    expect(audible.length / result.samples.length).toBeGreaterThan(0.9);
    await page.close();
  });
}

test("explicit seeks and moved audio remain precise while pause resets drift correction", async ({ context }, info) => {
  const page = await prepareAudio(context);
  const result = await page.evaluate(async () => {
    const probe = window.audioContinuity;
    try {
      await probe.start(); await probe.settle(350);
      probe.offset(probe.timeAt() - probe.nativeTime() - 0.06);
      const deadline = performance.now() + 2000;
      while (!probe.rates.some(rate => rate > 1) && performance.now() < deadline) await probe.settle(20);
      const corrected = probe.rates.some(rate => rate > 1);
      await probe.pause();
      const paused = { paused: probe.audio.paused, rate: probe.audio.playbackRate };
      probe.offset(0);
      await probe.seek(0.4);
      probe.writes.length = 0;
      await probe.seek(0.41);
      const smallSeek = { writes: [...probe.writes], native: probe.nativeTime() };
      await probe.start();
      probe.writes.length = 0;
      await probe.render({ audioTracks: [{ ...probe.props.audioTracks[0], startTime: 0.25, trimStart: 0.08 }] });
      const moved = [...probe.writes];
      await probe.pause();
      return { corrected, paused, smallSeek, moved, finalRate: probe.audio.playbackRate };
    } finally { await probe.close(); }
  });
  await info.attach("audio-positioning-with-drift-control", { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.corrected).toBe(true);
  expect(result.paused).toEqual({ paused: true, rate: 1 });
  expect(result.smallSeek.writes.some(write => Math.abs(write.value - 0.41) < 1e-6)).toBe(true);
  expect(Math.abs(result.smallSeek.native - 0.41)).toBeLessThan(1e-6);
  expect(result.moved.length).toBeGreaterThan(0);
  expect(Math.abs(result.moved[0].value - (result.moved[0].clock - 0.25 + 0.08))).toBeLessThan(0.02);
  expect(result.finalRate).toBe(1);
  await page.close();
});

test("large audio discontinuities wait for native readiness and cannot cause rapid recovery seeks", async ({ context }, info) => {
  const page = await prepareAudio(context);
  const result = await page.evaluate(async () => {
    const probe = window.audioContinuity;
    try {
      await probe.start(); await probe.settle(900);
      probe.observeState(undefined, true);
      probe.offset(probe.timeAt() - probe.nativeTime() - 0.8);
      probe.writes.length = 0;
      await probe.settle(350);
      const whileSeeking = probe.writes.length;
      probe.observeState(HTMLMediaElement.HAVE_CURRENT_DATA, false);
      await probe.settle(350);
      const beforeFutureData = probe.writes.length;
      probe.observeState(undefined, undefined);
      probe.writes.length = 0;
      await probe.settle(1700);
      const recoveries = [...probe.writes];
      probe.offset(probe.timeAt() - probe.nativeTime());
      await probe.settle(1300);
      probe.writes.length = 0;
      probe.offset(probe.timeAt() - probe.nativeTime() - 0.8);
      await probe.settle(350);
      return { whileSeeking, beforeFutureData, recoveries, rearmedRecoveries: [...probe.writes],
        nativeError: probe.audio.error?.message ?? null };
    } finally { await probe.close(); }
  });
  await info.attach("bounded-native-audio-recovery", { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.nativeError).toBe(null);
  expect(result.whileSeeking).toBe(0);
  expect(result.beforeFutureData).toBe(0);
  expect(result.recoveries.length).toBe(1);
  expect(result.rearmedRecoveries.length).toBe(1);
  await page.close();
});
