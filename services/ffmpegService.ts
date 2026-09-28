/** Owns one FFmpeg worker and settles every operation when that worker fails. */
const MSG = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  ERROR: "ERROR",
  LOG: "LOG",
  PROGRESS: "PROGRESS",
} as const;
const CDNS = [
  "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd",
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd",
  "https://cdn.jsdelivr.net/gh/ffmpegwasm/core@0.12.6/dist/umd",
];
type Timeouts = { fetchMs: number; loadMs: number; operationMs: number };
export class FFmpegService {
  private worker: Worker | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private msgId = 0;
  private urls = new Map<Worker, string[]>();
  private callbacks = new Map<
    number,
    {
      worker: Worker;
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private logCb: ((msg: string) => void) | null = null;
  private progressCb: ((p: { progress: number }) => void) | null = null;
  private timeouts: Timeouts;
  constructor(timeouts: Partial<Timeouts> = {}) {
    this.timeouts = {
      fetchMs: 30_000,
      loadMs: 45_000,
      operationMs: 300_000,
      ...timeouts,
    };
  }
  load(onLog?: (msg: string) => void): Promise<void> {
    if (onLog) this.logCb = onLog;
    if (this.loaded && this.worker) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.loadWorker().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }
  private reset(worker: Worker, error: Error) {
    if (this.worker !== worker && !this.urls.has(worker)) return;
    if (this.worker === worker) {
      this.worker = null;
      this.loaded = false;
    }
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    for (const [id, callback] of this.callbacks) {
      if (callback.worker !== worker) continue;
      clearTimeout(callback.timer);
      this.callbacks.delete(id);
      callback.reject(error);
    }
    this.urls.get(worker)?.forEach((url) => URL.revokeObjectURL(url));
    this.urls.delete(worker);
  }
  private async loadWorker(): Promise<void> {
    let error: unknown;
    for (const baseURL of CDNS) {
      const urls: string[] = [];
      let worker: Worker | undefined;
      try {
        this.logCb?.(`Connecting to ${new URL(baseURL).hostname}...`);
        const fetchAsset = async (name: string, type: string) => {
          const response = await fetch(`${baseURL}/${name}`, {
            signal: AbortSignal.timeout(this.timeouts.fetchMs),
          });
          if (!response.ok)
            throw new Error(`FFmpeg asset HTTP ${response.status}: ${name}`);
          const bytes = await response.arrayBuffer();
          if (!bytes.byteLength) throw new Error(`Empty FFmpeg asset: ${name}`);
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          urls.push(url);
          return url;
        };
        const coreURL = await fetchAsset("ffmpeg-core.js", "text/javascript");
        const wasmURL = await fetchAsset(
          "ffmpeg-core.wasm",
          "application/wasm",
        );
        const workerURL = this.buildWorkerBlob();
        urls.push(workerURL);
        worker = new Worker(workerURL);
        const attempt = worker;
        this.worker = attempt;
        this.urls.set(attempt, urls);
        attempt.onmessage = ({ data: { id, type, data } }) => {
          if (this.worker !== attempt) return;
          if (type === MSG.LOG) {
            this.logCb?.(data?.message || "");
            return;
          }
          if (type === MSG.PROGRESS) {
            this.progressCb?.(data);
            return;
          }
          const callback = this.callbacks.get(id);
          if (!callback || callback.worker !== attempt) return;
          clearTimeout(callback.timer);
          this.callbacks.delete(id);
          if (type === MSG.ERROR) callback.reject(new Error(String(data)));
          else callback.resolve(data);
        };
        attempt.onerror = (event) => {
          event.preventDefault?.();
          this.reset(
            attempt,
            new Error(event.message || "FFmpeg worker crashed"),
          );
        };
        attempt.onmessageerror = () =>
          this.reset(
            attempt,
            new Error("FFmpeg worker message could not be decoded"),
          );
        await this.send(MSG.LOAD, { coreURL, wasmURL }, [], attempt);
        if (this.worker !== attempt)
          throw new Error("FFmpeg worker stopped during initialization");
        this.loaded = true;
        this.logCb?.("FFmpeg Initialized.");
        return;
      } catch (cause) {
        error = cause;
        if (worker)
          this.reset(
            worker,
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        else urls.forEach((url) => URL.revokeObjectURL(url));
      }
    }
    throw new Error(
      `FFmpeg failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  private send(
    type: string,
    data?: any,
    transfer: Transferable[] = [],
    worker = this.worker,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!worker || (type !== MSG.LOAD && !this.loaded))
        return reject(new Error("FFmpeg not initialized; retry loading"));
      const id = this.msgId++;
      const timer = setTimeout(
        () => this.reset(worker, new Error(`FFmpeg ${type} timed out`)),
        type === MSG.LOAD ? this.timeouts.loadMs : this.timeouts.operationMs,
      );
      this.callbacks.set(id, { worker, resolve, reject, timer });
      try {
        worker.postMessage({ id, type, data }, transfer);
      } catch (error) {
        this.reset(
          worker,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }
  private buildWorkerBlob(): string {
    const script = `
var MSG = {
  LOAD: "LOAD", EXEC: "EXEC",
  WRITE_FILE: "WRITE_FILE", READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE", ERROR: "ERROR",
  LOG: "LOG", PROGRESS: "PROGRESS",
};
var ffmpeg = null;
var load = function(opts) {
  importScripts(opts.coreURL);
  if (!self.createFFmpegCore) {
    throw new Error("failed to import ffmpeg-core.js");
  }
  return self.createFFmpegCore({
    mainScriptUrlOrBlob: opts.coreURL
      + "#" + btoa(JSON.stringify({ wasmURL: opts.wasmURL })),
  }).then(function(core) {
    ffmpeg = core;
    ffmpeg.setLogger(function(data) {
      self.postMessage({ type: MSG.LOG, data: data });
    });
    ffmpeg.setProgress(function(data) {
      self.postMessage({ type: MSG.PROGRESS, data: data });
    });
    return true;
  });
};
self.onmessage = function(e) {
  var id = e.data.id;
  var type = e.data.type;
  var _data = e.data.data;
  var trans = [];
  var data;
  var handleResult = function(result) {
    data = result;
    if (data instanceof Uint8Array) trans.push(data.buffer);
    self.postMessage({ id: id, type: type, data: data }, trans);
  };
  var handleError = function(err) {
    self.postMessage({ id: id, type: MSG.ERROR, data: err.toString() });
  };
  try {
    if (type !== MSG.LOAD && !ffmpeg) {
       handleError(new Error("ffmpeg is not loaded"));
       return;
    }
    switch (type) {
      case MSG.LOAD:
        load(_data).then(handleResult).catch(handleError);
        return;
      case MSG.EXEC:
        ffmpeg.setTimeout(_data.timeout || -1);
        ffmpeg.exec.apply(ffmpeg, _data.args);
        data = ffmpeg.ret;
        ffmpeg.reset();
        break;
      case MSG.WRITE_FILE:
        ffmpeg.FS.writeFile(_data.path, _data.data);
        data = true;
        break;
      case MSG.READ_FILE:
        data = ffmpeg.FS.readFile(_data.path);
        break;
      case MSG.DELETE_FILE:
        ffmpeg.FS.unlink(_data.path);
        data = true;
        break;
      default:
        handleError(new Error("unknown message type: " + type));
        return;
    }
  } catch (err) {
    handleError(err);
    return;
  }
  if (data instanceof Uint8Array) trans.push(data.buffer);
  self.postMessage({ id: id, type: type, data: data }, trans);
};
`;
    return URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  }
  async exec(args: string[]) {
    const ret = await this.send(MSG.EXEC, {
      args,
      timeout: this.timeouts.operationMs,
    });
    if (ret !== 0) throw new Error(`FFmpeg exit code ${ret}`);
    return ret;
  }
  async writeFile(name: string, data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!bytes || bytes.byteLength === 0)
      throw new Error(`writeFile: empty payload for ${name}`);
    return this.send(MSG.WRITE_FILE, { path: name, data: bytes }, [
      bytes.buffer,
    ]);
  }
  async readFile(name: string) {
    return this.send(MSG.READ_FILE, { path: name });
  }
  async deleteFile(name: string) {
    return this.send(MSG.DELETE_FILE, { path: name });
  }
  async getDuration(name: string): Promise<number> {
    let duration = 0;
    const oldLog = this.logCb;
    this.logCb = (msg) => {
      oldLog?.(msg);
      const match = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (match) {
        const h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const s = parseFloat(match[3]);
        duration = h * 3600 + m * 60 + s;
      }
    };
    try {
      await this.exec(["-i", name]);
    } catch (e) {
      /* Metadata check always throws as there is no output */
    }
    this.logCb = oldLog;
    return duration;
  }
  onProgress(cb: (p: { progress: number }) => void) {
    this.progressCb = cb;
  }
}
export const ffmpegService = new FFmpegService();
