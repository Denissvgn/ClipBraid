import React, { useEffect, useRef, useMemo, memo } from "react";
import { AudioFragment, MediaAsset } from "../types";
import { audioSourceTimeAt, audioSourceWindow, intervalsOverlap, isIntervalActive, sourceTimeAt } from "../services/timeline";
import { clipHasSound, mixPolicy, trackGain } from "../services/mixing";
interface AudioEngineProps {
    audioTracks: AudioFragment[];
    mediaAssets: MediaAsset[];
    /** Resolves a source ID to its live object URL (media source store). */
    sourceUrl: (sourceId: string) => string | undefined;
    currentTime: number;
    isPlaying: boolean;
    seekRevision?: number;
    timeAt?: () => number;
    onPlaybackError?: (message: string) => void;
}
const releaseAudio = (audio: HTMLAudioElement) => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
};
export const AudioEngine = memo(({ audioTracks = [], mediaAssets = [], sourceUrl, currentTime = 0, isPlaying = false, seekRevision = 0, timeAt, onPlaybackError, }: AudioEngineProps) => {
    const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
    const latest = useRef({ isPlaying, onPlaybackError });
    latest.current = { isPlaying, onPlaybackError };
    const desired = useRef(new Map<string, {
        audio: HTMLAudioElement;
        playing: boolean;
        revision: number;
    }>());
    const waits = useRef(new Map<HTMLAudioElement, ReturnType<typeof setTimeout>>());
    const failure = (id: string, audio: HTMLAudioElement, message: string) => {
        const current = desired.current.get(id);
        if (current?.audio === audio && current.playing && latest.current.isPlaying)
            latest.current.onPlaybackError?.(message);
    };
    const configure = (id: string, audio: HTMLAudioElement) => {
        audio.onerror = () => failure(id, audio, "A soundtrack could not play. Check the source or press Play to retry.");
        audio.onwaiting = () => { clearTimeout(waits.current.get(audio)); waits.current.set(audio, setTimeout(() => { if (audio.readyState < 3)
            failure(id, audio, "Sound playback stalled. Check the source and press Play to retry."); }, 2000)); };
        audio.onplaying = () => { clearTimeout(waits.current.get(audio)); waits.current.delete(audio); };
    };
    const previousSeek = useRef(seekRevision);
    const previousPlaying = useRef(isPlaying);
    const previousMapping = useRef(new Map<string, {
        start: number;
        source: number;
    }>());
    const policy = useMemo(() => mixPolicy(mediaAssets, audioTracks), [mediaAssets, audioTracks]);
    const nearbyIds = [...audioTracks.filter(track => trackGain(track) > 0), ...mediaAssets.filter(clipHasSound)]
        .filter(item => intervalsOverlap(item, currentTime - 2, currentTime + 2)).map(item => item.id);
    const nearbyKey=JSON.stringify(nearbyIds);
    useEffect(() => {
        // Collect IDs for current audio requirements
        const currentIds = new Set([
            ...JSON.parse(nearbyKey) as string[],
        ]);
        // Cleanup unused audio elements
        const desiredUrls = new Map([...audioTracks, ...mediaAssets].map((asset) => [
            asset.id,
            sourceUrl(asset.sourceId),
        ]));
        for (const [id, audio] of audioRefs.current.entries()) {
            if (!currentIds.has(id) || audio.src !== desiredUrls.get(id)) {
                desired.current.delete(id);
                clearTimeout(waits.current.get(audio));
                waits.current.delete(audio);
                audio.onerror = null;
                audio.onwaiting = null;
                audio.onplaying = null;
                releaseAudio(audio);
                audioRefs.current.delete(id);
            }
        }
        // Load soundrack audio
        for (const track of audioTracks) {
            if (!currentIds.has(track.id))
                continue;
            const url = desiredUrls.get(track.id);
            if (url && !audioRefs.current.has(track.id)) {
                const audio = new Audio(url);
                audio.loop = false;
                audio.preload = "auto";
                configure(track.id, audio);
                audioRefs.current.set(track.id, audio);
            }
        }
        // Load video clip audio
        for (const asset of mediaAssets) {
            if (currentIds.has(asset.id) && clipHasSound(asset)) {
                const url = desiredUrls.get(asset.id);
                if (url && !audioRefs.current.has(asset.id)) {
                    const audio = new Audio(url);
                    audio.loop = false;
                    audio.preload = "auto";
                    configure(asset.id, audio);
                    audioRefs.current.set(asset.id, audio);
                }
            }
        }
    }, [audioTracks, mediaAssets, sourceUrl, nearbyKey]);
    useEffect(() => () => {
        desired.current.clear();
        for (const timer of waits.current.values())
            clearTimeout(timer);
        waits.current.clear();
        for (const audio of audioRefs.current.values()) {
            audio.onerror = null;
            audio.onwaiting = null;
            audio.onplaying = null;
            releaseAudio(audio);
        }
        audioRefs.current.clear();
    }, []);
    useEffect(() => {
        const synchronize = () => {
            const seeked = previousSeek.current !== seekRevision;
            const starting = previousPlaying.current !== isPlaying;
            const sampleTime = seeked || starting ? currentTime : (timeAt?.() ?? currentTime);
            previousPlaying.current = isPlaying;
            previousSeek.current = seekRevision;
            const nextMapping = new Map<string, {
                start: number;
                source: number;
            }>();
            const sync = (id: string, audio: HTMLAudioElement, active: boolean, target: number, start: number, source = 0) => {
                desired.current.set(id, { audio, playing: active && isPlaying, revision: seekRevision });
                const before = previousMapping.current.get(id);
                const moved = !before || before.start !== start || before.source !== source;
                nextMapping.set(id, { start, source });
                const ended = (Number.isFinite(audio.duration) && target >= audio.duration)
                    || (audio.ended && target >= audio.currentTime - 1e-6);
                if (!active || !isPlaying || ended) {
                    if (!audio.paused)
                        audio.pause();
                    if (active && !ended && Math.abs(audio.currentTime - target) > 1e-6)
                        audio.currentTime = target;
                    return;
                }
                // Drift tolerance applies only during continuous playback. A new
                // source/start or explicit seek must honor even a very short trim.
                if (audio.paused || seeked || moved || (!audio.seeking && Math.abs(audio.currentTime - target) > 0.02))
                    audio.currentTime = target;
                if (audio.error) {
                    failure(id, audio, "A soundtrack is unavailable for preview. Check the source or try Play again.");
                    return;
                }
                if (audio.paused) {
                    const revision = seekRevision;
                    void audio.play().then(() => { const current = desired.current.get(id); if (current?.audio !== audio || !current.playing || !latest.current.isPlaying)
                        audio.pause(); })
                        .catch(() => { if (desired.current.get(id)?.revision === revision)
                        failure(id, audio, "Sound playback was blocked. Press Play to retry."); });
                }
            };
            // Sync soundtracks
            audioTracks.forEach((track) => {
                const audio = audioRefs.current.get(track.id);
                if (!audio)
                    return;
                const volume = trackGain(track) * policy.gain;
                if (Math.abs(audio.volume - volume) > 1e-6)
                    audio.volume = volume;
                const isWithinRange = isIntervalActive(track, sampleTime);
                sync(track.id, audio, isWithinRange, audioSourceTimeAt(track,sampleTime), track.startTime,audioSourceWindow(track).start);
            });
            // Sync video clip audio
            mediaAssets.forEach((asset) => {
                if (!clipHasSound(asset))
                    return;
                const audio = audioRefs.current.get(asset.id);
                if (!audio)
                    return;
                const volume = trackGain(asset) * policy.gain;
                if (Math.abs(audio.volume - volume) > 1e-6)
                    audio.volume = volume;
                const isWithinRange = isIntervalActive(asset, sampleTime);
                const targetTime = sourceTimeAt(asset, sampleTime);
                sync(asset.id, audio, isWithinRange, targetTime, asset.startTime, asset.trimStart);
            });
            previousMapping.current = nextMapping;
        };
        synchronize();
        let frame: number | undefined;
        if (timeAt && isPlaying) {
            const tick = () => { synchronize(); frame = requestAnimationFrame(tick); };
            frame = requestAnimationFrame(tick);
        }
        return () => { if (frame !== undefined)
            cancelAnimationFrame(frame); };
    }, [isPlaying, timeAt ? null : currentTime, audioTracks, mediaAssets, sourceUrl, policy.gain, seekRevision, timeAt]);
    return null;
});
AudioEngine.displayName = "AudioEngine";
