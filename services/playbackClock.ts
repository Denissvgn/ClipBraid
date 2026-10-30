export interface PlaybackState {
    time: number;
    playing: boolean;
    preparing: boolean;
    error: string | null;
    notice: string | null;
}
type Context = Pick<AudioContext, "currentTime" | "state" | "resume" | "suspend" | "close" | "onstatechange"> & {
    outputLatency?: number;
    getOutputTimestamp?: () => AudioTimestamp;
    createConstantSource?: () => ConstantSourceNode;
    destination?: AudioDestinationNode;
};
interface Options {
    context(): Context;
    frame(callback: FrameRequestCallback): number;
    cancel(id: number): void;
}
export interface VideoProgress {
    start: number;
    end: number;
    sourceStart: number;
    frame(): {
        time: number;
        duration: number;
    } | null;
    ended?(): boolean;
    reset(): void;
}
/** One transport clock, advanced by Web Audio time. React/UI publishes at most
 * 10Hz; native media synchronization runs separately at display cadence. */
export class PlaybackClock {
    private context: Context | null = null;
    private listeners = new Set<() => void>();
    private state: PlaybackState = { time: 0, playing: false, preparing: false, error: null, notice: null };
    private position = 0;
    private presentedPosition = 0;
    private anchor = 0;
    private duration = 0;
    private generation = 0;
    private frame: number | null = null;
    private lastPublish = -Infinity;
    private cancelStart: (() => void) | null = null;
    private closing: Promise<void> | null = null;
    private silent: ConstantSourceNode | null = null;
    private lastOutput = 0;
    private videos = new Map<string, VideoProgress>();
    private progressTime = 0;
    private progressStamp = 0;
    constructor(private options: Options = { context: () => new AudioContext({ latencyHint: "interactive" }), frame: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id) }) { }
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    getSnapshot = () => this.state;
    registerVideo = (id: string, progress: VideoProgress) => { this.videos.set(id, progress); return () => { if (this.videos.get(id) === progress)
        this.videos.delete(id); }; };
    getAudioTime = () => {
        if (!this.state.playing || !this.context)
            return this.position;
        return Math.min(this.duration, Math.max(this.position,
            this.position + this.outputTime(this.context) - this.anchor));
    };
    getTime = () => {
        if (!this.state.playing || !this.context)
            return this.position;
        const desired = Math.min(this.duration, Math.max(this.presentedPosition, this.getAudioTime()));
        let ceiling = this.duration, floor = 0;
        for (const progress of this.videos.values())
            if (progress.end > this.presentedPosition + 1e-6 && progress.start < desired) {
                const frame = progress.frame();
                // Native EOF can follow the last frame's estimated interval.
                // Its final image covers the remaining selected clip tail.
                const through = frame ? (progress.ended?.() ? progress.end
                    : progress.start + frame.time - progress.sourceStart + frame.duration + .005) : progress.start;
                ceiling = Math.min(ceiling, Math.max(this.presentedPosition, Math.min(progress.end, through)));
                if (frame)
                    floor = Math.max(floor, progress.start + frame.time - progress.sourceStart - .015);
            }
        // Bound presentation by delivered frames without rebasing the audio
        // anchor: ordinary frame waits must not discard soundtrack time.
        const allowed = Math.min(ceiling, Math.max(desired, floor));
        this.presentedPosition = allowed;
        return allowed;
    };
    observe = () => ({ time: this.getTime(), audioTime: this.getAudioTime(), playing: this.state.playing, preparing: this.state.preparing, owner: "audio-output-clock", contextState: this.context?.state ?? "not-created", outputLatency: this.context?.outputLatency ?? null });
    setDuration = (duration: number) => { this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0; if (this.getTime() >= this.duration) {
        this.position = this.duration;
        this.presentedPosition = this.position;
        this.pause();
    }
    else if (this.position > this.duration)
        this.seek(this.duration); };
    seek = (time: number) => { for (const progress of this.videos.values())
        progress.reset(); this.position = Math.min(this.duration, Math.max(0, Number.isFinite(time) ? time : 0)); this.presentedPosition = this.position; this.anchor = this.context ? this.outputTime(this.context) : 0; this.progressTime = this.position; this.progressStamp = performance.now(); this.publish({ time: this.position }); };
    play = async () => {
        if (this.state.playing || this.state.preparing || this.duration <= 0)
            return;
        if (this.closing) {
            this.publish({ error: "Playback resources are still closing. Try Play again." });
            return;
        }
        const generation = ++this.generation;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (!this.context || this.context.state === "closed") {
                const context = this.options.context();
                this.context = context;
                this.lastOutput = 0;
                if (context.createConstantSource && context.destination) {
                    this.silent = context.createConstantSource();
                    this.silent.offset.value = 0;
                    this.silent.connect(context.destination);
                    this.silent.start();
                }
                context.onstatechange = () => { if (this.context === context && this.state.playing && context.state !== "running")
                    this.fail("Playback was interrupted. Press Play to resume."); };
            }
            const context = this.context;
            this.publish({ preparing: true, error: null, notice: null });
            const canceled = new Promise<void>(resolve => { this.cancelStart = resolve; });
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Audio playback did not start. Check browser playback permission and try Play again.")), 2000); });
            const resuming = context.resume().then(() => {
                if (generation !== this.generation && !this.state.playing && !this.state.preparing && context.state === "running")
                    void context.suspend().catch(() => { });
            });
            await Promise.race([resuming, canceled, timeout]);
            if (generation !== this.generation) {
                if (!this.state.playing && !this.state.preparing && context.state === "running")
                    void context.suspend().catch(() => { });
                return;
            }
            if (context.state !== "running")
                throw new Error("Audio playback is unavailable. Press Play to retry.");
            if (context.getOutputTimestamp) {
                const started = performance.now();
                while (generation === this.generation && performance.now() - started < 500) {
                    const point = context.getOutputTimestamp();
                    if ((point.contextTime ?? 0) > 0 && (point.performanceTime ?? 0) > 0)
                        break;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            if (generation !== this.generation)
                return;
            if (this.position >= this.duration)
                this.seek(0);
            this.anchor = this.outputTime(context);
            this.presentedPosition = this.position;
            this.progressTime = this.position;
            this.progressStamp = performance.now();
            this.lastPublish = -Infinity;
            this.publish({ time: this.position, playing: true, preparing: false });
            this.frame = this.options.frame(this.tick);
        }
        catch (error) {
            if (generation === this.generation)
                this.fail(`Could not start preview: ${String(error)}`);
        }
        finally {
            clearTimeout(timer);
            if (generation === this.generation)
                this.cancelStart = null;
        }
    };
    pause = (notice: string | null = null) => {
        this.position = this.getTime();
        this.presentedPosition = this.position;
        this.generation++;
        this.cancelStart?.();
        this.cancelStart = null;
        if (this.frame !== null)
            this.options.cancel(this.frame);
        this.frame = null;
        this.publish({ time: this.position, playing: false, preparing: false, notice });
        if (this.context?.state === "running")
            void this.context.suspend().catch(() => { });
    };
    fail = (message: string) => { this.pause(); this.publish({ error: message }); };
    clearError = () => this.publish({ error: null, notice: null });
    dispose = () => {
        this.listeners.clear();
        this.pause();
        const context = this.context;
        this.context = null;
        this.videos.clear();
        if (this.silent) {
            try {
                this.silent.stop();
            }
            catch { }
            this.silent.disconnect();
            this.silent = null;
        }
        if (context) {
            context.onstatechange = null;
            const closing = context.close();
            this.closing = closing;
            void closing.finally(() => { if (this.closing === closing)
                this.closing = null; }).catch(() => { });
        }
        this.listeners.clear();
    };
    private tick = (stamp: number) => {
        this.frame = null;
        if (!this.state.playing)
            return;
        if (this.context?.state !== "running") {
            this.fail("Playback was interrupted. Press Play to resume.");
            return;
        }
        const time = this.getTime();
        if (time > this.progressTime + .001) {
            this.progressTime = time;
            this.progressStamp = performance.now();
        }
        else if (performance.now() - this.progressStamp > 2000) {
            this.fail("Visual playback stalled. Check the source and press Play to retry.");
            return;
        }
        if (time >= this.duration) {
            this.pause();
            return;
        }
        if (stamp - this.lastPublish >= 100 - .1) {
            this.lastPublish = stamp;
            this.publish({ time });
        }
        this.frame = this.options.frame(this.tick);
    };
    private publish(change: Partial<PlaybackState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners)
        listener(); }
    private outputTime(context: Context) {
        const stamp = context.getOutputTimestamp?.();
        const time = stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.contextTime > 0 && stamp.performanceTime > 0 ? Math.min(context.currentTime, stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000) : context.currentTime;
        this.lastOutput = Math.max(this.lastOutput, time);
        return this.lastOutput;
    }
}
