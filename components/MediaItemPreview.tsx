import React, { useEffect, useRef, memo } from "react";
import { MediaAsset, VisualFilter } from "../types";
import type { PlaybackClock } from "../services/playbackClock";
import { intervalsOverlap, isIntervalActive, sourceTimeAt, } from "../services/timeline";
interface MediaItemPreviewProps {
    asset: MediaAsset;
    /** Resolved object URL for the immutable source; hidden while undefined. */
    url: string | undefined;
    currentTime: number;
    isPlaying: boolean;
    fitMode: "contain" | "cover";
    opacity: number;
    zIndex: number;
    seekRevision?: number;
    timeAt?: () => number;
    onPlaybackError?: (message: string) => void;
    registerVideo?: PlaybackClock["registerVideo"];
    opacityAt?: (asset: MediaAsset, time: number) => number;
}
export const MediaItemPreview = memo(({ asset, url, currentTime, isPlaying, fitMode, opacity, zIndex, seekRevision = 0, timeAt, onPlaybackError, registerVideo, opacityAt, }: MediaItemPreviewProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const latest = useRef({ isPlaying, url, asset, currentTime, seekRevision, onPlaybackError });
    latest.current = { isPlaying, url, asset, currentTime, seekRevision, onPlaybackError };
    const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const failure = (message: string) => { const value = latest.current; if (value.isPlaying && isIntervalActive(value.asset, timeAt?.() ?? value.currentTime))
        value.onPlaybackError?.(message); };
    useEffect(() => () => { clearTimeout(waiting.current); }, []);
    const previousSeek = useRef(seekRevision);
    const previousPlaying = useRef(isPlaying);
    const previousPlacement = useRef({ start: asset.startTime, trim: asset.trimStart });
    const presentedFrame = useRef<{
        time: number;
        duration: number;
    } | null>(null);
    useEffect(() => {
        const video = videoRef.current;
        if (asset.type !== "video" || !video || !registerVideo)
            return;
        presentedFrame.current = null;
        let previous: VideoFrameCallbackMetadata | undefined;
        let frameDuration = 1 / (asset.sourceFps || 30);
        const unregister = registerVideo(asset.id, {
            start: asset.startTime, end: asset.startTime + asset.duration, sourceStart: asset.trimStart,
            frame: () => presentedFrame.current,
            reset: () => { presentedFrame.current = null; previous = undefined; },
        });
        let callback: number;
        const presented: VideoFrameRequestCallback = (_now, metadata) => {
            if (previous) {
                const count = metadata.presentedFrames - previous.presentedFrames;
                const interval = (metadata.mediaTime - previous.mediaTime) / count;
                if (count > 0 && interval >= .001 && interval <= .1)
                    frameDuration = interval;
            }
            presentedFrame.current = { time: metadata.mediaTime, duration: frameDuration };
            previous = metadata;
            callback = video.requestVideoFrameCallback(presented);
        };
        if (typeof video.requestVideoFrameCallback !== "function")
            return unregister;
        callback = video.requestVideoFrameCallback(presented);
        return () => { video.cancelVideoFrameCallback(callback); unregister(); };
    }, [asset.id, asset.type, asset.startTime, asset.duration, asset.trimStart, asset.sourceFps, url, registerVideo]);
    const localTime = sourceTimeAt(asset, currentTime);
    const isVisible = intervalsOverlap(asset, currentTime - 0.5, currentTime + 0.5);
    useEffect(() => {
        if (!isPlaying || !timeAt || !opacityAt)
            return;
        let frame: number;
        const update = () => {
            const node = videoRef.current ?? imageRef.current;
            if (node) {
                const time = timeAt();
                node.style.opacity = String(opacityAt(asset, time));
                node.style.zIndex = isIntervalActive(asset, time) ? "2" : "1";
            }
            frame = requestAnimationFrame(update);
        };
        update();
        return () => cancelAnimationFrame(frame);
    }, [asset, isPlaying, timeAt, opacityAt, url]);
    useEffect(() => {
        if (asset.type !== "video" || !videoRef.current)
            return;
        const video = videoRef.current;
        const synchronize = () => {
            const seeked = previousSeek.current !== seekRevision;
            const starting = previousPlaying.current !== isPlaying;
            const target = sourceTimeAt(asset, seeked || starting ? currentTime : (timeAt?.() ?? currentTime));
            previousPlaying.current = isPlaying;
            previousSeek.current = seekRevision;
            const moved = previousPlacement.current.start !== asset.startTime || previousPlacement.current.trim !== asset.trimStart;
            previousPlacement.current = { start: asset.startTime, trim: asset.trimStart };
            if (seeked || moved)
                presentedFrame.current = null;
            const isActive = isIntervalActive(asset, timeAt?.() ?? currentTime);
            if (isActive) {
                if (isPlaying) {
                    if (video.paused || seeked || moved) {
                        video.currentTime = target;
                    }
                    // Correct against the delivered frame, rather than the decode head.
                    // Required frames also constrain transport time while decoding stalls.
                    const drift = target - (presentedFrame.current?.time ?? video.currentTime);
                    const rate = drift < -.025 ? .8 : drift > .025 ? 1.05 : 1;
                    if (video.playbackRate !== rate)
                        video.playbackRate = rate;
                    const ended = Number.isFinite(video.duration) && target >= video.duration;
                    if (video.paused && !ended) {
                        const revision = seekRevision;
                        void video.play().then(() => { if (!latest.current.isPlaying)
                            video.pause(); }).catch(() => {
                            if (latest.current.seekRevision === revision && latest.current.url === url)
                                failure("Visual playback was blocked. Press Play to retry.");
                        });
                    }
                }
                else {
                    if (video.playbackRate !== 1)
                        video.playbackRate = 1;
                    if (!video.paused)
                        video.pause();
                    if (Math.abs(video.currentTime - target) > 1e-6) {
                        video.currentTime = target;
                    }
                }
            }
            else {
                clearTimeout(waiting.current);
                if (!video.paused) {
                    video.pause();
                }
            }
        };
        synchronize();
        let frame: number | undefined;
        if (timeAt && isPlaying) {
            const tick = () => { synchronize(); frame = requestAnimationFrame(tick); };
            frame = requestAnimationFrame(tick);
        }
        return () => { if (frame !== undefined)
            cancelAnimationFrame(frame); };
    }, [
        timeAt ? null : localTime,
        isPlaying,
        timeAt ? null : currentTime,
        asset.startTime,
        asset.duration,
        asset.trimStart,
        asset.trimEnd,
        asset.type,
        url,
        seekRevision, timeAt,
    ]);
    const getFilterStyle = (filter: VisualFilter): string => {
        switch (filter) {
            case "grayscale":
                return "grayscale(100%)";
            case "sepia":
                return "sepia(100%)";
            case "noir":
                return "grayscale(100%) contrast(150%) brightness(80%)";
            case "vintage":
                return "sepia(50%) contrast(90%) brightness(110%) saturate(80%)";
            case "warm":
                return "sepia(30%) saturate(120%) brightness(105%)";
            case "cool":
                return "hue-rotate(180deg) saturate(80%) brightness(105%)";
            default:
                return "none";
        }
    };
    const style: React.CSSProperties = {
        objectFit: fitMode,
        width: "100%",
        height: "100%",
        position: "absolute",
        top: 0,
        left: 0,
        opacity: isVisible ? opacity : 0,
        mixBlendMode: "plus-lighter",
        zIndex,
        display: isVisible || opacity > 0 ? "block" : "none",
        pointerEvents: "none",
        filter: getFilterStyle(asset.filter),
        transition: "filter 0.3s ease-out",
    };
    if (!url)
        return null;
    if (asset.type === "video") {
        return (<video ref={videoRef} src={url} style={style} muted playsInline disablePictureInPicture preload="auto" onError={() => failure("A visual could not play. Check the source or press Play to retry.")} onWaiting={() => { clearTimeout(waiting.current); waiting.current = setTimeout(() => { if (videoRef.current && videoRef.current.readyState < 3)
            failure("Visual playback stalled. Check the source and press Play to retry."); }, 2000); }} onPlaying={() => clearTimeout(waiting.current)} onLoadedMetadata={() => {
                if (videoRef.current) {
                    videoRef.current.currentTime = Math.max(asset.trimStart, localTime);
                }
            }}/>);
    }
    return <img ref={imageRef} src={url} style={style} alt={asset.name}/>;
});
MediaItemPreview.displayName = "MediaItemPreview";
